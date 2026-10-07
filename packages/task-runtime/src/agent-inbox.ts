// Where approvals and questions wait for a person, across processes (RFC
// 0001 §6, §7). The process hosting agents writes each request as a file
// under <tasksDir>/agents/inbox/pending; `2ndscreen task approve|deny|answer`
// (or the MCP tools, or the Agent Desktop UI) writes the decision under
// answers/; the host polls for it, passes it to the agent, and removes both.
// Files are private to the user and written atomically.
//
// The approver and asker here implement the host's Approver and Asker, so a
// host gets a person in the loop without any UI of its own.

import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { APPROVAL_HINTS, type ApprovalHint } from './agent-contracts.ts';
import type { ApprovalDecision, ApprovalRequest, Approver, Asker, UserQuestion } from './agent-host.ts';
import { RuntimeError, systemClock, type Clock } from './contracts.ts';

export interface InboxPaths {
  dir: string;
  pending: string;
  answers: string;
}

/** Under the agent data directory (agent-ledgers.ts agentDataPaths().dir). */
export function inboxPaths(agentDataDir: string): InboxPaths {
  const dir = join(agentDataDir, 'inbox');
  return { dir, pending: join(dir, 'pending'), answers: join(dir, 'answers') };
}

export type InboxEntry =
  | { kind: 'approval'; id: string; createdAt: string; request: ApprovalRequest }
  | { kind: 'question'; id: string; createdAt: string; question: UserQuestion };

export type InboxAnswer =
  | { kind: 'approval'; decision: 'grant' }
  | { kind: 'approval'; decision: 'deny'; guidance?: { text?: string; hints: ApprovalHint[] } }
  | { kind: 'question'; answer: string };

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function prepare(paths: InboxPaths): void {
  for (const dir of [paths.dir, paths.pending, paths.answers]) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

const fileOf = (dir: string, id: string) => join(dir, `${id}.json`);

/** What waits for a person, oldest first. Unreadable files are skipped. */
export function listInbox(paths: InboxPaths): InboxEntry[] {
  let names: string[];
  try {
    names = readdirSync(paths.pending);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => readJson<InboxEntry>(join(paths.pending, n)))
    .filter((e): e is InboxEntry => e !== undefined && (e.kind === 'approval' || e.kind === 'question') && typeof e.id === 'string')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * Record a person's decision for one pending entry. Checked against the
 * entry: the kind must match, an answer must be one of the choices offered,
 * and an entry can be decided once.
 */
export function decide(paths: InboxPaths, id: string, answer: InboxAnswer): InboxEntry {
  if (!ID.test(id)) throw new RuntimeError('invalid_input', 'the inbox id is not valid');
  const entry = readJson<InboxEntry>(fileOf(paths.pending, id));
  if (!entry) throw new RuntimeError('not_found', `nothing in the inbox under ${id}`);
  if (entry.kind !== answer.kind) throw new RuntimeError('invalid_input', `${id} is a${entry.kind === 'approval' ? 'n approval' : ' question'}, not a${answer.kind === 'approval' ? 'n approval' : ' question'}`);
  if (answer.kind === 'question') {
    const choices = entry.kind === 'question' ? entry.question.choices : undefined;
    if (answer.answer.trim() === '') throw new RuntimeError('invalid_input', 'the answer is empty');
    if (choices && !choices.includes(answer.answer)) throw new RuntimeError('invalid_input', `the answer must be one of: ${choices.join(', ')}`, { choices });
  }
  if (answer.kind === 'approval' && answer.decision === 'deny' && answer.guidance)
    for (const hint of answer.guidance.hints) if (!APPROVAL_HINTS.includes(hint)) throw new RuntimeError('invalid_input', `${hint} is not one of ${APPROVAL_HINTS.join(', ')}`);
  const target = fileOf(paths.answers, id);
  if (readJson(target) !== undefined) throw new RuntimeError('conflict', `${id} is already decided`);
  prepare(paths);
  writeAtomic(target, answer);
  return entry;
}

/** Wait for the answer to one pending entry; the entry and its answer are removed once read or abandoned. */
async function await_<T extends InboxAnswer>(paths: InboxPaths, entry: InboxEntry, pollMs: number, signal: AbortSignal): Promise<T> {
  prepare(paths);
  const pendingFile = fileOf(paths.pending, entry.id);
  const answerFile = fileOf(paths.answers, entry.id);
  writeAtomic(pendingFile, entry);
  const cleanup = () => {
    rmSync(pendingFile, { force: true });
    rmSync(answerFile, { force: true });
  };
  try {
    for (;;) {
      if (signal.aborted) throw new RuntimeError('cancelled', 'no longer waiting');
      const answer = readJson<InboxAnswer>(answerFile);
      if (answer && answer.kind === entry.kind) return answer as T;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, pollMs);
        function done() {
          signal.removeEventListener('abort', done);
          clearTimeout(timer);
          resolve();
        }
        signal.addEventListener('abort', done, { once: true });
      });
    }
  } finally {
    cleanup();
  }
}

export interface InboxOptions {
  paths: InboxPaths;
  /** How often the answer file is looked for; default 500 ms. */
  pollMs?: number;
  clock?: Clock;
  newId?: () => string;
  /** Told when a request lands in the inbox, e.g. to show a notification. */
  onPending?: (entry: InboxEntry) => void;
}

const entryId = (newId: () => string) => newId().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'x';

export function createInboxApprover(options: InboxOptions): Approver {
  const clock = options.clock ?? systemClock;
  const newId = options.newId ?? (() => crypto.randomUUID());
  return {
    async request(request, signal): Promise<ApprovalDecision> {
      const entry: InboxEntry = { kind: 'approval', id: entryId(newId), createdAt: clock.now().toISOString(), request };
      const waiting = await_<Extract<InboxAnswer, { kind: 'approval' }>>(options.paths, entry, options.pollMs ?? 500, signal);
      options.onPending?.(entry);
      const answer = await waiting;
      return answer.decision === 'grant' ? { decision: 'grant' } : { decision: 'deny', ...(answer.guidance && { guidance: answer.guidance }) };
    },
  };
}

export function createInboxAsker(options: InboxOptions): Asker {
  const clock = options.clock ?? systemClock;
  const newId = options.newId ?? (() => crypto.randomUUID());
  return {
    async ask(question, signal): Promise<string> {
      const entry: InboxEntry = { kind: 'question', id: entryId(newId), createdAt: clock.now().toISOString(), question };
      const waiting = await_<Extract<InboxAnswer, { kind: 'question' }>>(options.paths, entry, options.pollMs ?? 500, signal);
      options.onPending?.(entry);
      return (await waiting).answer;
    },
  };
}

/** One line per entry for a person: id, what, which agent, and the computed consequences of an approval. */
export function formatInbox(entries: readonly InboxEntry[]): string[] {
  if (entries.length === 0) return ['inbox is empty'];
  return entries.map((e) => {
    if (e.kind === 'question') {
      const q = e.question;
      return `${e.id}  问题  ${q.agentId}  ${q.taskId}  ${q.message}${q.choices ? `（${q.choices.join(' / ')}）` : ''}`;
    }
    const r = e.request;
    const c = r.consequences;
    const facts = [
      `今日已用 ${c.usedInWindow}${c.remainingInWindow !== undefined ? `，剩 ${c.remainingInWindow}` : ''}`,
      ...(c.msSinceLast !== undefined ? [`距上次 ${Math.round(c.msSinceLast / 1000)} 秒`] : []),
      ...(c.targetHadUnknownResult ? ['该目标有过结果不明的外发'] : []),
      ...(c.inWorkHours ? [] : ['不在工作时段']),
    ];
    return `${e.id}  审批  ${r.agentId}  ${r.taskId}  ${r.summary}  [${c.application} · ${c.accountKey} · ${facts.join('，')}]`;
  });
}
