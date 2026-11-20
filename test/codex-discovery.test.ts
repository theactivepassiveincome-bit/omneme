// OMN-048: Codex CLI discovery for completion reviews, with a fake filesystem/process probe (no real Codex, no PATH or
// AppData access). Covers PATH, a redirected sandbox LOCALAPPDATA, missing/unreadable folders and an absent binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { installedCodex, type CodexProbe } from '../scripts/completion-review.ts';

const HOME = join('C:', 'Users', 'someone');
const REAL = join(HOME, 'AppData', 'Local');
const SANDBOX = join(REAL, 'Packages', 'openai.codex_x', 'AC', '#!sandbox.{0000}');
const bin = (base: string) => join(base, 'OpenAI', 'Codex', 'bin');
/** files: path -> mtime; dirs: folder -> subfolder names; a folder in `unreadable` behaves like a failed readdir. */
function fake(o: { where?: string[]; files?: Record<string, number>; dirs?: Record<string, string[]>; unreadable?: string[] }) {
  const seen: string[] = [];
  const probe: CodexProbe = {
    where: () => o.where ?? [],
    dirs: (p) => { seen.push(p); return o.unreadable?.includes(p) ? [] : o.dirs?.[p] ?? []; },
    file: (p) => o.files?.[p],
  };
  return { probe, seen };
}

test('PATH hit that exists wins; a PATH entry that does not exist falls through to the install folder', () => {
  const onPath = join('C:', 'tools', 'codex.exe');
  assert.equal(installedCodex({ LOCALAPPDATA: REAL }, fake({ where: [onPath], files: { [onPath]: 1 } }).probe), onPath);
  const installed = join(bin(REAL), 'v1', 'codex.exe');
  const f = fake({ where: [join('C:', 'gone', 'codex.exe')], dirs: { [bin(REAL)]: ['v1'] }, files: { [installed]: 5 } });
  assert.equal(installedCodex({ LOCALAPPDATA: REAL }, f.probe), installed);
});

test('sandbox LOCALAPPDATA that does not exist: the user-profile installation is found (newest version)', () => {
  const older = join(bin(REAL), 'a', 'codex.exe'), newer = join(bin(REAL), 'b', 'codex.exe');
  const f = fake({ dirs: { [bin(REAL)]: ['a', 'b', 'tools-only'] }, files: { [older]: 1, [newer]: 9 } });
  assert.equal(installedCodex({ LOCALAPPDATA: SANDBOX, USERPROFILE: HOME }, f.probe), newer);
  assert.ok(f.seen.includes(bin(SANDBOX)) && f.seen.includes(bin(REAL)), 'both locations were checked');
  // Same result when only HOMEDRIVE/HOMEPATH identify the profile.
  const g = fake({ dirs: { [bin(REAL)]: ['b'] }, files: { [newer]: 9 } });
  assert.equal(installedCodex({ LOCALAPPDATA: SANDBOX, HOMEDRIVE: 'C:', HOMEPATH: HOME.slice(2) }, g.probe), newer);
});

test('missing or unreadable folders and version folders without codex.exe are skipped, not fatal', () => {
  const ok = join(bin(REAL), 'v2', 'codex.exe');
  const f = fake({ unreadable: [bin(SANDBOX)], dirs: { [bin(REAL)]: ['v1', 'v2'] }, files: { [ok]: 3 } });
  assert.equal(installedCodex({ LOCALAPPDATA: SANDBOX, USERPROFILE: HOME }, f.probe), ok);
});

test('genuinely absent binary: concise actionable error, nothing guessed', () => {
  assert.throws(() => installedCodex({ LOCALAPPDATA: SANDBOX, USERPROFILE: HOME }, fake({ dirs: { [bin(REAL)]: ['v1'] } }).probe),
    /Codex CLI not found \(checked PATH and OpenAI\\Codex\\bin under LOCALAPPDATA and the user profile\)\. Open the ChatGPT desktop app/);
  assert.throws(() => installedCodex({}, fake({}).probe), /Codex CLI not found/);
});
