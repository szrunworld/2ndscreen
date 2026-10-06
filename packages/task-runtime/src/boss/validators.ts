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
} from '../contracts.ts';
import { identify, listCandidates, listEnded, normalize } from './candidates.ts';
import { look, type Env } from './actions.ts';
import { DEFAULT_CAPTURE_LIMITS, readResumeHeader, type CaptureLimits, type HeaderReading } from './capture.ts';
import { ALL_JOBS, classifyPage, jobFilter, jobMenu, listRows, requestDialog, resumeOverlay, text } from './pages.ts';

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
  /** The normalized option select_source uniquely matched for a task's job text, if it did. */
  resolvedJob(taskId: string, job: string): string | undefined;
}

/** What some verdicts need beyond the tree: local OCR for the resume header. */
export interface VerifyEnv {
  env: Env;
  limits?: Partial<CaptureLimits>;
}

const HEADER_EVIDENCE: Record<Exclude<HeaderReading, 'match'>, string> = {
  other: 'the resume header does not show the listed name',
  no_pane: 'the resume pane is not open and loaded',
  no_screenshot: 'no screenshot of the resume pane',
  not_this_image: 'the screenshot is not of this resume pane',
  ocr_failed: 'local OCR could not read the resume header',
};

/**
 * The open resume is `name`'s by its image header. The observation's own
 * pane screenshot is read when it has one; otherwise, or when that file no
 * longer is what the observation captured, one fresh screenshot of the pane
 * is taken and judged on its own. Only one fresh read: waiting is open_resume's job.
 */
async function resumeHeaderVerdict(context: UnitContext, observation: Observation, name: string, verify: VerifyEnv | undefined): Promise<CheckResult> {
  const vision = verify?.env.vision;
  if (!verify || !vision)
    return verdict(false, observation, 'online resume is open but local OCR is not available to read its header (capability missing)');
  const limits = { ...DEFAULT_CAPTURE_LIMITS, ...verify.limits };
  let seen = observation;
  let reading: HeaderReading = observation.screenshot
    ? await readResumeHeader(vision, observation, name, limits, context.signal, verify.env)
    : 'no_screenshot';
  if (reading !== 'match' && reading !== 'other') {
    const pane = resumeOverlay(observation)!.pane;
    seen = await look(context.session, verify.env, context.signal, { screenshot: true, region: pane });
    if (seen.pageClass !== 'online_resume') return verdict(false, seen, `page is ${seen.pageClass}, not a resume`);
    reading = await readResumeHeader(vision, seen, name, limits, context.signal, verify.env);
  }
  return reading === 'match'
    ? verdict(true, seen, 'online resume header shows the listed name')
    : verdict(false, seen, `online resume is open but ${HEADER_EVIDENCE[reading]}`);
}

export async function verifyUnit(unit: BossUnitName, context: UnitContext, observation: Observation, memory: VerifyMemory, verify?: VerifyEnv): Promise<CheckResult> {
  const page = classifyPage(observation);
  const account = context.task.account;
  switch (unit) {
    case 'select_source': {
      if (context.task.input.source !== 'conversations') return verdict(false, observation, `source ${context.task.input.source} is not supported on macOS`);
      if (!LIST_PAGES.has(page)) return verdict(false, observation, `page is ${page}, not the message list`);
      // Open, the menu hides the label; only a closed menu shows what is selected.
      if (jobMenu(observation)) return verdict(false, observation, 'the job menu is still open');
      const filter = jobFilter(observation);
      const label = filter ? text(filter) : '';
      if (!label || label === ALL_JOBS) return verdict(false, observation, 'no job is selected in the list filter');
      // Exactly the requested title, or the one option this task's selection resolved it to.
      // A title that merely contains the text is not enough: other jobs may contain it too.
      if (normalize(label) === normalize(context.task.input.job)) return verdict(true, observation, 'list filter shows exactly the requested job');
      return memory.resolvedJob(context.task.id, context.task.input.job) === normalize(label)
        ? verdict(true, observation, 'list filter shows the job uniquely matched for this task')
        : verdict(false, observation, 'list filter shows a job not resolved for this task');
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
      if (!name) return verdict(false, observation, 'no candidate to check the resume against');
      // Side-column text is not proven to be the overlay's; only the image header decides.
      return resumeHeaderVerdict(context, observation, name, verify);
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
