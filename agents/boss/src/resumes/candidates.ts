// Who is in the list and who is open. A list row is only a reference into
// one observation; the identity of a person comes from the opened
// conversation's header and history, never from the name alone. Names and
// histories go into hashes and the ledger's ref, never into evidence text.

import { createHash } from 'node:crypto';
import {
  rectContains,
  type AccountScope,
  type CandidateIdentity,
  type CandidateListing,
  type CandidateRef,
  type IdentityMatch,
  type Observation,
  type Rect,
  type UIElement,
} from '../../../../packages/task-runtime/src/contracts.ts';
import { ALL_JOBS, MARKERS, jobFilter, listRows, openChat, text } from './pages.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Width-insensitive, space-insensitive form for comparing titles and names. */
export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\s 　]+/g, '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .toLowerCase();
}

export type JobMatch = { kind: 'unique'; option: string } | { kind: 'ambiguous'; options: string[] } | { kind: 'none' };

/**
 * Which job option the task's job text means. An exact title wins; otherwise
 * the text must be contained in exactly one option. Several containing
 * options are ambiguous: the task asks instead of taking the first.
 */
export function matchJob(options: readonly string[], job: string): JobMatch {
  const want = normalize(job);
  if (!want) return { kind: 'none' };
  const distinct = [...new Set(options.map((o) => o.trim()).filter((o) => o && o !== ALL_JOBS))];
  const exact = distinct.filter((o) => normalize(o) === want);
  if (exact.length === 1) return { kind: 'unique', option: exact[0]! };
  if (exact.length > 1) return { kind: 'ambiguous', options: exact };
  const containing = distinct.filter((o) => normalize(o).includes(want));
  if (containing.length === 1) return { kind: 'unique', option: containing[0]! };
  if (containing.length > 1) return { kind: 'ambiguous', options: containing };
  return { kind: 'none' };
}

/** Whether a row's or page's job title belongs to the selected job filter. */
export function jobBelongs(title: string | undefined, selected: string): boolean {
  if (!title) return false;
  const a = normalize(title);
  const b = normalize(selected);
  // The list cuts long titles; a cut title is a prefix of the full one.
  const cut = a.replace(/(\.\.\.|…)$/, '');
  return a === b || (cut !== a && b.startsWith(cut)) || a.includes(b) || b.includes(a);
}

/** Row key within the list: name, job, time and a hash of the preview. Not a permanent id. */
function rowKey(row: { name: string; position: string; time: string; preview: string }): string {
  return [row.name, row.position, row.time, sha(row.preview).slice(0, 8)].join('|');
}

const DUP = '#dup';

/** Key of a name and job pair within one account, for remembering look-alikes. */
export const pairKey = (account: AccountScope, name: string, job: string | undefined): string =>
  `${account.accountKey}|${normalize(name)}|${normalize(job ?? '')}`;

/**
 * The candidates the list shows, top to bottom, with refs bound to this
 * observation. Rows of another job are left out when the filter names a job.
 * Rows that look exactly alike get a marked ref and the hint
 * `duplicate_row`: they cannot be told apart, so opening one is refused.
 * Name and job pairs shown on two rows get `name_job_collision`, and are
 * added to `collisions` so the hint stays on later refs after the rows
 * reorder or one scrolls out of view.
 */
export function listCandidates(observation: Observation, account: AccountScope, collisions?: Set<string>): CandidateListing {
  const rows = listRows(observation);
  const filter = jobFilter(observation);
  const selected = filter && text(filter) !== ALL_JOBS ? text(filter) : undefined;
  const kept = selected ? rows.filter((r) => jobBelongs(r.position, selected)) : rows;
  const counts = new Map<string, number>();
  for (const r of kept) counts.set(rowKey(r), (counts.get(rowKey(r)) ?? 0) + 1);
  const pairs = new Map<string, number>();
  for (const r of kept) pairs.set(pairKey(account, r.name, r.position), (pairs.get(pairKey(account, r.name, r.position)) ?? 0) + 1);
  for (const [pair, n] of pairs) if (n > 1) collisions?.add(pair);
  const candidates: CandidateRef[] = kept.map((r) => {
    const key = rowKey(r);
    const duplicate = (counts.get(key) ?? 0) > 1;
    const hints = [`time:${r.time}`, `unread:${r.unread}`];
    if (duplicate) hints.push('duplicate_row');
    const pair = pairKey(account, r.name, r.position);
    if ((pairs.get(pair) ?? 0) > 1 || collisions?.has(pair)) hints.push('name_job_collision');
    return {
      sourceRef: duplicate ? `${key}${DUP}` : key,
      name: r.name,
      jobTitle: r.position || undefined,
      hints,
      locator: { kind: 'element', index: r.index },
      snapshotId: observation.snapshotId,
    };
  });
  return {
    candidates,
    fingerprint: sha([account.accountKey, ...rows.map(rowKey)].join('\n')),
    endReached: listEnded(observation),
    snapshotId: observation.snapshotId,
  };
}

/** Rows' visible extent and whether the last one is cut off by the window's bottom edge. */
function listExtent(observation: Observation): { rows: number; lastBottom?: number; cut: boolean } {
  const rows = listRows(observation);
  const win = observation.window.frame;
  const els = observation.elements ?? [];
  const last = rows.at(-1);
  if (!last) return { rows: 0, cut: false };
  const name = els.find((e) => e.index === last.index);
  // A cut row reports a shrunken height for its text, or reaches the bottom edge.
  const rowTexts = els.filter((e) => e.frame && name?.frame && e.frame.y >= name.frame.y - 12 && e.frame.y < name.frame.y + 45 && e.role === 'AXStaticText');
  const lastBottom = Math.max(...rowTexts.map((e) => e.frame!.y + e.frame!.height));
  const cut = !!name?.frame && (name.frame.height < 14 || lastBottom >= win.y + win.height - 6 || rowTexts.length < 3);
  return { rows: rows.length, lastBottom, cut };
}

/** The message list column, below its tabs, in global points. */
export function listPane(observation: Observation): Rect {
  const win = observation.window.frame;
  return { x: win.x + 120, y: win.y + 100, width: 400, height: Math.max(0, win.height - 100) };
}

/**
 * Whether the list says it has ended: an empty-list or end notice inside the
 * list column and outside every row, so a message preview or a chat line
 * with the same words cannot end a batch. Blank space under the last row is
 * not an end: rows may still be loading.
 */
export function listEnded(observation: Observation): boolean {
  const pane = listPane(observation);
  const els = observation.elements ?? [];
  const bands = listRows(observation)
    .map((r) => els.find((e) => e.index === r.index)?.frame)
    .filter((f): f is Rect => !!f)
    .map((f) => ({ top: f.y - 12, bottom: f.y + 45 }));
  return els.some((e) => {
    if (e.role !== 'AXStaticText' || !e.frame || !rectContains(pane, e.frame)) return false;
    if (bands.some((b) => e.frame!.y >= b.top && e.frame!.y < b.bottom)) return false;
    return MARKERS.emptyList.test(text(e)) || MARKERS.listEnd.test(text(e));
  });
}

/** Whether a loading notice shows in the list column. */
export function listLoading(observation: Observation): boolean {
  const pane = listPane(observation);
  return (observation.elements ?? []).some((e) => e.frame && rectContains(pane, e.frame) && /加载中|正在加载/.test(text(e)));
}

/** Whether the last visible row is cut off at the bottom: there is more list below. */
export function listContinues(observation: Observation): boolean {
  return listExtent(observation).cut;
}

/** Rows in a fresh observation that a ref from an older one refers to. */
export function findRows(observation: Observation, ref: CandidateRef, account: AccountScope, collisions?: Set<string>): { rows: CandidateRef[]; moved: boolean } {
  const fresh = listCandidates(observation, account, collisions).candidates;
  const exact = fresh.filter((c) => c.sourceRef === ref.sourceRef);
  if (exact.length || ref.sourceRef.endsWith(DUP)) return { rows: exact, moved: false };
  // A new message changes the time and preview; the person keeps name and job.
  const same = fresh.filter((c) => c.name === ref.name && normalize(c.jobTitle ?? '') === normalize(ref.jobTitle ?? ''));
  return { rows: same, moved: same.length > 0 };
}

const nameMatches = (seen: string, listed: string) => {
  const a = normalize(seen);
  const b = normalize(listed);
  const cut = b.replace(/(\.\.\.|…)$/, '');
  return a === b || (cut !== b && cut.length >= 1 && a.startsWith(cut));
};

/**
 * Ambiguities that only mean the conversation has not finished drawing: no
 * header name, no job, or nothing beyond the name yet. BOSS fills the header
 * in after the message box appears, so these are waited out, never accepted.
 */
const INCOMPLETE = {
  noChat: 'no conversation is open',
  noName: 'the conversation header shows no name',
  noJob: 'the conversation shows no job to check',
  nameOnly: 'only a name is visible; identity needs summary or history',
} as const;

/** Whether an identity check failed only because the conversation is still loading. */
export function identityIncomplete(match: IdentityMatch): boolean {
  return match.kind === 'ambiguous' && (Object.values(INCOMPLETE) as string[]).includes(match.reason);
}

/**
 * Check the opened conversation against the list ref and derive the
 * person's identity from the header summary and history. The name and job
 * must agree; the identity needs history or summary beyond the name; the
 * same name and job shown twice in the list cannot be told apart here.
 */
export function identify(observation: Observation, ref: CandidateRef, account: AccountScope, collisions?: ReadonlySet<string>): IdentityMatch {
  const open = openChat(observation);
  if (!open) return { kind: 'ambiguous', reason: INCOMPLETE.noChat };
  const c = open.candidate;
  if (!c.name) return { kind: 'ambiguous', reason: INCOMPLETE.noName };
  if (!nameMatches(c.name, ref.name)) return { kind: 'mismatch', expected: hashTag('name', ref.name), seen: hashTag('name', c.name) };
  // The job is part of the match: without it on both sides nothing shows this is the right conversation.
  if (!ref.jobTitle) return { kind: 'ambiguous', reason: 'the list row shows no job to check' };
  if (!c.position) return { kind: 'ambiguous', reason: INCOMPLETE.noJob };
  if (!jobBelongs(c.position, ref.jobTitle) && !jobBelongs(ref.jobTitle, c.position))
    return { kind: 'mismatch', expected: hashTag('job', ref.jobTitle), seen: hashTag('job', c.position) };
  const history = c.history.map((l) => l.trim()).filter(Boolean);
  if (!history.length && !c.summary) return { kind: 'ambiguous', reason: INCOMPLETE.nameOnly };
  if (ref.hints.includes('name_job_collision') || collisions?.has(pairKey(account, ref.name, ref.jobTitle)))
    return { kind: 'ambiguous', reason: 'another row with the same name and job was seen; the opened row cannot be told apart' };
  const twins = listRows(observation).filter((r) => normalize(r.name) === normalize(c.name) && normalize(r.position) === normalize(ref.jobTitle!));
  if (twins.length > 1) return { kind: 'ambiguous', reason: 'the same name and job appear more than once in the list' };
  const fingerprint = sha([account.accountKey, normalize(c.name), normalize(c.summary), ...history.map(normalize)].join('\n'));
  // Weak: only a summary or only history beside the name. Reported as weak for the runner to decide on.
  const confidence = history.length && c.summary ? 'strong' : 'weak';
  const evidence = ['name matches list row', 'job matches list row', `summary ${c.summary ? 'present' : 'absent'}`, `history lines ${history.length}`, `confidence ${confidence}`];
  const identity: CandidateIdentity = {
    candidateId: `c-${fingerprint.slice(0, 24)}`,
    accountKey: account.accountKey,
    fingerprint,
    confidence,
    evidence,
  };
  return { kind: 'match', identity };
}

/** A short hash that tells values apart in evidence without repeating them. */
const hashTag = (what: string, value: string) => `${what}#${sha(normalize(value)).slice(0, 8)}`;

/** The element to click for a row, from a fresh listing. */
export function rowElement(observation: Observation, ref: CandidateRef): UIElement | undefined {
  const index = ref.locator?.kind === 'element' ? ref.locator.index : undefined;
  if (index === undefined || ref.snapshotId !== observation.snapshotId) return undefined;
  return observation.elements?.find((e) => e.index === index);
}
