// Encrypted local vault: SQLite file containing only ciphertext rows plus a key-slot header.
// See docs/SECURITY.md for the key hierarchy and threat model.
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync, createReadStream } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  DecryptionError, constantTimeEqual, deriveKek, formatRecoveryKey, hkdf, hmac, newKdfParams, open, parseRecoveryKey, random, seal,
  type KdfParams,
} from './crypto.ts';
import { SCHEMA_VERSION, canonicalJson, contentHash, lineageKey, type BlobRef, type DraftRecord, type MemoryRecord } from './schema.ts';
import { sha256 } from './crypto.ts';
import { acquireOwnership, type OwnerGuard } from './ownership.ts';

// OMN-041: every entry point that opens a vault file (create, unlock, resetPassword, restore target) first takes exclusive
// ownership of that path (src/ownership.ts). An unlocked Vault keeps it until lock(); a contender fails before reading.
const VAULT_BUSY = 'This vault is already open in another Omneme window or process. Close or lock it there, then try again.';
const ownVault = (path: string): OwnerGuard => acquireOwnership(path, VAULT_BUSY);

export const VAULT_FORMAT = 'omneme.vault/1';
export const BACKUP_FORMAT = 'omneme.backup/2'; // v2 adds C (blob chunk) lines; v1 still restorable
const BACKUP_FORMATS = ['omneme.backup/1', 'omneme.backup/2'];
export const CHUNK_SIZE = 4 * 2 ** 20;
/** Minimum vault password length, shared by create and resetPassword. */
export const MIN_PASSWORD_LENGTH = 8;

interface KeySlot { type: 'password' | 'recovery'; kdf?: KdfParams; wrapped: string }
export interface VaultHeader {
  format: string;
  vaultId: string;
  createdAt: string;
  aead: 'aes-256-gcm';
  compression: 'gzip';
  slots: KeySlot[];
  mac?: string; // HMAC over the rest of the header, keyed from the DEK
}

export type Credentials = { password: string } | { recoveryKey: string };
export type PutResult = 'inserted' | 'duplicate' | 'revision';

function slotAad(vaultId: string, type: string) { return Buffer.from(`omneme/keyslot/v1|${vaultId}|${type}`); }
function chunkAad(vaultId: string, id: Uint8Array) { return Buffer.concat([Buffer.from(`omneme/chunk/v1|${vaultId}|`), id]); }
function recAad(vaultId: string, id: Uint8Array) { return Buffer.concat([Buffer.from(`omneme/rec/v1|${vaultId}|`), id]); }
function headerBody(h: VaultHeader) { const { mac: _m, ...rest } = h; return canonicalJson(rest); }

async function unwrapDek(h: VaultHeader, creds: Credentials): Promise<Buffer> {
  if ('password' in creds) {
    const slot = h.slots.find((s) => s.type === 'password');
    if (!slot?.kdf) throw new Error('Vault has no password slot');
    const kek = await deriveKek(creds.password, slot.kdf);
    try { return open(kek, Buffer.from(slot.wrapped, 'base64'), slotAad(h.vaultId, 'password')); }
    catch { throw new DecryptionError('Incorrect password or corrupted vault header'); }
    finally { kek.fill(0); }
  }
  const slot = h.slots.find((s) => s.type === 'recovery');
  if (!slot) throw new Error('Vault has no recovery slot');
  const kek = hkdf(parseRecoveryKey(creds.recoveryKey), h.vaultId, 'omneme/v1/recovery-kek');
  try { return open(kek, Buffer.from(slot.wrapped, 'base64'), slotAad(h.vaultId, 'recovery')); }
  catch { throw new DecryptionError('Incorrect recovery key or corrupted vault header'); }
  finally { kek.fill(0); }
}

function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA temp_store=MEMORY; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records (id BLOB PRIMARY KEY, lineage BLOB NOT NULL, blob BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS records_lineage ON records(lineage);
    CREATE TABLE IF NOT EXISTS chunks (id BLOB PRIMARY KEY, blob BLOB NOT NULL);`);
  return db;
}

export class IntegrityError extends Error { constructor(m: string) { super(m); this.name = 'IntegrityError'; } }

/** Running commitment to the exact set of stored record ids (order-independent, keyed, MAC'd). */
interface SetState { count: number; digest: Buffer }

export interface BackupSummary { records: number; chunks: number; sha256: string; size: number }

export class Vault {
  private db: DatabaseSync | null;
  private keys: { rec: Buffer; id: Buffer; mac: Buffer; cps: Buffer } | null;
  private state: SetState = { count: 0, digest: Buffer.alloc(32) };
  readonly header: VaultHeader;
  readonly path: string;
  /** OMN-041: exclusive ownership of `path`, held from open until lock(). */
  private owner: OwnerGuard | null = null;
  /** Test-only hooks (used to simulate crashes mid-transaction). Never set in production code. */
  static testHooks: { afterInsert?: (n: number) => void; afterChunk?: () => void; beforeHeaderCommit?: () => void; afterHeaderUpdate?: () => void } = {};

  private constructor(path: string, db: DatabaseSync, header: VaultHeader, dek: Buffer) {
    this.path = path; this.db = db; this.header = header;
    const v = header.vaultId;
    this.keys = { rec: hkdf(dek, v, 'omneme/v1/records'), id: hkdf(dek, v, 'omneme/v1/record-id'), mac: hkdf(dek, v, 'omneme/v1/mac'), cps: hkdf(dek, v, 'omneme/v1/bsv-checkpoint-salt') };
    dek.fill(0);
  }

  /** Create a new vault. Returns the one-time recovery key, which must be shown to the user once and never stored. */
  static async create(path: string, password: string, opts: { kdfN?: number } = {}): Promise<{ vault: Vault; recoveryKey: string }> {
    if (existsSync(path)) throw new Error('A vault already exists at that path');
    if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const guard = ownVault(path);
    try {
      // Recheck under ownership: a concurrent creator may have finished first. A leftover ".creating" can only belong to
      // a dead creator now (a live one would still own the path), so createOwned may safely replace it.
      if (existsSync(path)) throw new Error('A vault already exists at that path');
      const r = await Vault.createOwned(path, password, opts);
      r.vault.owner = guard; // ownership passes to the returned vault with no gap
      return r;
    } catch (e) { guard.release(); throw e; }
  }

  private static async createOwned(path: string, password: string, opts: { kdfN?: number }): Promise<{ vault: Vault; recoveryKey: string }> {
    const vaultId = random(16).toString('hex');
    const dek = random(32);
    const recovery = random(32);
    const kdf = newKdfParams(opts.kdfN);
    const pwKek = await deriveKek(password, kdf);
    const rcKek = hkdf(recovery, vaultId, 'omneme/v1/recovery-kek');
    const header: VaultHeader = {
      format: VAULT_FORMAT, vaultId, createdAt: new Date().toISOString(), aead: 'aes-256-gcm', compression: 'gzip',
      slots: [
        { type: 'password', kdf, wrapped: seal(pwKek, dek, slotAad(vaultId, 'password')).toString('base64') },
        { type: 'recovery', wrapped: seal(rcKek, dek, slotAad(vaultId, 'recovery')).toString('base64') },
      ],
    };
    pwKek.fill(0); rcKek.fill(0);
    // Build at a temporary path and rename, so an interrupted create never leaves a half-made vault.
    const tmp = path + '.creating';
    rmSync(tmp, { force: true });
    const db = openDb(tmp);
    chmodSync(tmp, 0o600);
    const vault = new Vault(tmp, db, header, Buffer.from(dek));
    header.mac = hmac(vault.keys!.mac, headerBody(header)).toString('hex');
    db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('header', JSON.stringify(header));
    vault.writeState();
    vault.lock();
    renameSync(tmp, path);
    const final = new Vault(path, openDb(path), header, dek);
    final.readState();
    const rk = formatRecoveryKey(recovery); recovery.fill(0);
    return { vault: final, recoveryKey: rk };
  }

  static async unlock(path: string, creds: Credentials): Promise<Vault> {
    if (!existsSync(path)) throw new Error('No vault found at that path');
    const guard = ownVault(path); // before any read or schema statement
    let db: DatabaseSync | null = null;
    try {
      db = openDb(path);
      const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('header') as { v: string } | undefined;
      if (!row) throw new Error('Not an Omneme vault (missing header)');
      const header = JSON.parse(row.v) as VaultHeader;
      if (header.format !== VAULT_FORMAT) throw new Error(`Unsupported vault format ${header.format}`);
      const dek = await unwrapDek(header, creds);
      const vault = new Vault(path, db, header, dek);
      const mac = hmac(vault.keys!.mac, headerBody(header));
      if (!header.mac || !constantTimeEqual(mac, Buffer.from(header.mac, 'hex'))) { vault.lock(); throw new DecryptionError('Vault header integrity check failed'); }
      try { vault.readState(); } catch (e) { vault.lock(); throw e; }
      vault.owner = guard;
      return vault;
    } catch (e) { try { db?.close(); } catch { /* already closed */ } guard.release(); throw e; }
  }

  /**
   * OMN-025: offline password reset authenticated by the recovery key. Verifies the recovery slot, the header MAC and
   * the record-set state MAC before writing; then re-wraps the SAME data key in the password slot only (fresh scrypt
   * salt/params), refreshes the header MAC and commits ONLY the header row in one SQLite transaction, comparing it with
   * the header that was verified (a concurrent change aborts the reset). The recovery slot, records, chunks, record-set
   * state and backup format are untouched. Callers must ensure no unlock agent holds the vault.
   */
  static async resetPassword(path: string, opts: { recoveryKey: string; newPassword: string; confirmPassword: string; kdfN?: number }): Promise<void> {
    if (opts.newPassword !== opts.confirmPassword) throw new Error('Passwords do not match');
    if (opts.newPassword.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    if (!existsSync(path)) throw new Error('No vault found at that path');
    const kdf = newKdfParams(opts.kdfN); // validated before any key material is derived
    const guard = ownVault(path); // refuses while an agent or any other process holds the vault
    let db: DatabaseSync;
    try { db = openDb(path); } catch (e) { guard.release(); throw e; }
    let vault: Vault | null = null;
    let dek: Buffer | null = null;
    try {
      const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('header') as { v: string } | undefined;
      if (!row) throw new Error('Not an Omneme vault (missing header)');
      const before = row.v;
      const header = JSON.parse(before) as VaultHeader;
      if (header.format !== VAULT_FORMAT) throw new Error(`Unsupported vault format ${header.format}`);
      const pwIndex = header.slots.findIndex((s) => s.type === 'password');
      if (pwIndex < 0) throw new Error('Vault has no password slot');
      dek = await unwrapDek(header, { recoveryKey: opts.recoveryKey }); // authenticates the recovery slot
      vault = new Vault(path, db, header, Buffer.from(dek)); // constructor wipes its copy
      const mac = hmac(vault.keys!.mac, headerBody(header));
      if (!header.mac || !constantTimeEqual(mac, Buffer.from(header.mac, 'hex'))) throw new DecryptionError('Vault header integrity check failed');
      vault.readState(); // record-set state MAC must verify too
      const pwKek = await deriveKek(opts.newPassword, kdf);
      let wrapped: string;
      try { wrapped = seal(pwKek, dek, slotAad(header.vaultId, 'password')).toString('base64'); } finally { pwKek.fill(0); }
      const slots = header.slots.map((s, i) => (i === pwIndex ? { type: 'password' as const, kdf, wrapped } : s));
      const next: VaultHeader = { ...header, slots };
      delete next.mac;
      next.mac = hmac(vault.keys!.mac, headerBody(next)).toString('hex');
      const after = JSON.stringify(next);
      Vault.testHooks.beforeHeaderCommit?.();
      db.exec('BEGIN IMMEDIATE');
      try {
        const cur = db.prepare('SELECT v FROM meta WHERE k = ?').get('header') as { v: string } | undefined;
        if (!cur || cur.v !== before) throw new Error('Vault header changed during the reset; nothing was written');
        const r = db.prepare('UPDATE meta SET v = ? WHERE k = ? AND v = ?').run(after, 'header', before);
        if (Number(r.changes) !== 1) throw new Error('Vault header changed during the reset; nothing was written');
        Vault.testHooks.afterHeaderUpdate?.();
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch { /* no transaction */ } throw e; }
    } finally {
      dek?.fill(0);
      if (vault) vault.lock(); else { try { db.close(); } catch { /* already closed */ } }
      guard.release();
    }
  }

  get locked() { return this.keys === null; }

  /** Wipe keys from memory and close the database. */
  lock() {
    if (this.keys) { this.keys.rec.fill(0); this.keys.id.fill(0); this.keys.mac.fill(0); this.keys.cps.fill(0); }
    this.keys = null;
    if (this.db) { try { this.db.close(); } catch { /* ignore */ } }
    this.db = null;
    const owner = this.owner; this.owner = null;
    owner?.release(); // after the database is closed; repeat lock() is a no-op
  }

  private need() {
    if (!this.keys || !this.db) throw new Error('Vault is locked');
    return { keys: this.keys, db: this.db };
  }

  private stateMac(st: SetState) { return hmac(this.need().keys.mac, `state|${st.count}|${st.digest.toString('hex')}`); }
  private rowTag(id: Uint8Array) { return hmac(this.need().keys.mac, Buffer.concat([Buffer.from('S|'), id])); }
  private writeState() {
    const st = this.state;
    this.need().db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)')
      .run('state', JSON.stringify({ count: st.count, digest: st.digest.toString('hex'), mac: this.stateMac(st).toString('hex') }));
  }
  private readState() {
    const row = this.need().db.prepare('SELECT v FROM meta WHERE k = ?').get('state') as { v: string } | undefined;
    if (!row) throw new IntegrityError('Vault record-set state missing');
    const j = JSON.parse(row.v) as { count: number; digest: string; mac: string };
    const st = { count: j.count, digest: Buffer.from(j.digest, 'hex') };
    if (!constantTimeEqual(this.stateMac(st), Buffer.from(j.mac, 'hex'))) throw new IntegrityError('Vault record-set state tampered');
    this.state = st;
  }
  /** The vault's record-set commitment (count + digest): equal for a vault and any faithful restore of its backup. */
  recordSetState(): { count: number; digest: string } { this.need(); return { count: this.state.count, digest: this.state.digest.toString('hex') }; }

  /** Recompute the record-set commitment from the rows and compare it with the stored state. */
  private checkRecordSet(rows: Iterable<{ id: Uint8Array }>): void {
    let count = 0; const d = Buffer.alloc(32);
    for (const r of rows) { count++; const t = this.rowTag(r.id); for (let i = 0; i < 32; i++) d[i] ^= t[i]; }
    if (count !== this.state.count || !d.equals(this.state.digest))
      throw new IntegrityError(`Record set integrity check failed: expected ${this.state.count} records, found ${count} (records missing, added or rolled back)`);
  }

  private ids(d: DraftRecord) {
    const { keys } = this.need();
    const lk = lineageKey(d);
    return { lineage: hmac(keys.id, 'L|' + lk), id: hmac(keys.id, 'R|' + lk + '|' + d.contentHash) };
  }

  /**
   * Private checkpoint commitment (Stage 3 phase 2): HMAC(k, sha256 || size || seq), where k is derived from this vault's
   * own data key. k is never stored or exported; every backup of this vault yields the same k once unlocked, so a
   * restored copy can verify its on-chain commitment, while the public value reveals nothing about the backup.
   */
  checkpointCommitment(sha256Hex: string, size: number, seq: number): string {
    const b = Buffer.alloc(44); Buffer.from(sha256Hex, 'hex').copy(b, 0); b.writeBigUInt64BE(BigInt(size), 32); b.writeUInt32BE(seq, 40);
    return createHmac('sha256', this.need().keys.cps).update(b).digest('hex');
  }

  static recordIdOf(id: Uint8Array) { return 'omr_' + Buffer.from(id).subarray(0, 16).toString('hex'); }

  put(d: DraftRecord): PutResult { return this.putMany([d])[0]; }

  private insert(d: DraftRecord): PutResult {
    const { keys, db } = this.need();
    const { lineage, id } = this.ids(d);
    if (db.prepare('SELECT 1 FROM records WHERE id = ?').get(id)) return 'duplicate';
    const prior = db.prepare('SELECT id FROM records WHERE lineage = ?').all(lineage) as { id: Uint8Array }[];
    const rec: MemoryRecord = { ...d, schema: SCHEMA_VERSION, recordId: Vault.recordIdOf(id) };
    for (const p of prior) rec.relations = [...rec.relations, { type: 'supersedes', target: Vault.recordIdOf(p.id) }];
    const blob = seal(keys.rec, gzipSync(Buffer.from(JSON.stringify(rec), 'utf8')), recAad(this.header.vaultId, id));
    db.prepare('INSERT INTO records (id, lineage, blob) VALUES (?, ?, ?)').run(id, lineage, blob);
    this.state.count++;
    const t = this.rowTag(id); for (let i = 0; i < 32; i++) this.state.digest[i] ^= t[i];
    Vault.testHooks.afterInsert?.(this.state.count);
    return prior.length ? 'revision' : 'inserted';
  }

  private inBatch = false;

  /**
   * Run `fn` (which may call putBlob/putMany) inside ONE SQLite transaction: chunks, records and the
   * record-set state commit together or not at all. Used to import many small files efficiently.
   */
  async batch<T>(fn: () => Promise<T>): Promise<T> {
    const { db } = this.need();
    if (this.inBatch) return fn();
    const saved = { count: this.state.count, digest: Buffer.from(this.state.digest) };
    db.exec('BEGIN'); this.inBatch = true;
    try { const r = await fn(); this.writeState(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); this.state = saved; throw e; }
    finally { this.inBatch = false; }
  }

  /** Insert a batch atomically. */
  putMany(drafts: DraftRecord[]): PutResult[] {
    const { db } = this.need();
    if (this.inBatch) return drafts.map((d) => this.insert(d)); // committed (with state) by batch()
    const saved = { count: this.state.count, digest: Buffer.from(this.state.digest) };
    db.exec('BEGIN');
    try { const r = drafts.map((d) => this.insert(d)); this.writeState(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); this.state = saved; throw e; }
  }

  count(): number {
    const { db } = this.need();
    return (db.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }).n;
  }

  /** Decrypt and authenticate one row: AEAD tag, then id and lineage must be the keyed hashes of the record's own content. */
  private decryptRow(row: { id: Uint8Array; lineage: Uint8Array; blob: Uint8Array }): MemoryRecord {
    const { keys } = this.need();
    const pt = open(keys.rec, view(row.blob), recAad(this.header.vaultId, row.id));
    const rec = JSON.parse(gunzipSync(pt).toString('utf8')) as MemoryRecord;
    const want = this.ids(rec);
    if (rec.recordId !== Vault.recordIdOf(row.id) || !want.id.equals(Buffer.from(row.id)) || !want.lineage.equals(Buffer.from(row.lineage)))
      throw new DecryptionError('Record id/lineage mismatch');
    return rec;
  }
  private rows() {
    return this.need().db.prepare('SELECT id, lineage, blob FROM records').iterate() as Iterable<{ id: Uint8Array; lineage: Uint8Array; blob: Uint8Array }>;
  }

  // ---------- Encrypted, content-addressed blob store (exact original bytes) ----------
  // A blob is split into 4 MiB chunks. Each chunk is stored once, keyed by HMAC(id key, sha256(chunk)),
  // gzip-compressed and sealed with AES-256-GCM (AAD binds vault id + chunk id). The owning record's
  // BlobRef (sha256 + size + ordered chunk hashes) is covered by the record-set commitment, so missing
  // or altered chunks are detected by verify() and refused by backup.
  private chunkId(chunkSha: Buffer) { return hmac(this.need().keys.id, Buffer.concat([Buffer.from('C|'), chunkSha])); }

  /** Stream bytes into the blob store. Returns a reference to store in a record. */
  async putBlob(src: AsyncIterable<Buffer | Uint8Array | string>, stats?: { newChunks: number; reusedChunks: number; newBytes: number }): Promise<BlobRef> {
    const { keys, db } = this.need();
    const whole = createHash('sha256');
    const chunks: string[] = [];
    // One reusable chunk buffer: bytes are copied in once, never re-concatenated.
    const buf = Buffer.allocUnsafe(CHUNK_SIZE);
    let size = 0, fill = 0;
    const ins = db.prepare('INSERT OR IGNORE INTO chunks (id, blob) VALUES (?, ?)');
    const flush = (data: Buffer) => {
      const h = sha256(data);
      const id = this.chunkId(h);
      // Skip compression+encryption entirely when the chunk already exists (deduplication).
      Vault.testHooks.afterChunk?.();
      if (db.prepare('SELECT 1 FROM chunks WHERE id = ?').get(id)) { if (stats) stats.reusedChunks++; }
      else { ins.run(id, seal(keys.rec, gzipSync(data), chunkAad(this.header.vaultId, id))); if (stats) { stats.newChunks++; stats.newBytes += data.length; } }
      chunks.push(h.toString('hex'));
    };
    for await (const part of src) {
      let b = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array | string);
      whole.update(b); size += b.length;
      while (b.length) {
        const take = Math.min(CHUNK_SIZE - fill, b.length);
        b.copy(buf, fill, 0, take); fill += take; b = b.subarray(take);
        if (fill === CHUNK_SIZE) { flush(buf); fill = 0; }
      }
    }
    if (fill || chunks.length === 0) flush(buf.subarray(0, fill));
    return { sha256: whole.digest('hex'), size, chunks };
  }

  private readChunk(chunkSha: string): Buffer {
    const { keys, db } = this.need();
    const id = this.chunkId(Buffer.from(chunkSha, 'hex'));
    const row = db.prepare('SELECT blob FROM chunks WHERE id = ?').get(id) as { blob: Uint8Array } | undefined;
    if (!row) throw new IntegrityError(`Blob chunk missing (${chunkSha.slice(0, 12)}…)`);
    const pt = gunzipSync(open(keys.rec, view(row.blob), chunkAad(this.header.vaultId, id)));
    if (!sha256(pt).equals(Buffer.from(chunkSha, 'hex'))) throw new IntegrityError('Blob chunk content mismatch');
    return pt;
  }

  /** Yield the original bytes, verifying every chunk and the whole-file SHA-256 and size. */
  *readBlob(ref: BlobRef): Generator<Buffer> {
    const whole = createHash('sha256'); let size = 0;
    for (const c of ref.chunks) { const b = this.readChunk(c); whole.update(b); size += b.length; yield b; }
    if (size !== ref.size || whole.digest('hex') !== ref.sha256) throw new IntegrityError('Blob size/SHA-256 mismatch');
  }

  verifyBlob(ref: BlobRef): boolean {
    try { for (const _ of this.readBlob(ref)) { /* drain */ } return true; } catch { return false; }
  }

  /** Decrypt every record into memory. Throws if any record fails authentication (tampering is never silent). */
  loadAll(): MemoryRecord[] {
    const out: MemoryRecord[] = [];
    const ids: { id: Uint8Array }[] = [];
    let bad = 0;
    for (const row of this.rows()) {
      ids.push({ id: row.id });
      try { out.push(this.decryptRow(row)); } catch { bad++; }
    }
    if (bad) throw new DecryptionError(`${bad} record(s) failed integrity verification`);
    this.checkRecordSet(ids);
    return out;
  }

  /** Verify every record decrypts, its id matches and its contentHash matches its raw source. */
  verify(contentHashFn: (raw: unknown) => string): { total: number; ok: number; failed: number; recordSetOk: boolean; expected: number; blobs: number; blobsFailed: number; blobBytes: number; fingerprint: string } {
    let total = 0, ok = 0, blobs = 0, blobsFailed = 0, blobBytes = 0;
    const ids: { id: Uint8Array }[] = [];
    const prints: string[] = [];
    for (const row of this.rows()) {
      total++; ids.push({ id: row.id });
      try {
        const r = this.decryptRow(row);
        let good = r.kind === 'import' || contentHashFn(r.raw) === r.contentHash;
        if (r.blob) { blobs++; blobBytes += r.blob.size; if (!this.verifyBlob(r.blob)) { blobsFailed++; good = false; } }
        prints.push(`${r.recordId}:${r.contentHash}:${r.blob ? `${r.blob.sha256}:${r.blob.size}` : '-'}`);
        if (good) ok++;
      } catch { /* counted */ }
    }
    let recordSetOk = true;
    try { this.checkRecordSet(ids); } catch { recordSetOk = false; }
    // Fingerprint of the whole record set: every record id, content hash and archived-file hash, order-independent.
    const fingerprint = createHash('sha256').update(prints.sort().join('\n')).digest('hex');
    return { total, ok, failed: total - ok, recordSetOk, expected: this.state.count, blobs, blobsFailed, blobBytes, fingerprint };
  }

  /** Write an encrypted backup. Records stay encrypted under the vault DEK; the file is MAC-protected end to end. */
  /** Refuses to back up a vault whose record set fails verification. Written to `<out>.partial`, fsynced, then renamed. */
  exportBackup(outPath: string): BackupSummary {
    if (existsSync(outPath)) throw new Error('Backup target already exists');
    // A unique temporary name: an interrupted earlier run's partial file is left alone (reported by backup checks), never reused.
    const tmp = `${outPath}.partial-${process.pid}-${Date.now().toString(36)}`;
    const lines = this.backupLines();
    const fd = openSync(tmp, 'wx', 0o600);
    const h = createHash('sha256'); let size = 0;
    try {
      for (const b of lines) { writeSync(fd, b); h.update(b); size += b.length; }
      fsyncSync(fd);
    } catch (e) { closeSync(fd); rmSync(tmp, { force: true }); throw e; }
    closeSync(fd);
    if (existsSync(outPath)) { rmSync(tmp, { force: true }); throw new Error('Backup target appeared while writing; not overwriting it'); }
    renameSync(tmp, outPath);
    return { ...lines.summary(), sha256: h.digest('hex'), size };
  }

  /** Stream an encrypted backup into a writable (for example rclone's stdin), honouring backpressure. No temporary file. */
  async exportBackupToStream(out: Writable): Promise<BackupSummary> {
    const lines = this.backupLines();
    const h = createHash('sha256'); let size = 0;
    for (const b of lines) {
      h.update(b); size += b.length;
      if (!out.write(b)) await Promise.race([once(out, 'drain'), once(out, 'error').then(([e]) => { throw e; })]);
    }
    out.end(); await once(out, 'finish');
    return { ...lines.summary(), sha256: h.digest('hex'), size };
  }

  /** The backup as a sequence of byte chunks (one per line). Verifies every record before yielding anything. */
  private backupLines(): Iterable<Buffer> & { summary(): { records: number; chunks: number } } {
    const { keys, db } = this.need();
    const rows = db.prepare('SELECT id, lineage, blob FROM records ORDER BY id').all() as { id: Uint8Array; lineage: Uint8Array; blob: Uint8Array }[];
    // Refuse to back up anything that would not restore cleanly: verify every record before writing a byte.
    this.checkRecordSet(rows);
    let failed = 0;
    for (const r of rows) {
      try {
        const rec = this.decryptRow(r);
        if ((rec.kind !== 'import' && contentHash(rec.raw) !== rec.contentHash) || (rec.blob && !this.verifyBlob(rec.blob))) failed++;
      } catch { failed++; }
    }
    if (failed) throw new IntegrityError(`Backup refused: ${failed} record(s) failed authentication, content-integrity or blob checks (run "omneme verify")`);
    const header = this.header, state = this.state;
    let n = 0, c = 0;
    const self = this;
    return {
      summary: () => ({ records: n, chunks: c }),
      *[Symbol.iterator]() {
        const mac = createMac(keys.mac);
        const line = (str: string) => { const b = Buffer.from(str + '\n', 'utf8'); mac.update(b); return b; };
        yield line('H ' + JSON.stringify({ format: BACKUP_FORMAT, header, state: { count: state.count, digest: state.digest.toString('hex') } }));
        for (const r of rows) { n++; yield line(`R ${b64(r.id)} ${b64(r.lineage)} ${b64(r.blob)}`); }
        for (const ch of self.db!.prepare('SELECT id, blob FROM chunks ORDER BY id').iterate() as Iterable<{ id: Uint8Array; blob: Uint8Array }>) { c++; yield line(`C ${b64(ch.id)} ${b64(ch.blob)}`); }
        yield Buffer.from('T ' + JSON.stringify({ count: n, chunks: c, mac: mac.digest() }) + '\n', 'utf8');
      },
    };
  }

  /** Restore a backup into a NEW vault file. Verifies MAC, count and every record before committing. */
  static async restoreBackup(backup: string | Readable, vaultPath: string, creds: Credentials): Promise<{ records: number; chunks: number; sha256: string; size: number; state: { count: number; digest: string } }> {
    if (existsSync(vaultPath)) throw new Error('Restore target already exists; restore only into a clean path');
    mkdirSync(dirname(vaultPath), { recursive: true, mode: 0o700 });
    const guard = ownVault(vaultPath); // a concurrent restore/create of the same target is refused, not raced
    try {
      if (existsSync(vaultPath)) throw new Error('Restore target already exists; restore only into a clean path');
      return await Vault.readBackup(backup, creds, vaultPath);
    } finally { guard.release(); }
  }

  /**
   * Check a backup completely without writing a vault: header MAC and key unwrap (needs the password), every record
   * decrypted and authenticated, every chunk decrypted and hash-checked, trailer MAC, counts and the record-set state.
   * Also returns the SHA-256 and size of the exact bytes read, so a streamed download is verified in one pass.
   */
  static async verifyBackup(backup: string | Readable, creds: Credentials): Promise<{ records: number; chunks: number; sha256: string; size: number; state: { count: number; digest: string } }> {
    return Vault.readBackup(backup, creds, null);
  }

  private static async readBackup(backup: string | Readable, creds: Credentials, vaultPath: string | null): Promise<{ records: number; chunks: number; sha256: string; size: number; state: { count: number; digest: string } }> {
    const input = typeof backup === 'string' ? createReadStream(backup) : backup;
    const fileHash = createHash('sha256'); let size = 0;
    input.on('data', (b: Buffer) => { fileHash.update(b); size += b.length; });
    const rl = createInterface({ input, crlfDelay: Infinity });
    const tmp = vaultPath ? vaultPath + '.partial' : ':memory:';
    if (vaultPath) rmSync(tmp, { force: true });
    let vault: Vault | null = null;
    let mac: ReturnType<typeof createMac> | null = null;
    let n = 0, nc = 0, trailer: { count: number; chunks?: number; mac: string } | null = null;
    const neededChunks = new Set<string>();
    let expected: { count: number; digest: string } | null = null;
    try {
      for await (const l of rl) {
        if (trailer) throw new Error('Backup has data after trailer');
        if (l.startsWith('H ')) {
          if (vault) throw new Error('Duplicate backup header');
          const { format, header, state } = JSON.parse(l.slice(2)) as { format: string; header: VaultHeader; state?: { count: number; digest: string } };
          expected = state ?? null;
          if (!BACKUP_FORMATS.includes(format) || header.format !== VAULT_FORMAT) throw new Error('Unsupported backup format');
          const dek = await unwrapDek(header, creds);
          if (vaultPath) mkdirSync(dirname(vaultPath), { recursive: true, mode: 0o700 });
          const db = openDb(tmp); if (vaultPath) chmodSync(tmp, 0o600);
          vault = new Vault(tmp, db, header, dek);
          mac = createMac(vault.keys!.mac);
          const hm = hmac(vault.keys!.mac, headerBody(header));
          if (!header.mac || !constantTimeEqual(hm, Buffer.from(header.mac, 'hex'))) throw new DecryptionError('Backup header integrity check failed');
          db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('header', JSON.stringify(header));
          db.exec('BEGIN');
          mac.update(Buffer.from(l + '\n', 'utf8'));
        } else if (l.startsWith('R ')) {
          if (!vault || !mac) throw new Error('Backup record before header');
          mac.update(Buffer.from(l + '\n', 'utf8'));
          const [, id, lineage, blob] = l.split(' ');
          const row = { id: Buffer.from(id, 'base64'), lineage: Buffer.from(lineage, 'base64'), blob: Buffer.from(blob, 'base64') };
          const rec = vault.decryptRow(row); // authenticate before accepting
          for (const c of rec.blob?.chunks ?? []) neededChunks.add(c);
          if (vaultPath) vault.db!.prepare('INSERT INTO records (id, lineage, blob) VALUES (?, ?, ?)').run(row.id, row.lineage, row.blob);
          vault.state.count++;
          const t = vault.rowTag(row.id); for (let i = 0; i < 32; i++) vault.state.digest[i] ^= t[i];
          n++;
        } else if (l.startsWith('C ')) {
          if (!vault || !mac) throw new Error('Backup chunk before header');
          mac.update(Buffer.from(l + '\n', 'utf8'));
          const [, id, blob] = l.split(' ');
          const cid = Buffer.from(id, 'base64'), cblob = Buffer.from(blob, 'base64');
          const pt = gunzipSync(open(vault.keys!.rec, cblob, chunkAad(vault.header.vaultId, cid)));
          const h = sha256(pt);
          if (!vault.chunkId(h).equals(cid)) throw new IntegrityError('Backup chunk id mismatch');
          neededChunks.delete(h.toString('hex'));
          if (vaultPath) vault.db!.prepare('INSERT INTO chunks (id, blob) VALUES (?, ?)').run(cid, cblob);
          nc++;
        } else if (l.startsWith('T ')) {
          trailer = JSON.parse(l.slice(2));
        } else if (l.trim()) throw new Error('Unrecognised line in backup');
      }
      if (!vault || !mac) throw new Error('Backup is empty or missing header');
      if (!trailer) throw new Error('Backup is truncated (no trailer)');
      if (!constantTimeEqual(Buffer.from(mac.digest(), 'hex'), Buffer.from(trailer.mac, 'hex')) || trailer.count !== n || (trailer.chunks ?? 0) !== nc)
        throw new DecryptionError('Backup integrity check failed (tampered or truncated)');
      if (!expected || expected.count !== vault.state.count || expected.digest !== vault.state.digest.toString('hex'))
        throw new IntegrityError('Backup record set does not match the vault state it was taken from');
      if (neededChunks.size) throw new IntegrityError(`Backup is missing ${neededChunks.size} blob chunk(s) referenced by records`);
      const result = { records: n, chunks: nc, sha256: fileHash.digest('hex'), size, state: { count: expected.count, digest: expected.digest } };
      if (!vaultPath) { vault.db!.exec('ROLLBACK'); vault.lock(); return result; }
      vault.writeState();
      vault.db!.exec('COMMIT');
      vault.lock();
      if (existsSync(vaultPath)) throw new Error('Restore target appeared during restore; not overwriting it');
      renameSync(tmp, vaultPath);
      return result;
    } catch (e) {
      try { vault?.lock(); } catch { /* already closed */ }
      if (vaultPath) rmSync(tmp, { force: true });
      if (typeof backup === 'string') input.destroy();
      throw e;
    }
  }
}

/** Zero-copy Buffer view of a Uint8Array returned by node:sqlite. */
function view(u: Uint8Array): Buffer { return Buffer.from(u.buffer, u.byteOffset, u.byteLength); }

function b64(u: Uint8Array) { return Buffer.from(u).toString('base64'); }

/** Incremental HMAC-SHA256 over all backup lines. */
function createMac(key: Buffer) {
  const h = createHmac('sha256', key);
  return { update: (b: Buffer) => { h.update(b); }, digest: () => h.digest('hex') };
}
