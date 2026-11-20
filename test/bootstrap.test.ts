// OMN-045: the launchers refuse an unsupported runtime before importing any TypeScript, and launch unchanged on a
// supported one. Uses Node's own --no-experimental-strip-types switch to simulate a runtime without type stripping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = (f: string) => fileURLToPath(new URL(`../bin/${f}`, import.meta.url));

test('launchers show a clear unsupported-runtime error before importing TypeScript', () => {
  for (const f of ['omneme.mjs', 'omneme-start.mjs']) {
    const r = spawnSync(process.execPath, ['--no-experimental-strip-types', bin(f), '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 1, f);
    assert.match(r.stderr, /Omneme needs Node\.js 22\.18 or newer.*type stripping turned off/, f);
    assert.doesNotMatch(r.stderr, /ERR_UNKNOWN_FILE_EXTENSION|ERR_INVALID_TYPESCRIPT_SYNTAX|at /, `${f}: no TypeScript import was attempted`);
  }
});

test('launchers start normally on the current supported runtime', () => {
  const cli = spawnSync(process.execPath, [bin('omneme.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(cli.status, 0); assert.match(cli.stdout, /reset-password/);
  const start = spawnSync(process.execPath, [bin('omneme-start.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(start.status, 0); assert.match(start.stdout, /Omneme Start/);
});
