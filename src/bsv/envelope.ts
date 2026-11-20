// Omneme on-chain record envelope (spec: docs/BSV_STORAGE.md). Pure byte encoding, no network.
// When @bsv/sdk becomes installable, the script output should be cross-checked against the SDK's
// Script/LockingScript classes, and transaction construction delegated to it.
import { sha256 } from '../crypto.ts';

export const MAGIC = Buffer.from('OMNM', 'ascii');
export const PROTOCOL_PREFIX = Buffer.from('omneme', 'ascii');
export const ENVELOPE_VERSION = 1;

/** 1 = integrity commitment (Mode B), 2 = encrypted payload (Mode A), 3 = encrypted version manifest. */
export const EnvelopeType = { COMMITMENT: 1, ENCRYPTED_PAYLOAD: 2, MANIFEST: 3 } as const;
export type EnvelopeTypeCode = (typeof EnvelopeType)[keyof typeof EnvelopeType];

export interface Envelope { version: number; type: EnvelopeTypeCode; body: Buffer }

export function encodeEnvelope(e: Envelope): Buffer {
  const h = Buffer.alloc(10);
  MAGIC.copy(h, 0);
  h.writeUInt8(e.version, 4);
  h.writeUInt8(e.type, 5);
  h.writeUInt32BE(e.body.length, 6);
  return Buffer.concat([h, e.body]);
}

export function decodeEnvelope(b: Buffer): Envelope {
  if (b.length < 10 || !b.subarray(0, 4).equals(MAGIC)) throw new Error('Not an Omneme envelope');
  const version = b.readUInt8(4), type = b.readUInt8(5), len = b.readUInt32BE(6);
  if (version !== ENVELOPE_VERSION) throw new Error(`Unsupported envelope version ${version}`);
  if (![1, 2, 3].includes(type)) throw new Error(`Unknown envelope type ${type}`);
  if (b.length !== 10 + len) throw new Error('Envelope length mismatch');
  return { version, type: type as EnvelopeTypeCode, body: b.subarray(10) };
}

/** Commitment body: algorithm id (1 = SHA-256) followed by the 32-byte digest. No identifiers, no metadata. */
export function commitmentEnvelope(digest: Buffer): Envelope {
  if (digest.length !== 32) throw new Error('Digest must be 32 bytes');
  return { version: ENVELOPE_VERSION, type: EnvelopeType.COMMITMENT, body: Buffer.concat([Buffer.from([1]), digest]) };
}

function pushData(d: Buffer): Buffer {
  if (d.length < 0x4c) return Buffer.concat([Buffer.from([d.length]), d]);
  if (d.length <= 0xff) return Buffer.concat([Buffer.from([0x4c, d.length]), d]);
  if (d.length <= 0xffff) { const l = Buffer.alloc(2); l.writeUInt16LE(d.length); return Buffer.concat([Buffer.from([0x4d]), l, d]); }
  const l = Buffer.alloc(4); l.writeUInt32LE(d.length); return Buffer.concat([Buffer.from([0x4e]), l, d]);
}

/** Unspendable data output: OP_FALSE OP_RETURN <"omneme"> <envelope>. */
export function toLockingScript(e: Envelope): Buffer {
  return Buffer.concat([Buffer.from([0x00, 0x6a]), pushData(PROTOCOL_PREFIX), pushData(encodeEnvelope(e))]);
}

export function fromLockingScript(s: Buffer): Envelope {
  if (s.length < 2 || s[0] !== 0x00 || s[1] !== 0x6a) throw new Error('Not an OP_FALSE OP_RETURN script');
  const pushes: Buffer[] = [];
  let p = 2;
  while (p < s.length) {
    const op = s[p++];
    let len: number;
    if (op < 0x4c) len = op;
    else if (op === 0x4c) len = s[p++];
    else if (op === 0x4d) { len = s.readUInt16LE(p); p += 2; }
    else if (op === 0x4e) { len = s.readUInt32LE(p); p += 4; }
    else throw new Error('Unexpected opcode in data script');
    if (p + len > s.length) throw new Error('Truncated push');
    pushes.push(s.subarray(p, p + len)); p += len;
  }
  if (pushes.length !== 2 || !pushes[0].equals(PROTOCOL_PREFIX)) throw new Error('Not an Omneme data output');
  return decodeEnvelope(pushes[1]);
}

/** Bitcoin-style id of a byte string: double SHA-256, byte-reversed hex. */
export function doubleSha256Id(b: Buffer): string { return Buffer.from(sha256(sha256(b))).reverse().toString('hex'); }
