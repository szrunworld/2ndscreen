// `2ndscreen task …`: the command line of the task runtime. It parses the
// words strictly, makes exactly one call on the injected TaskControl and
// prints one JSON line. It starts no worker, loads no model, reads no
// environment and touches no file or ledger itself: everything it does goes
// through `control`, which returns promptly (docs/task-runtime-contracts.md,
// "A7 产品入口").
//
// Exit codes: 0 done, 1 the runtime refused or failed, 2 the words or the
// input were invalid.

import {
  DEFAULT_BUDGET,
  RuntimeError,
  assertValid,
  isRuntimeError,
  validateCollectResumesInput,
  type AccountScope,
  type Budget,
  type CliCommand,
  type CliIO,
  type CollectResumesInput,
  type TaskControl,
  type TaskRecord,
  USAGE_GROUPS,
  type UsageGroupBy,
} from './contracts.ts';

/** The contract's commands, bind-account for the explicit BOSS account, and the agent views. */
export type TaskCliCommand = CliCommand | 'bind-account' | 'agents' | 'usage';

export const CLI_COMMANDS: readonly TaskCliCommand[] = ['run', 'status', 'pause', 'resume', 'cancel', 'artifacts', 'inspect-procedure', 'bind-account', 'agents', 'usage'];


/**
 * What the runtime adds for agents (RFC 0001): the list of agent runs with
 * the stuck ones first, and provider usage attributed per agent. Both read
 * what the hosts wrote; neither needs the worker.
 */
export interface AgentViewControl {
  agents(options: { includeFinished: boolean }): Promise<unknown>;
  usage(options: { by: UsageGroupBy; since?: string }): Promise<unknown>;
}

/**
 * What the runtime's daemon adds to TaskControl for accounts: a submit that
 * binds the account before the task can start, and a later binding while a
 * task waits for one. runCli asks for these only when an account is given.
 */
export interface AccountControl {
  submit(skillId: string, input: CollectResumesInput, options?: { account?: AccountScope }): Promise<{ taskId: string }>;
  bindAccount(taskId: string, account: AccountScope): Promise<TaskRecord>;
}

export const CLI_USAGE = [
  'usage:',
  '  2ndscreen task run SKILL_ID --job TEXT --limit N --output DIR',
  '                 [--source conversations|recommend] [--mode available|original-only]',
  '                 [--browse-limit N] [--deadline ISO_TIME] [--budget FIELD=N]...',
  '                 [--take-over] [--keep-window] [--analysis off|on] [--account ACCOUNT_KEY]',
  '  2ndscreen task status TASK_ID',
  '  2ndscreen task pause TASK_ID',
  '  2ndscreen task resume TASK_ID',
  '  2ndscreen task cancel TASK_ID',
  '  2ndscreen task artifacts TASK_ID',
  '  2ndscreen task inspect-procedure PROCEDURE_ID',
  '  2ndscreen task bind-account TASK_ID ACCOUNT_KEY',
  '  2ndscreen task agents [--all]',
  '  2ndscreen task usage [--by agent|provider|model|task] [--since ISO_TIME]',
  '',
  '--limit is how many resumes must be committed; --output is an absolute directory, the',
  'task writes under DIR/TASK_ID. --source defaults to conversations, --mode to available.',
  '--account names the BOSS account the task works in, a key you choose (letters, digits, ".", "_", "-"),',
  'such as hr-zhang. The runtime cannot read the account from the window: without one a task waits',
  '(waiting_user, account_changed) until bind-account names it. A task keeps its account for good, and',
  'its candidates are never mixed with another account\'s.',
  `Budget fields: ${[...Object.keys(DEFAULT_BUDGET), 'taskTokens'].join(', ')}.`,
  'agents lists agent runs, blocked ones first with what they wait for (an approval, an answer, or',
  'something the agent reported); --all adds finished runs. usage sums provider calls, tokens and',
  'cost per agent (default), provider, model or task, since a time (default: the last 24 hours).',
  'Every command prints one JSON line: {"ok":true,"command":…,"result":…} or {"ok":false,…,"error":{code,message}}.',
].join('\n');

/** The value given when --source or --mode is left out. Matches skills/boss-resumes/task.json defaults. */
export const RUN_DEFAULTS = { source: 'conversations', captureMode: 'available' } as const;

const BUDGET_FIELDS: ReadonlySet<string> = new Set([...Object.keys(DEFAULT_BUDGET), 'taskTokens']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Goes into lease scopes and folder names: no ':' or '/'. */
const ACCOUNT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGITS = /^(0|[1-9][0-9]{0,14})$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const MAX_TEXT = 200;
const MAX_PATH = 4096;
const MAX_BROWSE = 1_000_000;

/**
 * Run one CLI invocation. Never throws; the returned number is the process
 * exit code. `--account` and bind-account need the AccountControl methods
 * (the runtime's daemon has them); other commands use TaskControl alone.
 */
export async function runCli(argv: readonly string[], io: CliIO, control: TaskControl): Promise<number> {
  const first = argv[0];
  if (first === undefined) return emit(io, null, usageError('a command is required'));
  if (HELP.has(first)) return help(io);
  if (!(CLI_COMMANDS as readonly string[]).includes(first)) return emit(io, null, usageError(`unknown command ${quote(first)}`));
  const command = first as TaskCliCommand;
  try {
    const result = await dispatch(command, argv.slice(1), control);
    return emit(io, command, { result });
  } catch (error) {
    // `task run --help` explains instead of acting.
    if (error === HELP_REQUESTED) return help(io);
    return emit(io, command, { error });
  }
}

const HELP: ReadonlySet<string> = new Set(['help', '--help', '-h']);
/** Thrown by the parsers when --help or -h stands where an option or ID would. */
const HELP_REQUESTED = Symbol('help');

function help(io: CliIO): number {
  io.stdout(JSON.stringify({ ok: true, command: 'help', result: { usage: CLI_USAGE, commands: CLI_COMMANDS } }));
  return 0;
}

async function dispatch(command: TaskCliCommand, words: readonly string[], control: TaskControl): Promise<unknown> {
  if (command === 'agents') {
    if (words.some((w) => w === '--help' || w === '-h')) throw HELP_REQUESTED;
    const extra = words.filter((w) => w !== '--all');
    if (extra.length > 0) throw usageError(`agents takes only --all, not ${quote(extra[0]!)}`);
    return agentViewControl(control).agents({ includeFinished: words.includes('--all') });
  }
  if (command === 'usage') return agentViewControl(control).usage(parseUsage(words));
  if (command === 'run') {
    const { skillId, input, account } = parseRun(words);
    if (account === undefined) return control.submit(skillId, input);
    return accountControl(control).submit(skillId, input, { account });
  }
  if (command === 'bind-account') {
    if (words.some((w) => w === '--help' || w === '-h')) throw HELP_REQUESTED;
    if (words.length !== 2) throw usageError('bind-account takes a TASK_ID and an ACCOUNT_KEY');
    const [taskId, key] = words as [string, string];
    const errors: string[] = [];
    if (!ID.test(taskId)) errors.push("TASK_ID must be 1-128 letters, digits, '.', '_', ':' or '-', starting with a letter or digit");
    const account = explicitAccount(key, errors);
    if (errors.length > 0) throw new RuntimeError('invalid_input', `bind-account: ${errors.join('; ')}`, { errors });
    return accountControl(control).bindAccount(taskId, account!);
  }
  const id = single(command, words);
  switch (command) {
    case 'status':
      return control.status(id);
    case 'pause':
      return control.pause(id);
    case 'resume':
      return control.resume(id);
    case 'cancel':
      return control.cancel(id);
    case 'artifacts':
      return control.artifacts(id);
    case 'inspect-procedure': {
      const procedure = await control.inspectProcedure(id);
      if (procedure === undefined) throw new RuntimeError('not_found', `no procedure ${id}`);
      return procedure;
    }
  }
}

function agentViewControl(control: TaskControl): AgentViewControl {
  const candidate = control as TaskControl & Partial<AgentViewControl>;
  if (typeof candidate.agents !== 'function' || typeof candidate.usage !== 'function')
    throw new RuntimeError('capability_missing', 'this task runtime has no agent views');
  return candidate as AgentViewControl;
}

/** Words after `usage`. */
export function parseUsage(words: readonly string[]): { by: UsageGroupBy; since?: string } {
  const errors: string[] = [];
  let by: UsageGroupBy = 'agent';
  let since: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === '--help' || word === '-h') throw HELP_REQUESTED;
    const value = words[i + 1];
    if (word === '--by') {
      if (value === undefined || !(USAGE_GROUPS as readonly string[]).includes(value)) errors.push(`--by takes one of ${USAGE_GROUPS.join(', ')}`);
      else by = value as UsageGroupBy;
      i += 1;
    } else if (word === '--since') {
      if (value === undefined || !ISO_TIME.test(value)) errors.push('--since takes an ISO time with a zone, e.g. 2026-10-07T00:00:00+08:00');
      else since = new Date(value).toISOString();
      i += 1;
    } else errors.push(`unknown word ${quote(word)}`);
  }
  if (errors.length > 0) throw new RuntimeError('invalid_input', `usage: ${errors.join('; ')}`, { errors });
  return { by, ...(since !== undefined && { since }) };
}

function accountControl(control: TaskControl): AccountControl {
  const candidate = control as TaskControl & Partial<AccountControl>;
  // Never drop an account the user named: a control without bindAccount cannot honor it.
  if (typeof candidate.bindAccount !== 'function') throw new RuntimeError('capability_missing', 'this task runtime cannot bind accounts');
  return candidate as AccountControl;
}

/** The account the user named, bound as given: explicit, never inferred. */
function explicitAccount(key: string, errors: string[]): AccountScope | undefined {
  if (!ACCOUNT_KEY.test(key)) {
    errors.push('ACCOUNT_KEY must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit');
    return undefined;
  }
  return { platform: 'boss', accountKey: key, binding: 'explicit' };
}

/** The one ID the non-run commands take. */
function single(command: TaskCliCommand, words: readonly string[]): string {
  const what = command === 'inspect-procedure' ? 'PROCEDURE_ID' : 'TASK_ID';
  if (words.some((w) => w === '--help' || w === '-h')) throw HELP_REQUESTED;
  if (words.length !== 1) throw usageError(`${command} takes exactly one ${what}`);
  const id = words[0]!;
  if (!ID.test(id)) throw usageError(`${what} must be 1-128 letters, digits, '.', '_', ':' or '-', starting with a letter or digit`);
  return id;
}

type Flag = { kind: 'text' | 'path' | 'int' | 'choice' | 'time' | 'budget'; choices?: readonly string[] } | { kind: 'bool' };

const RUN_FLAGS: Readonly<Record<string, Flag>> = {
  '--job': { kind: 'text' },
  '--limit': { kind: 'int' },
  '--output': { kind: 'path' },
  '--source': { kind: 'choice', choices: ['conversations', 'recommend'] },
  '--mode': { kind: 'choice', choices: ['available', 'original-only'] },
  '--browse-limit': { kind: 'int' },
  '--deadline': { kind: 'time' },
  '--budget': { kind: 'budget' },
  '--analysis': { kind: 'choice', choices: ['off', 'on'] },
  '--take-over': { kind: 'bool' },
  '--keep-window': { kind: 'bool' },
  '--account': { kind: 'text' },
};

/** Words after `run`, checked in full; every problem is reported at once. */
export function parseRun(words: readonly string[]): { skillId: string; input: CollectResumesInput; account?: AccountScope } {
  const errors: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const budget: Partial<Budget> = {};
  const positional: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (!word.startsWith('-')) {
      positional.push(word);
      continue;
    }
    // Only in an option's place: `--job -h` is a job called "-h".
    if (word === '--help' || word === '-h') throw HELP_REQUESTED;
    const flag = RUN_FLAGS[word];
    if (flag === undefined) {
      errors.push(word.includes('=') ? `write ${quote(word.split('=')[0]!)} and its value as two words` : `unknown option ${quote(word)}`);
      continue;
    }
    if (flag.kind === 'bool') {
      if (flags.has(word)) errors.push(`${word} is given twice`);
      flags.add(word);
      continue;
    }
    const value = words[i + 1];
    if (value === undefined || value.startsWith('--')) {
      errors.push(`${word} needs a value`);
      continue;
    }
    i++;
    if (flag.kind === 'budget') {
      parseBudget(value, budget, errors);
      continue;
    }
    if (values.has(word)) {
      errors.push(`${word} is given twice`);
      continue;
    }
    values.set(word, value);
  }

  if (positional.length !== 1) errors.push(positional.length === 0 ? 'run needs a SKILL_ID' : `run takes one SKILL_ID, got ${positional.length} words`);
  const skillId = positional[0] ?? '';
  if (positional.length === 1 && !ID.test(skillId)) errors.push('SKILL_ID must be 1-128 letters, digits, ".", "_", ":" or "-"');

  for (const required of ['--job', '--limit', '--output']) if (!values.has(required)) errors.push(`run needs ${required}`);

  const raw: Record<string, unknown> = {};
  const job = values.get('--job');
  if (job !== undefined) raw.job = text('--job', job, MAX_TEXT, errors);
  const limit = values.get('--limit');
  if (limit !== undefined) raw.requestedCount = integer('--limit', limit, 1, 10_000, errors);
  const output = values.get('--output');
  if (output !== undefined) raw.outputDir = text('--output', output, MAX_PATH, errors);
  raw.source = choice('--source', values.get('--source') ?? RUN_DEFAULTS.source, errors);
  raw.captureMode = choice('--mode', values.get('--mode') ?? RUN_DEFAULTS.captureMode, errors);
  const browse = values.get('--browse-limit');
  if (browse !== undefined) raw.browseLimit = integer('--browse-limit', browse, 1, MAX_BROWSE, errors);
  const deadline = values.get('--deadline');
  if (deadline !== undefined) {
    if (!ISO_TIME.test(deadline) || Number.isNaN(Date.parse(deadline))) errors.push('--deadline must be an ISO time with a zone, such as 2026-10-05T18:00:00+08:00');
    raw.deadline = deadline;
  }
  if (Object.keys(budget).length > 0) raw.budget = budget;
  const analysis = values.get('--analysis');
  if (analysis !== undefined) raw.analysis = choice('--analysis', analysis, errors);
  if (flags.has('--take-over')) raw.takeOver = true;
  if (flags.has('--keep-window')) raw.keepWindow = true;
  const accountKey = values.get('--account');
  const account = accountKey === undefined ? undefined : explicitAccount(accountKey, errors);

  if (errors.length > 0) throw new RuntimeError('invalid_input', `run: ${errors.join('; ')}`, { errors });
  // The contract's own validator has the last word: absolute path, count
  // bounds, browse limit not below the count, deadline not already past.
  const input = assertValid(validateCollectResumesInput(raw), 'run');
  return account ? { skillId, input, account } : { skillId, input };

  function choice(name: string, value: string, errs: string[]): string {
    const allowed = (RUN_FLAGS[name] as { choices: readonly string[] }).choices;
    if (!allowed.includes(value)) errs.push(`${name} must be one of ${allowed.join(', ')}`);
    return value;
  }
}

function parseBudget(value: string, budget: Partial<Budget>, errors: string[]): void {
  const at = value.indexOf('=');
  const field = at < 0 ? value : value.slice(0, at);
  if (at < 0 || !BUDGET_FIELDS.has(field)) {
    errors.push(`--budget takes FIELD=N with FIELD one of ${[...BUDGET_FIELDS].join(', ')}`);
    return;
  }
  if (field in budget) {
    errors.push(`--budget ${field} is given twice`);
    return;
  }
  const n = integer(`--budget ${field}`, value.slice(at + 1), 0, Number.MAX_SAFE_INTEGER, errors);
  (budget as Record<string, number | undefined>)[field] = n;
}

function integer(name: string, value: string, min: number, max: number, errors: string[]): number | undefined {
  if (!DIGITS.test(value)) {
    errors.push(`${name} must be a whole number written in digits`);
    return undefined;
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    errors.push(`${name} must be from ${min} to ${max}`);
    return undefined;
  }
  return n;
}

function text(name: string, value: string, max: number, errors: string[]): string {
  if (value.trim() === '') errors.push(`${name} must not be empty`);
  else if (value.length > max) errors.push(`${name} must be at most ${max} characters`);
  else if (CONTROL.test(value)) errors.push(`${name} must not contain control characters`);
  return value;
}

const quote = (word: string): string => JSON.stringify(word.length > 64 ? `${word.slice(0, 64)}…` : word);

function usageError(message: string): RuntimeError {
  return new RuntimeError('invalid_input', message, { usage: CLI_USAGE });
}

/** Print the single JSON line for a result or an error, and pick the exit code. */
function emit(io: CliIO, command: TaskCliCommand | null, outcome: { result: unknown } | { error: unknown } | RuntimeError): number {
  if (outcome instanceof RuntimeError) outcome = { error: outcome };
  if ('result' in outcome) {
    const line = serialize({ ok: true, command, result: outcome.result ?? null });
    if (line !== undefined) {
      io.stdout(line);
      return 0;
    }
    outcome = { error: new Error('the result could not be written as JSON') };
  }
  const { error } = outcome;
  if (isRuntimeError(error)) {
    const body: Record<string, unknown> = { code: error.code, message: error.message };
    if (error.details !== undefined && serialize(error.details) !== undefined) body.details = error.details;
    io.stdout(serialize({ ok: false, command, error: body })!);
    return error.code === 'invalid_input' ? 2 : 1;
  }
  const message = error instanceof Error ? error.message : String(error);
  io.stdout(serialize({ ok: false, command, error: { code: 'internal', message } })!);
  return 1;
}

function serialize(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
