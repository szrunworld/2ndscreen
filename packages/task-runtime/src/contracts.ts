// The shared vocabulary of the task runtime: what a task is, what the
// desktop reports, what an action asks for and what it did, how procedures
// earn trust, what counts as a delivered resume, and what the exploration
// bridge says. Every other module implements one of the interfaces here and
// receives the others through its factory, so modules can be built and
// tested apart. This file holds types, validators and small pure rules only;
// it imports nothing but Node built-ins.
//
// The factory each module exports is listed in docs/task-runtime-contracts.md.

import { isAbsolute } from 'node:path';

export const CONTRACT_VERSION = 1;

// ---------------------------------------------------------------------------
// Errors and validation results

/** Why a runtime operation failed. Callers branch on the code, not the text. */
export type RuntimeErrorCode =
  | 'invalid_input'
  | 'cancelled'
  | 'timeout'
  | 'model_unavailable'
  | 'budget_exhausted'
  | 'capability_missing'
  | 'permission_missing'
  | 'login_required'
  | 'snapshot_stale'
  | 'window_lost'
  | 'lease_held'
  | 'actor_busy'
  | 'forbidden_effect'
  | 'not_found'
  | 'conflict'
  | 'storage_full'
  | 'io';

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: RuntimeErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    this.details = details;
  }
}

export const isRuntimeError = (error: unknown, code?: RuntimeErrorCode): error is RuntimeError =>
  error instanceof RuntimeError && (code === undefined || error.code === code);

/** Throws `cancelled` if the signal has fired. Call before every side effect. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RuntimeError('cancelled', 'the operation was cancelled');
}

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** The value, or an `invalid_input` error listing every problem. */
export function assertValid<T>(result: Validated<T>, what: string): T {
  if (result.ok) return result.value;
  throw new RuntimeError('invalid_input', `${what}: ${result.errors.join('; ')}`, { errors: result.errors });
}

// ---------------------------------------------------------------------------
// Injected platform services

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program to completion. Kills it and rejects with `cancelled` when the signal fires. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: { env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
) => Promise<CommandResult>;

/** A long-lived child speaking JSON lines, for the exploration bridge. */
export interface LineProcess {
  readonly pid: number | undefined;
  write(line: string): void;
  closeInput(): void;
  lines(): AsyncIterable<string>;
  /** Resolves once the process has exited, with its exit code or signal. */
  exited(): Promise<{ code: number | null; signal: string | null }>;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
}

export type LineProcessSpawner = (file: string, args: readonly string[], env?: Record<string, string>) => LineProcess;

// ---------------------------------------------------------------------------
// Skill package and task input

export type CaptureMode = 'available' | 'original-only';
export type ResumeSource = 'conversations' | 'recommend';
export type EffectClass = 'read' | 'navigation' | 'artifact' | 'external-submit';
export const EFFECT_CLASSES: readonly EffectClass[] = ['read', 'navigation', 'artifact', 'external-submit'];

/** The machine-checked part of a skill: skills/<name>/task.json. */
export interface TaskSpec {
  schemaVersion: 1;
  id: string;
  version: string;
  platforms: Array<'macos'>;
  application: string;
  windowProfile: string;
  workflow: string;
  inputSchema: string;
  capabilities: string[];
  submitAllowed: boolean;
  foregroundAllowed: boolean;
  learning: { promoteAfterSuccesses: number };
  defaults: { captureMode: CaptureMode; analysis: 'off' | 'on' };
}

/** Input of boss.collect-resumes (inputSchema collect-resumes-input-v1). */
export interface CollectResumesInput {
  /** Text the job title must match. Several matches stop the task to ask, never take the first. */
  job: string;
  /** Committed candidates that make the task succeed. */
  requestedCount: number;
  /** Absolute directory; the task writes under <outputDir>/<taskId>/. */
  outputDir: string;
  source: ResumeSource;
  captureMode: CaptureMode;
  /** Candidates to look at before stopping with browse_limit. */
  browseLimit?: number;
  /** ISO time after which no new candidate is started. */
  deadline?: string;
  budget?: Partial<Budget>;
  /** Use a BOSS直聘 the runtime did not launch. */
  takeOver?: boolean;
  /** Leave the window on the agent screen when the task ends. */
  keepWindow?: boolean;
  analysis?: 'off' | 'on';
}

// ---------------------------------------------------------------------------
// Task, work item and their lifecycles

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'waiting_user'
  | 'cancelling'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type TaskPhase = 'preparing' | 'learning' | 'executing' | 'repairing' | 'finalizing';

export type WaitReason =
  | 'login_required'
  | 'captcha'
  | 'job_ambiguous'
  | 'account_changed'
  | 'model_unavailable'
  | 'budget_exhausted'
  | 'capability_missing'
  | 'permission_missing'
  | 'window_moved'
  | 'storage_full';

export type TerminationReason =
  | 'target_reached'
  | 'source_exhausted'
  | 'browse_limit'
  | 'deadline'
  | 'budget_exhausted'
  | 'cancelled'
  | 'fatal_error';

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['succeeded', 'partial', 'failed', 'cancelled'];

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['running', 'cancelling', 'cancelled', 'failed'],
  running: ['paused', 'waiting_user', 'cancelling', 'succeeded', 'partial', 'failed'],
  paused: ['running', 'cancelling', 'failed'],
  waiting_user: ['running', 'paused', 'cancelling', 'partial', 'failed'],
  cancelling: ['cancelled', 'failed'],
  succeeded: [],
  partial: [],
  failed: [],
  cancelled: [],
};

export const canTransitionTask = (from: TaskStatus, to: TaskStatus): boolean => TASK_TRANSITIONS[from].includes(to);

export interface TaskCounts {
  requested: number;
  /** Candidates opened or attempted. */
  browsed: number;
  /** Committed items whose artifacts satisfy the capture mode: the only success count. */
  committed: number;
  unavailable: number;
  failed: number;
  ambiguous: number;
  /** Saved for diagnosis but not counted, such as partial_capture. */
  diagnostic: number;
}

export interface TaskRecord {
  id: string;
  skillId: string;
  skillVersion: string;
  input: CollectResumesInput;
  status: TaskStatus;
  phase?: TaskPhase;
  waitReason?: WaitReason;
  terminationReason?: TerminationReason;
  account?: AccountScope;
  counts: TaskCounts;
  error?: { code: RuntimeErrorCode; message: string };
  createdAt: string;
  updatedAt: string;
}

/** Where to pick up after a pause, crash or user wait. Written before every new candidate. */
export interface TaskCheckpoint {
  taskId: string;
  /** The unit the task was in, so resume re-enters that unit's entry checks. */
  unit?: string;
  itemId?: string;
  /** Opaque source position from the workflow, e.g. list fingerprint plus scroll offset. */
  cursor?: string;
  lastCommittedItemId?: string;
  updatedAt: string;
}

export type WorkItemStatus =
  | 'discovered'
  | 'processing'
  | 'acquired'
  | 'validated'
  | 'committed'
  | 'unavailable'
  | 'failed'
  | 'ambiguous';

const ITEM_TRANSITIONS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  discovered: ['processing', 'unavailable', 'ambiguous'],
  processing: ['acquired', 'unavailable', 'failed', 'ambiguous', 'discovered'],
  acquired: ['validated', 'failed', 'ambiguous', 'processing'],
  validated: ['committed', 'failed', 'processing'],
  committed: [],
  unavailable: [],
  failed: ['processing'],
  ambiguous: [],
};

/**
 * Whether a work item may move from one status to another. `processing` may
 * return to `discovered` when a crash leaves it unchecked, and `failed` may be
 * retried; `committed` is final, so a committed file is never fetched again.
 */
export const canTransitionWorkItem = (from: WorkItemStatus, to: WorkItemStatus): boolean =>
  ITEM_TRANSITIONS[from].includes(to);

// ---------------------------------------------------------------------------
// Account and candidate identity

/** The BOSS account a task is bound to. Candidate keys and cursors never cross accounts. */
export interface AccountScope {
  platform: 'boss';
  /** Stable key: a visible account id, or a key the user bound explicitly. */
  accountKey: string;
  binding: 'observed' | 'explicit';
  displayHint?: string;
}

/** What a list row shows about a candidate. Valid only for the observation it came from. */
export interface CandidateRef {
  /** Row identity within the source, e.g. name+job+time; not a permanent id. */
  sourceRef: string;
  name: string;
  jobTitle?: string;
  hints: string[];
  /** Element to open the row, bound to `snapshotId`. Re-locate after any other observation. */
  locator?: Locator;
  snapshotId?: string;
}

export type IdentityConfidence = 'platform_id' | 'strong' | 'weak';

export interface CandidateIdentity {
  /** Internal id, also the folder name under candidates/. Must pass safePathSegment. */
  candidateId: string;
  accountKey: string;
  /** An identifier the platform itself shows, when there is one. */
  platformId?: string;
  /** Hash of the evidence used when no platform id is visible. */
  fingerprint: string;
  confidence: IdentityConfidence;
  evidence: string[];
}

/** The deduplication key of a candidate: account scope plus platform id or fingerprint. */
export const candidateDedupeKey = (identity: Pick<CandidateIdentity, 'accountKey' | 'platformId' | 'fingerprint'>): string =>
  identity.platformId
    ? `${identity.accountKey}:id:${identity.platformId}`
    : `${identity.accountKey}:fp:${identity.fingerprint}`;

/** A list identity checked against the detail page before any file is attributed. */
export type IdentityMatch =
  | { kind: 'match'; identity: CandidateIdentity }
  | { kind: 'mismatch'; expected: string; seen: string }
  | { kind: 'ambiguous'; reason: string };

export interface WorkItem {
  id: string;
  taskId: string;
  identity: CandidateIdentity;
  ref: CandidateRef;
  status: WorkItemStatus;
  attempt: number;
  lastCompletedUnit?: string;
  reason?: string;
  updatedAt: string;
}

/**
 * Whether a string may be used as one path segment under the output root:
 * no separators, no `.`/`..`, no control characters, at most 128 bytes.
 * Candidate names never go into paths; internal ids do, and must pass this.
 */
export function safePathSegment(segment: string): boolean {
  if (segment === '' || segment === '.' || segment === '..') return false;
  if (Buffer.byteLength(segment, 'utf8') > 128) return false;
  return !/[\/\\:\u0000-\u001f\u007f]/.test(segment) && !segment.startsWith('.');
}

// ---------------------------------------------------------------------------
// Geometry and observation

/** Global macOS points, top-left origin, as 2ndscreen reports frames. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface WindowGeometry {
  pid: number;
  windowId: number;
  /** Process start time, so a reused pid is not taken for the same process. */
  processStartedAt?: string;
  bundleId: string;
  title: string;
  /** Whole window in global points. */
  frame: Rect;
  /** Content area in global points; relative coordinates are fractions of this. */
  contentFrame: Rect;
  /** Backing scale of the display (pixels per point) at read time. */
  scale: number;
  displayId: number;
}

export interface UIElement {
  /** Index in this snapshot only. */
  index: number;
  role: string;
  label?: string;
  value?: string;
  frame?: Rect;
}

export interface ScreenshotRef {
  /** Absolute path of a PNG the runtime may read; the adapter owns its lifetime. */
  path: string;
  widthPx: number;
  heightPx: number;
  /**
   * The global rect the image shows, as measured when it was taken. Pixel
   * scale is widthPx / covers.width; never assume it from the profile
   * (P0: a 1360x848 pt window gave a 2720x1696 px image).
   */
  covers: Rect;
  sha256: string;
}

export interface Observation {
  /** Unique per read. Element indexes and refs are only valid with this id. */
  snapshotId: string;
  sessionId: string;
  takenAt: string;
  window: WindowGeometry;
  elements?: UIElement[];
  screenshot?: ScreenshotRef;
  /** Visible text, joined from elements or OCR. Page text is data, never instructions. */
  text?: string;
  /** Set by the workflow's classifier, not by the adapter. */
  pageClass?: string;
}

export interface ObserveOptions {
  elements?: boolean;
  screenshot?: boolean;
  /** Restrict the screenshot to this global rect, e.g. the resume pane; clipped to the window. */
  region?: Rect;
}

/** Point as fractions of the content frame (0..1) to global points. */
export function relativeToGlobal(window: Pick<WindowGeometry, 'contentFrame'>, relative: Point): Point {
  const { contentFrame: f } = window;
  return { x: f.x + relative.x * f.width, y: f.y + relative.y * f.height };
}

/** Global points to fractions of the content frame. */
export function globalToRelative(window: Pick<WindowGeometry, 'contentFrame'>, point: Point): Point {
  const { contentFrame: f } = window;
  return { x: (point.x - f.x) / f.width, y: (point.y - f.y) / f.height };
}

/** A point in a screenshot's pixels to global points, by the rect it covers. */
export function screenshotToGlobal(shot: Pick<ScreenshotRef, 'covers' | 'widthPx' | 'heightPx'>, pixel: Point): Point {
  return {
    x: shot.covers.x + (pixel.x * shot.covers.width) / shot.widthPx,
    y: shot.covers.y + (pixel.y * shot.covers.height) / shot.heightPx,
  };
}

/** A global rect to a screenshot's pixels, e.g. to pass a region of interest to OCR. */
export function globalToScreenshotRect(shot: Pick<ScreenshotRef, 'covers' | 'widthPx' | 'heightPx'>, rect: Rect): Rect {
  const sx = shot.widthPx / shot.covers.width;
  const sy = shot.heightPx / shot.covers.height;
  return { x: (rect.x - shot.covers.x) * sx, y: (rect.y - shot.covers.y) * sy, width: rect.width * sx, height: rect.height * sy };
}

/** A model's 0..1000 normalized screenshot coordinate to global points. */
export function normalizedToGlobal(window: Pick<WindowGeometry, 'frame'>, normalized: Point): Point {
  return {
    x: window.frame.x + (normalized.x / 1000) * window.frame.width,
    y: window.frame.y + (normalized.y / 1000) * window.frame.height,
  };
}

export const rectContains = (rect: Rect, point: Point): boolean =>
  point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;

// ---------------------------------------------------------------------------
// Locators, actions and results

/**
 * How to find a target, tried in the order a procedure lists them.
 * `element` with `index` is bound to one snapshot; with role/label it is
 * re-resolved on each fresh read. `relative` is a fraction of the content
 * frame. `template` and `ocr` are resolved by a local vision provider.
 */
export type Locator =
  | { kind: 'element'; role?: string; label?: string; labelPattern?: string; index?: number; within?: Rect }
  | { kind: 'relative'; point: Point }
  | { kind: 'template'; templateId: string; region?: Rect; offset?: Point }
  | { kind: 'ocr'; text: string; region?: Rect };

export type Action =
  | { kind: 'click'; target: Locator; button?: 'left' | 'right'; count?: 1 | 2; effect: EffectClass }
  | { kind: 'type'; target?: Locator; value: string; replace?: boolean; effect: EffectClass }
  | { kind: 'key'; key: string; modifiers?: Array<'cmd' | 'shift' | 'option' | 'ctrl'>; effect: EffectClass }
  | { kind: 'scroll'; target?: Locator; direction: 'up' | 'down' | 'left' | 'right'; amount?: number; by?: 'line' | 'page'; effect: EffectClass };

/** An action and the snapshot whose element indexes it refers to. */
export interface ActionRequest {
  actionId: string;
  action: Action;
  /** Required when any locator uses an element index. */
  snapshotId?: string;
}

/**
 * - `ok`: delivered and, when the request had an expectation, verified.
 * - `no_effect`: delivered but the page did not change; counts as a failure.
 * - `stale_snapshot`: refused because the snapshot is no longer current.
 * - `unknown`: delivered and the outcome cannot be told; never resend an
 *   external-submit action whose result is unknown.
 */
export type ActionStatus = 'ok' | 'no_effect' | 'failed' | 'stale_snapshot' | 'unknown';

export type InputRoute = 'element' | 'coordinate' | 'keyboard';

export interface ActionResult {
  actionId: string;
  status: ActionStatus;
  route?: InputRoute;
  /** The global point used, when the route was a coordinate. */
  point?: Point;
  /** The locator alternative that resolved, by position in the list. */
  locatorIndex?: number;
  beforeSnapshotId?: string;
  afterSnapshotId?: string;
  startedAt: string;
  finishedAt: string;
  /** Whether the user's foreground app or real pointer changed during the action. */
  focusChanged?: boolean;
  error?: { code: RuntimeErrorCode; message: string };
}

// ---------------------------------------------------------------------------
// Conditions and bounded waits

/**
 * A check over one observation, or over the output directory. Composite
 * conditions nest at most four levels.
 */
export type Condition =
  | { kind: 'element'; locator: Locator; present: boolean }
  | { kind: 'text'; pattern: string; present: boolean }
  | { kind: 'page'; pageClass: string }
  | { kind: 'window'; bundleId?: string; titlePattern?: string; present: boolean }
  | { kind: 'file'; path: string; minBytes?: number; stableMs?: number }
  | { kind: 'all'; conditions: Condition[] }
  | { kind: 'any'; conditions: Condition[] };

export const WAIT_LIMITS = { maxTimeoutMs: 120_000, minPollMs: 50, maxPollMs: 5_000 } as const;

export interface WaitSpec {
  condition: Condition;
  timeoutMs: number;
  pollMs?: number;
}

export interface CheckResult {
  ok: boolean;
  /** The observation the verdict was made on, when it was a screen check. */
  snapshotId?: string;
  /** Short, redacted reasons; never raw page text of a candidate. */
  evidence: string[];
  /** For waits: how long it took, or the timeout when `ok` is false. */
  elapsedMs?: number;
}

// ---------------------------------------------------------------------------
// Session and desktop adapter (A1)

/** Size and environment a window must match before work starts. */
export interface WindowProfile {
  id: string;
  version: number;
  logicalWidth: number;
  logicalHeight: number;
  bundleId: string;
  /** Recorded at bind time from the real window, never assumed. */
  appVersion?: string;
  locale?: string;
}

export interface AdapterCapabilities {
  /** 2ndscreen CLI/app version string. */
  version: string;
  backgroundClick: boolean;
  backgroundScroll: boolean;
  backgroundType: boolean;
  screenshot: boolean;
  accessibility: boolean;
  screenRecordingPermission: boolean;
  accessibilityPermission: boolean;
}

/** One app window on one agent screen, as 2ndscreen knows it right now. */
export interface WindowBinding {
  screenId: string;
  socket: string;
  window: WindowGeometry;
  /** Whether the runtime launched the app (and may quit it) or attached to it. */
  launchedByRuntime: boolean;
}

/** Thin, stateless wrapper around the 2ndscreen CLI/socket. */
export interface DesktopAdapter {
  capabilities(signal?: AbortSignal): Promise<AdapterCapabilities>;
  ensureScreen(profile: WindowProfile, signal?: AbortSignal): Promise<{ screenId: string; socket: string }>;
  /** Launch the app onto the screen, or attach to a running one if `takeOver`. */
  bindApp(screenId: string, profile: WindowProfile, options: { takeOver: boolean }, signal?: AbortSignal): Promise<WindowBinding>;
  observe(binding: WindowBinding, options: ObserveOptions, signal?: AbortSignal): Promise<Observation>;
  /** Deliver one action. Never retries; the caller decides. */
  act(binding: WindowBinding, request: ActionRequest, signal?: AbortSignal): Promise<ActionResult>;
  releaseWindow(binding: WindowBinding, signal?: AbortSignal): Promise<void>;
}

export type LeaseHolder = 'runtime' | 'bridge' | 'legacy-assistant';

/**
 * Exclusive right to drive one app. The account part of the scope is kept for
 * resume and audit, but does not make leases independent: BOSS直聘 runs as a
 * single instance, so any two leases on the same bundle id overlap.
 */
export interface SessionLease {
  leaseId: string;
  /** leaseScopeKey(bundleId, accountKey): "com.zhipin.www:<accountKey>", or "com.zhipin.www:*" before the account is known. */
  scopeKey: string;
  holder: LeaseHolder;
  ownerPid: number;
  taskId?: string;
  expiresAt: string;
}

/** "<bundleId>:<accountKey>", or "<bundleId>:*" when the account is not known yet. */
export function leaseScopeKey(bundleId: string, accountKey?: string): string {
  if (!bundleId || bundleId.includes(':')) throw new RuntimeError('invalid_input', `bad bundle id ${bundleId}`);
  return `${bundleId}:${accountKey ?? '*'}`;
}

/**
 * Whether two lease scopes contend for the same app. They do whenever the
 * bundle ids match, whatever the account parts: "app:*" overlaps "app:acct1",
 * and "app:acct1" overlaps "app:acct2", because one app process can only be
 * driven by one session at a time.
 */
export function leaseScopesOverlap(a: string, b: string): boolean {
  const app = (key: string) => {
    const colon = key.lastIndexOf(':');
    return colon < 0 ? key : key.slice(0, colon);
  };
  return app(a) === app(b);
}

/** Durable lease bookkeeping; implemented by the TaskStore. */
export interface LeaseStore {
  /**
   * Throws `lease_held` if another unexpired lease's scope overlaps the
   * request's scope by leaseScopesOverlap (not only an equal scope key).
   * Check and insert happen in one transaction.
   */
  acquireLease(request: Omit<SessionLease, 'leaseId' | 'expiresAt'> & { ttlMs: number }): Promise<SessionLease>;
  renewLease(leaseId: string, ttlMs: number): Promise<SessionLease>;
  releaseLease(leaseId: string): Promise<void>;
}

export interface OpenSessionRequest {
  taskId: string;
  profile: WindowProfile;
  takeOver: boolean;
  /** Bound account, if the task already has one; a different visible account fails with login_required. */
  account?: AccountScope;
  leaseTtlMs: number;
}

/** Proof that the caller is the only actor; revoked when the grant's function returns. */
export interface ActorGrant {
  readonly holder: Exclude<LeaseHolder, 'runtime'>;
  readonly binding: WindowBinding;
  readonly signal: AbortSignal;
}

export interface Session {
  readonly id: string;
  readonly taskId: string;
  readonly profile: WindowProfile;
  readonly lease: SessionLease;
  binding(): WindowBinding;
  observe(options?: ObserveOptions, signal?: AbortSignal): Promise<Observation>;
  /**
   * Deliver an action. Refuses with `stale_snapshot` if an element-index
   * locator refers to an older snapshot, `forbidden_effect` for
   * external-submit when not allowed, and `actor_busy` while a grant is out.
   */
  act(request: ActionRequest, signal?: AbortSignal): Promise<ActionResult>;
  /** Evaluate a condition against an observation (file conditions read disk). */
  check(condition: Condition, observation: Observation, signal?: AbortSignal): Promise<CheckResult>;
  /** Poll fresh observations until the condition holds or the bounded timeout passes. */
  waitFor(spec: WaitSpec, signal?: AbortSignal): Promise<CheckResult>;
  /** Find the app window again after it was replaced or the screen was rebuilt. */
  rebind(signal?: AbortSignal): Promise<WindowBinding>;
  /**
   * Hand the window to another actor (the exploration bridge). `act` refuses
   * until `fn` settles and, if aborted, until the actor is confirmed stopped.
   */
  withExclusiveActor<T>(holder: ActorGrant['holder'], fn: (grant: ActorGrant) => Promise<T>, signal?: AbortSignal): Promise<T>;
  close(policy: { keepWindow: boolean }): Promise<void>;
}

export interface SessionManager {
  open(request: OpenSessionRequest, signal?: AbortSignal): Promise<Session>;
}

// ---------------------------------------------------------------------------
// Local vision (A8): on-device OCR and image comparison, no model, no input

/** Coordinates are pixels of the image passed in. */
export interface OcrLine {
  text: string;
  box: Rect;
  /** 0..1 as the recognizer reports it. */
  confidence: number;
}

export interface OcrResult {
  lines: OcrLine[];
  imageSha256: string;
  widthPx: number;
  heightPx: number;
}

/** How a screenshot taken after a scroll relates to the one before it. */
export interface ImageComparison {
  /** 0..1; 1 means pixel-identical inside the region. */
  similarity: number;
  /**
   * How far content moved up, in pixels, if a shift was found. 0 or
   * undefined with high similarity means the scroll made no progress, which
   * only prompts an end check; it is not proof of the end.
   */
  verticalShiftPx?: number;
}

export interface TemplateMatch {
  box: Rect;
  score: number;
}

/**
 * Reads images the runtime already has. Never takes screenshots, never sends
 * input and never calls a model. Every method accepts a region of interest
 * in the image's pixels.
 */
export interface LocalVision {
  ocr(imagePath: string, options?: { roi?: Rect; languages?: string[] }, signal?: AbortSignal): Promise<OcrResult>;
  compare(beforePath: string, afterPath: string, options?: { roi?: Rect }, signal?: AbortSignal): Promise<ImageComparison>;
  /** Optional: resolve `template` locators. Absent means template locators fail with capability_missing. */
  findTemplate?(imagePath: string, templateId: string, options?: { roi?: Rect; minScore?: number }, signal?: AbortSignal): Promise<TemplateMatch | undefined>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Budgets and telemetry (A6 implements the recorder)

export interface Budget {
  localRecoveriesPerStep: number;
  modelRoundsPerRepair: number;
  modelRepairsPerItem: number;
  taskModelCalls: number;
  /** undefined: no token cap. */
  taskTokens?: number;
  wallClockMs: number;
}

export const DEFAULT_BUDGET: Budget = {
  localRecoveriesPerStep: 2,
  modelRoundsPerRepair: 6,
  modelRepairsPerItem: 2,
  taskModelCalls: 60,
  wallClockMs: 4 * 60 * 60 * 1000,
};

/** Token counts the model service did not report are 'unknown', never 0. */
export type TokenCount = number | 'unknown';

export const addTokens = (a: TokenCount, b: TokenCount): TokenCount =>
  a === 'unknown' || b === 'unknown' ? 'unknown' : a + b;

export type ModelPurpose = 'ui' | 'repair' | 'analysis';

/** Why a model was called; every call must name one. */
export type ModelCallReason = 'missing_procedure' | 'replay_failed' | 'postcondition_failed' | 'recovery_exhausted' | 'analysis';

export interface Usage {
  uiModelCalls: number;
  repairModelCalls: number;
  analysisModelCalls: number;
  inputTokens: TokenCount;
  outputTokens: TokenCount;
  screenshots: number;
  ocrCalls: number;
  replayedUnits: number;
  exploredUnits: number;
  localRecoveries: number;
  elapsedMs: number;
}

export const emptyUsage = (): Usage => ({
  uiModelCalls: 0,
  repairModelCalls: 0,
  analysisModelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  screenshots: 0,
  ocrCalls: 0,
  replayedUnits: 0,
  exploredUnits: 0,
  localRecoveries: 0,
  elapsedMs: 0,
});

export type TelemetryEvent =
  | { type: 'model_call'; purpose: ModelPurpose; reason: ModelCallReason; unit?: string; itemId?: string; inputTokens: TokenCount; outputTokens: TokenCount }
  | { type: 'screenshot' }
  | { type: 'ocr' }
  | { type: 'unit'; unit: string; route: 'replay' | 'scripted' | 'explore' | 'repair'; ok: boolean; elapsedMs: number }
  | { type: 'local_recovery'; unit: string; ok: boolean };

export interface TelemetryRecorder {
  record(event: TelemetryEvent): void;
  usage(): Usage;
}

export type BudgetCheck = { ok: true } | { ok: false; exhausted: 'model_calls' | 'tokens' | 'wall_clock' };

/**
 * Whether the task may spend more. With a token cap configured, an unknown
 * token count is treated as exhausted, since spend under the cap cannot be
 * shown; without a cap, unknown tokens are fine and calls and time still bound.
 */
export function checkBudget(budget: Budget, usage: Usage): BudgetCheck {
  const calls = usage.uiModelCalls + usage.repairModelCalls + usage.analysisModelCalls;
  if (calls >= budget.taskModelCalls) return { ok: false, exhausted: 'model_calls' };
  if (budget.taskTokens !== undefined) {
    const tokens = addTokens(usage.inputTokens, usage.outputTokens);
    if (tokens === 'unknown' || tokens >= budget.taskTokens) return { ok: false, exhausted: 'tokens' };
  }
  if (usage.elapsedMs >= budget.wallClockMs) return { ok: false, exhausted: 'wall_clock' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Artifacts (A2)

export type ArtifactKind =
  /** The attachment's original bytes. */
  | 'original'
  /** One screen of the online resume. */
  | 'captured_page'
  /** Pages stitched into one image. */
  | 'captured_image'
  | 'resume_text'
  | 'metadata'
  | 'diagnostic';

export type ArtifactCompleteness = 'complete' | 'partial_capture' | 'unverified' | 'invalid';

/** Evidence about how an online-resume capture ended. */
export interface CaptureEvidence {
  pages: number;
  topConfirmed: boolean;
  /** Independent signs the bottom was reached. Identical screens alone are not one. */
  bottomSignals: Array<'scroll_position_end' | 'end_marker' | 'content_terminated'>;
  stop: 'bottom_confirmed' | 'page_limit' | 'scroll_ineffective' | 'stitch_gap' | 'cancelled';
}

/**
 * Completeness of an online capture: complete only when the top was
 * confirmed, the capture stopped at the bottom, and at least two distinct
 * bottom signals agree. A page limit or an ineffective scroll is partial.
 */
export function captureCompleteness(evidence: CaptureEvidence): ArtifactCompleteness {
  if (evidence.pages < 1) return 'invalid';
  const signals = new Set(evidence.bottomSignals);
  if (evidence.topConfirmed && evidence.stop === 'bottom_confirmed' && signals.size >= 2) return 'complete';
  return 'partial_capture';
}

export interface FileValidation {
  exists: boolean;
  bytes: number;
  sizeStable: boolean;
  /** Content type sniffed from the header, e.g. application/pdf, image/png. */
  sniffedType?: string;
  /** PDFs: page count from a parser. */
  pageCount?: number;
  sha256?: string;
  problems: string[];
}

/** A file written into an item's staging directory, not yet archived. */
export interface StagedArtifact {
  itemId: string;
  kind: ArtifactKind;
  /** Absolute path inside the staging directory. */
  path: string;
  capture?: CaptureEvidence;
}

export interface ArtifactRecord {
  id: string;
  itemId: string;
  kind: ArtifactKind;
  /** Path relative to <outputDir>/<taskId>/. */
  relativePath: string;
  sha256: string;
  bytes: number;
  completeness: ArtifactCompleteness;
  validation: FileValidation;
  capture?: CaptureEvidence;
  /** Procedure versions that produced it, for audit. */
  procedureIds: string[];
  acquiredAt: string;
}

/**
 * Whether an item's artifacts make it count toward the requested number.
 * available: a complete original or a complete captured image.
 * original-only: a complete original only. Partial captures never count.
 */
export function isCountable(artifacts: ReadonlyArray<Pick<ArtifactRecord, 'kind' | 'completeness'>>, mode: CaptureMode): boolean {
  return artifacts.some(
    (a) => a.completeness === 'complete' && (a.kind === 'original' || (mode === 'available' && a.kind === 'captured_image')),
  );
}

export interface StagingArea {
  itemId: string;
  /** Absolute, unique per item attempt, on the output filesystem. */
  dir: string;
}

export interface ReconcileReport {
  /** Archived on disk, missing in the ledger: re-inserted from manifest/hash. */
  adopted: string[];
  /** In the ledger, missing or changed on disk: item moved back for re-validation. */
  invalidated: string[];
  /** Staging directories removed; temporary files never count. */
  discardedStaging: string[];
}

export interface ArtifactStore {
  readonly root: string;
  stage(itemId: string, signal?: AbortSignal): Promise<StagingArea>;
  validate(staged: StagedArtifact, signal?: AbortSignal): Promise<FileValidation>;
  /**
   * Move a validated file into candidates/<candidateId>/ with an atomic
   * rename on the same filesystem and return its record. Does not touch the
   * ledger; the caller commits the record with TaskStore.commitItem.
   */
  archive(staged: StagedArtifact, identity: CandidateIdentity, validation: FileValidation, procedureIds: string[], signal?: AbortSignal): Promise<ArtifactRecord>;
  /** Rewrite manifest.json, index.csv and failures.json from the ledger. */
  writeIndex(task: TaskRecord, items: WorkItem[], artifacts: ArtifactRecord[], signal?: AbortSignal): Promise<void>;
  reconcile(store: TaskStore, taskId: string, signal?: AbortSignal): Promise<ReconcileReport>;
}

// ---------------------------------------------------------------------------
// Ledger (A2)

export type TaskEvent = {
  taskId: string;
  itemId?: string;
  unit?: string;
  stepId?: string;
  type: string;
  at: string;
  result?: 'ok' | 'failed' | 'skipped';
  /** Path or id of evidence; never raw candidate content. */
  evidenceRef?: string;
  detail?: Record<string, unknown>;
};

export interface TaskPatch {
  phase?: TaskPhase;
  waitReason?: WaitReason | null;
  terminationReason?: TerminationReason;
  account?: AccountScope;
  error?: { code: RuntimeErrorCode; message: string } | null;
}

export interface TaskStore extends LeaseStore, ProcedureRepository {
  createTask(spec: Pick<TaskSpec, 'id' | 'version'>, input: CollectResumesInput): Promise<TaskRecord>;
  getTask(taskId: string): Promise<TaskRecord | undefined>;
  listTasks(filter?: { status?: TaskStatus[] }): Promise<TaskRecord[]>;
  /** Throws `conflict` if the move is not allowed by canTransitionTask or `from` does not match. */
  transitionTask(taskId: string, to: TaskStatus, patch?: TaskPatch, from?: TaskStatus): Promise<TaskRecord>;
  saveCheckpoint(checkpoint: TaskCheckpoint): Promise<void>;
  getCheckpoint(taskId: string): Promise<TaskCheckpoint | undefined>;
  /** Idempotent on candidateDedupeKey within the task: returns the existing item if known. */
  upsertWorkItem(taskId: string, identity: CandidateIdentity, ref: CandidateRef): Promise<WorkItem>;
  transitionWorkItem(itemId: string, to: WorkItemStatus, patch?: { lastCompletedUnit?: string; reason?: string }): Promise<WorkItem>;
  listWorkItems(taskId: string, filter?: { status?: WorkItemStatus[] }): Promise<WorkItem[]>;
  /**
   * In one transaction: insert the artifact records and move the item to
   * `committed` if isCountable for the task's capture mode; otherwise keep
   * the artifacts as diagnostic and move the item to `failed` with a reason.
   */
  commitItem(itemId: string, artifacts: ArtifactRecord[]): Promise<{ item: WorkItem; counted: boolean }>;
  listArtifacts(taskId: string, itemId?: string): Promise<ArtifactRecord[]>;
  appendEvent(event: TaskEvent): Promise<void>;
  listEvents(taskId: string, filter?: { itemId?: string; limit?: number }): Promise<TaskEvent[]>;
  /** Recomputed from work items, not kept as a separate counter. */
  counts(taskId: string): Promise<TaskCounts>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Procedures V2 (A3)

export type ProcedureStatus = 'seeded' | 'trial' | 'stable' | 'degraded' | 'retired';

/** Which environment a procedure's evidence applies to. Different keys never share counters. */
export interface ProcedureKey {
  skill: string;
  skillVersion: string;
  unit: string;
  platform: 'macos';
  appVersion: string;
  profile: string;
  /** Resume branch or page variant, e.g. "attachment" or "online". */
  branch?: string;
}

export const procedureKeyString = (k: ProcedureKey): string =>
  [k.skill, k.skillVersion, k.unit, k.platform, k.appVersion, k.profile, k.branch ?? '-'].join('|');

/** Slot syntax inside action strings and locator labels: {{name}}. */
export const SLOT_PATTERN = /\{\{([a-zA-Z][a-zA-Z0-9_.]*)\}\}/g;

export interface ProcedureStep {
  id: string;
  /** Action with {{slot}} references; locators listed in order of preference. */
  action: Action;
  /** Alternatives tried after the action's own target, in order. */
  fallbacks?: Locator[];
  expect?: WaitSpec;
}

export interface ProcedureCounters {
  /** All verified successful runs on this version, for audit. */
  successes: number;
  failures: number;
  /**
   * Distinct work items that succeeded since the last failure, oldest first:
   * the promotion streak. Any failure, even below the degrade threshold,
   * empties it.
   */
  successItemIds: string[];
  consecutiveFailures: number;
}

export interface ProcedureV2 {
  schemaVersion: 2;
  id: string;
  key: ProcedureKey;
  /** Increases by one per new definition under the same key. */
  version: number;
  parentVersion?: number;
  status: ProcedureStatus;
  source: 'seed' | 'learned' | 'repair' | 'v1-import';
  parameters: string[];
  preconditions: Condition[];
  postconditions: Condition[];
  steps: ProcedureStep[];
  counters: ProcedureCounters;
  createdAt: string;
  updatedAt: string;
}

export interface ProcedureRepository {
  /** All versions under a key, newest first. */
  listProcedures(key: ProcedureKey): Promise<ProcedureV2[]>;
  getProcedure(id: string): Promise<ProcedureV2 | undefined>;
  /** Insert a new version; throws `conflict` if (key, version) exists. */
  insertProcedure(procedure: ProcedureV2): Promise<void>;
  /** Replace status and counters only; the definition of a version never changes. */
  updateProcedureState(id: string, state: Pick<ProcedureV2, 'status' | 'counters' | 'updatedAt'>): Promise<ProcedureV2>;
}

export interface PromotionRule {
  /** Distinct work items that must succeed in a row, with no failure between, before trial becomes stable. */
  promoteAfterSuccesses: number;
  /** Consecutive failures that degrade a stable or trial version. */
  degradeAfterFailures: number;
}

export const DEFAULT_PROMOTION: PromotionRule = { promoteAfterSuccesses: 3, degradeAfterFailures: 1 };

/**
 * The state of a procedure after one verified run on one work item.
 * A success on an item already in the streak adds nothing toward promotion.
 * seeded/trial become stable after `promoteAfterSuccesses` distinct items
 * succeed consecutively; any failure resets that streak, even when it is
 * below `degradeAfterFailures`;
 * a seeded version that succeeds once becomes trial. Failures degrade after
 * `degradeAfterFailures` in a row; a degraded version does not run again
 * until a repair inserts a new trial version. Retired stays retired.
 */
export function nextProcedureState(
  procedure: Pick<ProcedureV2, 'status' | 'counters'>,
  outcome: { itemId: string; ok: boolean },
  rule: PromotionRule = DEFAULT_PROMOTION,
): Pick<ProcedureV2, 'status' | 'counters'> {
  const c = procedure.counters;
  if (procedure.status === 'retired' || procedure.status === 'degraded') return { status: procedure.status, counters: c };
  if (!outcome.ok) {
    const counters = { ...c, failures: c.failures + 1, consecutiveFailures: c.consecutiveFailures + 1, successItemIds: [] };
    return { status: counters.consecutiveFailures >= rule.degradeAfterFailures ? 'degraded' : procedure.status, counters };
  }
  const fresh = !c.successItemIds.includes(outcome.itemId);
  const counters = {
    ...c,
    successes: c.successes + 1,
    consecutiveFailures: 0,
    successItemIds: fresh ? [...c.successItemIds, outcome.itemId] : c.successItemIds,
  };
  if (procedure.status === 'stable') return { status: 'stable', counters };
  if (counters.successItemIds.length >= rule.promoteAfterSuccesses) return { status: 'stable', counters };
  return { status: 'trial', counters };
}

/** Values for slots, e.g. { "candidate.name": "张三" }. */
export type Bindings = Readonly<Record<string, string>>;

export interface ReplayResult {
  status: 'succeeded' | 'precondition_failed' | 'step_failed' | 'postcondition_failed' | 'cancelled';
  procedureId: string;
  stepsRun: number;
  failedStepId?: string;
  actions: ActionResult[];
  checks: CheckResult[];
  lastObservation?: Observation;
}

/**
 * Selects and replays procedures. Its factory takes no model or explorer:
 * replaying a stable procedure can never start a model client.
 */
export interface ProcedureEngine {
  /** Newest runnable version: stable before trial before seeded; never degraded or retired. */
  select(key: ProcedureKey, signal?: AbortSignal): Promise<ProcedureV2 | undefined>;
  replay(procedure: ProcedureV2, session: Session, bindings: Bindings, signal?: AbortSignal): Promise<ReplayResult>;
  /** Apply nextProcedureState and persist it. */
  recordOutcome(procedureId: string, outcome: { itemId: string; ok: boolean }): Promise<ProcedureV2>;
  /** Make an older stable version current again by inserting it as a new version. */
  rollback(key: ProcedureKey, toVersion: number): Promise<ProcedureV2>;
}

/** One action already performed, by the bridge or by a scripted unit. */
export interface ExecutedStep {
  stepId: string;
  action: Action;
  result: ActionResult;
  before?: Pick<Observation, 'snapshotId' | 'pageClass'>;
  after?: Pick<Observation, 'snapshotId' | 'pageClass'>;
  /** The element the action resolved to, used to turn coordinates into semantic locators. */
  resolvedElement?: Pick<UIElement, 'role' | 'label' | 'frame'>;
  executedBy: 'bridge' | 'runtime';
}

export interface UnitDefinition {
  name: string;
  goal: string;
  allowedEffects: EffectClass[];
  preconditions: Condition[];
  postconditions: Condition[];
  /** Whether the learner may store procedures for this unit. */
  learnable: boolean;
  timeoutMs: number;
}

export interface ProcedureProposal {
  key: ProcedureKey;
  parentVersion?: number;
  parameters: string[];
  steps: ProcedureStep[];
  preconditions: Condition[];
  postconditions: Condition[];
  source: 'learned' | 'repair';
}

/** Turns executed traces into procedures. Does not perform actions. */
export interface Learner {
  /** Replace bound values with slots, map coordinates to locators, drop nothing unverified. */
  propose(unit: UnitDefinition, key: ProcedureKey, trace: ExecutedStep[], bindings: Bindings): ProcedureProposal;
  /** Store a proposal as a trial version only after a local verifier passed. */
  accept(proposal: ProcedureProposal, verification: CheckResult, itemId: string): Promise<ProcedureV2>;
}

/** Lazily creates the exploration bridge. Throws `model_unavailable` when there is no model. */
export type ExplorerProvider = () => Promise<ExplorerBridge>;

export interface RecoveryContext {
  unit: UnitDefinition;
  key: ProcedureKey;
  session: Session;
  taskId: string;
  itemId?: string;
  bindings: Bindings;
  failure: ReplayResult | { status: 'no_procedure' } | { status: 'verify_failed'; check: CheckResult };
  usage: Usage;
  budget: Budget;
  /** Model repairs already spent on this item. */
  itemRepairs: number;
  /** Local verifier for the unit's outcome. */
  verify: (observation: Observation) => Promise<CheckResult>;
}

export type RecoveryOutcome =
  | { status: 'recovered'; route: 'wait' | 'relocate' | 'local_procedure'; observation: Observation }
  | { status: 'repaired'; outcome: ExplorationOutcome; proposal?: ProcedureProposal; verification: CheckResult }
  | { status: 'exhausted'; budget: BudgetCheck | 'item_repairs' | 'local' }
  | { status: 'model_unavailable' }
  | { status: 'cancelled' };

export interface Recovery {
  recover(context: RecoveryContext, signal?: AbortSignal): Promise<RecoveryOutcome>;
}

// ---------------------------------------------------------------------------
// Exploration bridge, JSON lines (A5)

export const BRIDGE_PROTOCOL_VERSION = 1;

/** First and only line the runtime writes to the bridge's stdin. */
export interface ExplorationRequest {
  v: 1;
  taskId: string;
  unitAttemptId: string;
  session: { socket: string; screenId: string; pid: number; windowId: number };
  unit: Pick<UnitDefinition, 'name' | 'goal' | 'allowedEffects'> & { expectedPostconditions: Condition[] };
  parameters: Record<string, string>;
  budget: { maxRounds: number; maxTokens?: number; timeoutMs: number };
  /** Always false in the first version; the bridge must refuse external-submit actions. */
  submitAllowed: false;
  /**
   * Why the runtime is exploring, copied onto every `model_usage` event.
   * Without it the bridge reports purpose `ui`, reason `missing_procedure`.
   */
  usageContext?: { purpose: ModelPurpose; reason: ModelCallReason };
}

interface BridgeEventBase {
  v: 1;
  taskId: string;
  unitAttemptId: string;
  at: string;
}

export type BridgeEvent =
  | (BridgeEventBase & { type: 'observed'; stepId?: string; snapshotId: string; window: WindowGeometry; pageClass?: string })
  | (BridgeEventBase & { type: 'action_started'; stepId: string; action: Action })
  | (BridgeEventBase & { type: 'action_finished'; stepId: string; action: Action; result: ActionResult; resolvedElement?: ExecutedStep['resolvedElement'] })
  | (BridgeEventBase & { type: 'model_usage'; stepId?: string; purpose: ModelPurpose; reason: ModelCallReason; inputTokens: TokenCount; outputTokens: TokenCount })
  | (BridgeEventBase & { type: 'unit_finished'; steps: number; proposal?: Omit<ProcedureProposal, 'key' | 'source'> })
  | (BridgeEventBase & { type: 'unit_failed'; reason: 'budget_exhausted' | 'model_unavailable' | 'cancelled' | 'timeout' | 'forbidden_effect' | 'error'; message: string });

export type BridgeEventType = BridgeEvent['type'];

/**
 * What one exploration did. The bridge already performed every step in
 * `executed`; the runtime verifies the result and may learn from it, but
 * must not send those actions again.
 */
export interface ExplorationOutcome {
  status: 'finished' | 'failed';
  failure?: Extract<BridgeEvent, { type: 'unit_failed' }>['reason'];
  executed: ExecutedStep[];
  modelCalls: number;
  inputTokens: TokenCount;
  outputTokens: TokenCount;
  proposal?: Omit<ProcedureProposal, 'key' | 'source'>;
  lastSnapshotId?: string;
}

export interface ExplorerBridge {
  /**
   * Run one unit through the Swift agent while holding the session's actor
   * grant. Resolves only after the child process has exited. Aborting kills
   * the child and still waits for exit before resolving with `cancelled`.
   */
  explore(request: ExplorationRequest, grant: ActorGrant, onEvent?: (event: BridgeEvent) => void): Promise<ExplorationOutcome>;
}

// ---------------------------------------------------------------------------
// BOSS resume workflow (A4)

export type BossUnitName =
  | 'select_source'
  | 'enumerate_candidates'
  | 'open_candidate'
  | 'open_resume'
  | 'acquire_resume'
  | 'persist_candidate'
  | 'return_to_list'
  | 'advance_list';

export const BOSS_UNITS: readonly BossUnitName[] = [
  'select_source',
  'enumerate_candidates',
  'open_candidate',
  'open_resume',
  'acquire_resume',
  'persist_candidate',
  'return_to_list',
  'advance_list',
];

export type BossPageClass =
  | 'login'
  | 'captcha'
  | 'conversation_list'
  | 'conversation_detail'
  | 'recommend_list'
  | 'candidate_detail'
  | 'online_resume'
  | 'attachment_preview'
  | 'request_resume_dialog'
  | 'popup'
  | 'loading'
  | 'unknown';

export interface CandidateListing {
  candidates: CandidateRef[];
  /** Hash of the visible rows, to tell a new page from a repeated one. */
  fingerprint: string;
  endReached: boolean;
  snapshotId: string;
}

export interface UnitContext {
  session: Session;
  task: TaskRecord;
  item?: WorkItem;
  candidate?: CandidateRef;
  staging?: StagingArea;
  bindings: Bindings;
  signal: AbortSignal;
}

export interface UnitRunResult {
  ok: boolean;
  executed: ExecutedStep[];
  observation: Observation;
  reason?: string;
}

export type AcquisitionResult =
  | { status: 'acquired'; artifacts: StagedArtifact[]; branch: 'attachment' | 'online' }
  | { status: 'unavailable'; reason: 'no_attachment' | 'request_dialog' | 'download_unavailable' | 'no_resume' }
  | { status: 'failed'; reason: string };

/** Business knowledge of BOSS直聘 for resume collection; drives nothing outside the session. */
export interface BossWorkflow {
  readonly id: 'boss-resumes-v1';
  readonly units: Readonly<Record<BossUnitName, UnitDefinition>>;
  classifyPage(observation: Observation): BossPageClass;
  /** The account visible in the window, if any can be read reliably. */
  readAccount(observation: Observation): AccountScope | undefined;
  listCandidates(observation: Observation, account: AccountScope): CandidateListing;
  /** Check a detail page against the list ref before anything is attributed. */
  identify(observation: Observation, ref: CandidateRef, account: AccountScope): IdentityMatch;
  /** Local verifier for a unit's outcome. A model saying "finished" is not evidence. */
  verifyUnit(unit: BossUnitName, context: UnitContext, observation: Observation): Promise<CheckResult>;
  /** Deterministic path for a unit, when the workflow has one; undefined defers to procedures/exploration. */
  runScripted(unit: BossUnitName, context: UnitContext): Promise<UnitRunResult> | undefined;
  /** Fetch the resume into the staging area by the capture mode. Never clicks a request-resume confirm. */
  acquireResume(context: UnitContext, mode: CaptureMode): Promise<AcquisitionResult>;
}

// ---------------------------------------------------------------------------
// Runner, daemon and CLI (A6, A7)

export interface TaskOutcome {
  taskId: string;
  status: TaskStatus;
  terminationReason?: TerminationReason;
  waitReason?: WaitReason;
  counts: TaskCounts;
  usage: Usage;
  /** <outputDir>/<taskId>. */
  outputPath: string;
}

export interface TaskRunner {
  /** Run or resume a task until it ends, waits for the user, or the signal fires. */
  run(taskId: string, signal: AbortSignal): Promise<TaskOutcome>;
}

export interface TaskStatusReport {
  task: TaskRecord;
  checkpoint?: TaskCheckpoint;
  usage?: Usage;
  outputPath: string;
}

/** What the CLI and MCP talk to. Every call returns promptly; none waits for GUI work. */
export interface TaskControl {
  submit(skillId: string, input: CollectResumesInput): Promise<{ taskId: string }>;
  status(taskId: string): Promise<TaskStatusReport>;
  pause(taskId: string): Promise<TaskRecord>;
  resume(taskId: string): Promise<TaskRecord>;
  cancel(taskId: string): Promise<TaskRecord>;
  artifacts(taskId: string): Promise<ArtifactRecord[]>;
  inspectProcedure(procedureId: string): Promise<ProcedureV2 | undefined>;
}

export interface CliIO {
  stdout(line: string): void;
  stderr(line: string): void;
}

export type CliCommand = 'run' | 'status' | 'pause' | 'resume' | 'cancel' | 'artifacts' | 'inspect-procedure';

// ---------------------------------------------------------------------------
// Validators

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown, min = 0): v is number => Number.isInteger(v) && (v as number) >= min;
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isIsoTime = (v: unknown): v is string => isString(v) && !Number.isNaN(Date.parse(v));
const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T => isString(v) && (values as readonly string[]).includes(v);
const ok = <T>(value: T, errors: string[]): Validated<T> => (errors.length ? { ok: false, errors } : { ok: true, value });

export function validateTaskSpec(raw: unknown): Validated<TaskSpec> {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ['task spec must be an object'] };
  if (raw.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  for (const k of ['id', 'version', 'application', 'windowProfile', 'workflow', 'inputSchema'] as const)
    if (!isNonEmpty(raw[k])) errors.push(`${k} must be a non-empty string`);
  if (!Array.isArray(raw.platforms) || raw.platforms.length === 0 || !raw.platforms.every((p) => p === 'macos'))
    errors.push('platforms must be ["macos"]');
  if (!Array.isArray(raw.capabilities) || !raw.capabilities.every(isNonEmpty)) errors.push('capabilities must be strings');
  if (typeof raw.submitAllowed !== 'boolean') errors.push('submitAllowed must be boolean');
  if (typeof raw.foregroundAllowed !== 'boolean') errors.push('foregroundAllowed must be boolean');
  if (!isObject(raw.learning) || !isInt(raw.learning.promoteAfterSuccesses, 1))
    errors.push('learning.promoteAfterSuccesses must be an integer >= 1');
  if (!isObject(raw.defaults) || !oneOf(raw.defaults.captureMode, ['available', 'original-only']) || !oneOf(raw.defaults.analysis, ['off', 'on']))
    errors.push('defaults must name captureMode and analysis');
  return ok(raw as unknown as TaskSpec, errors);
}

function validateBudgetPatch(raw: unknown, errors: string[], path: string): void {
  if (!isObject(raw)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in DEFAULT_BUDGET) && k !== 'taskTokens') errors.push(`${path}.${k} is not a budget field`);
    else if (!isInt(v)) errors.push(`${path}.${k} must be a non-negative integer`);
  }
}

/** Checks a collect-resumes input. `now` decides whether a deadline is already past. */
export function validateCollectResumesInput(raw: unknown, now: Date = new Date()): Validated<CollectResumesInput> {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ['input must be an object'] };
  if (!isNonEmpty(raw.job)) errors.push('job must be a non-empty string');
  if (!isInt(raw.requestedCount, 1) || (raw.requestedCount as number) > 10_000) errors.push('requestedCount must be an integer from 1 to 10000');
  if (!isNonEmpty(raw.outputDir) || !isAbsolute(raw.outputDir)) errors.push('outputDir must be an absolute path');
  if (!oneOf(raw.source, ['conversations', 'recommend'])) errors.push('source must be conversations or recommend');
  if (!oneOf(raw.captureMode, ['available', 'original-only'])) errors.push('captureMode must be available or original-only');
  if (raw.browseLimit !== undefined) {
    if (!isInt(raw.browseLimit, 1)) errors.push('browseLimit must be a positive integer');
    else if (isInt(raw.requestedCount, 1) && raw.browseLimit < raw.requestedCount) errors.push('browseLimit must not be below requestedCount');
  }
  if (raw.deadline !== undefined) {
    if (!isIsoTime(raw.deadline)) errors.push('deadline must be an ISO time');
    else if (Date.parse(raw.deadline) <= now.getTime()) errors.push('deadline is already past');
  }
  if (raw.budget !== undefined) validateBudgetPatch(raw.budget, errors, 'budget');
  for (const k of ['takeOver', 'keepWindow'] as const)
    if (raw[k] !== undefined && typeof raw[k] !== 'boolean') errors.push(`${k} must be boolean`);
  if (raw.analysis !== undefined && !oneOf(raw.analysis, ['off', 'on'])) errors.push('analysis must be off or on');
  const known = new Set(['job', 'requestedCount', 'outputDir', 'source', 'captureMode', 'browseLimit', 'deadline', 'budget', 'takeOver', 'keepWindow', 'analysis']);
  for (const k of Object.keys(raw)) if (!known.has(k)) errors.push(`unknown field ${k}`);
  return ok(raw as unknown as CollectResumesInput, errors);
}

const isRect = (v: unknown): v is Rect =>
  isObject(v) && isFiniteNumber(v.x) && isFiniteNumber(v.y) && isFiniteNumber(v.width) && isFiniteNumber(v.height) && v.width >= 0 && v.height >= 0;

const isUnitPoint = (v: unknown): v is Point =>
  isObject(v) && isFiniteNumber(v.x) && isFiniteNumber(v.y) && v.x >= 0 && v.x <= 1 && v.y >= 0 && v.y <= 1;

export function validateLocator(raw: unknown, path = 'locator'): string[] {
  if (!isObject(raw)) return [`${path} must be an object`];
  const errors: string[] = [];
  switch (raw.kind) {
    case 'element':
      if (raw.index === undefined && !isNonEmpty(raw.role) && !isNonEmpty(raw.label) && !isNonEmpty(raw.labelPattern))
        errors.push(`${path} needs an index, role, label or labelPattern`);
      if (raw.index !== undefined && !isInt(raw.index)) errors.push(`${path}.index must be a non-negative integer`);
      if (raw.labelPattern !== undefined) {
        try {
          new RegExp(String(raw.labelPattern));
        } catch {
          errors.push(`${path}.labelPattern is not a valid pattern`);
        }
      }
      if (raw.within !== undefined && !isRect(raw.within)) errors.push(`${path}.within must be a rect`);
      break;
    case 'relative':
      if (!isUnitPoint(raw.point)) errors.push(`${path}.point must be fractions from 0 to 1`);
      break;
    case 'template':
      if (!isNonEmpty(raw.templateId)) errors.push(`${path}.templateId is required`);
      if (raw.region !== undefined && !isRect(raw.region)) errors.push(`${path}.region must be a rect`);
      break;
    case 'ocr':
      if (!isNonEmpty(raw.text)) errors.push(`${path}.text is required`);
      if (raw.region !== undefined && !isRect(raw.region)) errors.push(`${path}.region must be a rect`);
      break;
    default:
      errors.push(`${path}.kind must be element, relative, template or ocr`);
  }
  return errors;
}

const usesElementIndex = (l: unknown): boolean => isObject(l) && l.kind === 'element' && l.index !== undefined;

export function validateAction(raw: unknown, policy: { submitAllowed: boolean }, path = 'action'): string[] {
  if (!isObject(raw)) return [`${path} must be an object`];
  const errors: string[] = [];
  if (!oneOf(raw.effect, EFFECT_CLASSES)) errors.push(`${path}.effect must be one of ${EFFECT_CLASSES.join(', ')}`);
  else if (raw.effect === 'external-submit' && !policy.submitAllowed) errors.push(`${path}: external-submit is not allowed`);
  switch (raw.kind) {
    case 'click':
      errors.push(...validateLocator(raw.target, `${path}.target`));
      if (raw.button !== undefined && !oneOf(raw.button, ['left', 'right'])) errors.push(`${path}.button must be left or right`);
      if (raw.count !== undefined && raw.count !== 1 && raw.count !== 2) errors.push(`${path}.count must be 1 or 2`);
      break;
    case 'type':
      if (!isString(raw.value)) errors.push(`${path}.value must be a string`);
      if (raw.target !== undefined) errors.push(...validateLocator(raw.target, `${path}.target`));
      if (raw.replace === true && raw.target === undefined) errors.push(`${path}: replace needs a target`);
      break;
    case 'key':
      if (!isNonEmpty(raw.key)) errors.push(`${path}.key is required`);
      if (raw.modifiers !== undefined && !(Array.isArray(raw.modifiers) && raw.modifiers.every((m) => oneOf(m, ['cmd', 'shift', 'option', 'ctrl']))))
        errors.push(`${path}.modifiers must be cmd, shift, option or ctrl`);
      break;
    case 'scroll':
      if (!oneOf(raw.direction, ['up', 'down', 'left', 'right'])) errors.push(`${path}.direction must be up, down, left or right`);
      if (raw.amount !== undefined && !(isInt(raw.amount, 1) && raw.amount <= 50)) errors.push(`${path}.amount must be 1 to 50`);
      if (raw.by !== undefined && !oneOf(raw.by, ['line', 'page'])) errors.push(`${path}.by must be line or page`);
      if (raw.target !== undefined) errors.push(...validateLocator(raw.target, `${path}.target`));
      break;
    default:
      errors.push(`${path}.kind must be click, type, key or scroll`);
  }
  return errors;
}

export function validateActionRequest(raw: unknown, policy: { submitAllowed: boolean }): Validated<ActionRequest> {
  if (!isObject(raw)) return { ok: false, errors: ['action request must be an object'] };
  const errors: string[] = [];
  if (!isNonEmpty(raw.actionId)) errors.push('actionId is required');
  errors.push(...validateAction(raw.action, policy));
  if (isObject(raw.action) && usesElementIndex(raw.action.target) && !isNonEmpty(raw.snapshotId))
    errors.push('an element index needs the snapshotId it came from');
  return ok(raw as unknown as ActionRequest, errors);
}

export function validateCondition(raw: unknown, path = 'condition', depth = 0): string[] {
  if (depth > 4) return [`${path} nests too deeply`];
  if (!isObject(raw)) return [`${path} must be an object`];
  switch (raw.kind) {
    case 'element':
      return [...validateLocator(raw.locator, `${path}.locator`), ...(typeof raw.present === 'boolean' ? [] : [`${path}.present must be boolean`])];
    case 'text': {
      const errors = typeof raw.present === 'boolean' ? [] : [`${path}.present must be boolean`];
      try {
        if (!isNonEmpty(raw.pattern)) errors.push(`${path}.pattern is required`);
        else new RegExp(raw.pattern);
      } catch {
        errors.push(`${path}.pattern is not a valid pattern`);
      }
      return errors;
    }
    case 'page':
      return isNonEmpty(raw.pageClass) ? [] : [`${path}.pageClass is required`];
    case 'window':
      return typeof raw.present === 'boolean' ? [] : [`${path}.present must be boolean`];
    case 'file': {
      const errors: string[] = [];
      if (!isNonEmpty(raw.path) || !isAbsolute(raw.path)) errors.push(`${path}.path must be absolute`);
      if (raw.minBytes !== undefined && !isInt(raw.minBytes)) errors.push(`${path}.minBytes must be a non-negative integer`);
      if (raw.stableMs !== undefined && !isInt(raw.stableMs)) errors.push(`${path}.stableMs must be a non-negative integer`);
      return errors;
    }
    case 'all':
    case 'any':
      if (!Array.isArray(raw.conditions) || raw.conditions.length === 0) return [`${path}.conditions must be a non-empty array`];
      return raw.conditions.flatMap((c, i) => validateCondition(c, `${path}.conditions[${i}]`, depth + 1));
    default:
      return [`${path}.kind is not a condition kind`];
  }
}

/** Waits are always bounded: 1 ms to WAIT_LIMITS.maxTimeoutMs, polling within limits. */
export function validateWaitSpec(raw: unknown, path = 'wait'): string[] {
  if (!isObject(raw)) return [`${path} must be an object`];
  const errors = validateCondition(raw.condition, `${path}.condition`);
  if (!isInt(raw.timeoutMs, 1) || raw.timeoutMs > WAIT_LIMITS.maxTimeoutMs) errors.push(`${path}.timeoutMs must be 1 to ${WAIT_LIMITS.maxTimeoutMs}`);
  if (raw.pollMs !== undefined && (!isInt(raw.pollMs, WAIT_LIMITS.minPollMs) || raw.pollMs > WAIT_LIMITS.maxPollMs))
    errors.push(`${path}.pollMs must be ${WAIT_LIMITS.minPollMs} to ${WAIT_LIMITS.maxPollMs}`);
  return errors;
}

/** Slot names used in a step's strings. */
export function stepSlots(step: ProcedureStep): string[] {
  const found = new Set<string>();
  const scan = (v: unknown): void => {
    if (isString(v)) for (const m of v.matchAll(SLOT_PATTERN)) found.add(m[1]!);
    else if (Array.isArray(v)) v.forEach(scan);
    else if (isObject(v)) Object.values(v).forEach(scan);
  };
  scan(step.action);
  scan(step.fallbacks);
  return [...found];
}

/** Replace {{slot}} references; throws `invalid_input` for an unbound slot. */
export function bindSlots(text: string, bindings: Bindings): string {
  return text.replace(SLOT_PATTERN, (_, name: string) => {
    const value = bindings[name];
    if (value === undefined) throw new RuntimeError('invalid_input', `slot ${name} has no binding`);
    return value;
  });
}

export function validateProcedure(raw: unknown, policy: { submitAllowed: boolean }): Validated<ProcedureV2> {
  if (!isObject(raw)) return { ok: false, errors: ['procedure must be an object'] };
  const errors: string[] = [];
  if (raw.schemaVersion !== 2) errors.push('schemaVersion must be 2');
  if (!isNonEmpty(raw.id)) errors.push('id is required');
  const key = raw.key;
  if (!isObject(key)) errors.push('key must be an object');
  else {
    for (const k of ['skill', 'skillVersion', 'unit', 'appVersion', 'profile'] as const) if (!isNonEmpty(key[k])) errors.push(`key.${k} is required`);
    if (key.platform !== 'macos') errors.push('key.platform must be macos');
  }
  if (!isInt(raw.version, 1)) errors.push('version must be an integer >= 1');
  if (raw.parentVersion !== undefined && !(isInt(raw.parentVersion, 1) && isInt(raw.version, 1) && raw.parentVersion < raw.version))
    errors.push('parentVersion must be below version');
  if (!oneOf(raw.status, ['seeded', 'trial', 'stable', 'degraded', 'retired'])) errors.push('status is not a procedure status');
  if (!oneOf(raw.source, ['seed', 'learned', 'repair', 'v1-import'])) errors.push('source is not a procedure source');
  const parameters = Array.isArray(raw.parameters) && raw.parameters.every(isNonEmpty) ? (raw.parameters as string[]) : undefined;
  if (!parameters) errors.push('parameters must be strings');
  for (const k of ['preconditions', 'postconditions'] as const) {
    if (!Array.isArray(raw[k])) errors.push(`${k} must be an array`);
    else (raw[k] as unknown[]).forEach((c, i) => errors.push(...validateCondition(c, `${k}[${i}]`)));
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) errors.push('steps must be a non-empty array');
  else {
    const ids = new Set<string>();
    raw.steps.forEach((s: unknown, i: number) => {
      const p = `steps[${i}]`;
      if (!isObject(s)) return void errors.push(`${p} must be an object`);
      if (!isNonEmpty(s.id)) errors.push(`${p}.id is required`);
      else if (ids.has(s.id)) errors.push(`${p}.id ${s.id} is repeated`);
      else ids.add(s.id);
      errors.push(...validateAction(s.action, policy, `${p}.action`));
      if (usesElementIndex(isObject(s.action) ? s.action.target : undefined)) errors.push(`${p}: stored procedures cannot use element indexes`);
      if (s.fallbacks !== undefined) {
        if (!Array.isArray(s.fallbacks)) errors.push(`${p}.fallbacks must be an array`);
        else s.fallbacks.forEach((l, j) => {
          errors.push(...validateLocator(l, `${p}.fallbacks[${j}]`));
          if (usesElementIndex(l)) errors.push(`${p}.fallbacks[${j}]: stored procedures cannot use element indexes`);
        });
      }
      if (s.expect !== undefined) errors.push(...validateWaitSpec(s.expect, `${p}.expect`));
      if (parameters)
        for (const slot of stepSlots(s as unknown as ProcedureStep))
          if (!parameters.includes(slot)) errors.push(`${p} uses slot ${slot} that is not a parameter`);
    });
  }
  const c = raw.counters;
  if (!isObject(c) || !isInt(c.successes) || !isInt(c.failures) || !isInt(c.consecutiveFailures) || !Array.isArray(c.successItemIds))
    errors.push('counters must hold successes, failures, consecutiveFailures and successItemIds');
  else if (raw.status === 'stable' && raw.source !== 'seed' && c.successes === 0)
    errors.push('a learned stable procedure must have verified successes');
  if (!isIsoTime(raw.createdAt) || !isIsoTime(raw.updatedAt)) errors.push('createdAt and updatedAt must be ISO times');
  return ok(raw as unknown as ProcedureV2, errors);
}

export function validateExplorationRequest(raw: unknown): Validated<ExplorationRequest> {
  if (!isObject(raw)) return { ok: false, errors: ['exploration request must be an object'] };
  const errors: string[] = [];
  if (raw.v !== BRIDGE_PROTOCOL_VERSION) errors.push(`v must be ${BRIDGE_PROTOCOL_VERSION}`);
  if (!isNonEmpty(raw.taskId)) errors.push('taskId is required');
  if (!isNonEmpty(raw.unitAttemptId)) errors.push('unitAttemptId is required');
  const s = raw.session;
  if (!isObject(s) || !isNonEmpty(s.socket) || !isNonEmpty(s.screenId) || !isInt(s.pid, 1) || !isInt(s.windowId, 1))
    errors.push('session needs socket, screenId, pid and windowId');
  const u = raw.unit;
  if (!isObject(u) || !isNonEmpty(u.name) || !isNonEmpty(u.goal)) errors.push('unit needs name and goal');
  else {
    if (!Array.isArray(u.allowedEffects) || !u.allowedEffects.every((e) => oneOf(e, EFFECT_CLASSES))) errors.push('unit.allowedEffects must be effect classes');
    else if (u.allowedEffects.includes('external-submit')) errors.push('unit.allowedEffects must not include external-submit');
    if (!Array.isArray(u.expectedPostconditions)) errors.push('unit.expectedPostconditions must be an array');
    else u.expectedPostconditions.forEach((c, i) => errors.push(...validateCondition(c, `unit.expectedPostconditions[${i}]`)));
  }
  if (!isObject(raw.parameters) || !Object.values(raw.parameters).every(isString)) errors.push('parameters must map names to strings');
  const b = raw.budget;
  if (!isObject(b) || !isInt(b.maxRounds, 1) || !isInt(b.timeoutMs, 1) || (b.maxTokens !== undefined && !isInt(b.maxTokens, 1)))
    errors.push('budget needs maxRounds and timeoutMs >= 1');
  if (raw.submitAllowed !== false) errors.push('submitAllowed must be false');
  const c = raw.usageContext;
  if (c !== undefined && (!isObject(c) || !oneOf(c.purpose, ['ui', 'repair', 'analysis']) || !oneOf(c.reason, ['missing_procedure', 'replay_failed', 'postcondition_failed', 'recovery_exhausted', 'analysis'])))
    errors.push('usageContext needs a model purpose and call reason');
  return ok(raw as unknown as ExplorationRequest, errors);
}

const isTokenCount = (v: unknown): v is TokenCount => v === 'unknown' || isInt(v);

function validateActionResultShape(raw: unknown, path: string): string[] {
  if (!isObject(raw)) return [`${path} must be an object`];
  const errors: string[] = [];
  if (!isNonEmpty(raw.actionId)) errors.push(`${path}.actionId is required`);
  if (!oneOf(raw.status, ['ok', 'no_effect', 'failed', 'stale_snapshot', 'unknown'])) errors.push(`${path}.status is not an action status`);
  if (!isIsoTime(raw.startedAt) || !isIsoTime(raw.finishedAt)) errors.push(`${path} needs startedAt and finishedAt`);
  return errors;
}

/**
 * Parse one line from the bridge's stdout. Lines are untrusted: anything
 * malformed is rejected, and an action outside the unit's effects is an error.
 */
export function parseBridgeEvent(line: string, expected?: { taskId: string; unitAttemptId: string }): Validated<BridgeEvent> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, errors: ['line is not JSON'] };
  }
  if (!isObject(raw)) return { ok: false, errors: ['event must be an object'] };
  const errors: string[] = [];
  if (raw.v !== BRIDGE_PROTOCOL_VERSION) errors.push(`v must be ${BRIDGE_PROTOCOL_VERSION}`);
  if (!isNonEmpty(raw.taskId) || !isNonEmpty(raw.unitAttemptId)) errors.push('taskId and unitAttemptId are required');
  else if (expected && (raw.taskId !== expected.taskId || raw.unitAttemptId !== expected.unitAttemptId))
    errors.push('event belongs to another task or attempt');
  if (!isIsoTime(raw.at)) errors.push('at must be an ISO time');
  const needStep = () => {
    if (!isNonEmpty(raw.stepId)) errors.push('stepId is required');
  };
  const policy = { submitAllowed: false };
  switch (raw.type) {
    case 'observed':
      if (!isNonEmpty(raw.snapshotId)) errors.push('snapshotId is required');
      if (!isObject(raw.window) || !isRect(raw.window.frame) || !isRect(raw.window.contentFrame) || !isFiniteNumber(raw.window.scale))
        errors.push('window must carry frame, contentFrame and scale');
      break;
    case 'action_started':
      needStep();
      errors.push(...validateAction(raw.action, policy));
      break;
    case 'action_finished':
      needStep();
      errors.push(...validateAction(raw.action, policy));
      errors.push(...validateActionResultShape(raw.result, 'result'));
      break;
    case 'model_usage':
      if (!oneOf(raw.purpose, ['ui', 'repair', 'analysis'])) errors.push('purpose must be ui, repair or analysis');
      if (!oneOf(raw.reason, ['missing_procedure', 'replay_failed', 'postcondition_failed', 'recovery_exhausted', 'analysis'])) errors.push('reason is not a model call reason');
      if (!isTokenCount(raw.inputTokens) || !isTokenCount(raw.outputTokens)) errors.push('token counts must be integers or "unknown"');
      break;
    case 'unit_finished':
      if (!isInt(raw.steps)) errors.push('steps must be a non-negative integer');
      break;
    case 'unit_failed':
      if (!oneOf(raw.reason, ['budget_exhausted', 'model_unavailable', 'cancelled', 'timeout', 'forbidden_effect', 'error'])) errors.push('reason is not a failure reason');
      if (!isString(raw.message)) errors.push('message must be a string');
      break;
    default:
      errors.push('type is not a bridge event type');
  }
  return ok(raw as unknown as BridgeEvent, errors);
}

/** One JSON line, with no embedded newlines. */
export const encodeJsonLine = (value: unknown): string => JSON.stringify(value) + '\n';
