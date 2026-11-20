// OMN-022: immediate worker wake after an approved ChatGPT task handoff. Synthetic data and temporary vaults only.
// The wake is always mocked: no schtasks.exe, no shell, no scheduler changes. Windows-compatible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { Vault } from '../src/vault.ts';
import { MemoryIndex } from '../src/search.ts';
import { latestHandoff } from '../src/handoff.ts';
import { handleCall, createWorkerWake, shouldWake, wakeCommand, wakeEnabled, WORKER_TASK } from '../src/agent.ts';
const ON = { OMNEME_WORKER_WAKE: '1' }; // OMN-045: the wake is opt-in; these tests enable it explicitly
import { PASSWORD, TEST_KDF_N, tmp } from './helpers.ts';

const approved = { project: 'Omneme Tasks', source: 'chatgpt', status: 'TASK OMN-999 | APPROVAL: APPROVED', next: 'synthetic next' };

async function store() {
  const { vault } = await Vault.create(join(tmp(), 'v.omneme'), PASSWORD, { kdfN: TEST_KDF_N });
  const records = vault.loadAll(); return { vault, records, ix: new MemoryIndex(records) };
}
function mockSpawn(outcome: { exit?: number; error?: string; throws?: boolean }) {
  const calls: { file: string; args: string[]; opts: any }[] = [];
  const spawn = (file: string, args: string[], opts: object) => {
    calls.push({ file, args, opts });
    if (outcome.throws) throw Object.assign(new Error('x'), { code: 'EPERM' });
    const c = new EventEmitter() as EventEmitter & { unref(): void }; c.unref = () => {};
    setImmediate(() => outcome.error ? c.emit('error', Object.assign(new Error('x'), { code: outcome.error })) : c.emit('exit', outcome.exit ?? 0));
    return c;
  };
  return { spawn, calls };
}
const tick = () => new Promise((r) => setImmediate(() => setImmediate(r)));

test('approved ChatGPT task save is durable, then requests one wake with fixed command (async, hidden)', async () => {
  const s = await store(); const logs: string[] = []; const m = mockSpawn({ exit: 0 });
  const wake = createWorkerWake({ env: ON, spawn: m.spawn, platform: 'win32', say: (x) => logs.push(x) });
  let savedBeforeWake = false;
  const r = handleCall('save_memory', approved, s.ix, s, () => { savedBeforeWake = !!latestHandoff(s.vault.loadAll(), 'Omneme Tasks'); wake(); });
  assert.equal(r.isError, undefined); assert.ok(savedBeforeWake, 'handoff is in the vault before the wake is requested');
  assert.equal(m.calls.length, 1);
  assert.deepEqual(m.calls[0].args, ['/Run', '/TN', WORKER_TASK]); assert.equal(m.calls[0].file, wakeCommand().file);
  assert.match(m.calls[0].file, /System32[\\/]schtasks\.exe$/i);
  assert.equal(m.calls[0].opts.windowsHide, true); assert.equal(m.calls[0].opts.shell, false);
  await tick(); assert.ok(logs.some((l) => /Worker wake requested/.test(l)));
  assert.ok(!logs.join('\n').includes('OMN-999') && !logs.join('\n').includes('synthetic next'), 'logs are content-free');
});

test('wake failure (spawn error, non-zero exit, throw) never fails the save; logs a content-free fallback note', async () => {
  for (const outcome of [{ error: 'ENOENT' }, { exit: 1 }, { throws: true }]) {
    const s = await store(); const logs: string[] = []; const m = mockSpawn(outcome);
    const r = handleCall('save_memory', approved, s.ix, s, createWorkerWake({ env: ON, spawn: m.spawn, platform: 'win32', say: (x) => logs.push(x) }));
    assert.equal(r.isError, undefined); assert.ok(latestHandoff(s.vault.loadAll(), 'Omneme Tasks'));
    await tick(); assert.equal(logs.length, 1); assert.match(logs[0], /Worker wake failed .*ten-minute schedule still applies/);
    assert.ok(!logs[0].includes('OMN-999'));
  }
  // A wake function that itself throws cannot break the save either.
  const s = await store();
  const r = handleCall('save_memory', approved, s.ix, s, () => { throw new Error('boom'); });
  assert.equal(r.isError, undefined);
});

test('no wake for failed saves, non-approved statuses, other projects, other sources and other tools', async () => {
  const cases: [string, any][] = [
    ['save_memory', { ...approved, project: '' }], // save fails
    ['save_memory', { ...approved, status: 'TASK OMN-999 | APPROVAL: DONE' }],
    ['save_memory', { ...approved, status: 'TASK OMN-999 | APPROVAL: PENDING' }],
    ['save_memory', { ...approved, status: 'TASK OMN-999 | APPROVAL: APPROVED & calc.exe' }],
    ['save_memory', { ...approved, status: 'Decision: TASK OMN-999 | APPROVAL: APPROVED' }],
    ['save_memory', { ...approved, project: 'Omneme Tasks Extra' }],
    ['save_memory', { ...approved, project: 'Other' }],
    ['save_memory', { ...approved, source: 'claude' }],
    ['save_memory', { ...approved, source: 'ChatGPT ' }],
    ['save_memory', { project: approved.project, status: approved.status, next: 'x' }], // default source claude
    ['resume_memory', { project: 'Omneme Tasks' }],
    ['search_memory', { query: 'x' }],
  ];
  for (const [name, args] of cases) {
    const s = await store(); let woke = 0;
    handleCall(name, args, s.ix, s, () => { woke++; });
    assert.equal(woke, 0, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(shouldWake('save_memory', approved, { text: 'x', isError: true }), false);
});

test('non-Windows skips the wake; overlapping wakes collapse to one in-flight request', async () => {
  const logs: string[] = []; const m = mockSpawn({ exit: 0 });
  createWorkerWake({ env: ON, spawn: m.spawn, platform: 'linux', say: (x) => logs.push(x) })();
  assert.equal(m.calls.length, 0); assert.match(logs[0], /skipped/);
  const w = createWorkerWake({ env: ON, spawn: m.spawn, platform: 'win32', say: () => {} });
  w(); w(); assert.equal(m.calls.length, 1);
  await tick(); w(); assert.equal(m.calls.length, 2, 'a new wake is allowed after the previous one finished');
});

// OMN-045: default install. Without OMNEME_WORKER_WAKE=1 an approved-looking ChatGPT save is stored but never reaches
// the scheduler; only the exact value "1" enables the wake, and the existing safeguards still apply when it is on.
test('worker wake is OFF by default and only exactly OMNEME_WORKER_WAKE=1 turns it on', async () => {
  for (const env of [{}, { OMNEME_WORKER_WAKE: '' }, { OMNEME_WORKER_WAKE: 'true' }, { OMNEME_WORKER_WAKE: 'yes' }, { OMNEME_WORKER_WAKE: ' 1' }, { OMNEME_WORKER_WAKE: '0' }]) {
    const s = await store(); const m = mockSpawn({}); const logs: string[] = [];
    const r = handleCall('save_memory', approved, s.ix, s, createWorkerWake({ env, spawn: m.spawn, platform: 'win32', say: (x) => logs.push(x) }));
    assert.equal(r.isError, undefined); assert.ok(latestHandoff(s.vault.loadAll(), 'Omneme Tasks'), 'save is still durable');
    await tick(); assert.equal(m.calls.length, 0, `no scheduler call for ${JSON.stringify(env)}`); assert.deepEqual(logs, []);
    assert.equal(wakeEnabled(env), false);
  }
  const s = await store(); const m = mockSpawn({});
  handleCall('save_memory', approved, s.ix, s, createWorkerWake({ env: ON, spawn: m.spawn, platform: 'win32', say: () => {} }));
  assert.equal(m.calls.length, 1); assert.deepEqual(m.calls[0].args, ['/Run', '/TN', WORKER_TASK]);
  handleCall('save_memory', { ...approved, source: 'claude' }, s.ix, s, createWorkerWake({ env: ON, spawn: m.spawn, platform: 'win32', say: () => {} }));
  assert.equal(m.calls.length, 1, 'enabled wake keeps the exact source/status/project checks');
  assert.equal(wakeEnabled(ON), true);
});
