// Builds a SYNTHETIC "old computer" vault and a USB-style backup folder for testing the recovery package.
// Usage: node scripts/make-synthetic-usb.ts <root>
// Creates <root>/old-pc/vault.omneme and <root>/USB/Omneme-Backups with three backups: an older good one, a newer good
// one, and the newest one deliberately damaged (to exercise the automatic fallback). Synthetic data only.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Vault } from '../src/vault.ts';
import { importExport } from '../src/importers/index.ts';
import { importLocal } from '../src/importers/localFiles.ts';
import { writeChatgptZip, writeClaudeZip, TEST_KDF_N } from '../test/helpers.ts';

export const SYNTHETIC_PASSWORD = 'synthetic-recovery-test-only';
const root = process.argv[2];
if (!root) throw new Error('usage: make-synthetic-usb.ts <root>');
mkdirSync(join(root, 'src'), { recursive: true });
const { vault: v } = await Vault.create(join(root, 'old-pc', 'vault.omneme'), SYNTHETIC_PASSWORD, { kdfN: TEST_KDF_N });
await importExport(v, writeChatgptZip(join(root, 'src'))); await importExport(v, writeClaudeZip(join(root, 'src')));
mkdirSync(join(root, 'src', 'files')); writeFileSync(join(root, 'src', 'files', 'synthetic.bin'), randomBytes(2_000_000));
writeFileSync(join(root, 'src', 'files', 'note.txt'), 'synthetic note');
await importLocal(v, join(root, 'src', 'files'));
const folder = join(root, 'USB', 'Omneme-Backups'); mkdirSync(folder, { recursive: true });
for (const [name, at] of [['omneme-20261101T000000Z.omnbak', '2026-11-01T00:00:00Z'], ['omneme-20261108T000000Z.omnbak', '2026-11-08T00:00:00Z'], ['omneme-20261109T000000Z.omnbak', '2026-11-09T00:00:00Z']]) {
  const s = v.exportBackup(join(folder, name));
  writeFileSync(join(folder, `${name}.json`), JSON.stringify({ file: name, size: s.size, sha256: s.sha256, records: s.records, createdAt: at }));
}
v.lock();
const bad = join(folder, 'omneme-20261109T000000Z.omnbak'); const b = readFileSync(bad); b[Math.floor(b.length / 2)] ^= 1; writeFileSync(bad, b);
console.log(`synthetic old-pc vault and USB folder ready in ${root} (newest backup deliberately damaged)`);
