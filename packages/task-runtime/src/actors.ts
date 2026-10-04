// Which processes can still act for a task worker, kept on disk so that a
// later daemon can prove they are all gone before it hands the task on.
//
// A worker runs in its own process group (spawnDetachedWorker), so the
// 2ndscreen commands it runs (A1's execFile) share its group. The exploration
// bridge and the vision helper start through the LineProcessSpawner, each
// in a new process group of its own that outlives the worker if the worker
// dies. Every such group is written to the worker's record before the spawn
// returns, and the spawn itself is announced first, so a worker killed at
// any point leaves either the group or an unfinished spawn on record — never
// a child nobody knows about.
//
// verify() answers whether every actor of a dead worker is gone. It kills
// only groups it can tie to the record: a leader with the recorded start
// time, or a group whose leader has exited (a pid cannot be reused as a
// process group id while that group has members). Anything it cannot read
// or prove stays "not stopped".

import { execFile } from 'node:child_process';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { LineProcessSpawner } from './contracts.ts';

export const ACTOR_RECORD_VERSION = 1;

/** One process group that may act for the worker. */
export interface ActorGroup {
  /** Process group id; its leader's pid. */
  pgid: number;
  /** When the leader was started, ms since the epoch, as seen by the worker at spawn. */
  spawnedAtMs: number;
  /** What it is, for the log. */
  file: string;
}

export interface ActorRecord {
  v: typeof ACTOR_RECORD_VERSION;
  /** The worker. */
  pid: number;
  /** Its process group; equal to pid when it was started detached. */
  pgid: number;
  /** The worker's start, `ps -o lstart` as ms since the epoch. */
  startedAtMs: number;
  /** Spawns begun whose group is not written yet. Non-zero after a crash means: cannot prove. */
  pendingSpawns: number;
  groups: ActorGroup[];
  /** Written last at a clean exit, after every group was confirmed gone. */
  closedAt?: string;
}

/** Facts about processes, injected for tests. */
export interface ProcessProbe {
  /** Start of `pid` in ms since the epoch, undefined when there is no such process, throws when unknown. */
  startedAtMs(pid: number): Promise<number | undefined>;
  /** Whether any process is in group `pgid`. */
  groupAlive(pgid: number): boolean;
  /** Signal every process of group `pgid`. */
  killGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  sleep(ms: number): Promise<void>;
}

/** `ps -o lstart=` has whole seconds; a start this close to the record is the same process. */
const START_TOLERANCE_MS = 2_000;

export const systemProbe: ProcessProbe = {
  startedAtMs: (pid) =>
    new Promise((resolve, reject) => {
      if (!Number.isSafeInteger(pid) || pid <= 1) return resolve(undefined);
      execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: { LC_ALL: 'C', TZ: process.env.TZ ?? '' } }, (error, stdout) => {
        const text = stdout.trim();
        // ps exits 1 with no output when the pid does not exist.
        if (error && text === '' && (error as { code?: unknown }).code === 1) return resolve(undefined);
        if (error) return reject(error);
        const ms = Date.parse(text);
        if (Number.isNaN(ms)) return reject(new Error(`cannot read the start of pid ${pid}: ${JSON.stringify(text)}`));
        resolve(ms);
      });
    }),
  groupAlive: (pgid) => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      // EPERM: members exist that we may not signal.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  killGroup: (pgid, signal) => {
    try {
      process.kill(-pgid, signal);
    } catch {
      // Gone already.
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const recordName = (pid: number, startedAtMs: number) => `${pid}-${startedAtMs}.json`;

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

function readRecord(path: string): ActorRecord {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ActorRecord;
  const int = (v: unknown) => Number.isSafeInteger(v);
  if (raw?.v !== ACTOR_RECORD_VERSION || !int(raw.pid) || !int(raw.pgid) || !int(raw.startedAtMs) || !int(raw.pendingSpawns) || !Array.isArray(raw.groups)
    || raw.groups.some((g) => !int(g?.pgid) || !int(g?.spawnedAtMs)))
    throw new Error(`actor record ${path} is not readable`);
  return raw;
}

/** This worker's record, kept current as it spawns and reaps children. */
export class ActorRegistry {
  readonly path: string;
  private record: ActorRecord;

  private constructor(path: string, record: ActorRecord) {
    this.path = path;
    this.record = record;
  }

  /** Writes the record of this process; call before the daemon can start any task. */
  static async create(dir: string, options: { probe?: ProcessProbe; pid?: number; pgid?: number } = {}): Promise<ActorRegistry> {
    const probe = options.probe ?? systemProbe;
    const pid = options.pid ?? process.pid;
    const startedAtMs = await probe.startedAtMs(pid);
    if (startedAtMs === undefined) throw new Error(`cannot read this process's start time (pid ${pid})`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const pgid = options.pgid ?? (await processGroupOf(pid));
    const record: ActorRecord = { v: ACTOR_RECORD_VERSION, pid, pgid, startedAtMs, pendingSpawns: 0, groups: [] };
    const path = join(dir, recordName(pid, startedAtMs));
    writeRecord(path, record);
    return new ActorRegistry(path, record);
  }

  get current(): Readonly<ActorRecord> {
    return this.record;
  }

  /** A spawner that records each child's group before handing it back, and drops it once confirmed gone. */
  wrap(spawn: LineProcessSpawner, now: () => number = Date.now): LineProcessSpawner {
    return (file, args, env) => {
      this.update((r) => ({ ...r, pendingSpawns: r.pendingSpawns + 1 }));
      const spawnedAtMs = now();
      let child: ReturnType<LineProcessSpawner>;
      try {
        child = spawn(file, args, env);
      } catch (error) {
        this.update((r) => ({ ...r, pendingSpawns: r.pendingSpawns - 1 }));
        throw error;
      }
      const pgid = child.pid;
      this.update((r) => ({
        ...r,
        pendingSpawns: r.pendingSpawns - 1,
        groups: pgid === undefined ? r.groups : [...r.groups, { pgid, spawnedAtMs, file }],
      }));
      if (pgid !== undefined) {
        // The spawner resolves exited() only once the whole group is gone.
        void child.exited().then(() => this.update((r) => ({ ...r, groups: r.groups.filter((g) => !(g.pgid === pgid && g.spawnedAtMs === spawnedAtMs)) })));
      }
      return child;
    };
  }

  /** At a clean exit, after every child was reaped: nothing of this worker acts any more. */
  close(): void {
    if (this.record.groups.length > 0 || this.record.pendingSpawns > 0) return;
    this.update((r) => ({ ...r, closedAt: new Date().toISOString() }));
  }

  private update(change: (record: ActorRecord) => ActorRecord): void {
    this.record = change(this.record);
    writeRecord(this.path, this.record);
  }
}

async function processGroupOf(pid: number): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], (error, stdout) => {
      const pgid = Number(stdout.trim());
      if (error || !Number.isSafeInteger(pgid) || pgid <= 0) reject(new Error(`cannot read the process group of pid ${pid}`));
      else resolve(pgid);
    });
  });
}

export type ActorExitVerdict = { stopped: true; evidence: string } | { stopped: false; reason: string };

/** The record of the worker with this pid and start, if one was written. */
export function findRecord(dir: string, pid: number, startedAtMs: number | undefined): { path: string; record: ActorRecord } | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const match = /^(\d+)-(\d+)\.json$/.exec(name);
    if (!match || Number(match[1]) !== pid) continue;
    if (startedAtMs !== undefined && Math.abs(Number(match[2]) - startedAtMs) > START_TOLERANCE_MS) continue;
    const path = join(dir, name);
    return { path, record: readRecord(path) };
  }
  return undefined;
}

/**
 * Proves every actor of a worker has exited, stopping the groups it can tie
 * to the record. `startedAtMs` is the worker's start as the daemon recorded
 * it (undefined when unknown: then the record must be the only one for pid).
 */
export async function verifyWorkerStopped(
  dir: string,
  worker: { pid: number; startedAtMs?: number },
  options: { probe?: ProcessProbe; killGraceMs?: number; signal?: AbortSignal } = {},
): Promise<ActorExitVerdict> {
  const probe = options.probe ?? systemProbe;
  const killGraceMs = options.killGraceMs ?? 3_000;
  let found: ReturnType<typeof findRecord>;
  try {
    found = findRecord(dir, worker.pid, worker.startedAtMs);
  } catch (error) {
    return { stopped: false, reason: (error as Error).message };
  }
  if (!found) return { stopped: false, reason: `no actor record for worker pid ${worker.pid}; cannot tell what it started` };
  const { record } = found;
  const evidence: string[] = [];

  // The worker itself: a live worker is still the owner, whatever its lease says.
  let start: number | undefined;
  try {
    start = await probe.startedAtMs(record.pid);
  } catch (error) {
    return { stopped: false, reason: `cannot read pid ${record.pid}: ${(error as Error).message}` };
  }
  if (start !== undefined && Math.abs(start - record.startedAtMs) <= START_TOLERANCE_MS)
    return { stopped: false, reason: `worker pid ${record.pid} is still running` };
  evidence.push(start === undefined ? `worker ${record.pid} exited` : `worker ${record.pid} exited (pid reused)`);
  if (record.closedAt) return { stopped: true, evidence: [...evidence, `closed cleanly at ${record.closedAt}`].join('; ') };
  if (record.pendingSpawns > 0) return { stopped: false, reason: `worker ${record.pid} died while starting a child; its group is unknown` };

  // Its own group (the 2ndscreen commands it ran), then each spawned group.
  const groups: Array<{ pgid: number; leaderStartMs?: number; what: string }> = [];
  if (record.pgid === record.pid) groups.push({ pgid: record.pgid, what: `worker group ${record.pgid}` });
  else evidence.push(`worker shared group ${record.pgid}; its own commands end with it`);
  for (const g of record.groups) groups.push({ pgid: g.pgid, leaderStartMs: g.spawnedAtMs, what: `${g.file} group ${g.pgid}` });

  for (const group of groups) {
    options.signal?.throwIfAborted();
    const verdict = await stopGroup(group, probe, killGraceMs);
    if (!verdict.ok) return { stopped: false, reason: verdict.text };
    evidence.push(verdict.text);
  }
  return { stopped: true, evidence: evidence.join('; ') };
}

async function stopGroup(
  group: { pgid: number; leaderStartMs?: number; what: string },
  probe: ProcessProbe,
  killGraceMs: number,
): Promise<{ ok: boolean; text: string }> {
  if (!probe.groupAlive(group.pgid)) return { ok: true, text: `${group.what} gone` };
  // Members remain. Is it still the recorded group?
  let leader: number | undefined;
  try {
    leader = await probe.startedAtMs(group.pgid);
  } catch (error) {
    return { ok: false, text: `cannot read ${group.what}: ${(error as Error).message}` };
  }
  if (leader !== undefined) {
    const known = group.leaderStartMs;
    // A live leader started at another time is another process: the recorded
    // group had to end before its pid could lead a group again.
    if (known === undefined) return { ok: false, text: `${group.what} has a live leader the record cannot identify` };
    if (Math.abs(leader - known) > START_TOLERANCE_MS) return { ok: true, text: `${group.what} gone (pid reused)` };
  }
  // The recorded group, leader alive or not: stop it and see it go.
  probe.killGroup(group.pgid, 'SIGTERM');
  const deadline = Date.now() + killGraceMs;
  while (probe.groupAlive(group.pgid) && Date.now() < deadline) await probe.sleep(50);
  for (let i = 0; i < 20 && probe.groupAlive(group.pgid); i++) {
    probe.killGroup(group.pgid, 'SIGKILL');
    await probe.sleep(50);
  }
  if (probe.groupAlive(group.pgid)) return { ok: false, text: `${group.what} would not stop` };
  return { ok: true, text: `${group.what} stopped by this daemon` };
}

/** Drops records of workers that closed cleanly more than `olderThanMs` ago. */
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
