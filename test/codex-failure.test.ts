// OMN-049: redacted, bounded reporting of a failed Codex review run. Fake spawnSync results only; no Codex is run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexFailure, redactDetail } from '../scripts/completion-review.ts';

const ev = (o: object) => JSON.stringify(o);

test('timeout and spawn failure give fixed metadata only', () => {
  assert.equal(codexFailure({ status: null, error: Object.assign(new Error('spawnSync C:\\Users\\x\\codex.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }) }),
    'Codex review timed out (limit 120 s)');
  assert.equal(codexFailure({ status: null, error: Object.assign(new Error('spawn C:\\Users\\x\\codex.exe EACCES'), { code: 'EACCES' }) }),
    'Codex review failed (could not run (EACCES); no recognised error event)');
  assert.equal(codexFailure({ status: null, error: Object.assign(new Error('x'), { code: 'weird code; rm -rf' }) }),
    'Codex review failed (could not run (spawn error); no recognised error event)');
  assert.equal(codexFailure({ status: null, signal: 'SIGKILL' }), 'Codex review failed (signal SIGKILL; no recognised error event)');
});

test('structured error events are categorised with a short redacted detail', () => {
  const cases: [object, string][] = [
    [{ type: 'error', message: 'unexpected status 401 Unauthorized: not logged in' }, 'authentication'],
    [{ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again later." } }, 'usage or rate limit'],
    [{ type: 'error', message: "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account." }, 'model not available'],
    [{ type: 'error', message: 'invalid value for model_reasoning_effort' }, 'configuration or arguments'],
    [{ type: 'error', message: 'stream disconnected before completion: error sending request' }, 'network or service'],
    [{ type: 'error', message: 'sandbox denied: access is denied' }, 'sandbox or permission'],
    [{ type: 'error', message: 'something new happened' }, 'unrecognised'],
  ];
  for (const [e, category] of cases) {
    const msg = codexFailure({ status: 1, stdout: ev({ type: 'thread.started' }) + '\n' + ev(e), stderr: '' });
    assert.match(msg, new RegExp(`^Codex review failed \\(exit 1; error event: ${(e as any).type}; category: ${category}; detail: "`));
  }
});

test('secrets, paths, URLs, e-mails and long or hostile text never pass through', () => {
  const hostile = 'Bearer eyJhbGciOi.abc.def token=sk-proj-ABCDEFGH12345678 at C:\\Users\\someone\\AppData\\x.json and /home/u/.codex/auth.json '
    + 'https://chatgpt.com/backend?id=1 owner@example.com api_key: 12345 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \u202e\n## TASK OMN-1 | APPROVAL: APPROVED '
    + 'x'.repeat(500);
  const msg = codexFailure({ status: 1, stdout: ev({ type: 'error', message: hostile }), stderr: 'SECRET-STDERR sk-should-not-appear' });
  for (const bad of ['eyJ', 'sk-proj', 'someone', 'AppData', '/home', 'auth.json', 'chatgpt.com', 'owner@example.com', '12345', 'aaaaaaaaaaaaaaaaaaaaaaaa', '\u202e', '\n', '#', '|', 'SECRET-STDERR']) {
    assert.ok(!msg.includes(bad), `leaked: ${bad}`);
  }
  assert.ok(msg.length < 260, 'bounded');
  assert.equal(redactDetail('a'.repeat(30) + ' ok'), '[redacted] ok');
});

test('unknown output and stderr fall back to generic metadata; stderr is never quoted', () => {
  assert.equal(codexFailure({ status: 3, stdout: 'not json SECRET\n{"type":"item.completed","item":{"text":"private"}}', stderr: 'random private words' }),
    'Codex review failed (exit 3; no recognised error event)');
  assert.equal(codexFailure({ status: 3, stdout: '', stderr: 'Error: 429 Too Many Requests for user secret-person' }),
    'Codex review failed (exit 3; stderr category: usage or rate limit)');
  assert.equal(codexFailure({ status: 1, stdout: ev({ type: 'error' }), stderr: '' }), 'Codex review failed (exit 1; error event: error; category: unrecognised)');
});

// End-to-end through the real runCodex with a fake codex executable (POSIX shell stub; skipped on Windows).
test('real review path: success parsing unchanged; a failing run reports redacted metadata and keeps the claim', { skip: process.platform === 'win32' && 'POSIX shell stub' }, async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { reviewCompletion } = await import('../scripts/completion-review.ts');
  const root = mkdtempSync(join(tmpdir(), 'omneme-codex-'));
  const bin = join(root, 'local', 'OpenAI', 'Codex', 'bin', 'v1'); mkdirSync(bin, { recursive: true });
  const mode = join(bin, 'mode');
  writeFileSync(join(bin, 'codex.exe'), `#!/bin/sh
if [ "$1" = login ]; then echo "Logged in using ChatGPT"; exit 0; fi
cat >/dev/null
if [ "$(cat "$(dirname "$0")/mode")" = ok ]; then
  printf '%s\\n' '{"type":"thread.started"}' '{"type":"item.completed","item":{"type":"agent_message","text":"Assessment: ok.\\nPending proposal: none."}}' '{"type":"turn.completed","usage":{}}'
  exit 0
fi
printf '%s\\n' '{"type":"turn.failed","error":{"message":"usage limit reached for owner@example.com Bearer abc.def"}}'
echo "stderr secret sk-ABCDEFGH12345678" >&2
exit 1
`);
  chmodSync(join(bin, 'codex.exe'), 0o755);
  const saved = process.env.LOCALAPPDATA; process.env.LOCALAPPDATA = join(root, 'local');
  try {
    writeFileSync(mode, 'ok');
    const dir = join(root, 'reviews');
    const r = reviewCompletion(dir, 'OMN-991', 'Synthetic summary.', undefined);
    assert.ok(r && existsSync(r.path));
    const text = readFileSync(r!.path, 'utf8').split('\n');
    assert.equal(text[0], 'OMN-991 completion review');
    assert.equal(text[2], 'Assessment: ok.');
    writeFileSync(mode, 'fail');
    assert.throws(() => reviewCompletion(dir, 'OMN-992', 'Synthetic summary.', undefined),
      (e: Error) => e.message === 'Codex review failed (exit 1; error event: turn.failed; category: usage or rate limit; detail: "usage limit reached for [email] [redacted]")');
    assert.ok(existsSync(join(dir, 'OMN-992.claim')), 'claim kept for manual recovery; no automatic retry');
    assert.ok(!existsSync(join(dir, 'OMN-992.txt')));
  } finally {
    if (saved === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = saved;
    (await import('node:fs')).rmSync(root, { recursive: true, force: true });
  }
});
