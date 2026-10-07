// The workflows a skill package may name in its task.json. A workflow is
// constructed only for a skill that is installed and names it: the generic
// runtime starts with none, and a build that carries no business package
// registers nothing here.
//
// The legacy BOSS workflow is registered by the entry points that still ship
// it (see legacyWorkflows); the roadmap's C01b moves it out of the generic
// build into the business package.

import type { BossWorkflow, LocalVision, TelemetryRecorder } from './contracts.ts';

export interface WorkflowDeps {
  vision?: LocalVision;
  telemetry?: TelemetryRecorder;
}

export type WorkflowFactory = (deps: WorkflowDeps) => BossWorkflow;

export interface WorkflowRegistry {
  has(id: string): boolean;
  create(id: string, deps: WorkflowDeps): BossWorkflow;
  ids(): string[];
}

export function createWorkflowRegistry(factories: Readonly<Record<string, WorkflowFactory>> = {}): WorkflowRegistry {
  const map = new Map(Object.entries(factories));
  return {
    has: (id) => map.has(id),
    create(id, deps) {
      const factory = map.get(id);
      if (!factory) throw new Error(`workflow ${id} is not registered`);
      return factory(deps);
    },
    ids: () => [...map.keys()],
  };
}

/** No business workflow at all: what a generic build registers. */
export const NO_WORKFLOWS: WorkflowRegistry = createWorkflowRegistry();

/** The BOSS résumé workflow this package still carries, for the entry points that opt in. */
export async function legacyWorkflows(): Promise<WorkflowRegistry> {
  const { createBossResumesWorkflow } = await import('./boss/workflow.ts');
  return createWorkflowRegistry({ 'boss-resumes-v1': (deps) => createBossResumesWorkflow(deps) });
}
