// Blockchain storage interface + local mock adapter. No network adapter exists in Stage 1:
// nothing in this codebase can broadcast a transaction.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../crypto.ts';
import { commitmentEnvelope, doubleSha256Id, fromLockingScript, toLockingScript, EnvelopeType, type Envelope } from './envelope.ts';

export type Network = 'mock' | 'testnet' | 'mainnet';

export interface PublishResult { txid: string; network: Network; adapter: string; publishedAt: string }

/** A storage adapter publishes data-output scripts and retrieves them by txid. */
export interface BlockchainStorageAdapter {
  readonly name: string;
  readonly network: Network;
  /** Publish one unspendable data output. Real adapters must require wallet signing (BRC-100) and explicit approval for mainnet. */
  publish(lockingScript: Buffer): Promise<PublishResult>;
  /** Fetch the data-output script for a txid from this provider, or null if unavailable. */
  fetch(txid: string): Promise<Buffer | null>;
}

/** Writes "transactions" as JSON files in a local directory. The txid is a double-SHA256 of the script, not a real BSV txid. */
export class MockLedgerAdapter implements BlockchainStorageAdapter {
  readonly name = 'mock-ledger';
  readonly network: Network = 'mock';
  private dir: string;
  constructor(dir: string) { this.dir = dir; mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  async publish(script: Buffer): Promise<PublishResult> {
    const txid = doubleSha256Id(script);
    const publishedAt = new Date().toISOString();
    const f = join(this.dir, txid + '.json');
    if (!existsSync(f)) writeFileSync(f, JSON.stringify({ txid, network: 'mock', script: script.toString('hex'), publishedAt }), { mode: 0o600 });
    return { txid, network: 'mock', adapter: this.name, publishedAt };
  }
  async fetch(txid: string): Promise<Buffer | null> {
    if (!/^[0-9a-f]{64}$/.test(txid)) return null;
    const f = join(this.dir, txid + '.json');
    if (!existsSync(f)) return null;
    return Buffer.from(JSON.parse(readFileSync(f, 'utf8')).script, 'hex');
  }
}

/** Mode B: anchor a SHA-256 commitment to encrypted content (e.g. a backup file). */
export async function anchorCommitment(adapter: BlockchainStorageAdapter, content: Buffer): Promise<PublishResult & { digest: string }> {
  const digest = sha256(content);
  const res = await adapter.publish(toLockingScript(commitmentEnvelope(digest)));
  return { ...res, digest: digest.toString('hex') };
}

/** Verify that `txid`, fetched from any adapter, commits to exactly `content`. */
export async function verifyCommitment(adapters: BlockchainStorageAdapter[], txid: string, content: Buffer): Promise<{ ok: boolean; source: string | null; reason?: string }> {
  for (const a of adapters) {
    const script = await a.fetch(txid);
    if (!script) continue;
    let env: Envelope;
    try { env = fromLockingScript(script); } catch (e) { return { ok: false, source: a.name, reason: (e as Error).message }; }
    if (env.type !== EnvelopeType.COMMITMENT || env.body[0] !== 1) return { ok: false, source: a.name, reason: 'Not a SHA-256 commitment' };
    return { ok: env.body.subarray(1).equals(sha256(content)), source: a.name, reason: undefined };
  }
  return { ok: false, source: null, reason: 'Transaction not found at any provider' };
}
