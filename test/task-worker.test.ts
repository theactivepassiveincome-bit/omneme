import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);

for (const stale of [false, true]) {
  test(`only one worker checks the queue with ${stale ? 'a stale lock' : 'no lock'}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omneme-worker-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      mkdirSync(join(dir, 'src'));
      const worker = join(dir, 'scripts', 'task-worker.ts');
      const lock = join(dir, 'omneme-worker.lock');
      copyFileSync(new URL('../scripts/task-worker.ts', import.meta.url), worker);
      copyFileSync(new URL('../scripts/completion-review.ts', import.meta.url), join(dir, 'scripts', 'completion-review.ts'));
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(join(dir, 'src', 'agent.ts'), `
        export async function callAgent() {
          await new Promise(resolve => setTimeout(resolve, 1200));
          return { isError: false, text: '' };
        }
      `);
      if (stale) {
        writeFileSync(lock, '123');
        const old = new Date(Date.now() - 4 * 3600_000);
        utimesSync(lock, old, old);
      }
      // Synchronize the old check-before-write path after it observes a free or stale lock.
      const preload = join(dir, 'barrier.cjs');
      writeFileSync(preload, `
        const fs = require('node:fs');
        const { syncBuiltinESMExports } = require('node:module');
        const { join } = require('node:path');
        const dir = process.env.OMNEME_WORKER_DIR;
        const lock = join(dir, 'omneme-worker.lock');
        const exists = fs.existsSync;
        function barrier() {
          fs.writeFileSync(join(dir, 'ready-' + process.env.WORKER_TEST_ID), '');
          const peer = join(dir, 'ready-' + (1 - Number(process.env.WORKER_TEST_ID)));
          const until = Date.now() + 1500;
          while (!exists(peer) && Date.now() < until) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        const stat = fs.statSync;
        fs.existsSync = path => {
          const present = exists(path);
          if (path === lock && !present) barrier();
          return present;
        };
        fs.statSync = (path, ...args) => {
          const result = stat(path, ...args);
          if (path === lock && Date.now() - result.mtimeMs >= 3 * 3600_000) barrier();
          return result;
        };
        syncBuiltinESMExports();
      `);
      const results = await Promise.all([0, 1].map(id =>
        exec(process.execPath, ['--no-warnings', '--require', preload, worker], {
          env: { ...process.env, OMNEME_WORKER_DIR: dir, WORKER_TEST_ID: String(id) },
          timeout: 10_000,
        }),
      ));
      assert.deepEqual(results.map(result => result.stdout.trim()).sort(), [
        'A task is already running - nothing started.',
        'No approved task.',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
