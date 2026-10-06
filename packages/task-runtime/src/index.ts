// @2ndscreen/task-runtime: the public contract and the assembled runtime.
//
// contracts.ts holds every type, validator and rule the modules share
// (docs/task-runtime-contracts.md). The assembly in bootstrap.ts builds
// what `2ndscreen task` uses: openControlClient for the short-lived command
// line, startWorker for the background process that runs tasks.

export * from './contracts.ts';
export * from './agent-contracts.ts';
export * from './agent-host.ts';
export * from './agent-status.ts';
export * from './agent-ledgers.ts';
export {
  loadSkills,
  openControlClient,
  preparePrivateDirs,
  resolveConfig,
  runtimePaths,
  startWorker,
  workerCommand,
  type ControlClient,
  type RuntimeConfig,
  type RuntimePaths,
  type SkillPackage,
  type Worker,
  type WorkerOptions,
} from './bootstrap.ts';
export { runCli, CLI_COMMANDS, CLI_USAGE } from './cli.ts';
export { ActorRegistry, verifyWorkerStopped, type ActorRecord } from './actors.ts';
export type { ActorExitVerdict, ActorExitVerifier, WorkerRecord } from './daemon.ts';
