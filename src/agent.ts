// Omneme unlock agent (Stage 4.3): the owner unlocks the vault once in a console window; the vault stays in memory
// and answers tool calls on 127.0.0.1 only, authenticated by a random per-session token kept in ~/.omneme/agent.json.
// `omneme mcp` (started by Claude Desktop, no password) forwards MCP tool calls here. Closing the window locks it.
// OMN-022: immediate worker wake. After save_memory has durably stored a handoff to exactly project "Omneme Tasks",
// source "chatgpt", status exactly "TASK OMN-<digits> | APPROVAL: APPROVED", the agent asks Windows to run the EXISTING
// scheduled task "Omneme Task Worker" now (schtasks.exe /Run /TN, fixed arguments, async, hidden). Nothing from the
// handoff reaches the command line. The wake never blocks or fails the save; on failure a content-free line is logged
// and the ten-minute schedule still picks the task up. The worker's own approval/pause/guard/dedup checks are unchanged.
// OMN-045: this is an optional developer tool, OFF by default. It runs only when the agent is started with the
// environment variable OMNEME_WORKER_WAKE set to exactly "1". The "chatgpt" source of a save is caller-supplied
// local metadata, not authenticated owner approval; enabling the wake trusts every local client of this agent.
// Limitations: if the worker is already running, Task Scheduler applies the task's instance policy (schtasks /Create
// default: IgnoreNew), so the wake is dropped and the next ten-minute run handles it; if the task does not exist
// (worker stopped) or the platform is not Windows, no wake happens. Only one wake request is in flight at a time.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import type { Vault } from './vault.ts';
import type { MemoryRecord } from './schema.ts';
import { MemoryIndex } from './search.ts';
import { callTool, type ToolResult } from './mcp.ts';
import { BusyError, acquireOwnership, pidAlive, type OwnerGuard } from './ownership.ts';

export const agentFile = () => process.env.OMNEME_AGENT_FILE ?? join(homedir(), '.omneme', 'agent.json');

// ---- OMN-022 worker wake ----
export const WAKE_PROJECT = 'Omneme Tasks';
export const WAKE_SOURCE = 'chatgpt';
export const WAKE_STATUS = /^TASK OMN-\d+ \| APPROVAL: APPROVED$/;
export const WORKER_TASK = 'Omneme Task Worker';
/** OMN-045: opt-in flag for the developer worker wake; anything other than exactly "1" leaves it off. */
export const WAKE_ENV = 'OMNEME_WORKER_WAKE';
export const wakeEnabled = (env: Record<string, string | undefined> = process.env): boolean => env[WAKE_ENV] === '1';
/** Fixed executable and arguments; never derived from handoff data. */
export const wakeCommand = (): { file: string; args: string[] } =>
  ({ file: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe'), args: ['/Run', '/TN', WORKER_TASK] });

/** True only for a successful save_memory of a new approved task by ChatGPT to the Omneme Tasks project. */
export function shouldWake(name: string, args: any, result: ToolResult): boolean {
  if (name !== 'save_memory' || result.isError) return false;
  return typeof args?.project === 'string' && args.project.trim() === WAKE_PROJECT
    && args?.source === WAKE_SOURCE // exact: the stored source is not trimmed
    && typeof args?.status === 'string' && WAKE_STATUS.test(args.status);
}

type SpawnLike = (file: string, args: string[], opts: object) => { on(ev: string, fn: (...a: any[]) => void): unknown; unref?(): void };
export interface WakeDeps { spawn?: SpawnLike; platform?: string; say: (s: string) => void; env?: Record<string, string | undefined> }

/** Returns a fire-and-forget wake function. Never throws; logs only content-free diagnostics. */
export function createWorkerWake(deps: WakeDeps): () => void {
  const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnLike); const platform = deps.platform ?? process.platform;
  if (!wakeEnabled(deps.env)) return () => {}; // default install: a save never contacts the scheduler
  let inFlight = false;
  return () => {
    if (platform !== 'win32') { deps.say('Worker wake skipped (not Windows); the ten-minute schedule still applies.'); return; }
    if (inFlight) return;
    inFlight = true; let done = false;
    const finish = (msg: string | null) => { if (done) return; done = true; inFlight = false; if (msg) deps.say(msg); };
    try {
      const { file, args } = wakeCommand();
      const child = spawn(file, args, { windowsHide: true, stdio: 'ignore', shell: false });
      child.on('error', (e: NodeJS.ErrnoException) => finish(`Worker wake failed (${e?.code ?? 'error'}); the ten-minute schedule still applies.`));
      child.on('exit', (code: number | null) => finish(code === 0 ? `${new Date().toLocaleTimeString()} Worker wake requested.` : `Worker wake failed (exit ${code}); the ten-minute schedule still applies.`));
      child.unref?.();
    } catch (e) { finish(`Worker wake failed (${(e as NodeJS.ErrnoException)?.code ?? 'error'}); the ten-minute schedule still applies.`); }
  };
}

/** Run one tool call, then (only after a successful approved-task save) request the wake. The wake cannot affect the result. */
export function handleCall(name: string, args: any, ix: MemoryIndex, store: { vault: Vault; records: MemoryRecord[] }, wake: () => void): ToolResult {
  const r = callTool(name, args, ix, store);
  try { if (shouldWake(name, args, r)) wake(); } catch { /* never let a wake affect the save */ }
  return r;
}

const AGENT_BUSY = 'Another Omneme agent is already running for this agent file. Close that window first; this one was not started and its vault is locked.';

/**
 * OMN-041: become the single publisher of agent file `f`, or throw. Ownership (src/ownership.ts) excludes guarded agents;
 * an existing record whose pid is alive (or cannot be checked) is treated as a live agent that predates the guard and is
 * never overwritten. A record of a dead pid is stale and may be replaced by the owner.
 */
export function claimAgentFile(f: string): OwnerGuard {
  mkdirSync(dirname(f), { recursive: true });
  const guard = acquireOwnership(f, AGENT_BUSY);
  try {
    if (existsSync(f)) {
      let rec: unknown;
      try { rec = JSON.parse(readFileSync(f, 'utf8')); }
      catch { throw new BusyError(`${AGENT_BUSY} (The agent file is unreadable; if no agent is running, delete ${f}.)`); }
      const pid = rec && typeof rec === 'object' ? (rec as { pid?: unknown }).pid : undefined;
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pidAlive(pid)) throw new BusyError(AGENT_BUSY);
    }
    return guard;
  } catch (e) { guard.release(); throw e; }
}

export async function runAgent(vault: Vault, say: (s: string) => void, opts: { wake?: () => void } = {}) {
  const f = agentFile();
  let guard: OwnerGuard;
  try { guard = claimAgentFile(f); } catch (e) { vault.lock(); throw e; } // before listen/publish
  let messages: number;
  try { messages = await startAgent(vault, say, f, opts); }
  catch (e) { vault.lock(); guard.release(); throw e; } // startAgent closed its own listener
  const owner = guard;
  // Only the owner removes the record, and only if it is still its own.
  const cleanup = () => { try { if (JSON.parse(readFileSync(f, 'utf8')).pid === process.pid) rmSync(f); } catch { /* gone */ } };
  process.on('exit', () => { cleanup(); vault.lock(); owner.release(); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => process.exit(0));
  say(`Omneme is UNLOCKED for Claude (${messages} messages). Keep this window open; close it to lock.`);
  await new Promise(() => {});
}

/** Index the vault, listen on 127.0.0.1 and publish the discovery record. On failure closes the listener and throws. */
async function startAgent(vault: Vault, say: (s: string) => void, f: string, opts: { wake?: () => void }): Promise<number> {
  const records: MemoryRecord[] = vault.loadAll(); const ix = new MemoryIndex(records); const store = { vault, records };
  const wake = opts.wake ?? createWorkerWake({ say });
  if (!opts.wake && wakeEnabled()) say(`Developer worker wake is ON (${WAKE_ENV}=1): approved Omneme Tasks saves request the "${WORKER_TASK}" scheduled task.`);
  const token = randomBytes(32).toString('hex'); const tok = Buffer.from(token);
  const srv = createServer((req, res) => {
    const auth = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (req.method !== 'POST' || req.url !== '/call' || auth.length !== tok.length || !timingSafeEqual(auth, tok)) { res.writeHead(403).end(); return; }
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let r: ToolResult; try { const j = JSON.parse(body); r = handleCall(j.name, j.arguments, ix, store, wake); say(`${new Date().toLocaleTimeString()} ${j.name}${r.isError ? ' (error)' : ''}`); }
      catch { r = { text: 'bad request', isError: true }; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r));
    });
  });
  try {
    await new Promise<void>((ok, fail) => { srv.once('error', fail); srv.listen(0, '127.0.0.1', () => { srv.off('error', fail); ok(); }); });
    const port = (srv.address() as any).port;
    writeFileSync(f, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
  } catch (e) { try { srv.close(); } catch { /* not listening */ } throw e; }
  return ix.stats().messages;
}

// OMN-039: source-compatible instructions (the old "Omneme Unlock" shortcut is not part of the source candidate).
const START_AGENT = 'Ask the user to start the Omneme agent: in a terminal opened in the Omneme source folder (the one containing package.json), run node bin/omneme.mjs agent --vault "YOUR-VAULT-FILE" with YOUR-VAULT-FILE replaced by the intended vault path, enter the vault password only in that terminal and leave it open. Then try again.';

/** Forward a tool call to the running agent (used by `omneme mcp` when no password is supplied). */
export async function callAgent(name: string, args: any): Promise<ToolResult> {
  const f = agentFile();
  if (!existsSync(f)) return { text: `Omneme is locked. ${START_AGENT}`, isError: true };
  const { port, token } = JSON.parse(readFileSync(f, 'utf8'));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/call`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json() as ToolResult;
  } catch (e) { return { text: `Omneme is locked or not reachable (${(e as Error).message}). ${START_AGENT}`, isError: true }; }
}
