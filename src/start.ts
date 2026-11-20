// First-run launcher: starts the local web UI in onboarding mode on 127.0.0.1 and opens the browser.
// Passwords are typed only into the browser form; nothing secret is accepted on the command line,
// written to files or logged. The vault is chosen by the shared rule in selectVault (OMN-033), the same
// rule the CLI uses for `agent` (Omneme Unlock) and `backup-run` (Omneme Backup).
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { startWeb } from './web.ts';

export const LIVE_DEFAULT_VAULT = (home = homedir()) => join(home, '.omneme', 'vault.omneme');
/** Legacy first-run-only vault created by earlier versions of Omneme Start. Never created by this version unless chosen with --vault. */
export const DISPOSABLE_VAULT = (home = homedir()) => join(home, '.omneme', 'first-run', 'vault.omneme');

const HELP = `Omneme Start — local web UI (127.0.0.1 only)

Usage: omneme-start [--vault <path>] [--port <n>] [--no-open]

  --vault <path>  Vault to create or unlock. Without it: $OMNEME_VAULT if set; otherwise the main vault
                  (${LIVE_DEFAULT_VAULT()}), or the earlier first-run vault if it is the only one.
                  If both exist you are asked to choose (or must pass --vault when not run interactively).
  --port <n>      Local port (default: a free port chosen automatically)
  --no-open       Do not open the browser

Passwords are entered in the browser only. Close this window or press Ctrl-C to stop and lock.`;

// ---- OMN-033: one vault-selection rule for Omneme Start, `omneme agent` and `omneme backup-run` ----
export type VaultSource = 'option' | 'env' | 'main' | 'first-run' | 'new-main';
export interface VaultSelection {
  /** Chosen vault; undefined only when both standard vaults exist and a deliberate choice is required. */
  vaultPath?: string;
  source?: VaultSource;
  /** Set when both the main and the legacy first-run vault exist: [main, first-run]. */
  candidates?: [string, string];
}
export interface VaultSelectEnv { home?: string; exists?: (p: string) => boolean }

/**
 * Precedence: explicit --vault, then a non-empty OMNEME_VAULT, then the standard locations:
 * neither exists → the main vault (canonical); exactly one exists → that one (including a legacy first-run-only
 * vault); both exist → no choice is made here (caller must ask, or fail with --vault instructions).
 * Synchronous and read-only: it never creates, copies, migrates or overwrites a vault.
 */
export function selectVault(explicit: string | undefined, env: Record<string, string | undefined>, deps: VaultSelectEnv = {}): VaultSelection {
  if (explicit) return { vaultPath: resolve(explicit), source: 'option' };
  if (env.OMNEME_VAULT) return { vaultPath: resolve(env.OMNEME_VAULT), source: 'env' };
  const exists = deps.exists ?? existsSync;
  const main = resolve(LIVE_DEFAULT_VAULT(deps.home)), firstRun = resolve(DISPOSABLE_VAULT(deps.home));
  const hasMain = exists(main), hasFirst = exists(firstRun);
  if (hasMain && hasFirst) return { candidates: [main, firstRun] };
  if (hasFirst) return { vaultPath: firstRun, source: 'first-run' };
  return { vaultPath: main, source: hasMain ? 'main' : 'new-main' };
}

/** Message for unattended use when both vaults exist. Names both paths so the user can pass one explicitly. */
export function ambiguousVaultMessage(candidates: [string, string], how: string): string {
  return `Two Omneme vaults exist and none was chosen:\n  main vault:      ${candidates[0]}\n  first-run vault: ${candidates[1]}\n`
    + `Nothing was opened or changed. Choose one explicitly, for example:\n  ${how} --vault "${candidates[0]}"\n`
    + 'or set OMNEME_VAULT to the vault file you want.';
}

/**
 * Resolve a selection to one path. Both-exist case: only an interactive terminal may choose, by typing 1 or 2;
 * anything else (or no terminal) fails with --vault instructions. `ask` is injectable for tests.
 */
export async function resolveVaultSelection(sel: VaultSelection, how: string, io: { interactive: boolean; ask: (q: string) => Promise<string> }): Promise<string> {
  if (sel.vaultPath) return sel.vaultPath;
  const c = sel.candidates!;
  if (!io.interactive) throw new Error(ambiguousVaultMessage(c, how));
  const answer = (await io.ask(`Two Omneme vaults exist:\n  1) main vault:      ${c[0]}\n  2) first-run vault: ${c[1]}\nType 1 or 2 and press Enter to choose which vault to open: `)).trim();
  if (answer === '1') return c[0];
  if (answer === '2') return c[1];
  throw new Error(ambiguousVaultMessage(c, how));
}

/** Plain (visible) terminal question; used only for the vault choice, never for secrets. */
export function askLine(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => { rl.question(q, (a) => { res(a); rl.close(); }); rl.once('close', () => res('')); });
}

export const terminalIsInteractive = () => !!process.stdin.isTTY && !!process.stderr.isTTY;

export interface StartOptions { vaultPath: string; vaultSource?: VaultSource; vaultCandidates?: [string, string]; port: number; open: boolean; help: boolean; kdfN?: number }

/**
 * Parse launcher arguments. Unknown options (e.g. --password) are rejected by strict parsing.
 * When both standard vaults exist, vaultPath is '' and vaultCandidates is set; main() then asks or fails.
 */
export function startOptions(argv: string[], env: Record<string, string | undefined> = process.env, deps: VaultSelectEnv = {}): StartOptions {
  const { values: o } = parseArgs({
    args: argv, strict: true, allowPositionals: false,
    options: { vault: { type: 'string' }, port: { type: 'string' }, 'no-open': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  const port = o.port ? Number(o.port) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a number between 0 and 65535');
  // Weak KDF parameters only in explicit test mode (same rule as the CLI).
  const kdfN = env.OMNEME_TEST_MODE === '1' && env.OMNEME_KDF_N ? Number(env.OMNEME_KDF_N) : undefined;
  const sel = selectVault(o.vault, env, deps);
  return { vaultPath: sel.vaultPath ?? '', vaultSource: sel.source, vaultCandidates: sel.candidates, port, open: !o['no-open'], help: !!o.help, kdfN };
}

function openBrowser(url: string) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const p = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' });
    p.on('error', () => console.log('Could not open a browser automatically. Open the address above yourself.'));
    p.unref();
  } catch { console.log('Could not open a browser automatically. Open the address above yourself.'); }
}

export async function main(argv: string[]): Promise<number> {
  const o = startOptions(argv);
  if (o.help) { console.log(HELP); return 0; }
  const vaultPath = o.vaultPath || await resolveVaultSelection({ candidates: o.vaultCandidates }, `node "${process.argv[1] ?? 'bin/omneme-start.mjs'}"`, { interactive: terminalIsInteractive(), ask: askLine });
  const web = await startWeb({ vaultPath, port: o.port, onboarding: { kdfN: o.kdfN } });
  console.log(`Omneme is running at ${web.url}  (this computer only)`);
  console.log(`Vault file: ${vaultPath}`);
  console.log('Keep this window open while you use Omneme. Close it or press Ctrl-C to stop and lock the vault.');
  if (o.open) openBrowser(web.url);
  await new Promise<void>((r) => { process.once('SIGINT', () => r()); process.once('SIGTERM', () => r()); if (process.platform === 'win32') process.once('SIGBREAK', () => r()); });
  await web.close();
  return 0;
}
