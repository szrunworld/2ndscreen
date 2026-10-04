// Which processes can still act for a task worker, kept on disk so that a
// later daemon can prove they are all gone before it hands the task on
// (the daemon's verifyActorExit hook).
//
// A worker runs as the leader of its own process group (spawnDetachedWorker),
// so the 2ndscreen commands it runs (A1's execFile) are in that group. The
// exploration bridge and the vision helper start through the
// LineProcessSpawner, each leading a new group of its own that outlives the
// worker if the worker dies. Every spawn is announced on disk before it
// happens and its group written when it returns, in one write with the end of
// the announcement, so a worker killed at any point leaves either the group
// or an unfinished spawn on record — never a child nobody knows about.
//
// The 2ndscreen commands of A1's CommandRunner also lead groups of their
// own (detached). Each is announced in the record while it runs. Their
// pids are not known here, so they are never signalled: after a crash the
// verifier only waits until no orphaned group leader of that program,
// started within the worker's lifetime (from the announcement to the
// record's last heartbeat), is left running.
//
// verifyWorkerStopped() answers whether every actor of a dead worker is gone.
// It is conservative: a group counts as gone only when no process is in it,
// or when its id now leads a process started after the recorded group had to
// have ended. It stops only a group whose leader is the recorded process
// (same pid, start time inside the recorded spawn window). A group whose
// leader is gone but which still has members cannot be tied to the record —
// the id may have been reused while nobody looked — so it is left alone and
// the answer is "not stopped". Anything it cannot read is "not stopped" too.

import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner, LineProcessSpawner } from './contracts.ts';
import { processIdentity, processStartTime, type ActorExitVerdict, type WorkerRecord } from './daemon.ts';

export const ACTOR_RECORD_VERSION = 1;

/** One process group that may act for the worker. */
export interface ActorGroup {
  /** Process group id: its leader's pid. */
  pgid: number;
  /** Clock readings just before and just after the spawn: the leader started in between. */
  spawnedAfterMs: number;
  spawnedBeforeMs: number;
  /** The program, for the log. */
  file: string;
}

export interface ActorCommand {
  id: number;
  file: string;
  /** Clock reading just before the command was started. */
  startedAfterMs: number;
}

/** The record's mtime is refreshed this often while the worker lives. */
export const HEARTBEAT_MS = 2_000;

export interface ActorRecord {
  v: typeof ACTOR_RECORD_VERSION;
  /** The worker. */
  pid: number;
  /** Its process group, read at start; verification requires it to equal pid. */
  pgid: number;
  /** The worker's start as the daemon records it (daemon.processStartTime: ps lstart as ISO). */
  startedAt: string;
  /** Spawns announced whose outcome is not written yet. Non-zero after a crash means: cannot prove. */
  pendingSpawns: number;
  groups: ActorGroup[];
  /** Commands under way (CommandRunner), by when they were announced; their pids are unknown. */
  commands: ActorCommand[];
  /** Written at a clean exit, once every spawned group was confirmed gone. */
  closedAt?: string;
}

/** Facts about processes, injected for tests. Nothing here may guess. */
export interface ProcessProbe {
  /** The start of `pid` (ISO, second resolution), undefined when no such process; throws when it cannot be read. */
  startedAt(pid: number): string | undefined;
  /** Whether group `pgid` has members; 'unknown' when the system will not say. */
  group(pgid: number): 'alive' | 'gone' | 'unknown';
  /** The process group of `pid`; undefined when it cannot be read. */
  groupOf(pid: number): number | undefined;
  killGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  /**
   * Running processes of program `file` (as started: argv[0]) that lead
   * their own group and were left to launchd (ppid 1), started in
   * [fromMs, toMs]; undefined when the process list cannot be read.
   */
  orphanLeaders(file: string, fromMs: number, toMs: number): number[] | undefined;
  sleep(ms: number): Promise<void>;
}

const exists = (pid: number): boolean | undefined => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ESRCH' ? false : code === 'EPERM' ? true : undefined;
  }
};

export const systemProbe: ProcessProbe = {
  startedAt(pid) {
    const before = exists(pid);
    if (before === false) return undefined;
    if (before === undefined) throw new Error(`cannot tell whether pid ${pid} exists`);
    const start = processStartTime(pid);
    if (start !== undefined) return start;
    // It may have exited between the two looks.
    if (exists(pid) === false) return undefined;
    throw new Error(`cannot read the start time of pid ${pid}`);
  },
  group(pgid) {
    try {
      process.kill(-pgid, 0);
      return 'alive';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EPERM: members exist that may not be signalled. Anything else is not an answer.
      return code === 'ESRCH' ? 'gone' : code === 'EPERM' ? 'alive' : 'unknown';
    }
  },
  groupOf(pid) {
    try {
      const out = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const pgid = Number(out);
      return out !== '' && Number.isSafeInteger(pgid) && pgid > 0 ? pgid : undefined;
    } catch {
      return undefined;
    }
  },
  killGroup(pgid, signal) {
    try {
      process.kill(-pgid, signal);
    } catch {
      // Gone already; the caller looks again.
    }
  },
  orphanLeaders(file, fromMs, toMs) {
    let out: string;
    try {
      // Numbers, start times and argv[0] only: no arguments, no environment.
      out = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,comm='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 });
    } catch {
      return undefined;
    }
    const found: number[] = [];
    for (const line of out.split('\n')) {
      if (line.trim() === '') continue;
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s(.*)$/.exec(line);
      if (!m) return undefined;
      const [pid, ppid, pgid] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const start = Date.parse(m[4]!);
      if (Number.isNaN(start)) return undefined;
      // ps truncates to seconds: the true start is in [start, start + 1000).
      if (m[5]!.trim() === file && ppid === 1 && pgid === pid && start + 1000 > fromMs && start <= toMs) found.push(pid);
    }
    return found;
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const recordName = (pid: number, startedAt: string) => `${pid}-${Date.parse(startedAt)}.json`;

/** Atomic and durable: written to a temporary file, flushed, then renamed over the record. */
function writeRecord(path: string, record: ActorRecord): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(record));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

const pidLike = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 1;

/** Reads and checks a record; throws on anything malformed. */
function readRecord(path: string): ActorRecord {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ActorRecord;
  const ok =
    raw?.v === ACTOR_RECORD_VERSION &&
    pidLike(raw.pid) &&
    pidLike(raw.pgid) &&
    typeof raw.startedAt === 'string' &&
    !Number.isNaN(Date.parse(raw.startedAt)) &&
    Number.isSafeInteger(raw.pendingSpawns) &&
    raw.pendingSpawns >= 0 &&
    Array.isArray(raw.groups) &&
    raw.groups.every((g) => pidLike(g?.pgid) && Number.isSafeInteger(g.spawnedAfterMs) && Number.isSafeInteger(g.spawnedBeforeMs) && g.spawnedAfterMs <= g.spawnedBeforeMs) &&
    Array.isArray(raw.commands) &&
    raw.commands.every((c) => Number.isSafeInteger(c?.id) && Number.isSafeInteger(c.startedAfterMs) && typeof c.file === 'string');
  if (!ok) throw new Error(`actor record ${path} is malformed`);
  return raw;
}

/** This worker's record, kept current as it spawns and reaps children. */
export class ActorRegistry {
  readonly path: string;
  private record: ActorRecord;
  /** Set once the record could not be kept current: from then on nothing is spawned. */
  private broken: Error | undefined;
  private commandIds = 0;

  private constructor(path: string, record: ActorRecord) {
    this.path = path;
    this.record = record;
  }

  /** Writes this process's record; call before the daemon can start any task. */
  static create(dir: string, options: { probe?: ProcessProbe; pid?: number } = {}): ActorRegistry {
    const probe = options.probe ?? systemProbe;
    const pid = options.pid ?? process.pid;
    const startedAt = probe.startedAt(pid);
    if (startedAt === undefined) throw new Error(`cannot read this process's start time (pid ${pid})`);
    const pgid = probe.groupOf(pid);
    if (pgid === undefined) throw new Error(`cannot read this process's group (pid ${pid})`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record: ActorRecord = { v: ACTOR_RECORD_VERSION, pid, pgid, startedAt, pendingSpawns: 0, groups: [], commands: [] };
    const path = join(dir, recordName(pid, startedAt));
    writeRecord(path, record);
    return new ActorRegistry(path, record);
  }

  get current(): Readonly<ActorRecord> {
    return this.record;
  }

  /** Whether the record has stopped being kept current; a verifier will then never prove this worker stopped. */
  get failure(): Error | undefined {
    return this.broken;
  }

  /**
   * A spawner that announces each spawn before it happens and records the
   * child's group in the same write that ends the announcement. The group is
   * dropped once the spawner reports the whole group gone. When any of this
   * cannot be written, the announcement or the group stays on disk: the
   * record then proves nothing, which is the safe side.
   */
  wrap(spawn: LineProcessSpawner, now: () => number = Date.now): LineProcessSpawner {
    return (file, args, env) => {
      if (this.broken) throw new Error(`not starting ${file}: the actor record cannot be kept (${this.broken.message})`);
      this.update((r) => ({ ...r, pendingSpawns: r.pendingSpawns + 1 }));
      const spawnedAfterMs = now();
      const child = spawn(file, args, env);
      const spawnedBeforeMs = now();
      const pgid = child.pid;
      if (pgid === undefined) {
        // Not started as far as node knows; the spawner confirms it by resolving exited().
        child.exited().then(
          () => this.tryUpdate((r) => ({ ...r, pendingSpawns: r.pendingSpawns - 1 })),
          () => undefined, // unconfirmed: the announcement stays
        );
        return child;
      }
      const group: ActorGroup = { pgid, spawnedAfterMs, spawnedBeforeMs, file };
      this.tryUpdate((r) => ({ ...r, pendingSpawns: r.pendingSpawns - 1, groups: [...r.groups, group] }));
      // exited() resolves only once the whole group is confirmed gone.
      child.exited().then(
        () => this.tryUpdate((r) => ({ ...r, groups: r.groups.filter((g) => !(g.pgid === pgid && g.spawnedAfterMs === spawnedAfterMs)) })),
        () => undefined, // unconfirmed: the group stays on record
      );
      return child;
    };
  }

  /**
   * A command runner that keeps each command announced in the record while
   * it runs. The runner settles only once its child has exited, so a
   * command still announced after a crash may still be running.
   */
  wrapRunner(run: CommandRunner, now: () => number = Date.now): CommandRunner {
    return async (file, args, options) => {
      if (this.broken) throw new Error(`not running ${file}: the actor record cannot be kept (${this.broken.message})`);
      const command: ActorCommand = { id: ++this.commandIds, file, startedAfterMs: now() };
      this.update((r) => ({ ...r, commands: [...r.commands, command] }));
      try {
        return await run(file, args, options);
      } finally {
        this.tryUpdate((r) => ({ ...r, commands: r.commands.filter((c) => c.id !== command.id) }));
      }
    };
  }

  /** Refreshes the record's mtime while the worker lives, bounding when it can have started anything. */
  startHeartbeat(): () => void {
    const timer = setInterval(() => {
      try {
        const at = new Date();
        utimesSync(this.path, at, at);
      } catch (error) {
        this.broken ??= error instanceof Error ? error : new Error(String(error));
      }
    }, HEARTBEAT_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** At a clean exit, after every child was reaped: nothing spawned by this worker acts any more. */
  close(): void {
    if (this.record.groups.length > 0 || this.record.commands.length > 0 || this.record.pendingSpawns > 0 || this.broken) return;
    this.tryUpdate((r) => ({ ...r, closedAt: new Date().toISOString() }));
  }

  private update(change: (record: ActorRecord) => ActorRecord): void {
    const next = change(this.record);
    writeRecord(this.path, next);
    this.record = next;
  }

  private tryUpdate(change: (record: ActorRecord) => ActorRecord): void {
    try {
      this.update(change);
    } catch (error) {
      this.broken ??= error instanceof Error ? error : new Error(String(error));
    }
  }
}

/** The record of exactly this worker (pid and recorded start); undefined when none was written. Throws on a malformed or mismatched one. */
export function findRecord(dir: string, pid: number, startedAt: string): { path: string; record: ActorRecord } | undefined {
  if (Number.isNaN(Date.parse(startedAt))) throw new Error(`unreadable start time ${JSON.stringify(startedAt)}`);
  const path = join(dir, recordName(pid, startedAt));
  try {
    statSync(path);
  } catch {
    return undefined;
  }
  const record = readRecord(path);
  if (record.pid !== pid || record.startedAt !== startedAt) throw new Error(`actor record ${path} does not match worker ${pid} started ${startedAt}`);
  return { path, record };
}

/** Whether a leader start (ps, whole seconds) can be the process spawned in the recorded window. */
function startedInWindow(start: string, group: ActorGroup): boolean {
  const ms = Date.parse(start);
  // ps truncates: the true start is in [ms, ms + 1000).
  return ms + 1000 > group.spawnedAfterMs && ms <= group.spawnedBeforeMs;
}

/**
 * Proves every actor of a worker has exited, stopping the recorded groups
 * whose leader it can identify. Only for a worker recorded with its start
 * time; a legacy or unidentified worker is never declared stopped.
 */
export async function verifyWorkerStopped(
  dir: string,
  worker: Pick<WorkerRecord, 'ownerPid' | 'processStartedAt' | 'legacy'>,
  options: { probe?: ProcessProbe; killGraceMs?: number; signal?: AbortSignal } = {},
): Promise<ActorExitVerdict> {
  const probe = options.probe ?? systemProbe;
  const killGraceMs = options.killGraceMs ?? 3_000;
  if (worker.legacy || !worker.processStartedAt)
    return { stopped: false, reason: `worker pid ${worker.ownerPid} has no recorded start time; its processes cannot be identified` };
  let found: ReturnType<typeof findRecord>;
  try {
    found = findRecord(dir, worker.ownerPid, worker.processStartedAt);
  } catch (error) {
    return { stopped: false, reason: (error as Error).message };
  }
  if (!found) return { stopped: false, reason: `no actor record for worker pid ${worker.ownerPid} started ${worker.processStartedAt}` };
  const { record } = found;
  const evidence: string[] = [];

  // The worker itself: while it lives it is the owner, whatever its lease says.
  try {
    const now = probe.startedAt(record.pid);
    if (now === record.startedAt) return { stopped: false, reason: `worker pid ${record.pid} is still running` };
    evidence.push(now === undefined ? `worker ${record.pid} exited` : `worker ${record.pid} exited (pid now another process)`);
  } catch (error) {
    return { stopped: false, reason: `cannot identify worker pid ${record.pid}: ${(error as Error).message}` };
  }
  if (record.pgid !== record.pid) return { stopped: false, reason: `worker ${record.pid} shared process group ${record.pgid}; its commands cannot be told apart` };
  if (record.pendingSpawns > 0) return { stopped: false, reason: `worker ${record.pid} died while starting a child; that child's group is unknown` };

  // Its own group holds the 2ndscreen commands it ran. With its leader gone
  // it cannot be tied to the record, so it can only be waited out, never stopped.
  const own = probe.group(record.pgid);
  if (own !== 'gone') return { stopped: false, reason: `worker group ${record.pgid} is ${own === 'alive' ? 'not empty' : 'unreadable'}; waiting for its commands to end` };
  evidence.push(`worker group ${record.pgid} empty`);

  // Commands that were under way: never signalled, only waited out.
  if (record.commands.length > 0) {
    let lastAliveMs: number;
    try {
      lastAliveMs = statSync(found.path).mtimeMs + 2 * HEARTBEAT_MS;
    } catch (error) {
      return { stopped: false, reason: `cannot read the actor record's heartbeat: ${(error as Error).message}` };
    }
    const left: number[] = [];
    for (const file of new Set(record.commands.map((c) => c.file))) {
      const fromMs = Math.min(...record.commands.filter((c) => c.file === file).map((c) => c.startedAfterMs));
      const found = probe.orphanLeaders(file, fromMs, lastAliveMs);
      if (found === undefined) return { stopped: false, reason: 'cannot list processes to look for its commands' };
      left.push(...found);
    }
    if (left.length > 0) return { stopped: false, reason: `${record.commands.length} command(s) were under way; orphaned processes from that time still run (pid ${left.join(', ')})` };
    evidence.push(`no orphaned process from its ${record.commands.length} unfinished command(s) runs`);
  }

  for (const group of record.groups) {
    if (options.signal?.aborted) return { stopped: false, reason: 'verification was cancelled' };
    const verdict = await stopGroup(group, probe, killGraceMs);
    if (!verdict.ok) return { stopped: false, reason: verdict.text };
    evidence.push(verdict.text);
  }
  if (record.closedAt) evidence.push(`record closed at ${record.closedAt}`);
  return { stopped: true, evidence: evidence.join('; ') };
}

async function stopGroup(group: ActorGroup, probe: ProcessProbe, killGraceMs: number): Promise<{ ok: boolean; text: string }> {
  const what = `${group.file} group ${group.pgid}`;
  const state = probe.group(group.pgid);
  if (state === 'gone') return { ok: true, text: `${what} gone` };
  if (state === 'unknown') return { ok: false, text: `${what} is unreadable` };
  let leader: string | undefined;
  try {
    leader = probe.startedAt(group.pgid);
  } catch (error) {
    return { ok: false, text: `cannot identify the leader of ${what}: ${(error as Error).message}` };
  }
  if (leader === undefined) return { ok: false, text: `${what} has members but no leader; they cannot be tied to the record` };
  if (!startedInWindow(leader, group)) {
    // A pid is not reused while its group has members: a leader started
    // after the recorded spawn means the recorded group had ended.
    if (Date.parse(leader) > group.spawnedBeforeMs) return { ok: true, text: `${what} gone (the id now leads a later process)` };
    return { ok: false, text: `${what} is led by a process that started before the recorded spawn` };
  }
  // The recorded leader is alive: stop its group and watch it go.
  probe.killGroup(group.pgid, 'SIGTERM');
  const deadline = Date.now() + killGraceMs;
  while (probe.group(group.pgid) === 'alive' && Date.now() < deadline) await probe.sleep(50);
  for (let i = 0; i < 40 && probe.group(group.pgid) === 'alive'; i++) {
    probe.killGroup(group.pgid, 'SIGKILL');
    await probe.sleep(50);
  }
  const after = probe.group(group.pgid);
  if (after !== 'gone') return { ok: false, text: `${what} ${after === 'alive' ? 'would not stop' : 'is unreadable after stopping'}` };
  return { ok: true, text: `${what} stopped by this daemon` };
}

/** Drops records of workers that closed cleanly more than `olderThanMs` ago; unreadable ones stay. */
export function pruneClosedRecords(dir: string, olderThanMs: number, now: number = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^\d+-\d+\.json$/.test(name)) continue;
    const path = join(dir, name);
    try {
      const record = readRecord(path);
      if (record.closedAt && now - statSync(path).mtimeMs > olderThanMs) rmSync(path, { force: true });
    } catch {
      // Unreadable records stay: they may be all that proves an actor exists.
    }
  }
}

/** Workers with a record that are running now (same pid and start) and have not closed. */
export function liveWorkers(dir: string): ActorRecord[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const live: ActorRecord[] = [];
  for (const name of names) {
    if (!/^\d+-\d+\.json$/.test(name)) continue;
    try {
      const record = readRecord(join(dir, name));
      if (!record.closedAt && processIdentity(record.pid, record.startedAt) === 'alive') live.push(record);
    } catch {
      // Not a live worker we can identify.
    }
  }
  return live;
}
