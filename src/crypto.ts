// Omneme cryptographic primitives. Thin wrappers over Node's built-in OpenSSL
// bindings (node:crypto). No primitives are implemented here.
import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync,
  randomBytes, scrypt, timingSafeEqual,
} from 'node:crypto';

export const AEAD_ALG = 'aes-256-gcm';
const NONCE_LEN = 12;
const TAG_LEN = 16;

/** Password KDF parameters, stored per vault so they can be upgraded (e.g. to Argon2id). */
export interface KdfParams {
  alg: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string; // base64
}

/** Default: N=2^17, r=8 => 128 MiB memory, roughly 0.3-1 s on a laptop. */
export const DEFAULT_SCRYPT = { N: 2 ** 17, r: 8, p: 1 };
export const MIN_SCRYPT_N = 2 ** 14; // absolute floor (tests only; real vaults are created with 2^17)
export const MAX_SCRYPT_N = 2 ** 20; // individual bound on N
// Combined bounds (memory = 128·N·r bytes; work ∝ N·r·p). Default N=2^17, r=8, p=1 = 128 MiB, N·r·p = 2^20.
export const MAX_SCRYPT_MEMORY = 256 * 2 ** 20; // 256 MiB: 2x the default
export const MAX_SCRYPT_WORK = 2 ** 22;          // N·r·p: 4x the default

export function newKdfParams(N = DEFAULT_SCRYPT.N): KdfParams {
  if (!Number.isInteger(Math.log2(N)) || N < MIN_SCRYPT_N) throw new Error('Invalid scrypt N');
  return { alg: 'scrypt', N, r: DEFAULT_SCRYPT.r, p: DEFAULT_SCRYPT.p, salt: randomBytes(16).toString('base64') };
}

export function deriveKek(password: string, params: KdfParams): Promise<Buffer> {
  if (params.alg !== 'scrypt') return Promise.reject(new Error(`Unsupported KDF ${params.alg}`));
  // Parameters come from a (MAC-protected, but MAC is checked only after unlock) header: bound them
  // so a tampered header can neither weaken the KDF below the floor nor exhaust memory.
  const saltLen = Buffer.from(params.salt ?? '', 'base64').length;
  if (!Number.isInteger(Math.log2(params.N)) || params.N < MIN_SCRYPT_N || params.N > MAX_SCRYPT_N
    || !Number.isInteger(params.r) || !(params.r >= 1 && params.r <= 32) || !Number.isInteger(params.p) || !(params.p >= 1 && params.p <= 16) || saltLen < 16
    || 128 * params.N * params.r > MAX_SCRYPT_MEMORY || params.N * params.r * params.p > MAX_SCRYPT_WORK)
    return Promise.reject(new Error('KDF parameters out of accepted range'));
  const pw = Buffer.from(password.normalize('NFKC'), 'utf8');
  const maxmem = MAX_SCRYPT_MEMORY + 32 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    scrypt(pw, Buffer.from(params.salt, 'base64'), 32, { N: params.N, r: params.r, p: params.p, maxmem }, (err, key) => {
      pw.fill(0);
      if (err) reject(err); else resolve(key);
    });
  });
}

/** AEAD seal: output = nonce(12) | ciphertext | tag(16). Random nonces; one key per vault. */
export function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const c = createCipheriv(AEAD_ALG, key, nonce, { authTagLength: TAG_LEN });
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]);
}

export class DecryptionError extends Error {
  constructor(msg = 'Decryption failed: wrong key or tampered data') { super(msg); this.name = 'DecryptionError'; }
}

export function open(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  if (blob.length < NONCE_LEN + TAG_LEN) throw new DecryptionError('Ciphertext too short');
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  try {
    const d = createDecipheriv(AEAD_ALG, key, nonce, { authTagLength: TAG_LEN });
    d.setAAD(aad);
    d.setAuthTag(tag);
    const out = d.update(ct);
    const tail = d.final(); // always empty for GCM; avoid an extra full-size copy
    return tail.length ? Buffer.concat([out, tail]) : out;
  } catch {
    throw new DecryptionError();
  }
}

export function hkdf(ikm: Buffer, salt: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.from(salt, 'utf8'), Buffer.from(info, 'utf8'), 32));
}

export function hmac(key: Buffer, data: string | Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function sha256(data: string | Buffer | Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

export function sha256hex(data: string | Buffer | Uint8Array): string {
  return sha256(data).toString('hex');
}

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function random(n: number): Buffer { return randomBytes(n); }

/** Recovery key: 32 random bytes rendered as 16 groups of 4 hex chars. */
export function formatRecoveryKey(k: Buffer): string {
  return k.toString('hex').match(/.{4}/g)!.join('-');
}
export function parseRecoveryKey(s: string): Buffer {
  const hex = s.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 64) throw new Error('Recovery key must contain 64 hex digits');
  return Buffer.from(hex, 'hex');
}
