// OMN-041: approved vault and agent ownership correction.
// Acceptance tests with real child processes, synthetic data, temporary vaults and a fixture HOME / agent file.
// Agents run with a no-op wake: no scheduler, no real vault, no real config.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Vault } from '../src/vault.ts';
import { claimAgentFile } from '../src/agent.ts';
import { BusyError, guardFileFor } from '../src/ownership.ts';
import { contentHash } from '../src/schema.ts';
import { DecryptionError } from '../src/crypto.ts';
import { PASSWORD, TEST_KDF_N, tmp } from './helpers.ts';

const SRC = pathToFileURL(fileURLToPath(new URL('../src/', import.meta.url))).href;
const scripts = tmp(); // child script lives apart from any vault or fixture folder
const CHILD = join(scripts, 'ownership-child.mjs');
writeFileSync(CHILD, `
import { createInterface } from 'node:readline';
const [mode, vaultPath, src] = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const PW = process.env.OMNEME_TEST_PW;
try {
  const { Vault } = await import(src + 'vault.ts');
  if (mode === 'create') {
    const { vault } = await Vault.create(vaultPath, PW, { kdfN: Number(process.env.OMNEME_TEST_KDF_N) });
    out({ ok: true }); vault.lock(); process.exit(0);
  }
  const v = await Vault.unlock(vaultPath, { password: PW });
  if (mode === 'agent') {
    const { runAgent } = await import(src + 'agent.ts');
    await runAgent(v, (s) => out({ say: s }), { wake: () => {} });
  }
  out({ ok: true });
  const { callTool } = await import(src + 'mcp.ts');
  const { MemoryIndex } = await import(src + 'search.ts');
  const store = { vault: v, records: v.loadAll() };
  for await (const line of createInterface({ input: process.stdin })) {
    const [cmd, arg] = line.split(' ');
    if (cmd === 'save') {
      const r = callTool('save_memory', { project: 'Synthetic Ownership', status: arg, next: 'synthetic next' }, new MemoryIndex(store.records), store);
      out({ saved: !r.isError });
    }
    if (cmd === 'close') { v.lock(); out({ closed: true }); process.exit(0); }
  }
} catch (e) { out({ ok: false, name: e?.name, code: e?.code, message: String(e?.message) }); process.exit(3); }
`);

const HOME = tmp();
const kids: ChildProcess[] = [];
after(() => { for (const k of kids) if (k.exitCode === null && k.signalCode === null) k.kill('SIGKILL'); });

type Kid = { proc: ChildProcess; first: () => Promise<any>; until: (p: (o: any) => boolean) => Promise<any>; send: (s: string) => void; done: Promise<number | null> };
function child(mode: 'create' | 'hold' | 'agent', vaultPath: string, env: Record<string, string> = {}): Kid {
  const proc = spawn(process.execPath, [CHILD, mode, vaultPath, SRC], {
    env: { ...process.env, HOME, USERPROFILE: HOME, OMNEME_AGENT_FILE: join(HOME, '.omneme', 'agent.json'), OMNEME_TEST_PW: PASSWORD, OMNEME_TEST_KDF_N: String(TEST_KDF_N), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  kids.push(proc);
  const lines: any[] = []; let buf = ''; let err = '';
  proc.stdout!.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  proc.stderr!.on('data', (d) => { err += d; });
  let closed = false;
  const done = new Promise<number | null>((r) => proc.on('close', (c) => { closed = true; r(c); }));
  const until = async (p: (o: any) => boolean) => {
    const end = Date.now() + 60_000;
    for (;;) {
      const hit = lines.find(p); if (hit) return hit;
      if (closed) throw new Error(`child ended without the expected line; stderr: ${err.slice(0, 500)}`);
      if (Date.now() > end) throw new Error('child timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { proc, until, first: () => until(() => true), send: (s) => proc.stdin!.write(s + '\n'), done };
}

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
async function freshVault(name = 'v.omneme') {
  const d = tmp(); const path = join(d, name);
  (await Vault.create(path, PASSWORD, { kdfN: TEST_KDF_N })).vault.lock();
  return { d, path };
}
async function kill(k: Kid) { k.proc.kill('SIGKILL'); await k.done; }

test('simultaneous opens of one vault: exactly one winner; refused contenders leave the vault bytes unchanged', { timeout: 120_000 }, async () => {
  const { d, path } = await freshVault();
  const before = sha(path);
  const ks = [child('hold', path), child('hold', path), child('hold', path)];
  const firsts = await Promise.all(ks.map((k) => k.first()));
  assert.equal(firsts.filter((o) => o.ok).length, 1, 'one opener wins');
  for (const o of firsts.filter((x) => !x.ok)) { assert.equal(o.code, 'EBUSY'); assert.match(o.message, /already open/); }
  assert.equal(sha(path), before, 'vault bytes unchanged while contenders were refused');
  // A live guard transaction may have its own journal; it must not create vault journals or partial vaults.
  assert.deepEqual(readdirSync(d).filter((f) => /journal|creating|partial/.test(f) && !/^v\.omneme\.owner-journal$/.test(f)), []);
  for (const k of ks) await kill(k);
});

test('simultaneous creates of one path: one winner, no overwrite, no leftover temp file', { timeout: 120_000 }, async () => {
  const d = tmp(); const path = join(d, 'new.omneme');
  const ks = [child('create', path), child('create', path), child('create', path), child('create', path)];
  const firsts = await Promise.all(ks.map((k) => k.first()));
  assert.equal(firsts.filter((o) => o.ok).length, 1, 'exactly one creator wins');
  for (const o of firsts.filter((x) => !x.ok)) assert.ok(o.code === 'EBUSY' || /already exists/.test(o.message), o.message);
  await Promise.all(ks.map((k) => k.done));
  assert.ok(!existsSync(path + '.creating'));
  const v = await Vault.unlock(path, { password: PASSWORD });
  const r = v.verify(contentHash); v.lock();
  assert.ok(r.recordSetOk); assert.equal(r.total, 0);
});

test('aliases share ownership: relative path and symlinked parent are refused at once, even with a wrong password', { timeout: 60_000 }, async (t) => {
  const { d, path } = await freshVault();
  const holder = child('hold', path); assert.equal((await holder.first()).ok, true);
  const t0 = Date.now();
  await assert.rejects(Vault.unlock(relative(process.cwd(), path), { password: 'wrong password!' }), BusyError);
  await assert.rejects(Vault.unlock(path, { password: PASSWORD }), BusyError);
  await assert.rejects(Vault.resetPassword(path, { recoveryKey: '0'.repeat(64), newPassword: 'another password', confirmPassword: 'another password', kdfN: TEST_KDF_N }), BusyError);
  assert.ok(Date.now() - t0 < 5000, 'refusal is prompt');
  const link = join(tmp(), 'linked');
  let linked = true;
  try { symlinkSync(d, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { linked = false; }
  if (linked) {
    assert.equal(guardFileFor(join(link, 'v.omneme')), guardFileFor(path));
    await assert.rejects(Vault.unlock(join(link, 'v.omneme'), { password: PASSWORD }), BusyError);
  } else t.diagnostic('symlink/junction not permitted here; symlink-parent alias not exercised');
  await kill(holder);
});

test('clean lock releases (repeat lock safe); failed password releases; reopen works', async () => {
  const { path } = await freshVault();
  const v = await Vault.unlock(path, { password: PASSWORD });
  await assert.rejects(Vault.unlock(path, { password: PASSWORD }), BusyError, 'same-process second opener is refused too');
  v.lock(); v.lock();
  await assert.rejects(Vault.unlock(path, { password: 'wrong password!' }), DecryptionError);
  const v2 = await Vault.unlock(path, { password: PASSWORD }); v2.lock();
  const w = child('hold', path); assert.equal((await w.first()).ok, true, 'another process can open after release');
  w.send('close'); await w.until((o) => o.closed); await w.done;
});

test('a force-killed owner releases ownership without deleting any stale file', { timeout: 60_000 }, async () => {
  const { path } = await freshVault();
  const holder = child('hold', path); assert.equal((await holder.first()).ok, true);
  await assert.rejects(Vault.unlock(path, { password: PASSWORD }), BusyError);
  await kill(holder);
  assert.ok(existsSync(guardFileFor(path)), 'guard file is still there; only the dead transaction released it');
  const v = await Vault.unlock(path, { password: PASSWORD }); v.lock();
});

test('reproduction: a second writer is excluded; sequential writes keep count/digest, verify and backup/restore pass', { timeout: 120_000 }, async () => {
  const { d, path } = await freshVault();
  const a = child('hold', path); assert.equal((await a.first()).ok, true);
  const b = child('hold', path);
  const bf = await b.first(); assert.equal(bf.ok, false); assert.equal(bf.code, 'EBUSY');
  a.send('save A'); assert.equal((await a.until((o) => 'saved' in o)).saved, true);
  a.send('close'); await a.until((o) => o.closed); await a.done;
  const c = child('hold', path); assert.equal((await c.first()).ok, true);
  c.send('save B'); assert.equal((await c.until((o) => 'saved' in o)).saved, true);
  c.send('close'); await c.until((o) => o.closed); await c.done;
  const v = await Vault.unlock(path, { password: PASSWORD });
  const r = v.verify(contentHash);
  assert.equal(r.total, 2); assert.equal(r.expected, 2); assert.ok(r.recordSetOk); assert.equal(r.failed, 0);
  const bak = join(d, 'b.omnbak'); v.exportBackup(bak);
  const state = v.recordSetState(); v.lock();
  const target = join(tmp(), 'restored.omneme');
  assert.deepEqual((await Vault.restoreBackup(bak, target, { password: PASSWORD })).state, state);
  const rv = await Vault.unlock(target, { password: PASSWORD });
  assert.equal(rv.verify(contentHash).fingerprint, r.fingerprint); rv.lock();
});

test('agents: one publisher per agent file; loser exits and leaves the record unchanged; separate agent files coexist', { timeout: 120_000 }, async () => {
  const v1 = await freshVault(), v2 = await freshVault();
  const af = join(tmp(), 'home-a', '.omneme', 'agent.json');
  const a = child('agent', v1.path, { OMNEME_AGENT_FILE: af });
  await a.until((o) => /UNLOCKED/.test(o.say ?? ''));
  const rec = readFileSync(af, 'utf8');
  assert.equal(JSON.parse(rec).pid, a.proc.pid);
  const b = child('agent', v2.path, { OMNEME_AGENT_FILE: af });
  const bf = await b.until((o) => o.ok === false);
  assert.equal(bf.code, 'EBUSY'); assert.notEqual(await b.done, 0, 'loser exits with an error');
  assert.equal(readFileSync(af, 'utf8'), rec, 'winner record untouched');
  const lv = await Vault.unlock(v2.path, { password: PASSWORD }); lv.lock(); // loser released its vault
  const af2 = join(tmp(), 'home-b', '.omneme', 'agent.json');
  const c = child('agent', v2.path, { OMNEME_AGENT_FILE: af2 });
  await c.until((o) => /UNLOCKED/.test(o.say ?? ''));
  assert.equal(JSON.parse(readFileSync(af2, 'utf8')).pid, c.proc.pid);
  assert.equal(readFileSync(af, 'utf8'), rec);
  await kill(a); await kill(c);
});

test('agents: a live pre-guard agent record or unknown/invalid PID is never overwritten; a proven-dead PID is replaced', { timeout: 120_000 }, async () => {
  const { path } = await freshVault();
  const dir = join(tmp(), '.omneme'); mkdirSync(dir); const af = join(dir, 'agent.json');
  // In-process check: live same-process PID and all missing/invalid/unsafe PID variants must throw BusyError,
  // preserve exact file bytes, and release the agent-file ownership guard.
  const badRecords = [
    JSON.stringify({ port: 1, token: 'synthetic', pid: process.pid }), // live same-process PID
    JSON.stringify({ port: 1, token: 'synthetic' }),                   // missing PID
    JSON.stringify({ port: 1, token: 'synthetic', pid: null }),        // null PID
    JSON.stringify({ port: 1, token: 'synthetic', pid: '12345' }),     // string PID
    JSON.stringify({ port: 1, token: 'synthetic', pid: 0 }),           // zero PID
    JSON.stringify({ port: 1, token: 'synthetic', pid: -5 }),          // negative PID
    JSON.stringify({ port: 1, token: 'synthetic', pid: 12.34 }),       // fractional PID
    JSON.stringify({ port: 1, token: 'synthetic', pid: Number.MAX_SAFE_INTEGER + 1 }), // unsafe integer PID
    'null',
    '[]',
    '{corrupt-json',
  ];
  for (const raw of badRecords) {
    writeFileSync(af, raw);
    assert.throws(() => claimAgentFile(af), BusyError, `must refuse record: ${raw}`);
    assert.equal(readFileSync(af, 'utf8'), raw, `record bytes must be preserved for: ${raw}`);
  }
  // Child-process agent must also refuse live or unknown-PID records, preserve bytes, and release its vault and agent guard.
  for (const raw of [
    JSON.stringify({ port: 1, token: 'synthetic', pid: process.pid }),
    JSON.stringify({ port: 1, token: 'synthetic' }),
    JSON.stringify({ port: 1, token: 'synthetic', pid: null }),
    JSON.stringify({ port: 1, token: 'synthetic', pid: '12345' }),
  ]) {
    writeFileSync(af, raw);
    const b = child('agent', path, { OMNEME_AGENT_FILE: af });
    assert.equal((await b.until((o) => o.ok === false)).code, 'EBUSY');
    assert.notEqual(await b.done, 0);
    assert.equal(readFileSync(af, 'utf8'), raw);
    const v = await Vault.unlock(path, { password: PASSWORD }); v.lock(); // contender released its vault guard
  }
  // A positive safe-integer PID proven dead (ESRCH) is replaced cleanly.
  const gone = spawn(process.execPath, ['-e', '']); const deadPid = gone.pid!; await new Promise((r) => gone.on('close', r));
  writeFileSync(af, JSON.stringify({ port: 1, token: 'synthetic', pid: deadPid }));
  const c = child('agent', path, { OMNEME_AGENT_FILE: af });
  await c.until((o) => /UNLOCKED/.test(o.say ?? ''));
  assert.equal(JSON.parse(readFileSync(af, 'utf8')).pid, c.proc.pid);
  await kill(c);
});
