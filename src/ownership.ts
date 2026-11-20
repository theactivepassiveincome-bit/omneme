// OMN-041: approved vault and agent ownership correction.
// Exclusive, process-safe ownership of a file (a vault or an agent discovery file), reusing the SQLite-guard pattern of
// scripts/task-worker.ts: a sidecar SQLite database "<canonical path>.owner" is opened and a write transaction
// (BEGIN IMMEDIATE) is held open for the owner's whole lifetime. SQLite's OS-level file locks (LockFileEx on Windows,
// fcntl on POSIX, see https://www.sqlite.org/lockingv3.html) exclude every other connection, in this or any other process,
// and the OS drops them automatically when the owner dies. Transaction ownership, never file existence, decides: the
// sidecar is empty, holds no secrets or private data, and is never deleted or replaced (no stale-lock takeover).
import { DatabaseSync } from 'node:sqlite';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export class BusyError extends Error {
  readonly code = 'EBUSY';
  constructor(m: string) { super(m); this.name = 'BusyError'; }
}

export interface OwnerGuard { readonly file: string; release(): void }

/** Absolute path with symlinks resolved: the file itself if it exists, otherwise its real parent plus its name. */
export function canonicalPath(p: string): string {
  const abs = resolve(p);
  try { return realpathSync.native(abs); } catch { /* not there yet */ }
  try { return join(realpathSync.native(dirname(abs)), basename(abs)); } catch { return abs; }
}

/** The sidecar guard file shared by every alias (relative/absolute/symlinked parent) of `target`. */
export function guardFileFor(target: string): string { return canonicalPath(target) + '.owner'; }

/**
 * Take exclusive ownership of `target` or throw BusyError(busyMessage) at once (no waiting, no retries).
 * The parent directory must exist. release() is idempotent.
 */
export function acquireOwnership(target: string, busyMessage: string): OwnerGuard {
  const file = guardFileFor(target);
  const db = new DatabaseSync(file); // default busy timeout is 0: a contender fails immediately
  try { db.exec('BEGIN IMMEDIATE'); }
  catch (e) {
    try { db.close(); } catch { /* ignore */ }
    if (((e as { errcode?: number }).errcode ?? 0) % 256 === 5) throw new BusyError(busyMessage); // SQLITE_BUSY
    throw e;
  }
  let held = true;
  return {
    file,
    release() {
      if (!held) return;
      held = false;
      try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      try { db.close(); } catch { /* ignore */ }
    },
  };
}

/** Conservative liveness probe: EPERM (exists, not ours) and any non-ESRCH error count as alive. */
export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
