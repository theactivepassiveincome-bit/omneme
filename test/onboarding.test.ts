// OMN-026/027 first-run flow: create, import, rebuild index, search, and the security boundaries.
// Synthetic fixtures only.
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { Vault } from '../src/vault.ts';
import { contentHash } from '../src/schema.ts';
import { startWeb } from '../src/web.ts';
import { DISPOSABLE_VAULT, LIVE_DEFAULT_VAULT, resolveVaultSelection, selectVault, startOptions } from '../src/start.ts';
import { MARKERS, PASSWORD, TEST_KDF_N, makeZip, tmp, writeChatgptZip, writeClaudeZip } from './helpers.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const post = (base: string, path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', body: form(body), headers: { ...FORM, ...headers }, redirect: 'manual' });
const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0];

test('first run: create vault, recovery key shown once, import, rebuild index, find a conversation', async () => {
  const d = tmp();
  const path = join(d, 'first-run', 'vault.omneme');
  const web = await startWeb({ vaultPath: path, port: 0, onboarding: { kdfN: TEST_KDF_N } });
  try {
    let html = await (await fetch(web.url)).text();
    assert.match(html, /No vault exists yet/);
    assert.match(html, /action="\/create"/);
    let res = await post(web.url, 'create', { password: PASSWORD, repeat: 'different password' });
    assert.equal(res.status, 400);
    assert.ok(!existsSync(path));
    res = await post(web.url, 'create', { password: 'short', repeat: 'short' });
    assert.equal(res.status, 400);
    res = await post(web.url, 'create', { password: PASSWORD, repeat: PASSWORD });
    assert.equal(res.status, 200);
    html = await res.text();
    assert.match(html, /[0-9a-f]{4}(-[0-9a-f]{4}){15}/, 'recovery key shown');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(existsSync(path));
    const cookie = cookieOf(res);
    html = await (await fetch(web.url, { headers: { cookie } })).text();
    assert.match(html, /action="\/import"/);
    assert.ok(!/[0-9a-f]{4}(-[0-9a-f]{4}){15}/.test(html), 'recovery key not shown again');

    // Import one supported export (path pasted with Windows-style quotes).
    const exp = tmp();
    res = await post(web.url, 'import', { path: `"${writeChatgptZip(exp)}"` }, { cookie });
    assert.equal(res.status, 200);
    html = await res.text();
    assert.match(html, /Import complete/);
    assert.ok(!html.includes(MARKERS.simple), 'import report must not echo content');
    assert.match(html, /<a class="primary" href="\/connect">Connect your AI<\/a>/, 'Connect your AI is primary action');
    assert.match(html, /<a[^>]* href="\/"[^>]*>Search your conversations<\/a>/, 'Search remains available as secondary action');
    assert.match(html, /<a[^>]* href="\/#import"[^>]*>Import another platform<\/a>/, 'Import another platform remains available as secondary action');
    // Search finds the imported conversation without a manual rebuild.
    html = await (await fetch(web.url + '?q=' + encodeURIComponent(MARKERS.simple), { headers: { cookie } })).text();
    assert.match(html, /1 result/);
    assert.ok(html.includes(MARKERS.title));
    assert.match(html, /id="import"/);
    assert.match(html, /href="\/connect">Connect your AI<\/a>/);
    res = await fetch(web.url + 'conversation?id=chatgpt%3Acg-simple', { headers: { cookie } });
    assert.equal(res.status, 200);
    // Explicit rebuild works and keeps results.
    res = await post(web.url, 'reindex', {}, { cookie });
    assert.equal(res.status, 303);
    assert.match(await (await fetch(web.url + '?q=' + encodeURIComponent(MARKERS.simple), { headers: { cookie } })).text(), /1 result/);
    // Bad paths are refused without touching the vault.
    assert.equal((await post(web.url, 'import', { path: 'relative/export.zip' }, { cookie })).status, 400);
    assert.equal((await post(web.url, 'import', { path: join(exp, 'missing.zip') }, { cookie })).status, 404);
    assert.equal((await post(web.url, 'import', { path }, { cookie })).status, 400);
  } finally { await web.close(); }
  // The vault on disk is intact and unlockable with the chosen password.
  const v = await Vault.unlock(path, { password: PASSWORD });
  try { const r = v.verify(contentHash); assert.equal(r.failed, 0); assert.equal(r.recordSetOk, true); } finally { v.lock(); }
});

test('OMN-028: Connect your AI guidance, client setup, single ownership, Gemini separation, custom project prompt and HTML escaping', async () => {
  const d = tmp();
  const path = join(d, "O'Reilly & Co", 'vault.omneme');
  const escapedPath = path.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
  const web = await startWeb({ vaultPath: path, port: 0, onboarding: { kdfN: TEST_KDF_N } });
  try {
    // Unauthenticated /connect is refused in onboarding mode.
    assert.equal((await fetch(web.url + 'connect')).status, 401);
    const createRes = await post(web.url, 'create', { password: PASSWORD, repeat: PASSWORD });
    assert.equal(createRes.status, 200);
    const cookie = cookieOf(createRes);
    const exp = tmp();
    const impRes = await post(web.url, 'import', { path: writeChatgptZip(exp) }, { cookie });
    assert.equal(impRes.status, 200);
    const impHtml = await impRes.text();
    // OMN-032: the vault is called "Your vault"; its path is never rendered, raw or escaped.
    assert.match(impHtml, /Your vault/);
    assert.ok(!impHtml.includes(escapedPath) && !impHtml.includes(path), 'vault path is never emitted');
    // OMN-029: the import result links to /connect instead of repeating the full setup guide.
    assert.ok(!impHtml.includes('id="connect-ai"'), 'full setup guide is not duplicated on the import result');
    assert.ok(!impHtml.includes('claude mcp add'), 'client setup commands only on /connect');

    // Dedicated /connect route with user-chosen project name containing HTML-special characters.
    const rawProject = 'Alpha <script>&" Team \'1\'';
    const escProject = 'Alpha &lt;script&gt;&amp;&quot; Team &#39;1&#39;';
    const connRes = await fetch(web.url + 'connect?project=' + encodeURIComponent(rawProject), { headers: { cookie } });
    assert.equal(connRes.status, 200);
    const html = await connRes.text();
    assert.ok(!html.includes('<script>'), 'project name is HTML-escaped');
    assert.ok(html.includes(escProject), 'escaped project name appears in form and copyable resume prompt');
    assert.ok(!html.includes(escapedPath) && !html.includes(path), 'vault path is never emitted');
    assert.ok(html.includes('agent --vault "YOUR-VAULT-FILE"'), 'custom vault uses a labelled placeholder');
    // OMN-031: Claude Code is the default client; the other clients are offered as choices only.
    assert.match(html, /Claude Code \(verified default\)/);
    assert.match(html, /claude mcp add omneme --scope user/);
    assert.match(html, /href="\/connect\?client=chatgpt-work&amp;project=/, 'client links keep the project');
    assert.match(html, /href="\/connect\?client=antigravity&amp;project=/);
    assert.ok(!html.includes('[mcp_servers.omneme]'), 'only the selected client setup is shown');
    assert.ok(!html.includes('mcp_config.json'), 'only the selected client setup is shown');
    // Gemini separation & explicit limitations.
    assert.match(html, /Gemini history import vs\. connecting an AI client/);
    assert.match(html, /Gemini is import-only/);
    // Single vault ownership & non-default onboarding vault warning.
    assert.match(html, /Single vault ownership/);
    assert.match(html, /Lock vault/);
    assert.match(html, /id="agent-cmd">node --no-warnings bin\\omneme\.mjs agent --vault "YOUR-VAULT-FILE"<\/pre>/, 'OMN-038: custom vault is named explicitly');
    assert.doesNotMatch(html, /opens only your main vault|always use your main vault/, 'OMN-033: launcher guidance matches the shared vault rule');
    assert.match(html, /id="launcher-vaults"[^>]*>[\s\S]*?pass <code>--vault<\/code> for this vault[\s\S]*?<code>backup<\/code>, <code>handoff-latest<\/code> and <code>handoff-save<\/code> use your main vault/);
    assert.doesNotMatch(html, /Omneme [A-Z][\w ]*\.cmd/, 'OMN-038: no launcher absent from the source download');
    assert.doesNotMatch(html, /count must be/); assert.match(html, /<details id="advanced">[\s\S]*?Optional troubleshooting:/);
    assert.ok(!/logs <code>resume_memory<\/code>|tool log/i.test(html), 'no instruction to look for tool calls in the Unlock console');
    // Non-main onboarding vault: switching is marked unverified, distinct from live-vault evidence.
    assert.match(html, /Claude Code retrieved a known record from a separate test vault/);
    assert.doesNotMatch(html, /not yet verified end to end/);
    assert.ok(!html.includes(PASSWORD), 'password is never included in guidance or generated settings');
    assert.ok(!/[0-9a-f]{4}(-[0-9a-f]{4}){15}/.test(html), 'recovery key is never included in guidance');

    // Other clients keep their existing instructions and verification guidance.
    for (const [client, needles] of [['chatgpt-work', ['[mcp_servers.omneme]', 'config.toml', 'handoff-latest', 'single backslashes are correct']], ['antigravity', ['omneme-pilot', 'mcp_config.json', 'In JSON every backslash must be doubled', 'C:/Users/NAME/omneme/bin/omneme.mjs']]] as const) {
      const r = await fetch(web.url + 'connect?client=' + client + '&project=' + encodeURIComponent(rawProject), { headers: { cookie } });
      assert.equal(r.status, 200);
      const h = await r.text();
      for (const n of needles) assert.ok(h.includes(n), `${client} shows ${n}`);
      assert.ok(!h.includes('claude mcp add'), `${client} page hides Claude Code setup`);
      assert.ok(h.includes(escProject) && !h.includes('<script>'), 'project kept and escaped');
      assert.ok(h.includes(`name="client" value="${client}"`), 'project form keeps the client');
      assert.match(h, /How to tell your connected AI sees/);
      assert.match(h, /<details id="advanced">[\s\S]*?Optional troubleshooting:[\s\S]*?matching count alone cannot confirm/);
      assert.match(h, /Positive evidence \(vault-specific record\)/);
      assert.match(h, /Empty result is inconclusive/);
      assert.ok(!/reports none found, the Unlock agent is still running against a different vault/.test(h), 'empty result is not claimed to mean wrong vault');
      assert.match(h, /id="separate-vault-unverified"/, 'separate-vault use marked unverified for non-default clients');
      assert.ok(h.includes('agent --vault "YOUR-VAULT-FILE"'));
      assert.ok(!h.includes(escapedPath) && !h.includes(path));
      assert.ok(!h.includes(PASSWORD));
      if (client === 'chatgpt-work') {
        // OMN-033: desktop restart guidance and only the verification scope actually established.
        assert.match(h, /id="chatgpt-work-restart"[\s\S]*?fully quit the ChatGPT app and reopen it/);
        assert.match(h, /id="chatgpt-work-evidence"[^>]*>[^<]*dedicated test connector\. This standard setup and browser ChatGPT have not been verified\./);
        assert.doesNotMatch(h, /Confirmed capabilities/);
        assert.doesNotMatch(h, /this client connection was confirmed against the main vault/);
        const prompt = /id="resume-prompt">([^<]*)<\/pre>/.exec(h)?.[1] ?? '';
        assert.doesNotMatch(prompt, /[A-Za-z]:\\|\/(Users|home)\/|\.omneme/, 'no personal paths in the copyable AI prompt');
      }
    }

    // Incomplete import (422) does NOT promote Connect your AI as the primary action, while keeping Search and Import another platform.
    const brokenZip = join(exp, 'broken-export.zip');
    writeFileSync(brokenZip, makeZip([{ name: 'conversations.json', data: '[{"conversation_id":"bad"' }]));
    const incRes = await post(web.url, 'import', { path: brokenZip }, { cookie });
    assert.equal(incRes.status, 422);
    const incHtml = await incRes.text();
    assert.match(incHtml, /Import INCOMPLETE/);
    assert.ok(!incHtml.includes('class="primary" href="/connect"'), 'incomplete import does not show Connect your AI as primary action');
    assert.match(incHtml, /<a[^>]* href="\/"[^>]*>Search your conversations<\/a>/);
    assert.match(incHtml, /<a[^>]* href="\/#import"[^>]*>Import another platform<\/a>/);
  } finally { await web.close(); }
});

test('OMN-031: client choice, Claude Code numbered setup for the selected vault, known-record check, invalid client', async () => {
  const d = tmp();
  const path = join(d, "Tom & Jerry's", 'vault.omneme');
  const escapedPath = path.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
  const web = await startWeb({ vaultPath: path, port: 0, onboarding: { kdfN: TEST_KDF_N } });
  try {
    assert.equal((await fetch(web.url + 'connect?client=claude-code')).status, 401, 'auth still required');
    const cookie = cookieOf(await post(web.url, 'create', { password: PASSWORD, repeat: PASSWORD }));
    assert.equal((await post(web.url, 'import', { path: writeChatgptZip(tmp()) }, { cookie })).status, 200);
    const def = await (await fetch(web.url + 'connect', { headers: { cookie } })).text();
    const explicit = await (await fetch(web.url + 'connect?client=claude-code', { headers: { cookie } })).text();
    for (const html of [def, explicit]) {
      assert.match(html, /<strong aria-current="page">Claude Code \(verified default\)<\/strong>/);
      assert.match(html, /<a href="\/connect\?client=chatgpt-work">ChatGPT Work \(partly verified\)<\/a>/);
      assert.match(html, /<a href="\/connect\?client=antigravity">Antigravity \(partly verified\)<\/a>/);
      assert.match(html, /<ol[^>]* id="claude-code-steps"[^>]*>/);
      assert.ok(html.includes('agent --vault "YOUR-VAULT-FILE"'), 'Unlock command uses a labelled placeholder for a custom vault');
      assert.ok(!html.includes(path) && !html.includes(escapedPath), 'vault path never emitted');
      assert.doesNotMatch(html, /count must be/); assert.match(html, /<details id="advanced">[\s\S]*?Optional troubleshooting:/);
      assert.match(html, /id="known-record-check">Use the Omneme search_memory tool/);
      assert.match(html, /Do not save anything/, 'check is read-only');
      assert.match(html, /connected to your vault only when the result includes the exact title and provider you noted/);
      assert.match(html, /No match is not confirmation/);
      assert.match(html, /Claude Code retrieved a known record from a separate test vault/);
      assert.ok(!html.includes('[mcp_servers.omneme]') && !html.includes('omneme-pilot'));
      assert.match(html, /<a[^>]* href="\/"[^>]*>Search your conversations<\/a>/);
      assert.match(html, /<a[^>]* href="\/#import"[^>]*>Import another platform<\/a>/);
      assert.ok(!html.includes(PASSWORD) && !html.includes(MARKERS.simple), 'no credentials or private content');
    }
    // Invalid client values: 400, error shown, all choices offered, input never reflected.
    for (const bad of ['gemini', '<script>x</script>', 'CLAUDE-CODE']) {
      const r = await fetch(web.url + 'connect?client=' + encodeURIComponent(bad), { headers: { cookie } });
      assert.equal(r.status, 400);
      const h = await r.text();
      assert.match(h, /id="client-error"/);
      assert.match(h, /<a href="\/connect\?client=claude-code">Claude Code \(verified default\)<\/a>/);
      assert.ok(!h.includes('<script>') && !h.includes('x&lt;/script'), 'invalid value is not reflected');
    }
    assert.equal((await fetch(web.url + 'connect?client=', { headers: { cookie } })).status, 200, 'empty client falls back to default');
  } finally { await web.close(); }
});

test('OMN-032: default onboarding pages and AI prompts never expose home, install or unusual vault paths', async () => {
  const d = tmp();
  const odd = "Zq9 ÜNUSUAL-%TEMP%-dir & 'q' (x)";
  const path = join(d, odd, 'nested;Fake User', 'vault.omneme');
  const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const user = userInfo().username;
  const needles = [path, escHtml(path), odd, escHtml(odd), 'nested;Fake User', d, homedir(), repoRoot, ...(user.length >= 5 && !/^(admin|guest|owner|users?)$/i.test(user) ? [user] : [])]; // skip names that are ordinary UI words
  const clean = (label: string, html: string) => { for (const n of needles) assert.ok(!html.includes(n), `${label} must not contain a local path or user name`); };
  const web = await startWeb({ vaultPath: path, port: 0, onboarding: { kdfN: TEST_KDF_N } });
  try {
    const create = await (await fetch(web.url)).text();
    clean('create page', create);
    assert.match(create, /Your vault: a vault at a custom location/);
    assert.match(create, /shown in the <code>Omneme Start<\/code> window/, 'generic way to find the exact location');
    assert.match(create, /<label for="pw">/, 'password inputs are labelled');
    const created = await post(web.url, 'create', { password: PASSWORD, repeat: PASSWORD });
    const cookie = cookieOf(created);
    clean('recovery key page', await created.text());
    const imp = await post(web.url, 'import', { path: writeChatgptZip(tmp()) }, { cookie });
    assert.equal(imp.status, 200);
    clean('import result', await imp.text());
    const search = await (await fetch(web.url, { headers: { cookie } })).text();
    clean('search page', search);
    assert.match(search, /aria-current="step"/, 'setup progress is shown');
    for (const client of ['claude-code', 'chatgpt-work', 'antigravity']) {
      const r = await fetch(web.url + 'connect?client=' + client, { headers: { cookie } });
      assert.equal(r.status, 200, `${client} flow renders`);
      const h = await r.text();
      clean(client, h);
      assert.match(h, /id="connect-ai"/);
      assert.match(h, /<h1>Connect your AI<\/h1>/);
      assert.ok(h.includes('agent --vault "YOUR-VAULT-FILE"'), `${client}: custom vault placeholder`);
      assert.match(h, /Replace <code>YOUR-VAULT-FILE<\/code>/, `${client}: placeholder is explained`);
      assert.match(h, /node --no-warnings (app\\omneme\\)?bin\\omneme\.mjs agent/, `${client}: CLI path is relative to the Omneme folder`);
      assert.match(h, /<details id="advanced"><summary>/, `${client}: advanced details are in a disclosure`);
      const prompt = /id="resume-prompt">([^<]*)<\/pre>/.exec(h)?.[1] ?? '';
      assert.match(prompt, /confirm you see my Omneme vault\./, 'resume prompt is generic');
      assert.doesNotMatch(prompt, /[A-Za-z]:\\|\/(Users|home)\//, 'resume prompt has no absolute path');
      if (client === 'claude-code') {
        assert.ok(h.includes('--no-warnings "%CD%\\'), 'Claude Code registration derives the path from the run location');
        const check = /id="known-record-check">([^<]*)<\/pre>/.exec(h)?.[1] ?? '';
        assert.doesNotMatch(check, /[A-Za-z]:\\|\/(Users|home)\//);
      }
      if (client === 'chatgpt-work') assert.ok(h.includes("'OMNEME-FOLDER\\") && h.includes('handoff-latest "Omneme" --vault "YOUR-VAULT-FILE"'));
      if (client === 'antigravity') assert.ok(h.includes('OMNEME-FOLDER\\\\'), 'Antigravity JSON uses the folder placeholder');
      if (client !== 'claude-code') assert.match(h, /Replace <code>OMNEME-FOLDER<\/code>/);
    }
    const bad = await fetch(web.url + 'connect?client=nope', { headers: { cookie } });
    assert.equal(bad.status, 400);
    clean('invalid client', await bad.text());
    await post(web.url, 'lock', {}, { cookie });
    const unlock = await (await fetch(web.url)).text();
    clean('unlock page', unlock);
    assert.match(unlock, /vault is locked/);
  } finally { await web.close(); }
});

test('existing vault is never overwritten by /create; unlock still works', async () => {
  const d = tmp();
  const path = join(d, 'v.omneme');
  const { vault } = await Vault.create(path, PASSWORD, { kdfN: TEST_KDF_N });
  vault.lock();
  const before = readFileSync(path), mtime = statSync(path).mtimeMs;
  const web = await startWeb({ vaultPath: path, port: 0, onboarding: { kdfN: TEST_KDF_N } });
  try {
    const html = await (await fetch(web.url)).text();
    assert.match(html, /vault is locked/);
    assert.ok(!html.includes('action="/create"'));
    const res = await post(web.url, 'create', { password: 'another password 123', repeat: 'another password 123' });
    assert.equal(res.status, 409);
    assert.ok(readFileSync(path).equals(before));
    assert.equal(statSync(path).mtimeMs, mtime);
    assert.equal((await post(web.url, 'unlock', { password: 'another password 123' })).status, 401);
    assert.equal((await post(web.url, 'unlock', { password: PASSWORD })).status, 303);
  } finally { await web.close(); }
});

test('origin, host and auth protections apply to create, import and reindex', async () => {
  const d = tmp();
  const path = join(d, 'v.omneme');
  const web = await startWeb({ vaultPath: path, port: 0, onboarding: { kdfN: TEST_KDF_N } });
  const exp = writeChatgptZip(tmp());
  try {
    // Cross-origin create is refused and creates nothing.
    const pageResponse = await fetch(web.url);
    assert.equal(pageResponse.headers.get('referrer-policy'), 'same-origin');
    let res = await post(web.url, 'create', { password: PASSWORD, repeat: PASSWORD }, { origin: 'http://evil.example' });
    assert.equal(res.status, 403);
    res = await post(web.url, 'create', { password: PASSWORD, repeat: PASSWORD }, { 'sec-fetch-site': 'cross-site' });
    assert.equal(res.status, 403);
    assert.ok(!existsSync(path));
    // Wrong Host header (DNS rebinding) is refused.
    const port = new URL(web.url).port;
    const status = await new Promise<number>((ok, ko) => {
      const r = request({ host: '127.0.0.1', port, path: '/create', method: 'POST', headers: { ...FORM, host: 'evil.example:' + port } }, (rs) => { rs.resume(); ok(rs.statusCode!); });
      r.on('error', ko); r.end(form({ password: PASSWORD, repeat: PASSWORD }));
    });
    assert.equal(status, 421);
    assert.ok(!existsSync(path));
    res = await post(web.url, 'create', { password: PASSWORD, repeat: PASSWORD });
    assert.equal(res.status, 200);
    const cookie = cookieOf(res);
    // Import/reindex require the session cookie and same origin.
    assert.equal((await post(web.url, 'import', { path: exp })).status, 401);
    assert.equal((await post(web.url, 'import', { path: exp }, { cookie: 'omneme_s=' + 'a'.repeat(64) })).status, 401);
    assert.equal((await post(web.url, 'reindex', {})).status, 401);
    assert.equal((await post(web.url, 'import', { path: exp }, { cookie, origin: 'http://evil.example' })).status, 403);
    assert.match(await (await fetch(web.url + '?q=' + encodeURIComponent(MARKERS.simple), { headers: { cookie } })).text(), /0 result/);
    // Lock, then import is refused.
    await post(web.url, 'lock', {}, { cookie });
    assert.equal((await post(web.url, 'import', { path: exp }, { cookie })).status, 401);
  } finally { await web.close(); }
});

test('overlapping imports are serialised: one runs, others get 409, vault stays consistent', async () => {
  const d = tmp();
  const path = join(d, 'v.omneme');
  const web = await startWeb({ vaultPath: path, port: 0, onboarding: { kdfN: TEST_KDF_N } });
  try {
    const cookie = cookieOf(await post(web.url, 'create', { password: PASSWORD, repeat: PASSWORD }));
    const a = writeChatgptZip(tmp()), b = writeClaudeZip(tmp());
    const statuses = (await Promise.all([a, b, a].map((p) => post(web.url, 'import', { path: p }, { cookie })))).map((r) => r.status);
    assert.ok(statuses.includes(200), String(statuses));
    assert.ok(statuses.every((s) => s === 200 || s === 409), String(statuses));
    // Lock while idle works and is not blocked.
    assert.equal((await post(web.url, 'lock', {}, { cookie })).status, 303);
  } finally { await web.close(); }
  const v = await Vault.unlock(path, { password: PASSWORD });
  try { const r = v.verify(contentHash); assert.equal(r.failed, 0); assert.equal(r.recordSetOk, true); } finally { v.lock(); }
});

test('normal mode is unchanged: no create, import, reindex or connect routes', async () => {
  const d = tmp();
  const path = join(d, 'v.omneme');
  const web = await startWeb({ vaultPath: path, port: 0 });
  try {
    const html = await (await fetch(web.url)).text();
    assert.match(html, /vault is locked/);
    assert.ok(!html.includes('/create'));
    assert.ok(!html.includes('/connect'));
    assert.equal((await post(web.url, 'create', { password: PASSWORD, repeat: PASSWORD })).status, 404);
    assert.ok(!existsSync(path));
    assert.equal((await post(web.url, 'import', { path: '/x' })).status, 404);
    assert.equal((await post(web.url, 'reindex', {})).status, 404);
    assert.equal((await fetch(web.url + 'connect')).status, 404);
    const { vault } = await Vault.create(path, PASSWORD, { kdfN: TEST_KDF_N });
    vault.lock();
    const unlockRes = await post(web.url, 'unlock', { password: PASSWORD });
    assert.equal(unlockRes.status, 303);
    const cookie = cookieOf(unlockRes);
    assert.equal((await fetch(web.url + 'connect', { headers: { cookie } })).status, 404);
    const searchHtml = await (await fetch(web.url, { headers: { cookie } })).text();
    assert.ok(!searchHtml.includes('/connect'));
    assert.ok(!searchHtml.includes('Connect your AI'));
  } finally { await web.close(); }
});

test('launcher options: shared vault default, no secrets accepted on the command line, test KDF only in test mode', () => {
  const home = tmp(); // fixture home with no vaults: the canonical main vault is chosen (never the real home)
  const o = startOptions([], {}, { home });
  assert.equal(o.vaultPath, resolve(LIVE_DEFAULT_VAULT(home)));
  assert.notEqual(o.vaultPath, resolve(DISPOSABLE_VAULT(home)));
  assert.equal(o.vaultSource, 'new-main');
  assert.equal(o.port, 0);
  assert.equal(o.open, true);
  assert.equal(o.kdfN, undefined);
  assert.equal(startOptions(['--no-open', '--port', '9000'], {}, { home }).open, false);
  assert.throws(() => startOptions(['--password', 'x'], {}, { home }));
  assert.throws(() => startOptions(['--recovery-key', 'x'], {}, { home }));
  assert.throws(() => startOptions(['positional'], {}, { home }));
  assert.throws(() => startOptions(['--port', '70000'], {}, { home }));
  assert.equal(startOptions([], { OMNEME_KDF_N: '16384' }, { home }).kdfN, undefined);
  assert.equal(startOptions([], { OMNEME_KDF_N: '16384', OMNEME_TEST_MODE: '1' }, { home }).kdfN, 16384);
});

test('OMN-033: one vault-selection rule for Start, Unlock (agent) and Backup (backup-run), fixture paths only', async () => {
  const home = tmp();
  const main = resolve(LIVE_DEFAULT_VAULT(home)), first = resolve(DISPOSABLE_VAULT(home));
  const put = (p: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, 'fixture'); };
  const snapshot = () => [main, first].map((p) => (existsSync(p) ? readFileSync(p, 'utf8') : null));
  const never = async () => { throw new Error('must not ask'); };

  // Neither exists: the canonical main vault; nothing is created by selection.
  assert.deepEqual(selectVault(undefined, {}, { home }), { vaultPath: main, source: 'new-main' });
  assert.deepEqual(snapshot(), [null, null]);

  // Only the legacy first-run vault exists: it is used (no migration, no second vault).
  put(first);
  assert.deepEqual(selectVault(undefined, {}, { home }), { vaultPath: first, source: 'first-run' });
  assert.equal(startOptions([], {}, { home }).vaultPath, first);
  assert.ok(!existsSync(main), 'main vault is not created');

  // Only the main vault exists.
  const home2 = tmp(), main2 = resolve(LIVE_DEFAULT_VAULT(home2));
  put(main2);
  assert.deepEqual(selectVault(undefined, {}, { home: home2 }), { vaultPath: main2, source: 'main' });
  assert.equal(startOptions([], {}, { home: home2 }).vaultPath, main2);

  // Both exist: no automatic choice.
  put(main);
  const before = snapshot();
  const both = selectVault(undefined, {}, { home });
  assert.equal(both.vaultPath, undefined);
  assert.deepEqual(both.candidates, [main, first]);
  const so = startOptions([], {}, { home });
  assert.equal(so.vaultPath, '');
  assert.deepEqual(so.vaultCandidates, [main, first]);
  // Unattended: clear failure with --vault instructions naming both files; never asks.
  await assert.rejects(resolveVaultSelection(both, 'omneme agent', { interactive: false, ask: never }), (e: Error) =>
    /Two Omneme vaults exist/.test(e.message) && e.message.includes(`omneme agent --vault "${main}"`) && e.message.includes(first) && /OMNEME_VAULT/.test(e.message));
  // Interactive: only a deliberate 1 or 2 chooses; anything else fails.
  assert.equal(await resolveVaultSelection(both, 'x', { interactive: true, ask: async () => '1\n' }), main);
  assert.equal(await resolveVaultSelection(both, 'x', { interactive: true, ask: async () => ' 2 ' }), first);
  for (const a of ['', 'y', 'main', '12']) await assert.rejects(resolveVaultSelection(both, 'x', { interactive: true, ask: async () => a }), /--vault/);
  assert.deepEqual(snapshot(), before, 'selection never writes, copies or overwrites a vault');

  // Overrides win over the standard locations, in order: --vault, then OMNEME_VAULT (Start and CLI alike).
  const custom = join(tmp(), 'custom.omneme'), envPath = join(tmp(), 'env.omneme');
  assert.deepEqual(selectVault(custom, { OMNEME_VAULT: envPath }, { home }), { vaultPath: resolve(custom), source: 'option' });
  assert.deepEqual(selectVault(undefined, { OMNEME_VAULT: envPath }, { home }), { vaultPath: resolve(envPath), source: 'env' });
  assert.deepEqual(selectVault(undefined, { OMNEME_VAULT: '' }, { home }).candidates, [main, first], 'empty OMNEME_VAULT is ignored');
  assert.equal(startOptions(['--vault', custom], { OMNEME_VAULT: envPath }, { home }).vaultPath, resolve(custom));
  assert.equal(startOptions([], { OMNEME_VAULT: envPath }, { home }).vaultPath, resolve(envPath));
  assert.equal(await resolveVaultSelection(selectVault(custom, {}, { home }), 'x', { interactive: false, ask: never }), resolve(custom));
});

test('OMN-034: known record before locking, read-only check, Work caveat, vault label and post-import backup step', async () => {
  const d = tmp();
  const path = join(d, "Bob & Co's", 'vault.omneme');
  const escapedPath = path.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
  const web = await startWeb({ vaultPath: path, port: 0, onboarding: { kdfN: TEST_KDF_N } });
  try {
    assert.equal((await fetch(web.url + 'connect?client=chatgpt-work')).status, 401, 'auth still required');
    const cookie = cookieOf(await post(web.url, 'create', { password: PASSWORD, repeat: PASSWORD }));
    // Post-import: Connect stays primary; the backup step is secondary, points to the existing workflow, claims nothing ran.
    const imp = await post(web.url, 'import', { path: writeChatgptZip(tmp()) }, { cookie });
    assert.equal(imp.status, 200);
    const ih = await imp.text();
    const iConnect = ih.indexOf('class="primary" href="/connect"'), iBackup = ih.indexOf('id="backup-next"');
    assert.ok(iConnect > 0 && iBackup > iConnect, 'backup step follows the primary Connect action');
    assert.match(ih, /href="#backup-next"/, 'backup step is linked from the next-step card');
    assert.match(ih, /id="backup-next"[\s\S]*?No backup of this import has been made yet/);
    // OMN-038: existing CLI commands for the selected (custom) vault instead of launchers absent from the source download.
    assert.ok(ih.includes('node --no-warnings bin\\omneme.mjs backup "BACKUP-FILE" --vault "YOUR-VAULT-FILE"\nnode --no-warnings bin\\omneme.mjs verify-backup "BACKUP-FILE"'), 'backup then verify-backup');
    assert.match(ih, /id="backup-next"[\s\S]*?close any running Unlock agent first/);
    assert.doesNotMatch(ih, /\.cmd<\/code>|Omneme [A-Z][\w ]*\.cmd/, 'no launcher references');
    assert.doesNotMatch(ih, /action="\/backup|href="\/backup/, 'no web backup endpoint');
    assert.doesNotMatch(ih, /backup (was|has been) (made|written|completed)/i, 'never claims a backup ran');
    assert.ok(!ih.includes(path) && !ih.includes(escapedPath) && !ih.includes(MARKERS.simple));
    for (const client of ['chatgpt-work', 'antigravity', 'claude-code']) {
      const h = await (await fetch(web.url + 'connect?client=' + client, { headers: { cookie } })).text();
      assert.match(h, /id="vault-line"[^>]*>Your vault: a vault at a custom location\./, `${client}: selected vault label shown`);
      assert.ok(!h.includes(path) && !h.includes(escapedPath) && !h.includes(PASSWORD), `${client}: no path or secret`);
      if (client === 'claude-code') { assert.doesNotMatch(h, /chatgpt-work-scope|client-step-pick/); continue; }
      // Ordering: pick a non-sensitive known record → lock → unlock → configure → read-only verification.
      const at = ['client-step-pick', 'client-step-lock', 'client-step-unlock', 'client-step-configure', 'client-step-verify'].map((id) => h.indexOf(`id="${id}"`));
      assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1])), `${client}: steps in order ${at}`);
      assert.match(h, /id="client-step-pick"[^>]*><strong>Pick a known record now\.<\/strong>[^<]*<a href="\/">[\s\S]*?non-sensitive/);
      assert.match(h, /id="client-known-record-check">Use the Omneme search_memory tool[^<]*Do not save anything\./, `${client}: read-only check`);
      assert.match(h, /id="client-check-read-only"/);
      const card = h.slice(h.indexOf('id="setup-h"'), h.indexOf('<details id="advanced">'));
      if (client === 'chatgpt-work') {
        assert.match(card, /id="chatgpt-work-scope"[\s\S]*?dedicated desktop test connector[\s\S]*?passed[\s\S]*?standard setup and ChatGPT Work in a browser are <strong>unverified<\/strong>/, 'Work scope visible in the setup card');
        assert.ok(card.indexOf('id="chatgpt-work-scope"') < card.indexOf('id="client-steps"'), 'caveat shown before the steps');
      } else assert.doesNotMatch(h, /chatgpt-work-scope/);
    }
  } finally { await web.close(); }
});

test('OMN-034: backup-preview and backup-drill use the shared vault rule and name the vault file; others unchanged', () => {
  const home = tmp();
  const main = resolve(LIVE_DEFAULT_VAULT(home)), first = resolve(DISPOSABLE_VAULT(home));
  for (const p of [main, first]) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, 'fixture'); }
  const snapshot = () => [main, first].map((p) => readFileSync(p, 'utf8'));
  const cfg = join(home, '.omneme', 'backup-config.json'), usb = join(tmp(), 'usb-folder');
  const bin = fileURLToPath(new URL('../bin/omneme.mjs', import.meta.url));
  // Fixture home only (never the real one); no inherited vault, backup config or backup log settings.
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, OMNEME_PASSWORD: PASSWORD };
  for (const k of ['OMNEME_VAULT', 'OMNEME_BACKUP_CONFIG', 'OMNEME_BACKUP_LOG', 'OMNEME_BACKUP_ASSUME_YES']) delete env[k];
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--no-warnings', bin, ...args], { env: { ...env, ...extra }, input: '', encoding: 'utf8', timeout: 20000 });
  // Both standard vaults, nobody to answer: clear failure naming both files; nothing opened or written.
  for (const cmd of [['backup-preview', '--usb', usb], ['backup-drill']]) {
    const r = run(cmd);
    assert.equal(r.status, 1, `${cmd[0]}: ${r.stderr}`);
    assert.match(r.stderr, /Two Omneme vaults exist/);
    assert.ok(r.stderr.includes(main) && r.stderr.includes(first) && /--vault/.test(r.stderr), `${cmd[0]}: names both vaults`);
    assert.doesNotMatch(r.stdout, /Vault file:|BACKUP PREVIEW/, `${cmd[0]}: nothing runs before a deliberate choice`);
  }
  // Explicit --vault wins over OMNEME_VAULT; preview names the selected vault in its own report.
  const pv = run(['backup-preview', '--usb', usb, '--vault', first], { OMNEME_VAULT: main });
  assert.ok([0, 3].includes(pv.status!), pv.stderr);
  assert.match(pv.stdout, /BACKUP PREVIEW/);
  assert.ok(pv.stdout.includes(first) && !pv.stdout.includes(main), 'preview shows the selected vault file');
  // OMNEME_VAULT applies when --vault is absent; drill names the vault file before anything else (then stops: no config).
  const dr = run(['backup-drill'], { OMNEME_VAULT: first });
  assert.equal(dr.stdout.split(/\r?\n/)[0], `Vault file: ${first}`);
  assert.notEqual(dr.status, 0);
  // Unrelated commands keep their default (main vault): no choice, no vault-file line.
  const other = run(['verify']);
  assert.doesNotMatch(other.stderr + other.stdout, /Two Omneme vaults|Vault file:/);
  assert.deepEqual(snapshot(), ['fixture', 'fixture'], 'no vault is migrated or changed');
  assert.ok(!existsSync(cfg) && !existsSync(usb), 'no backup configuration, folder or backup written');
});

test('OMN-038: source onboarding for main, first-run and custom vaults: real CLI commands, node from PATH, no launchers or local paths', () => {
  // Each vault kind is rendered in a child process whose home is a fixture folder, so the main and first-run
  // locations never touch the real home. Synthetic export only.
  const home = tmp();
  const script = [
    `const { startWeb } = await import(${JSON.stringify(new URL('../src/web.ts', import.meta.url).href)});`,
    `const { PASSWORD, TEST_KDF_N, tmp, writeChatgptZip } = await import(${JSON.stringify(new URL('./helpers.ts', import.meta.url).href)});`,
    'const s = await startWeb({ vaultPath: process.env.FIXTURE_VAULT, port: 0, onboarding: { kdfN: TEST_KDF_N } });',
    "const post = (p, b, cookie) => fetch(s.url + p, { method: 'POST', body: new URLSearchParams(b).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, redirect: 'manual' });",
    "const cookie = (await post('create', { password: PASSWORD, repeat: PASSWORD })).headers.get('set-cookie').split(';')[0];",
    "const out = { import: await (await post('import', { path: writeChatgptZip(tmp()) }, cookie)).text() };",
    "for (const c of ['claude-code', 'chatgpt-work', 'antigravity']) out[c] = await (await fetch(s.url + 'connect?client=' + c, { headers: { cookie } })).text();",
    'await s.close(); process.stdout.write(JSON.stringify(out));',
  ].join('\n');
  const cases = [
    ['main', join(home, '.omneme', 'vault.omneme'), '%USERPROFILE%\\.omneme\\vault.omneme'],
    ['first-run', join(home, '.omneme', 'first-run', 'vault.omneme'), '%USERPROFILE%\\.omneme\\first-run\\vault.omneme'],
    ['custom', join(tmp(), 'Custom & Co', 'vault.omneme'), 'YOUR-VAULT-FILE'],
  ] as const;
  const launchers = /Omneme (Unlock|Backup|Backup Preview|Resume Handoff|Save Handoff|Install Claude Code|Claude MCP Test)\.cmd|Omneme [A-Z][\w ]*\.cmd/;
  for (const [kind, vaultPath, arg] of cases) {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, FIXTURE_VAULT: vaultPath };
    delete env.OMNEME_VAULT;
    const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, `${kind}: ${r.stderr}`);
    const pages: Record<string, string> = JSON.parse(r.stdout);
    for (const [name, h] of Object.entries(pages)) {
      const label = `${kind}/${name}`;
      for (const n of [vaultPath, home, homedir(), 'Custom &amp; Co']) assert.ok(!h.includes(n), `${label}: no local path`);
      assert.doesNotMatch(h, launchers, `${label}: no launcher absent from the source download`);
      assert.doesNotMatch(h, /Program Files|nodejs|node\.exe/i, `${label}: no hardcoded Node install`);
      assert.ok(!h.includes(PASSWORD), `${label}: no password`);
      if (kind !== 'custom') assert.ok(!h.includes('YOUR-VAULT-FILE'), `${label}: known location needs no placeholder`);
    }
    // Post-import: Connect stays primary; backup + verify-backup name the selected vault; nothing claims a backup ran.
    const ih = pages.import;
    assert.match(ih, /class="primary" href="\/connect"/);
    assert.ok(ih.includes(`<pre class="cmd" id="backup-cmd">node --no-warnings bin\\omneme.mjs backup "BACKUP-FILE" --vault "${arg}"\nnode --no-warnings bin\\omneme.mjs verify-backup "BACKUP-FILE"</pre>`), `${kind}: backup commands`);
    assert.match(ih, /Omneme does not back up automatically/);
    assert.match(ih, /the Omneme source folder \(the one that contains <code>package\.json<\/code>\)/, `${kind}: source folder`);
    for (const client of ['claude-code', 'chatgpt-work', 'antigravity']) {
      const h = pages[client];
      assert.ok(h.includes(`<pre class="cmd" id="agent-cmd">node --no-warnings bin\\omneme.mjs agent --vault "${arg}"</pre>`), `${kind}/${client}: agent names the selected vault`);
      assert.match(h, /contains <code>package\.json<\/code>/, `${kind}/${client}: commands run from the source folder`);
      assert.match(h, /id="node-path-tip"[\s\S]*?where node/, `${kind}/${client}: node discovery fallback`);
      assert.match(h, /Single vault ownership/);
      assert.match(h, new RegExp(`this vault's \\d+ messages`), `${kind}/${client}: dynamic count`);
      const prompt = /id="resume-prompt">([^<]*)<\/pre>/.exec(h)?.[1] ?? '';
      assert.doesNotMatch(prompt, /[A-Za-z]:\\|\/(Users|home)\/|\.omneme|%USERPROFILE%/, `${kind}/${client}: no path in the AI prompt`);
      // Known record before Lock -> Unlock agent -> configure -> read-only check.
      const order = client === 'claude-code'
        ? ['Pick a known record now', 'Lock this browser session', 'id="agent-cmd"', 'id="claude-mcp-add"', 'id="known-record-check"']
        : ['id="client-step-pick"', 'id="client-step-lock"', 'id="agent-cmd"', 'id="client-step-configure"', 'id="client-known-record-check"'];
      const at = order.map((s) => h.indexOf(s));
      assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1])), `${kind}/${client}: step order ${at}`);
    }
    assert.ok(pages['claude-code'].includes('claude mcp add omneme --scope user -- node --no-warnings "%CD%\\bin\\omneme.mjs" mcp'));
    assert.match(pages['claude-code'], /claude mcp get omneme/);
    const work = pages['chatgpt-work'];
    assert.ok(work.includes("command = 'node'\nargs = [\"--no-warnings\", 'OMNEME-FOLDER\\bin\\omneme.mjs', \"mcp\"]"), `${kind}: TOML uses node from PATH and the folder placeholder`);
    assert.ok(work.includes(`handoff-latest "Omneme" --vault "${arg}" --copy`), `${kind}: handoff-latest names the vault`);
    assert.ok(work.includes(`handoff-save --file "HANDOFF-FILE.json" --vault "${arg}"`), `${kind}: handoff-save names the vault`);
    assert.match(work, /id="chatgpt-work-scope"/, 'Work caveat kept');
    const json = /<pre class="cmd">(\{[^<]*\})<\/pre>/.exec(pages.antigravity)?.[1] ?? '';
    const cfg = JSON.parse(json.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    assert.deepEqual(cfg.mcpServers['omneme-pilot'], { command: 'node', args: ['--no-warnings', 'OMNEME-FOLDER\\bin\\omneme.mjs', 'mcp'] }, `${kind}: Antigravity JSON is valid and escaped`);
  }
});

test('vault prompt keeps the answer when readline closes', () => {
  const moduleUrl = new URL('../src/start.ts', import.meta.url).href;
  const script = [
    'import { askLine } from ' + JSON.stringify(moduleUrl),
    "process.stdout.write(await askLine('Choose a vault: '))",
  ].join('\n');
  for (const answer of ['1', '2', '']) {
    const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
      input: answer ? answer + '\n' : '', encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, answer);
  }
});
