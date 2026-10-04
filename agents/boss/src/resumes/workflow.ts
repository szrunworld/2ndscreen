// boss-resumes-v1: collecting resumes the account can already see in
// BOSS直聘's message list, as eight units the runtime drives one at a time.
// The workflow knows the pages and what success looks like; every action
// goes through the Session, and none of them sends, greets or requests.
//
// Supported on macOS (P0): the conversations source and the online resume.
// The recommend source and saving original attachments are not verified;
// asking for them fails with capability_missing instead of pretending.

import {
  RuntimeError,
  systemClock,
  throwIfAborted,
  type AccountScope,
  type AcquisitionResult,
  type BossPageClass,
  type BossUnitName,
  type BossWorkflow,
  type CaptureMode,
  type CheckResult,
  type Clock,
  type LocalVision,
  type Observation,
  type TelemetryRecorder,
  type UnitContext,
  type UnitDefinition,
  type UnitRunResult,
} from '../../../../packages/task-runtime/src/contracts.ts';
import { clickElement, delivered, look, pollFor, pressKey, scrollOver, Trace, type Env } from './actions.ts';
import { findRows, identify, identityIncomplete, listCandidates, listContinues, listEnded, listLoading, matchJob, normalize, rowElement } from './candidates.ts';
import {
  ATTACHMENT_ROUTE_OFF,
  captureOnlineResume,
  confirmResumeIdentity,
  dismissRequestDialog,
  fetchAttachment,
  type AttachmentRoute,
  type CaptureLimits,
} from './capture.ts';
import { ALL_JOBS, attachmentPreview, classifyPage, jobFilter, listRows, requestDialog, resumeOverlay, text } from './pages.ts';
import { verifyUnit } from './validators.ts';

const noText = (pattern: string) => ({ kind: 'text', pattern, present: false }) as const;
const hasText = (pattern: string) => ({ kind: 'text', pattern, present: true }) as const;
const messageBox = { kind: 'element', locator: { kind: 'element', role: 'AXTextArea' }, present: true } as const;

/** Unit boundaries. Bindings used: job, candidate.name, list.fingerprint. */
export const BOSS_RESUME_UNITS: Readonly<Record<BossUnitName, UnitDefinition>> = {
  select_source: {
    name: 'select_source',
    goal: '在消息列表的职位筛选中选中与 {{job}} 唯一匹配的职位；有多个匹配时停下询问',
    allowedEffects: ['read', 'navigation'],
    preconditions: [],
    postconditions: [hasText('{{job}}'), noText('确定向牛人请求简历')],
    // Choosing among jobs is a decision for the user when ambiguous; never learned.
    learnable: false,
    timeoutMs: 30_000,
  },
  enumerate_candidates: {
    name: 'enumerate_candidates',
    goal: '读取消息列表中当前可见的候选人',
    allowedEffects: ['read'],
    preconditions: [],
    postconditions: [],
    learnable: false,
    timeoutMs: 15_000,
  },
  open_candidate: {
    name: 'open_candidate',
    goal: '打开 {{candidate.name}} 的会话',
    allowedEffects: ['read', 'navigation'],
    preconditions: [noText('确定向牛人请求简历')],
    postconditions: [messageBox, hasText('{{candidate.name}}')],
    learnable: true,
    timeoutMs: 20_000,
  },
  open_resume: {
    name: 'open_resume',
    goal: '打开 {{candidate.name}} 的在线简历（只查看，不索取）',
    allowedEffects: ['read', 'navigation'],
    preconditions: [messageBox],
    postconditions: [hasText('举报'), noText('正在加载简历'), noText('确定向牛人请求简历')],
    learnable: true,
    timeoutMs: 30_000,
  },
  acquire_resume: {
    name: 'acquire_resume',
    goal: '将 {{candidate.name}} 的简历保存到暂存目录',
    allowedEffects: ['read', 'navigation', 'artifact'],
    preconditions: [],
    postconditions: [],
    learnable: false,
    timeoutMs: 300_000,
  },
  persist_candidate: {
    name: 'persist_candidate',
    goal: '归档已验证的简历产物并提交账本',
    allowedEffects: ['artifact'],
    preconditions: [],
    postconditions: [],
    learnable: false,
    timeoutMs: 60_000,
  },
  return_to_list: {
    name: 'return_to_list',
    goal: '关闭简历或弹层，回到消息列表',
    allowedEffects: ['read', 'navigation'],
    preconditions: [],
    postconditions: [noText('举报'), noText('确定向牛人请求简历')],
    learnable: true,
    timeoutMs: 20_000,
  },
  advance_list: {
    name: 'advance_list',
    goal: '向下滚动消息列表，直到出现新候选人或确认到底',
    allowedEffects: ['read'],
    preconditions: [],
    postconditions: [],
    learnable: false,
    timeoutMs: 30_000,
  },
};

export interface BossResumesOptions {
  vision?: LocalVision;
  telemetry?: TelemetryRecorder;
  clock?: Clock;
  /** Original attachments; off unless a verified route is configured. */
  attachment?: AttachmentRoute;
  capture?: Partial<CaptureLimits>;
  pollMs?: number;
  /** Timeouts for page changes after a click. */
  openTimeoutMs?: number;
}

export function createBossResumesWorkflow(deps: {
  vision?: LocalVision;
  telemetry?: TelemetryRecorder;
  clock?: Clock;
}): BossWorkflow {
  return createBossResumesWorkflowWith(deps);
}

/** The same workflow with its tunables exposed, for tests and for enabling a verified attachment route. */
export function createBossResumesWorkflowWith(options: BossResumesOptions): BossWorkflow {
  const env: Env = { clock: options.clock ?? systemClock, telemetry: options.telemetry, vision: options.vision, pollMs: options.pollMs ?? 250 };
  const route = options.attachment ?? ATTACHMENT_ROUTE_OFF;
  const openTimeoutMs = options.openTimeoutMs ?? 15_000;
  const endConfirmed: string[] = [];
  /** Name and job pairs seen on two rows at once, per account; they stay ambiguous for the workflow's life. */
  const collisions = new Set<string>();
  /** task id + job text → the option selectSource uniquely matched, so the verifier can tell it from a lookalike. */
  const resolvedJobs = new Map<string, string>();
  const jobKey = (taskId: string, job: string) => `${taskId}|${normalize(job)}`;
  const memory = {
    listEndConfirmed: (id: string) => endConfirmed.includes(id),
    collisions,
    resolvedJob: (taskId: string, job: string) => resolvedJobs.get(jobKey(taskId, job)),
  };
  const rememberEnd = (id: string) => {
    endConfirmed.push(id);
    if (endConfirmed.length > 32) endConfirmed.shift();
  };

  const result = (ok: boolean, trace: Trace, observation: Observation, reason?: string): UnitRunResult =>
    ({ ok, executed: trace.steps, observation, ...(reason ? { reason } : {}) });

  const needAccount = (context: UnitContext): AccountScope => {
    const account = context.task.account;
    if (!account) throw new RuntimeError('invalid_input', 'the task has no bound BOSS account yet');
    return account;
  };

  /** Leave overlays and the request confirm, ending on the message list. */
  async function closeOverlays(context: UnitContext, trace: Trace): Promise<Observation> {
    const { session, signal } = context;
    let o = await look(session, env, signal);
    for (let i = 0; i < 3; i++) {
      if (requestDialog(o)) {
        if (!(await dismissRequestDialog(session, env, o, trace, signal))) return o;
        o = await look(session, env, signal);
        continue;
      }
      const overlay = resumeOverlay(o);
      const preview = overlay ? undefined : attachmentPreview(o);
      if (!overlay && !preview) return o;
      const close = overlay?.close;
      const r = close ? await clickElement(session, o, close, trace, signal) : await pressKey(session, o, 'escape', trace, signal);
      if (r.status === 'failed' || r.status === 'stale_snapshot') return o;
      const after = await pollFor(session, env, signal, openTimeoutMs, (x) => (resumeOverlay(x) || attachmentPreview(x) ? undefined : true));
      o = after.observation;
    }
    return o;
  }

  async function selectSource(context: UnitContext): Promise<UnitRunResult> {
    const { session, signal, task } = context;
    const trace = new Trace();
    if (task.input.source !== 'conversations')
      throw new RuntimeError('capability_missing', `the ${task.input.source} source is not verified on macOS; only conversations is supported`);
    if (task.input.captureMode === 'original-only' && !route.enabled)
      throw new RuntimeError('capability_missing', 'original-only needs a verified attachment download route, which macOS does not have yet');
    let o = await closeOverlays(context, trace);
    if (o.pageClass === 'login' || o.pageClass === 'captcha') return result(false, trace, o, o.pageClass === 'login' ? 'login_required' : 'captcha');
    if (o.pageClass !== 'conversation_list' && o.pageClass !== 'conversation_detail') return result(false, trace, o, 'list_not_shown');
    const filter = jobFilter(o);
    if (!filter) return result(false, trace, o, 'job_filter_missing');
    const current = text(filter);
    const key = jobKey(task.id, task.input.job);
    resolvedJobs.delete(key);
    if (current !== ALL_JOBS && normalize(current) === normalize(task.input.job)) return result(true, trace, o);

    // Open the filter and read the options it adds below itself.
    // Indexes renumber when the menu opens; a text at a place it was not before is an option.
    const placed = (e: { frame?: { x: number; y: number } }, t: string) => `${t}@${Math.round(e.frame?.x ?? -1)},${Math.round(e.frame?.y ?? -1)}`;
    const before = new Set((o.elements ?? []).map((e) => placed(e, text(e))));
    const opened = await clickElement(session, o, filter, trace, signal);
    if (!delivered(opened)) return result(false, trace, o, `job_filter_click_${opened.status}`);
    const win = o.window.frame;
    const optionsOf = (x: Observation) => (x.elements ?? []).filter((e) =>
      e.role === 'AXStaticText' && e.frame && text(e) && !before.has(placed(e, text(e)))
      && e.frame.x - win.x >= 120 && e.frame.x - win.x < 520 && e.frame.y - win.y > 40);
    const shown = await pollFor(session, env, signal, openTimeoutMs, (x) => (optionsOf(x).length ? optionsOf(x) : undefined));
    o = shown.observation;
    const options = shown.value ?? [];
    // Diagnostic only: a click the app took without changing the tree at all is told apart from a menu with no readable options.
    const unchanged = !options.length && (o.elements ?? []).every((e) => before.has(placed(e, text(e))));
    const match = matchJob(options.map(text), task.input.job);
    if (match.kind !== 'unique') {
      await pressKey(session, o, 'escape', trace, signal);
      const after = await look(session, env, signal);
      const reason = match.kind === 'ambiguous' ? 'job_ambiguous' : options.length ? 'job_not_found'
        : unchanged ? 'job_options_not_shown: the filter click changed nothing in the accessibility tree' : 'job_options_not_shown';
      return result(false, trace, after, reason);
    }
    const option = options.find((e) => text(e) === match.option)!;
    resolvedJobs.set(key, normalize(match.option));
    const picked = await clickElement(session, o, option, trace, signal);
    if (!delivered(picked)) return result(false, trace, o, `job_option_click_${picked.status}`);
    const applied = await pollFor(session, env, signal, openTimeoutMs, (x) => {
      const f = jobFilter(x);
      return f && normalize(text(f)) === normalize(match.option) ? true : undefined;
    });
    return result(applied.value === true, trace, applied.observation, applied.value ? undefined : 'job_not_applied');
  }

  async function openCandidate(context: UnitContext): Promise<UnitRunResult> {
    const { session, signal } = context;
    const trace = new Trace();
    const account = needAccount(context);
    const ref = context.candidate;
    if (!ref) throw new RuntimeError('invalid_input', 'open_candidate needs a candidate ref');
    const o = await closeOverlays(context, trace);
    if (o.pageClass !== 'conversation_list' && o.pageClass !== 'conversation_detail') return result(false, trace, o, 'list_not_shown');
    if (ref.hints.includes('duplicate_row')) return result(false, trace, o, 'candidate_row_ambiguous');
    const { rows } = findRows(o, ref, account, collisions);
    if (rows.length === 0) return result(false, trace, o, 'candidate_not_in_list');
    if (rows.length > 1) return result(false, trace, o, 'candidate_row_ambiguous');
    const row = rowElement(o, rows[0]!);
    if (!row) return result(false, trace, o, 'candidate_row_not_found');
    const clicked = await clickElement(session, o, row, trace, signal, 'row');
    if (!delivered(clicked)) return result(false, trace, o, `row_click_${clicked.status}`);
    // The header may still show the previous person, or nothing yet, for a moment; wait for this one.
    // Only a match or an ambiguity that more loading cannot resolve ends the wait early.
    const opened = await pollFor(session, env, signal, openTimeoutMs, (x) => {
      if (x.pageClass !== 'conversation_detail') return undefined;
      const m = identify(x, rows[0]!, account, collisions);
      return m.kind === 'mismatch' || identityIncomplete(m) ? undefined : m;
    });
    if (!opened.value) {
      const last = opened.observation;
      const incomplete = last.pageClass === 'conversation_detail' && identityIncomplete(identify(last, rows[0]!, account, collisions));
      return result(false, trace, last, incomplete ? 'identity_incomplete' : 'conversation_not_opened');
    }
    if (opened.value.kind === 'ambiguous') return result(false, trace, opened.observation, 'identity_ambiguous');
    const known = context.item?.identity;
    if (known && opened.value.kind === 'match' && known.fingerprint !== opened.value.identity.fingerprint)
      return result(false, trace, opened.observation, 'identity_mismatch');
    return result(true, trace, opened.observation);
  }

  async function openResume(context: UnitContext, trace = new Trace()): Promise<UnitRunResult> {
    const { session, signal } = context;
    const name = context.candidate?.name ?? context.item?.ref.name;
    if (!name) throw new RuntimeError('invalid_input', 'open_resume needs a candidate');
    let o = await look(session, env, signal);
    const open = resumeOverlay(o);
    // Already open: kept only if its header, read now without waiting, names this candidate; otherwise reopened at its top.
    if (open && !open.loading) {
      const mine = await confirmResumeIdentity(session, env, signal, o, name, { timeoutMs: 0, limits: options.capture });
      if (mine.ok) return result(true, trace, mine.observation);
    }
    if (open || requestDialog(o)) o = await closeOverlays(context, trace);
    if (o.pageClass !== 'conversation_detail') return result(false, trace, o, 'conversation_not_open');
    const link = (o.elements ?? []).find((e) => e.role === 'AXLink' && text(e) === '在线简历')
      ?? (o.elements ?? []).find((e) => text(e) === '在线简历');
    if (!link) return result(false, trace, o, 'online_resume_link_missing');
    const clicked = await clickElement(session, o, link, trace, signal);
    if (!delivered(clicked)) return result(false, trace, o, `resume_click_${clicked.status}`);
    // "正在加载简历" is not an open resume; wait for the image pane.
    const shown = await pollFor(session, env, signal, openTimeoutMs, (x) => {
      if (requestDialog(x)) return 'dialog' as const;
      const overlay = resumeOverlay(x);
      return overlay && !overlay.loading ? ('open' as const) : undefined;
    });
    if (shown.value === 'dialog') {
      await dismissRequestDialog(session, env, shown.observation, trace, signal);
      return result(false, trace, await look(session, env, signal), 'request_dialog');
    }
    if (shown.value !== 'open') return result(false, trace, shown.observation, shown.observation.pageClass === 'loading' ? 'resume_load_timeout' : 'resume_not_open');
    // BOSS 1.7.4 names nobody beside the resume; its image header does, read from this pane, waiting a bounded time for it to draw.
    const mine = await confirmResumeIdentity(session, env, signal, shown.observation, name, { timeoutMs: openTimeoutMs, limits: options.capture });
    return mine.ok ? result(true, trace, mine.observation) : result(false, trace, mine.observation, mine.reason);
  }

  async function advanceList(context: UnitContext): Promise<UnitRunResult> {
    const { session, signal } = context;
    const trace = new Trace();
    const account = needAccount(context);
    const o = await closeOverlays(context, trace);
    if (o.pageClass !== 'conversation_list' && o.pageClass !== 'conversation_detail') return result(false, trace, o, 'list_not_shown');
    if (listEnded(o)) return result(true, trace, o, 'end_reached');
    if (!listRows(o).length) return result(false, trace, o, 'list_empty_unconfirmed');
    const before = listCandidates(o, account, collisions).fingerprint;
    const win = o.window.frame;
    const column = { x: win.x + 140, y: win.y + 145, width: 380, height: Math.max(100, win.height - 160) };
    const moved = (x: Observation) => (listCandidates(x, account, collisions).fingerprint !== before ? true : undefined);
    let last = o;
    for (const lines of [5, 10]) {
      const r = await scrollOver(session, last, column, 'down', lines, trace, signal);
      if (r.status === 'failed' || r.status === 'stale_snapshot') return result(false, trace, last, `scroll_${r.status}`);
      const after = await pollFor(session, env, signal, 3_000, moved);
      last = after.observation;
      if (after.value) return result(true, trace, last);
    }
    if (listEnded(last)) return result(true, trace, last, 'end_reached');
    if (listContinues(last)) return result(false, trace, last, 'scroll_ineffective');
    if (listLoading(last)) return result(false, trace, last, 'list_still_loading');
    // Unmoved with the last row whole. The list ends only if a scroll up
    // moves it and a scroll down brings back exactly these rows.
    const up = await scrollOver(session, last, column, 'up', 5, trace, signal);
    if (up.status === 'failed' || up.status === 'stale_snapshot') return result(false, trace, last, `scroll_${up.status}`);
    const upper = await pollFor(session, env, signal, 3_000, moved);
    if (upper.value) {
      await scrollOver(session, upper.observation, column, 'down', 10, trace, signal);
      const back = await pollFor(session, env, signal, 3_000, (x) => (listCandidates(x, account, collisions).fingerprint === before ? true : undefined));
      if (!back.value || listLoading(back.observation)) return result(false, trace, back.observation, 'list_end_unconfirmed');
      rememberEnd(back.observation.snapshotId);
      return result(true, trace, back.observation, 'end_reached');
    }
    // It scrolls neither way and shows no end notice: a short list may still
    // be loading more, so the end is not proved.
    return result(false, trace, upper.observation, 'list_end_unconfirmed');
  }

  async function acquireResume(context: UnitContext, mode: CaptureMode): Promise<AcquisitionResult> {
    const { session, signal } = context;
    throwIfAborted(signal);
    if (!context.staging) return { status: 'failed', reason: 'no_staging_area' };
    const name = context.candidate?.name ?? context.item?.ref.name;
    if (!name) return { status: 'failed', reason: 'no_candidate' };
    const itemId = context.item?.id ?? context.staging.itemId;
    const trace = new Trace();
    if (mode === 'original-only' && !route.enabled)
      throw new RuntimeError('capability_missing', 'original-only needs a verified attachment download route, which macOS does not have yet');

    if (route.enabled) {
      const o = await look(session, env, signal);
      if (o.pageClass !== 'conversation_detail') await closeOverlays(context, trace);
      const attachment = await fetchAttachment({ session, env, staging: context.staging, itemId, candidateName: name, route, trace, signal });
      if (attachment.status === 'acquired' || mode === 'original-only') return attachment;
      // available: the online resume stands in for a missing attachment.
    }

    // The online resume is an image: without local OCR neither its identity nor its text can be read.
    if (!env.vision) return { status: 'failed', reason: 'local_vision_missing: the online resume is an image and needs local OCR' };
    let o = await look(session, env, signal);
    if (requestDialog(o)) {
      const dismissed = await dismissRequestDialog(session, env, o, trace, signal);
      if (!dismissed) return { status: 'failed', reason: 'request_dialog_not_dismissed' };
      o = await look(session, env, signal);
    }
    if (o.pageClass !== 'online_resume') {
      const opened = await openResume(context, trace);
      if (!opened.ok) {
        const reason = opened.reason ?? 'resume_not_open';
        return reason === 'request_dialog' ? { status: 'unavailable', reason: 'request_dialog' } : { status: 'failed', reason };
      }
    }
    return captureOnlineResume({ session, env, staging: context.staging, itemId, candidateName: name, trace, signal, limits: options.capture });
  }

  const workflow: BossWorkflow = {
    id: 'boss-resumes-v1',
    units: BOSS_RESUME_UNITS,
    classifyPage: (observation): BossPageClass => classifyPage(observation),
    // No account id is readable in the BOSS window on macOS (P0); the task binds one explicitly.
    readAccount: () => undefined,
    listCandidates: (observation, account) => listCandidates(observation, account, collisions),
    identify: (observation, ref, account) => identify(observation, ref, account, collisions),
    verifyUnit: (unit, context, observation): Promise<CheckResult> => verifyUnit(unit, context, observation, memory, { env, limits: options.capture }),
    runScripted(unit, context) {
      switch (unit) {
        case 'select_source':
          return selectSource(context);
        case 'enumerate_candidates':
          return (async () => {
            const trace = new Trace();
            const o = await look(context.session, env, context.signal);
            const ok = o.pageClass === 'conversation_list' || o.pageClass === 'conversation_detail';
            return result(ok, trace, o, ok ? undefined : 'list_not_shown');
          })();
        case 'open_candidate':
          return openCandidate(context);
        case 'open_resume':
          return openResume(context);
        case 'return_to_list':
          return (async () => {
            const trace = new Trace();
            const o = await closeOverlays(context, trace);
            const ok = !resumeOverlay(o) && !requestDialog(o) && (o.pageClass === 'conversation_list' || o.pageClass === 'conversation_detail');
            return result(ok, trace, o, ok ? undefined : 'list_not_restored');
          })();
        case 'advance_list':
          return advanceList(context);
        case 'acquire_resume':
        case 'persist_candidate':
          // acquireResume and the artifact store do these; there is no screen path to script.
          return undefined;
      }
    },
    acquireResume,
  };
  return workflow;
}
