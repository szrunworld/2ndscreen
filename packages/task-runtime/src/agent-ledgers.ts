// Two append-only ledgers the agent host writes, as JSON lines in files
// only the user can read.
//
// - Effect uses: what counts against the limits of RFC 0001 §7. They must
//   outlive the process, or a restart would reset a day's quota. Reading is
//   fail-closed: a line that cannot be read stops the check instead of
//   being skipped, because skipping it would undercount.
// - Provider usage: every provider call, attributed to the agent, task and
//   run that made it, with tokens and, when a price is known, the cost
//   (after nasiko's per-agent cost attribution). Unknown token counts stay
//   unknown; they are never added up as zero.

import { appendFileSync, chmodSync, closeSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RuntimeError, addTokens, type TokenCount, type UsageGroupBy } from './contracts.ts';
import type { ProviderPurpose } from './agent-contracts.ts';
import type { EffectLedger, EffectUse } from './agent-host.ts';

// ---------------------------------------------------------------------------
// Where they live

export interface AgentDataPaths {
  /** <tasksDir>/agents, private like the rest of the runtime's data. */
  dir: string;
  /** The status board's snapshot (agent-status.ts). */
  status: string;
  effects: string;
  usage: string;
  /** Optional PriceTable, as JSON, that `task usage` prices calls with. */
  prices: string;
}

export function agentDataPaths(tasksDir: string): AgentDataPaths {
  const dir = join(tasksDir, 'agents');
  return { dir, status: join(dir, 'status.json'), effects: join(dir, 'effects.jsonl'), usage: join(dir, 'provider-usage.jsonl'), prices: join(dir, 'prices.json') };
}

/** Creates the agent data directory readable by the user alone, tightening it if it exists (like preparePrivateDirs). */
export function prepareAgentDataDir(paths: AgentDataPaths): void {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
}

/** The price table, or none when the file is missing. A file that is there but unreadable is an error. */
export function readPriceTable(path: string): PriceTable {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new RuntimeError('io', `cannot read ${path}`);
  }
  const raw = JSON.parse(text) as unknown;
  const ok = (p: unknown): p is Price => {
    const v = p as Partial<Price> | null;
    return typeof v === 'object' && v !== null && typeof v.currency === 'string' && typeof v.inputPerMTok === 'number' && v.inputPerMTok >= 0 && typeof v.outputPerMTok === 'number' && v.outputPerMTok >= 0;
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !Object.values(raw).every(ok))
    throw new RuntimeError('invalid_input', `${path} must map provider or provider/model to { currency, inputPerMTok, outputPerMTok }`);
  return raw as PriceTable;
}

// ---------------------------------------------------------------------------
// JSON lines

function readLines(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new RuntimeError('io', `cannot read ${path}`);
  }
  const lines = text.split('\n');
  // A last line with no newline is a write cut short by a crash: not a record.
  if (!text.endsWith('\n')) lines.pop();
  return lines.filter((l) => l !== '');
}

/**
 * Append one record. A last line without its newline is what a crash in the
 * middle of a write leaves; it was never a record, so it is cut off first
 * rather than joined to the next one, which would make a bad line that
 * fail-closed readers stop at for good. Each ledger has one writer at a
 * time (the process hosting the agents), so the tail is never someone
 * else's write in progress. The use a crash cut short goes uncounted, as
 * does one whose action was sent just before a crash and never recorded.
 */
function append(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r+');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new RuntimeError('io', `cannot open ${path}`);
  }
  if (fd !== undefined) {
    try {
      const { size } = fstatSync(fd);
      if (size > 0) {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) {
          // Find where the unfinished line starts, reading backwards in chunks.
          let end = size;
          let keep = 0;
          const chunk = Buffer.alloc(4096);
          while (end > 0) {
            const from = Math.max(0, end - chunk.length);
            const n = readSync(fd, chunk, 0, end - from, from);
            const at = chunk.subarray(0, n).lastIndexOf(0x0a);
            if (at >= 0) {
              keep = from + at + 1;
              break;
            }
            end = from;
          }
          ftruncateSync(fd, keep);
        }
      }
    } finally {
      closeSync(fd);
    }
  }
  appendFileSync(path, JSON.stringify(record) + '\n', { mode: 0o600 });
}

/** Replace a ledger's contents atomically. */
function rewrite<T>(path: string, records: readonly T[]): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    for (const r of records) writeSync(fd, JSON.stringify(r) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

// ---------------------------------------------------------------------------
// Effect uses

const isEffectUse = (v: unknown): v is EffectUse => {
  const u = v as Partial<EffectUse> | null;
  return (
    typeof u === 'object' &&
    u !== null &&
    typeof u.agentId === 'string' &&
    typeof u.taskId === 'string' &&
    typeof u.application === 'string' &&
    typeof u.accountKey === 'string' &&
    typeof u.effect === 'string' &&
    typeof u.at === 'string' &&
    !Number.isNaN(Date.parse(u.at)) &&
    typeof u.status === 'string'
  );
};

export interface FileEffectLedger extends EffectLedger {
  /** Drop uses older than `before`; they no longer count against any window. Returns how many were dropped. */
  compact(before: string): Promise<number>;
}

export function createFileEffectLedger(path: string): FileEffectLedger {
  const all = (): EffectUse[] =>
    readLines(path).map((line, i) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        value = undefined;
      }
      if (!isEffectUse(value)) throw new RuntimeError('io', `${path} line ${i + 1} is not an effect use; refusing to count limits without it`);
      return value;
    });
  return {
    async uses(q) {
      const since = Date.parse(q.since);
      return all().filter((u) => u.application === q.application && u.accountKey === q.accountKey && u.effect === q.effect && Date.parse(u.at) >= since);
    },
    async record(use) {
      append(path, use);
    },
    async compact(before) {
      const cutoff = Date.parse(before);
      const records = all();
      const kept = records.filter((u) => Date.parse(u.at) >= cutoff);
      if (kept.length !== records.length) rewrite(path, kept);
      return records.length - kept.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Provider usage

export interface ProviderUsageRecord {
  at: string;
  agentId: string;
  runId: string;
  taskId?: string;
  providerId: string;
  /** The model the provider used, when it says; keys the price. */
  model?: string;
  purpose: ProviderPurpose;
  ok: boolean;
  inputTokens: TokenCount;
  outputTokens: TokenCount;
  latencyMs: number;
}

export interface Price {
  currency: string;
  /** Per million tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Prices by `providerId/model`, or by `providerId` for any model of it. */
export type PriceTable = Readonly<Record<string, Price>>;

export function priceOf(table: PriceTable, record: Pick<ProviderUsageRecord, 'providerId' | 'model'>): Price | undefined {
  return (record.model !== undefined ? table[`${record.providerId}/${record.model}`] : undefined) ?? table[record.providerId];
}

/** The cost of one call, or undefined when a token count or the price is unknown. */
export function costOf(table: PriceTable, record: ProviderUsageRecord): { currency: string; amount: number } | undefined {
  const price = priceOf(table, record);
  if (!price || record.inputTokens === 'unknown' || record.outputTokens === 'unknown') return undefined;
  return { currency: price.currency, amount: (record.inputTokens * price.inputPerMTok + record.outputTokens * price.outputPerMTok) / 1_000_000 };
}

export interface ProviderUsageLedger {
  record(record: ProviderUsageRecord): Promise<void>;
  list(query?: { since?: string; agentId?: string }): Promise<ProviderUsageRecord[]>;
}

export function createMemoryUsageLedger(): ProviderUsageLedger & { readonly all: ProviderUsageRecord[] } {
  const all: ProviderUsageRecord[] = [];
  return {
    all,
    async record(r) {
      all.push(r);
    },
    async list(q = {}) {
      return all.filter((r) => (q.since === undefined || r.at >= q.since) && (q.agentId === undefined || r.agentId === q.agentId));
    },
  };
}

/** Usage records are for reading, not for limits: an unreadable line is skipped and counted. */
export function createFileUsageLedger(path: string): ProviderUsageLedger & { skipped(): number } {
  let skipped = 0;
  return {
    async record(r) {
      append(path, r);
    },
    async list(q = {}) {
      skipped = 0;
      const out: ProviderUsageRecord[] = [];
      for (const line of readLines(path)) {
        try {
          const r = JSON.parse(line) as ProviderUsageRecord;
          if (typeof r.agentId !== 'string' || typeof r.providerId !== 'string' || typeof r.at !== 'string') throw new Error('shape');
          if ((q.since === undefined || r.at >= q.since) && (q.agentId === undefined || r.agentId === q.agentId)) out.push(r);
        } catch {
          skipped += 1;
        }
      }
      return out;
    },
    skipped: () => skipped,
  };
}


export interface UsageSummaryRow {
  key: string;
  calls: number;
  failed: number;
  inputTokens: TokenCount;
  outputTokens: TokenCount;
  /** Summed per currency, over the calls whose cost is known. */
  costs: Record<string, number>;
  /** Calls whose cost could not be told (unknown tokens or no price). */
  uncosted: number;
}

const keyOf = (r: ProviderUsageRecord, by: UsageGroupBy): string => {
  switch (by) {
    case 'agent':
      return r.agentId;
    case 'provider':
      return r.providerId;
    case 'model':
      return `${r.providerId}/${r.model ?? '?'}`;
    case 'task':
      return r.taskId ?? `run:${r.runId}`;
  }
};

/** Rows sorted by calls, most first. */
export function summarizeUsage(records: readonly ProviderUsageRecord[], by: UsageGroupBy, prices: PriceTable = {}): UsageSummaryRow[] {
  const rows = new Map<string, UsageSummaryRow>();
  for (const r of records) {
    const key = keyOf(r, by);
    const row = rows.get(key) ?? { key, calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, costs: {}, uncosted: 0 };
    row.calls += 1;
    if (!r.ok) row.failed += 1;
    row.inputTokens = addTokens(row.inputTokens, r.inputTokens);
    row.outputTokens = addTokens(row.outputTokens, r.outputTokens);
    const cost = costOf(prices, r);
    if (cost) row.costs[cost.currency] = (row.costs[cost.currency] ?? 0) + cost.amount;
    else row.uncosted += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));
}

export function formatUsage(rows: readonly UsageSummaryRow[]): string[] {
  if (rows.length === 0) return ['no provider usage'];
  const cost = (r: UsageSummaryRow) => {
    const parts = Object.entries(r.costs).map(([c, a]) => `${a.toFixed(4)} ${c}`);
    if (r.uncosted) parts.push(`${r.uncosted} call(s) without a cost`);
    return parts.join(' + ') || '-';
  };
  // The failed column only when something failed, so a clean summary has no blank column.
  const anyFailed = rows.some((r) => r.failed > 0);
  const table = rows.map((r) => [r.key, `${r.calls} calls`, ...(anyFailed ? [`${r.failed} failed`] : []), `in ${r.inputTokens}`, `out ${r.outputTokens}`, cost(r)]);
  const widths = table[0]!.map((_, i) => Math.max(...table.map((row) => row[i]!.length)));
  return table.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd());
}

