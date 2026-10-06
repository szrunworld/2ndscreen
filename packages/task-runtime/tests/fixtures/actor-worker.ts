// A stand-in worker for tests/actors.test.ts: records itself, starts one
// long-lived helper through the recorded spawner (like the bridge or the
// vision helper, in a process group of its own), says so, and waits.
import { ActorRegistry } from '../../src/actors.ts';
import { createLineProcessSpawner } from '../../src/adapters/agent-bridge.ts';

const registry = ActorRegistry.create(process.argv[2]!);
const spawn = registry.wrap(createLineProcessSpawner());
const child = spawn('/bin/sleep', ['600']);
process.stdout.write(JSON.stringify({ pid: process.pid, child: child.pid, record: registry.path }) + '\n');
setInterval(() => {}, 1 << 30);
