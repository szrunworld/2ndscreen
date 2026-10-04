// Local verdicts on whether a unit did its job, from a fresh observation or
// the staging directory. These are the only success evidence the runtime
// takes; a model reporting "finished" is not one. Evidence strings never
// repeat a candidate's name, history or messages.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BossUnitName,
  CheckResult,
  Observation,
  UnitContext,
} from '../../../../packages/task-runtime/src/contracts.ts';
import { identify, listCandidates, listEnded, normalize } from './candidates.ts';
import { overlayShowsName } from './capture.ts';
import { ALL_JOBS, classifyPage, jobFilter, listRows, requestDialog, resumeOverlay, text } from './pages.ts';

const verdict = (ok: boolean, observation: Observation | undefined, ...evidence: string[]): CheckResult => ({
  ok,
  snapshotId: observation?.snapshotId,
  evidence,
});

const LIST_PAGES = new Set(['conversation_list', 'conversation_detail']);

/** Temporary names a download or copy leaves while it is unfinished. */
export const UNFINISHED = /\.(crdownload|download|part|partial|tmp)$/i;

/** The staging directory holds at least one finished, non-empty file and nothing half-written. */
export async function stagingHasResume(dir: string): Promise<{ ok: boolean; evidence: string[] }> {
  const files: Array<{ name: string; size: number }> = [];
  const walk = async (at: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(at);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(at, name);
      const s = await stat(path).catch(() => undefined);
      if (s?.isDirectory() && depth < 3) await walk(path, depth + 1);
      else if (s?.isFile()) files.push({ name, size: s.size });
    }
  };
  await walk(dir, 0);
  const unfinished = files.filter((f) => UNFINISHED.test(f.name));
  const content = files.filter((f) => f.size > 0 && !UNFINISHED.test(f.name) && f.name !== 'metadata.json');
  if (unfinished.length) return { ok: false, evidence: [`${unfinished.length} unfinished file(s) in staging`] };
  if (!content.length) return { ok: false, evidence: ['no resume file in staging'] };
  return { ok: true, evidence: [`${content.length} file(s) staged`] };
}

export interface VerifyMemory {
  /** Observations at which a scroll probe confirmed the list's end. */
  listEndConfirmed(snapshotId: string): boolean;
  /** Name and job pairs seen on two rows at once. */
  collisions: ReadonlySet<string>;
}

export async function verifyUnit(unit: BossUnitName, context: UnitContext, observation: Observation, memory: VerifyMemory): Promise<CheckResult> {
  const page = classifyPage(observation);
  const account = context.task.account;
  switch (unit) {
    case 'select_source': {
      if (context.task.input.source !== 'conversations') return verdict(false, observation, `source ${context.task.input.source} is not supported on macOS`);
      if (!LIST_PAGES.has(page)) return verdict(false, observation, `page is ${page}, not the message list`);
      const filter = jobFilter(observation);
      const label = filter ? text(filter) : '';
      if (!label || label === ALL_JOBS) return verdict(false, observation, 'no job is selected in the list filter');
      return normalize(label).includes(normalize(context.task.input.job))
        ? verdict(true, observation, 'list filter shows the requested job')
        : verdict(false, observation, 'list filter shows another job');
    }
    case 'enumerate_candidates': {
      if (!LIST_PAGES.has(page)) return verdict(false, observation, `page is ${page}, not the message list`);
      const rows = listRows(observation).length;
      return rows > 0 || listEnded(observation)
        ? verdict(true, observation, `list shows ${rows} row(s)`)
        : verdict(false, observation, 'list shows no rows and no end notice');
    }
    case 'open_candidate': {
      if (!context.candidate) return verdict(false, observation, 'no candidate ref to check against');
      if (!account) return verdict(false, observation, 'the task has no bound account');
      if (page !== 'conversation_detail') return verdict(false, observation, `page is ${page}, not a conversation`);
      const match = identify(observation, context.candidate, account, memory.collisions);
      if (match.kind === 'mismatch') return verdict(false, observation, `identity mismatch (${match.expected} vs ${match.seen})`);
      if (match.kind === 'ambiguous') return verdict(false, observation, `identity ambiguous: ${match.reason}`);
      const known = context.item?.identity;
      if (known && known.fingerprint !== match.identity.fingerprint)
        return verdict(false, observation, 'the open conversation is a different person than this work item');
      return verdict(true, observation, ...match.identity.evidence);
    }
    case 'open_resume': {
      const name = context.candidate?.name ?? context.item?.ref.name;
      if (page === 'attachment_preview') return verdict(true, observation, 'attachment preview is open');
      if (page !== 'online_resume') return verdict(false, observation, `page is ${page}, not a resume`);
      const overlay = resumeOverlay(observation)!;
      if (!name) return verdict(false, observation, 'no candidate to check the resume against');
      return overlayShowsName(observation, overlay, name)
        ? verdict(true, observation, 'online resume is open beside the listed name')
        : verdict(false, observation, 'online resume is open but does not show the listed name');
    }
    case 'acquire_resume': {
      if (!context.staging) return verdict(false, undefined, 'no staging area');
      const staged = await stagingHasResume(context.staging.dir);
      return { ok: staged.ok, evidence: staged.evidence };
    }
    case 'persist_candidate':
      return context.item?.status === 'committed'
        ? verdict(true, undefined, 'work item is committed')
        : verdict(false, undefined, `work item is ${context.item?.status ?? 'missing'}`);
    case 'return_to_list': {
      if (resumeOverlay(observation) || requestDialog(observation)) return verdict(false, observation, 'an overlay or dialog is still open');
      if (!LIST_PAGES.has(page)) return verdict(false, observation, `page is ${page}, not the message list`);
      return verdict(true, observation, 'message list is showing');
    }
    case 'advance_list': {
      if (!LIST_PAGES.has(page)) return verdict(false, observation, `page is ${page}, not the message list`);
      if (!account) return verdict(false, observation, 'the task has no bound account');
      if (listEnded(observation)) return verdict(true, observation, 'list end is visible');
      if (memory.listEndConfirmed(observation.snapshotId)) return verdict(true, observation, 'list end confirmed by a scroll probe');
      const previous = context.bindings['list.fingerprint'];
      if (!previous) return verdict(false, observation, 'no previous list fingerprint to compare with');
      return listCandidates(observation, account, new Set(memory.collisions)).fingerprint !== previous
        ? verdict(true, observation, 'list shows new rows')
        : verdict(false, observation, 'list did not move');
    }
  }
}
