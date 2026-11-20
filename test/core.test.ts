import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { open, seal, deriveKek, newKdfParams, DecryptionError, random } from '../src/crypto.ts';
import { streamJsonArray, JsonStreamError } from '../src/jsonstream.ts';
import { readZipEntries, openZipEntry } from '../src/zip.ts';
import { canonicalJson, toIso } from '../src/schema.ts';
import { makeZip, tmp, TEST_KDF_N } from './helpers.ts';

test('AEAD round trip, wrong key, tampering and wrong AAD all fail closed', () => {
  const k = random(32), aad = Buffer.from('ctx');
  const blob = seal(k, Buffer.from('secret 秘密'), aad);
  assert.equal(open(k, blob, aad).toString(), 'secret 秘密');
  assert.throws(() => open(random(32), blob, aad), DecryptionError);
  const t = Buffer.from(blob); t[20] ^= 1;
  assert.throws(() => open(k, t, aad), DecryptionError);
  assert.throws(() => open(k, blob, Buffer.from('other')), DecryptionError);
});

test('scrypt KDF is deterministic per salt and rejects weak parameters', async () => {
  const p = newKdfParams(TEST_KDF_N);
  assert.deepEqual(await deriveKek('pw-12345678', p), await deriveKek('pw-12345678', p));
  assert.notDeepEqual(await deriveKek('pw-12345678', p), await deriveKek('pw-12345679', p));
  assert.throws(() => newKdfParams(1024));
  await assert.rejects(deriveKek('x', { ...p, N: 1024 }));
});

async function collect(text: string, chunk: number) {
  // Chunk the UTF-8 bytes, so multi-byte characters are split across chunk boundaries.
  const bytes = Buffer.from(text, 'utf8');
  const parts: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += chunk) parts.push(bytes.subarray(i, i + chunk));
  const out = [];
  for await (const it of streamJsonArray(Readable.from(parts))) out.push(it);
  return out;
}

test('streaming JSON splitter handles any chunk boundary, strings with brackets, escapes and Unicode', async () => {
  const data = [{ a: 'x]}{["\\"', b: [1, { c: '中文🐼' }] }, { d: null }, { e: ' ' }];
  const text = '﻿ ' + JSON.stringify(data, null, 1);
  for (const n of [1, 2, 3, 7, 64, 100000]) {
    const out = await collect(text, n);
    assert.deepEqual(out.map((o) => ('value' in o ? o.value : o)), data, `chunk=${n}`);
  }
});

test('streaming JSON splitter reports malformed elements and truncation instead of silently dropping', async () => {
  const out = await collect('[{"a":1},{"b":tru},{"c":3}, 42, {"d":4}]', 5);
  assert.deepEqual(out.map((o) => ('value' in o ? 'ok' : 'err')), ['ok', 'err', 'ok', 'err', 'ok']);
  await assert.rejects(collect('[{"a":1},{"b":', 4), (e: Error) => e instanceof JsonStreamError && /truncated after 1/.test(e.message));
  await assert.rejects(collect('{"not":"array"}', 4), JsonStreamError);
  await assert.rejects(collect('', 4), JsonStreamError);
});

test('ZIP reader lists and streams entries, detects corruption and non-ZIPs', async () => {
  const d = tmp();
  const p = join(d, 'a.zip');
  writeFileSync(p, makeZip([{ name: 'dir/中文.json', data: '[1,2,3]' }, { name: 'raw.bin', data: Buffer.alloc(5000, 7), store: true }]));
  const es = await readZipEntries(p);
  assert.deepEqual(es.map((e) => e.name), ['dir/中文.json', 'raw.bin']);
  const read = async (i: number) => { const c: Buffer[] = []; for await (const x of await openZipEntry(p, es[i])) c.push(x as Buffer); return Buffer.concat(c); };
  assert.equal((await read(0)).toString(), '[1,2,3]');
  assert.equal((await read(1)).length, 5000);
  // Corrupt the stored entry's data -> CRC mismatch.
  const buf = makeZip([{ name: 'raw.bin', data: Buffer.alloc(100, 1), store: true }]);
  buf[40] ^= 0xff;
  const bad = join(d, 'bad.zip'); writeFileSync(bad, buf);
  const be = await readZipEntries(bad);
  await assert.rejects(async () => { for await (const _ of await openZipEntry(bad, be[0])) { /* drain */ } }, /CRC/);
  const trunc = join(d, 'trunc.zip'); writeFileSync(trunc, buf.subarray(0, 60));
  await assert.rejects(readZipEntries(trunc), /end-of-central-directory/);
});

test('canonical JSON and timestamp normalisation', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 1 }] }), '{"a":[{"c":1,"d":2}],"b":1}');
  assert.equal(toIso(1_700_000_000), '2023-11-14T22:13:20.000Z');
  assert.equal(toIso(1_700_000_000.5), '2023-11-14T22:13:20.500Z');
  assert.equal(toIso('2024-03-01T10:00:00Z'), '2024-03-01T10:00:00.000Z');
  assert.equal(toIso(null), null);
  assert.equal(toIso('garbage'), null);
});
