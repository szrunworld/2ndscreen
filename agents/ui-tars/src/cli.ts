#!/usr/bin/env -S npx tsx
// Run one instruction with a UI-TARS model on a 2ndscreen agent screen.
//
//   ARK_API_KEY=... npx tsx src/cli.ts --screen chat --pid 1234 "打开文件传输助手，读最新一条消息"

import { parseArgs } from 'node:util';
import { GUIAgent, UITarsModelVersion } from '@ui-tars/sdk';
import { SecondScreenOperator } from './operator.ts';
import type { Step } from './plan.ts';

const usage = `usage: 2ndscreen-ui-tars --screen NAME --pid PID [--window-id ID]
                          [--allow-submit] [--foreground] [--max-steps N] INSTRUCTION

Runs INSTRUCTION with a UI-TARS model on an agent screen, acting only on the
app with PID. Without --allow-submit, the run stops before anything that
would send or submit: Enter, typed text ending in a newline, or a click on a
Send button. Without --foreground, nothing takes the user's pointer.

Environment:
  ARK_API_KEY        Volcengine Ark API key (required)
  ARK_MODEL          model or endpoint ID (default doubao-1-5-ui-tars-250428)
  ARK_BASE_URL       default https://ark.cn-beijing.volces.com/api/v3
  UI_TARS_VERSION    doubao-1.5-15B (default), doubao-1.5-20B, 1.5 or 1.0
  SECONDSCREEN_CLI   path to the 2ndscreen command (default: on PATH)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    screen: { type: 'string' },
    pid: { type: 'string' },
    'window-id': { type: 'string' },
    'allow-submit': { type: 'boolean', default: false },
    foreground: { type: 'boolean', default: false },
    'max-steps': { type: 'string', default: '25' },
    help: { type: 'boolean', short: 'h' },
  },
});

const instruction = positionals.join(' ').trim();
if (values.help || !values.screen || !values.pid || !instruction) {
  console.error(usage);
  process.exit(values.help ? 0 : 2);
}
const apiKey = process.env.ARK_API_KEY;
if (!apiKey) {
  console.error('set ARK_API_KEY to a Volcengine Ark API key');
  process.exit(2);
}

const describe = (step: Step) =>
  step.kind === 'run' ? `$ 2ndscreen ${step.words.join(' ')}` : step.kind === 'wait' ? `wait ${step.ms} ms` : `stop: ${step.reason}`;

const operator = new SecondScreenOperator({
  screen: values.screen,
  pid: Number(values.pid),
  windowId: values['window-id'] ? Number(values['window-id']) : undefined,
  allowSubmit: values['allow-submit'],
  foreground: values.foreground,
  onStep: (step) => console.error(`  ${describe(step)}`),
  onError: (error) => console.error(`  ! ${error.message}`),
});

let status = 'init';
const quiet = { log() {}, info() {}, warn: console.warn, error: console.error };

const agent = new GUIAgent({
  model: {
    baseURL: process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey,
    model: process.env.ARK_MODEL || 'doubao-1-5-ui-tars-250428',
  },
  uiTarsVersion: (process.env.UI_TARS_VERSION as UITarsModelVersion) || UITarsModelVersion.DOUBAO_1_5_15B,
  operator,
  maxLoopCount: Number(values['max-steps']),
  logger: quiet,
  onData: ({ data }) => {
    status = data.status;
    for (const conversation of data.conversations ?? []) {
      for (const prediction of conversation.predictionParsed ?? []) {
        console.error(`· ${prediction.thought.trim()}\n  → ${prediction.action_type}(${JSON.stringify(prediction.action_inputs)})`);
      }
    }
  },
  onError: ({ error }) => console.error(`error: ${error.message ?? JSON.stringify(error)}`),
});

await agent.run(instruction);
// The operator ends runs it stops itself; otherwise the agent's status says
// how it ended: finished, or a step limit, an error or a call for help.
const result = operator.stop ?? (status === 'end' ? { outcome: 'done', reason: 'finished' } : { outcome: 'user', reason: status });
console.log(JSON.stringify({ ok: result.outcome === 'done', ...result }));
process.exit(result.outcome === 'done' ? 0 : 1);
