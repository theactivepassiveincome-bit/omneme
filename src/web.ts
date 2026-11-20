// Minimal local web UI. Binds to 127.0.0.1 only; vault keys live in this process's memory
// only while unlocked. All imported content is treated as untrusted and HTML-escaped; a strict
// CSP forbids scripts entirely.
// Optional first-run (onboarding) mode adds: create a vault when none exists at the path, import one
// export by local path, and rebuild the index. Without `onboarding` the UI behaves exactly as before.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault } from './vault.ts';
import { MemoryIndex, convKey } from './search.ts';
import { importExport } from './importers/index.ts';
import type { Provider } from './schema.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const MAIN_VAULT = resolvePath(join(homedir(), '.omneme', 'vault.omneme'));
const FIRST_RUN_VAULT = resolvePath(join(homedir(), '.omneme', 'first-run', 'vault.omneme'));
const OMNEME_BIN = fileURLToPath(new URL('../bin/omneme.mjs', import.meta.url));

// OMN-032: rendered pages and AI prompts never contain absolute home, install or vault paths (or the user name).
// Commands are derived from the run location instead: an installed copy keeps the CLI at app\omneme\bin\omneme.mjs
// next to the .cmd launchers (see "Omneme Start.cmd"); a source checkout keeps it at bin\omneme.mjs.
const INSTALLED = /[\\/]app[\\/]omneme[\\/]bin[\\/]omneme\.mjs$/i.test(OMNEME_BIN);
const CLI = INSTALLED ? 'app\\omneme\\bin\\omneme.mjs' : 'bin\\omneme.mjs';
const FOLDER = INSTALLED
  ? 'the Omneme folder (the one that contains <code>Omneme Start.cmd</code>)'
  : 'the Omneme source folder (the one that contains <code>package.json</code>)';
// OMN-038: client configs start `node` from PATH (as windows/Omneme Start.cmd does); no install path is hardcoded.
const NODE_CMD = 'node';
const NODE_TIP = `<p class="meta" id="node-path-tip">This setting starts <code>${NODE_CMD}</code> from your PATH (Node.js 22.18 or newer). If your AI client reports that it cannot find <code>node</code>, run <code>where node</code> in Command Prompt and replace <code>${NODE_CMD}</code> with the full path it prints (in JSON, double each backslash).</p>`;
const VAULT_PLACEHOLDER = 'YOUR-VAULT-FILE', FOLDER_PLACEHOLDER = 'OMNEME-FOLDER', BACKUP_PLACEHOLDER = 'BACKUP-FILE';
type VaultKind = 'main' | 'first-run' | 'custom';
const vaultKind = (p: string): VaultKind => { const f = resolvePath(p); return f === MAIN_VAULT ? 'main' : f === FIRST_RUN_VAULT ? 'first-run' : 'custom'; };
// CMD expands %USERPROFILE% at run time, so the known default locations need no personal path; anything else is a placeholder.
const VAULT_ARG: Record<VaultKind, string> = { main: '%USERPROFILE%\\.omneme\\vault.omneme', 'first-run': '%USERPROFILE%\\.omneme\\first-run\\vault.omneme', custom: VAULT_PLACEHOLDER };
const VAULT_LABEL: Record<VaultKind, string> = { main: 'your main Omneme vault', 'first-run': 'a separate first-run vault (your main vault is not touched)', custom: 'a vault at a custom location' };
const vaultLineFor = (k: VaultKind) => `<p class="meta" id="vault-line">Your vault: ${VAULT_LABEL[k]}. Its exact file location is shown in the <code>Omneme Start</code> window.</p>`;
const RUN_TIP = `<p class="meta">Run commands in <strong>Command Prompt</strong> opened in ${FOLDER}: in File Explorer, open that folder, type <code>cmd</code> in the address bar and press Enter.</p>`;
const VAULT_TIP = `<p class="meta">Replace <code>${VAULT_PLACEHOLDER}</code> with your vault's full file path, shown as <strong>Vault file</strong> in the <code>Omneme Start</code> window. Keep the quotes.</p>`;
// OMN-034/038: secondary post-import step using the existing CLI backup commands (no web backup endpoint, no launchers).
const backupNext = (k: VaultKind) => `<section class="card" id="backup-next"><h2>Also: keep a second copy of your vault</h2>
<p>No backup of this import has been made yet. Omneme does not back up automatically.</p>
<p>Lock this browser session and close any running Unlock agent first (only one process may hold the vault open). Then, in <strong>Command Prompt</strong> opened in ${FOLDER}, write an encrypted backup of this vault and read it back to verify it:</p>
<pre class="cmd" id="backup-cmd">node --no-warnings ${CLI} backup "${BACKUP_PLACEHOLDER}" --vault "${esc(VAULT_ARG[k])}"
node --no-warnings ${CLI} verify-backup "${BACKUP_PLACEHOLDER}"</pre>
<p class="meta">Replace <code>${BACKUP_PLACEHOLDER}</code> (both times) with the full path of a new file on another drive, for example a USB drive. Keep the quotes. Each command asks for your vault password in that window.${k === 'custom' ? ` Replace <code>${VAULT_PLACEHOLDER}</code> with your vault's full file path, shown as <strong>Vault file</strong> in the <code>Omneme Start</code> window.` : ''} Repeated backups to configured destinations: see <code>backup-setup</code>, <code>backup-preview</code> and <code>backup-run</code> in <code>node --no-warnings ${CLI} --help</code>.</p></section>`;
const FOLDER_TIP = `<p class="meta" id="folder-placeholder">Replace <code>${FOLDER_PLACEHOLDER}</code> with the full path of ${FOLDER}. To find it, open Command Prompt there and run <code>cd</code>. In JSON every backslash must be doubled (for example <code>C:\\\\Users\\\\NAME\\\\omneme\\\\${CLI.replace(/\\/g, '\\\\')}</code>) or written as a forward slash (<code>C:/Users/NAME/omneme/${CLI.replace(/\\/g, '/')}</code>). In the TOML example the path stays inside single quotes, where single backslashes are correct.</p>`;

const CSS = `.brand{display:inline-flex;align-items:center;gap:.65rem}.brand svg{flex:none}
:root{--fg:#1d1d1f;--muted:#5f6368;--bg:#f6f7f9;--card:#fff;--line:#dadce0;--accent:#0b57d0;--on-accent:#fff;--soft:#e8f0fe;--warn:#fff4e5;--warn-line:#e8a33d;--code:#f1f3f4;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--fg:#e8eaed;--muted:#a0a6ad;--bg:#16181b;--card:#202124;--line:#3c4043;--accent:#8ab4f8;--on-accent:#0b1a33;--soft:#1f2a3d;--warn:#3a2f1c;--warn-line:#a8792a;--code:#2a2b2e}}
*{box-sizing:border-box}body{font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;background:var(--bg);color:var(--fg)}
header.top{display:flex;flex-wrap:wrap;gap:8px 16px;justify-content:space-between;align-items:center;max-width:880px;margin:0 auto;padding:12px 16px}
.brand{font-size:20px;font-weight:700;color:var(--fg);text-decoration:none}main{max-width:880px;margin:0 auto;padding:0 16px 48px}
h1{font-size:26px;line-height:1.25;margin:12px 0 4px}h2{font-size:19px;line-height:1.3;margin:0 0 8px}h3{font-size:16px;margin:12px 0 6px}a{color:var(--accent)}
.lead{font-size:17px;color:var(--muted);margin:0 0 12px}.meta{color:var(--muted);font-size:13px}.label{font-weight:600;margin:0 0 6px}
.card,.box{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin:16px 0}
input,select,button{font:inherit;color:inherit}input,select{padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);max-width:100%}
button,.btn,.primary{display:inline-block;padding:8px 16px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);font-weight:600;cursor:pointer;text-decoration:none}
button.go,.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
code,pre{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace}code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:.92em}
pre{white-space:pre-wrap;word-break:break-word;margin:6px 0}pre code{background:none;padding:0}
pre.cmd{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-size:14px}
.key{font:15px/1.5 ui-monospace,Consolas,monospace;background:var(--warn);border:1px solid var(--warn-line);border-radius:8px;padding:10px 12px;word-break:break-word}
.note{background:var(--soft);border-radius:8px;padding:10px 14px}.warn{background:var(--warn);border-left:4px solid var(--warn-line);border-radius:8px;padding:10px 14px}
.steps{list-style:none;counter-reset:s;padding:0;margin:8px 0 0}.steps>li{counter-increment:s;position:relative;padding:0 0 18px 44px}
.steps>li::before{content:counter(s);position:absolute;left:0;top:0;width:30px;height:30px;border-radius:50%;background:var(--accent);color:var(--on-accent);display:grid;place-items:center;font-weight:700;font-size:14px}
.stepper ol{display:flex;flex-wrap:wrap;gap:6px 20px;list-style:none;padding:0;margin:4px 0 0;font-size:14px;color:var(--muted)}
.stepper .n{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;border:1px solid var(--line);font-size:12px;margin-right:4px}
.stepper [aria-current]{color:var(--fg);font-weight:700}.stepper [aria-current] .n{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.seg{display:flex;flex-wrap:wrap;gap:6px}.seg a,.seg strong{display:inline-block;padding:6px 14px;border:1px solid var(--line);border-radius:999px;text-decoration:none;font-size:14px;background:var(--card)}
.seg strong{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
details{border:1px solid var(--line);border-radius:8px;padding:8px 14px;margin:12px 0;background:var(--card)}summary{cursor:pointer;font-weight:600}details[open]>summary{margin-bottom:8px}
.actions,.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:10px 0}.grow{flex:1 1 260px}.stack{display:grid;gap:6px;max-width:420px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.m{border-left:3px solid var(--line);padding:6px 12px;margin:10px 0}.user{border-color:var(--accent)}.assistant{border-color:#1e8e3e}.hit{padding:8px 0;border-bottom:1px solid var(--line)}
@media (max-width:560px){h1{font-size:22px}.card,.box{padding:14px}.steps>li{padding-left:38px}}`;

const STEPS = [['Your vault', ''], ['Import history', '/#import'], ['Connect your AI', '/connect']] as const;
function stepper(active: number, unlocked: boolean): string {
  return `<nav class="stepper" aria-label="Setup progress"><ol>${STEPS.map(([label, href], i) => {
    const n = i + 1, inner = `<span class="n">${n}</span>${label}`;
    return `<li${n === active ? ' aria-current="step"' : ''}>${unlocked && href && n !== active ? `<a href="${href}">${inner}</a>` : inner}</li>`;
  }).join('')}</ol></nav>`;
}

// OMN-031: one client is shown at a time; Claude Code is the verified default.
const CLIENTS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'chatgpt-work', label: 'ChatGPT Work (partly verified)' },
  { id: 'antigravity', label: 'Antigravity (partly verified)' },
] as const;
type ClientId = (typeof CLIENTS)[number]['id'];
const DEFAULT_CLIENT: ClientId = 'claude-code';
/** Returns the client id, the default when absent/empty, or null for an unknown value. */
function parseClient(raw: string | null): ClientId | null {
  const v = (raw ?? '').trim();
  if (!v) return DEFAULT_CLIENT;
  return CLIENTS.find((c) => c.id === v)?.id ?? null;
}

function connectSection(vaultPath: string, stats: { conversations: number; messages: number; imports: number }, rawProject: string, client: ClientId = DEFAULT_CLIENT, invalidClient = false): string {
  // vaultPath is used only to classify the vault; it is never rendered (OMN-032).
  const kind = vaultKind(vaultPath), isMain = kind === 'main';
  const project = rawProject.trim() || 'Omneme';
  const vaultArg = esc(VAULT_ARG[kind]);
  const vaultTip = kind === 'custom' ? VAULT_TIP : '';
  const agyCfg = JSON.stringify({ mcpServers: { 'omneme-pilot': { command: NODE_CMD, args: ['--no-warnings', `${FOLDER_PLACEHOLDER}\\${CLI}`, 'mcp'] } } }, null, 2);
  const agentCmd = `node --no-warnings ${CLI} agent --vault "${vaultArg}"`;
  const projQ = rawProject.trim() ? '&amp;project=' + esc(encodeURIComponent(rawProject.trim())) : '';
  const chooser = `<nav id="client-choice" aria-label="AI client"><p class="label">Choose your AI client</p><div class="seg">${CLIENTS.map((c) => c.id === client && !invalidClient
    ? `<strong aria-current="page">${c.label}${c.id === DEFAULT_CLIENT ? ' (verified default)' : ''}</strong>`
    : `<a href="/connect?client=${c.id}${projQ}">${c.label}${c.id === DEFAULT_CLIENT ? ' (verified default)' : ''}</a>`).join('')}</div></nav>
${invalidClient ? `<p id="client-error" class="warn" role="alert"><strong>Unknown AI client.</strong> Choose Claude Code, ChatGPT Work or Antigravity above. Showing Claude Code (the verified default).</p>` : ''}`;
  const intro = `<h1>Connect your AI</h1>
<p class="lead">Let an AI assistant on this computer search your vault and save handoffs to it. Your vault holds ${stats.conversations} conversations · ${stats.messages} messages · ${stats.imports} imports.</p>
${vaultLineFor(kind)}`; // OMN-034: the selected vault's label only, never its path
  const lockStep = `<strong>Lock this browser session.</strong> Click <strong>Lock vault</strong> at the top of this page (or close the <code>Omneme Start</code> window). Single vault ownership: only one process may hold the vault open at a time.`;
  // OMN-038: the Unlock agent is the CLI `agent` command; --vault always names this vault (it wins over OMNEME_VAULT
  // and the main/first-run choice), so no launcher or interactive choice is involved.
  const unlockStep = `<strong>Start the Unlock agent for your vault.</strong> Close any other running Unlock agent window first (only one can run at a time). In Command Prompt opened in ${FOLDER}, run:
<pre class="cmd" id="agent-cmd">${agentCmd}</pre>${vaultTip}
<p>The window shows the selected <strong>Vault file</strong>; check it, then enter your password there and leave the window open while your AI uses Omneme. Enter your password only in that Unlock window; never paste your password or recovery key into chat, command flags or config files.</p>`;
  const geminiNote = `<p class="meta"><strong>Gemini history import vs. connecting an AI client:</strong> Importing a Google Takeout Gemini Apps activity file or a CodingCat Gemini capture stores past Gemini activity in your vault for search. Gemini is import-only: it has no confirmed live MCP connection in Omneme.</p>`;
  const nextLinks = `<nav class="actions" aria-label="Next steps"><a href="/">Search your conversations</a> <a href="/#import">Import another platform</a></nav>`;
  const unverifiedOther = `<p class="warn" id="separate-vault-unverified"><strong>Unverified:</strong> using this client with a separate (non-main) vault started with <code>agent --vault</code> has not been tested for this client. Before relying on it, confirm with the known-record check above.</p>`;
  const claudeCode = `<section class="card" aria-labelledby="setup-h"><h2 id="setup-h">Set up Claude Code</h2>${RUN_TIP}
<ol class="steps" id="claude-code-steps">
<li><strong>Pick a known record now.</strong> While this page is unlocked, <a href="/">search your conversations</a> and note one conversation <em>title</em>, its <em>provider</em>, and a distinctive, non-sensitive search phrase from a record unique to this vault.</li>
<li>${lockStep}</li>
<li>${unlockStep}</li>
<li><strong>Register Omneme in Claude Code once</strong> (skip if already done). Claude Code must already be installed. In a second Command Prompt opened in ${FOLDER} (<code>%CD%</code> expands to that folder), run:<pre class="cmd" id="claude-mcp-add">claude mcp add omneme --scope user -- ${NODE_CMD} --no-warnings "%CD%\\${CLI}" mcp</pre>Check the registration with <code>claude mcp get omneme</code>.${NODE_TIP}</li>
<li><strong>Run the read-only check.</strong> Start a new Claude Code session and paste, replacing the phrase with the one you noted:<pre class="key" id="known-record-check">Use the Omneme search_memory tool to search for "PHRASE YOU NOTED". Do not save anything. List only the conversation titles and providers returned; do not quote message text.</pre></li>
<li id="claude-code-success"><strong>Connected only on a match:</strong> Claude Code is connected to your vault only when the result includes the exact title and provider you noted in step 1.</li>
</ol>
<p id="claude-code-no-match" class="note"><strong>No match is not confirmation:</strong> an empty result or results without your noted title do not confirm the connection (and do not by themselves prove a wrong vault). Try another phrase from step 1, and if the results show records only from a different vault, close that Unlock window and start the agent above again.</p></section>`;
  // OMN-034: ChatGPT Work and Antigravity also pick a non-sensitive known record before locking, and verify read-only.
  const pickStep = `<strong>Pick a known record now.</strong> While this page is unlocked, <a href="/">search your conversations</a> and note one conversation <em>title</em>, its <em>provider</em>, and a distinctive, non-sensitive search phrase from a record unique to this vault. Choose a record without private details: you will ask the AI to find it.`;
  const verifyList = `<strong>Check that your AI sees your vault (read-only).</strong> In a new chat with the connected AI, paste, replacing the phrase with the one you noted in step 1:
<pre class="key" id="client-known-record-check">Use the Omneme search_memory tool to search for "PHRASE YOU NOTED". Do not save anything. List only the conversation titles and providers returned; do not quote message text.</pre>
<p class="meta" id="client-check-read-only">This check only reads. Do not ask the AI to save a handoff until the check has matched.</p>
<h3>How to tell your connected AI sees your vault</h3>
<ul>

<li><strong>Positive evidence (vault-specific record):</strong> The AI sees this vault only when it returns the known record you noted in step 1 with the matching title and provider. The resume prompt below for project <code>${esc(project)}</code> is optional and also only reads.</li>
<li><strong>Empty result is inconclusive:</strong> "No results" or "no saved handoff" does not prove a wrong vault (the phrase or project may simply not be there). Retry with a record you confirmed. If the AI returns records that exist only in a different vault, close that Unlock agent, lock this browser session, and start the Unlock agent command above again.</li>
</ul>`;
  const chatgptWork = `<strong>Add Omneme to ChatGPT Work.</strong> Add the MCP forwarder to <code>%USERPROFILE%\\.codex\\config.toml</code> (no credentials in config):
<pre class="cmd">[mcp_servers.omneme]
command = '${NODE_CMD}'
args = ["--no-warnings", '${FOLDER_PLACEHOLDER}\\${CLI}', "mcp"]</pre>${FOLDER_TIP}${NODE_TIP}
<p class="warn" id="chatgpt-work-restart"><strong>Windows desktop app:</strong> after adding or changing a connector, fully quit the ChatGPT app and reopen it. Closing the window alone may leave the old connector settings in use.</p>`;
  // OMN-034: the verified scope is shown in the setup card, not only under Advanced details.
  const chatgptScope = `<p class="warn" id="chatgpt-work-scope"><strong>Verified so far:</strong> only a dedicated desktop test connector in the ChatGPT Windows desktop app (Work mode) passed. This standard setup and ChatGPT Work in a browser are <strong>unverified</strong>; rely on the read-only known-record check below.</p>`;
  const chatgptDetails = `<p class="meta">Tools offered: <code>resume_memory</code>, <code>save_memory</code>, <code>search_memory</code>, and <code>get_conversation</code> through the running Unlock agent.</p>
<p class="meta" id="chatgpt-work-evidence">Verification so far: the ChatGPT Windows desktop app in Work mode retrieved a record through a dedicated test connector. This standard setup and browser ChatGPT have not been verified.</p>
<p class="meta">Manual clipboard fallback (when MCP is unavailable, e.g. browser ChatGPT): lock this browser session and close any Unlock agent for your vault, then run in ${FOLDER}:</p>
<pre class="cmd">node --no-warnings ${CLI} handoff-latest "${esc(project)}" --vault "${vaultArg}" --copy</pre>${vaultTip}
<p class="meta" id="handoff-save-cmd">To save a handoff the same way, write it as a JSON file (<code>project</code>, <code>status</code>, <code>next</code>, optional <code>decisions</code>, <code>completed</code>, <code>outstanding</code>) and run <code>node --no-warnings ${CLI} handoff-save --file "HANDOFF-FILE.json" --vault "${vaultArg}"</code>. Without <code>--vault</code>, <code>handoff-latest</code> and <code>handoff-save</code> use your main vault (or <code>OMNEME_VAULT</code> if set).</p>`;
  const antigravity = `<strong>Add Omneme to Antigravity.</strong> Configure the workspace plugin in <code>.agents\\mcp_config.json</code> and <code>.agents\\plugins\\omneme-pilot\\mcp_config.json</code> (with <code>.agents\\plugins\\omneme-pilot\\plugin.json</code> set to <code>{"name":"omneme-pilot"}</code>, no credentials stored):
<pre class="cmd">${esc(agyCfg)}</pre>${FOLDER_TIP}${NODE_TIP}
<p class="warn" id="antigravity-restart"><strong>Antigravity app:</strong> after adding or changing the workspace MCP configuration, fully quit Antigravity and reopen it so the updated server tools load.</p>`;
  const antigravityDetails = `<p class="meta">Confirmed capabilities: exposes <code>search_memory</code>, <code>get_conversation</code>, <code>save_memory</code>, and <code>resume_memory</code> via <code>omneme-pilot</code> forwarding to the running Unlock agent. Limitation: workspace-scoped config applies to the opened workspace folder and reads whichever single vault the active Unlock agent holds open.</p>`;
  const resumePrompt = `<section class="card" aria-labelledby="resume-h"><h2 id="resume-h">Copyable resume prompt</h2>
<p class="meta">Paste this into your connected AI to pick up a project from your vault.</p>
<form method="get" action="/connect" class="row"><input type="hidden" name="client" value="${esc(client)}"><label for="project">Project name</label><input id="project" name="project" value="${esc(project)}" placeholder="Omneme" size="28"><button>Update prompt</button></form>
<pre class="key" id="resume-prompt">Use the Omneme resume_memory tool for project "${esc(project)}" (or search_memory if no handoff is saved yet). Report the handoff status, savedAt timestamp, and matching conversation titles or counts so I can confirm you see my Omneme vault. Do not include passwords, recovery keys, or private message text.</pre></section>`;
  const vaultDetails = isMain ? '' : `<p class="meta" id="launcher-vaults">Commands and vaults: the commands on this page pass <code>--vault</code> for this vault. Without it, <code>agent</code>, <code>backup-preview</code> and <code>backup-run</code> choose the vault like <code>Omneme Start</code> (<code>OMNEME_VAULT</code> if set, otherwise the main vault, or the earlier first-run vault when it is the only one; if both exist they ask, and fail with <code>--vault</code> instructions when no one can answer), while <code>backup</code>, <code>handoff-latest</code> and <code>handoff-save</code> use your main vault (or <code>OMNEME_VAULT</code>). Only one Unlock agent (<code>%USERPROFILE%\\.omneme\\agent.json</code>) can run at a time.</p>`;
  if (client === 'claude-code') {
    return `<div id="connect-ai">${intro}
${chooser}
${claudeCode}
${resumePrompt}
<details id="advanced"><summary>Advanced details: capabilities, evidence and Gemini</summary><p><strong>Optional troubleshooting:</strong> Compare this vault's ${stats.messages} messages with the count in the Unlock window (<code>Omneme is UNLOCKED for Claude (${stats.messages} messages)</code>). A matching count alone cannot confirm which vault is open.</p>
<p class="meta">Capabilities: <code>search_memory</code>, <code>get_conversation</code>, <code>save_memory</code>, <code>resume_memory</code> (plus optional <code>SessionEnd</code> hook <code>scripts/session-capture-hook.ts</code>). <code>claude mcp get omneme</code> shows the registration.</p>
<p class="meta">${isMain
    ? 'Live-vault integration evidence: Claude Code was confirmed against the main vault through the Unlock agent.'
    : 'Claude Code retrieved a known record from a separate test vault. Run the check above to confirm this vault.'}</p>
${vaultDetails}
${geminiNote}
</details>
${nextLinks}</div>`;
  }
  return `<div id="connect-ai">${intro}
${chooser}
<section class="card" aria-labelledby="setup-h"><h2 id="setup-h">Set up ${client === 'chatgpt-work' ? 'ChatGPT Work' : 'Antigravity'}</h2>${RUN_TIP}
${client === 'chatgpt-work' ? chatgptScope : ''}
<ol class="steps" id="client-steps">
<li id="client-step-pick">${pickStep}</li>
<li id="client-step-lock">${lockStep}</li>
<li id="client-step-unlock">${unlockStep}</li>
<li id="client-step-configure">${client === 'chatgpt-work' ? chatgptWork : antigravity}</li>
<li id="client-step-verify">${verifyList}</li>
</ol>
${isMain ? '' : unverifiedOther}</section>
${resumePrompt}
<details id="advanced"><summary>Advanced details: capabilities, fallback, evidence and Gemini</summary><p><strong>Optional troubleshooting:</strong> Compare this vault's ${stats.messages} messages with the count in the Unlock window (<code>Omneme is UNLOCKED for Claude (${stats.messages} messages)</code>). A matching count alone cannot confirm which vault is open.</p>
${client === 'chatgpt-work' ? chatgptDetails : antigravityDetails}
<p class="meta">${client === 'chatgpt-work' ? 'Live-vault evidence for ChatGPT Work is limited to the desktop test-connector check above.' : isMain
    ? 'Live-vault integration evidence: this client connection was confirmed against the main vault through the Unlock agent.'
    : 'Live-vault integration evidence covers only the main vault. Switching the Unlock agent to a separate onboarding vault with <code>--vault</code> is not yet verified end to end; rely on the vault-specific record check above.'}</p>
${vaultDetails}
${geminiNote}
</details>
${nextLinks}</div>`;
}

function page(title: string, body: string, unlocked: boolean, step = 0): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Omneme</title><style>${CSS}</style></head><body>
<header class="top"><a class="brand" href="/"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false" width="32" height="32"><rect width="64" height="64" rx="12" fill="#2C2038" /><path transform="translate(9.2 3.5) scale(.19)" fill="#F7F3E9" fill-rule="evenodd" d="M120 14 C87 14 65 26 43 54 Q61 49 64 74 Q48 62 26 64 Q46 67 46 99 V213 Q46 237 26 240 Q47 242 64 229 Q62 254 43 250 C67 277 91 286 120 286 C149 286 173 277 197 250 Q178 254 176 229 Q193 242 214 240 Q194 237 194 213 V99 Q194 67 214 64 Q192 62 176 74 Q179 49 197 54 C175 26 153 14 120 14 Z M120 23 C96 23 81 48 81 78 C81 105 95 119 120 141 C145 119 159 105 159 78 C159 48 144 23 120 23 Z M67 103 L113 168 Q86 176 67 205 Z M173 103 L127 168 Q154 176 173 205 Z M120 177 C95 177 81 202 81 227 C81 255 96 277 120 277 C144 277 159 255 159 227 C159 202 145 177 120 177 Z" /></svg><span>Omneme</span></a>${unlocked ? '<form method="post" action="/lock"><button>Lock vault</button></form>' : ''}</header>
<main>${step ? stepper(step, unlocked) : ''}${body}</main></body></html>`;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let n = 0; const chunks: Buffer[] = [];
  for await (const c of req) { n += (c as Buffer).length; if (n > 64 * 1024) throw new Error('Body too large'); chunks.push(c as Buffer); }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export interface OnboardingOptions {
  /** scrypt N for newly created vaults; tests only (production uses the vault default). */
  kdfN?: number;
}
export interface WebOptions { vaultPath: string; port: number; idleMinutes?: number; maxSessionHours?: number; onboarding?: OnboardingOptions }

export function startWeb(opts: WebOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  let vault: Vault | null = null;
  let index: MemoryIndex | null = null;
  let session: string | null = null;
  let lastUse = Date.now(), sessionStart = 0;
  let failures = 0, blockedUntil = 0;
  let allowedHosts = new Set<string>();
  // Single-writer guard: create/import/reindex/unlock/lock never overlap, and the idle timer never locks mid-write.
  let busy = false;
  const onb = opts.onboarding;
  const lock = () => { vault?.lock(); vault = null; index = null; session = null; };
  const idleMs = (opts.idleMinutes ?? 15) * 60_000;
  const maxMs = (opts.maxSessionHours ?? 8) * 3_600_000;
  const timer = setInterval(() => { if (vault && !busy && (Date.now() - lastUse > idleMs || Date.now() - sessionStart > maxMs)) lock(); }, 30_000);
  timer.unref();

  const send = (res: ServerResponse, code: number, html: string, extra: Record<string, string> = {}) => {
    res.writeHead(code, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      // Chromium can send Origin: null on form POSTs under no-referrer.
      // Retain the origin for local forms while withholding referrers cross-origin.
      'referrer-policy': 'same-origin', 'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      ...extra,
    });
    res.end(html);
  };
  const startSession = (v: Vault, ix: MemoryIndex) => {
    lock(); // replace any existing session only after a successful unlock/create
    vault = v; index = ix; failures = 0;
    session = randomBytes(32).toString('hex'); lastUse = sessionStart = Date.now();
    return `omneme_s=${session}; HttpOnly; SameSite=Strict; Path=/`;
  };
  const busyPage = (res: ServerResponse, authed: boolean) => send(res, 409, page('Busy', '<p>Another operation is still running. Wait for it to finish, then try again.</p><p><a href="/">Back</a></p>', authed));
  // OMN-032: pages say "Your vault"; the file path is shown only in the local Omneme Start window.
  const vaultLine = () => vaultLineFor(vaultKind(opts.vaultPath));
  const step = (n: number) => (onb ? n : 0);
  const hidePath = (m: string) => m.split(resolvePath(opts.vaultPath)).join('your vault file').split(opts.vaultPath).join('your vault file');

  const server = createServer(async (req, res) => {
    try {
      // DNS-rebinding defence: only answer requests addressed to the loopback host names we bound.
      if (!allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) return send(res, 421, page('Refused', '<p>Unexpected Host header.</p>', false));
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const cookie = /(?:^|;\s*)omneme_s=([a-f0-9]{64})/.exec(req.headers.cookie ?? '')?.[1];
      const authed = !!vault && !!session && cookie === session;
      if (req.method === 'POST') {
        // CSRF defence (in addition to SameSite=Strict): browsers send Origin and Sec-Fetch-Site on POST.
        const origin = req.headers.origin, site = req.headers['sec-fetch-site'];
        if ((origin && !allowedHosts.has(origin.replace(/^http:\/\//, '').toLowerCase())) || (site && site !== 'same-origin' && site !== 'none'))
          return send(res, 403, page('Forbidden', '<p>Cross-origin request refused.</p>', false));
        if (url.pathname === '/unlock') {
          const f = await readForm(req);
          if (busy) return busyPage(res, authed);
          if (Date.now() < blockedUntil) return send(res, 429, page('Unlock', '<p>Too many failed attempts. Wait and try again.</p>', false));
          let next: Vault | null = null;
          busy = true;
          try {
            next = await Vault.unlock(opts.vaultPath, { password: f.get('password') ?? '' });
            const nextIndex = new MemoryIndex(next.loadAll());
            return send(res, 303, '', { location: '/', 'set-cookie': startSession(next, nextIndex) });
          } catch {
            next?.lock();
            failures++;
            if (failures >= 3) blockedUntil = Date.now() + Math.min(2 ** (failures - 3), 300) * 1000;
            return send(res, 401, page('Unlock', '<p>Unlock failed.</p><p><a href="/">Try again</a></p>', false));
          } finally { busy = false; }
        }
        if (onb && url.pathname === '/create') {
          const f = await readForm(req);
          if (busy) return busyPage(res, authed);
          // Never overwrite: refuse if anything already exists at the vault path (Vault.create also refuses).
          if (existsSync(opts.vaultPath)) return send(res, 409, page('Create vault', '<p>A vault already exists at this path. It was not changed. Unlock it instead.</p><p><a href="/">Back</a></p>', false));
          const pw = f.get('password') ?? '';
          if (pw !== (f.get('repeat') ?? '')) return send(res, 400, page('Create vault', '<p>Passwords do not match.</p><p><a href="/">Try again</a></p>', false));
          if (pw.length < 8) return send(res, 400, page('Create vault', '<p>Password must be at least 8 characters.</p><p><a href="/">Try again</a></p>', false));
          busy = true;
          try {
            const { vault: v, recoveryKey } = await Vault.create(opts.vaultPath, pw, { kdfN: onb.kdfN });
            const setCookie = startSession(v, new MemoryIndex(v.loadAll()));
            return send(res, 200, page('Vault created', `<h1>Vault created</h1>${vaultLine()}
<section class="card"><h2>Recovery key — shown once</h2><p>Write it down and keep it offline, separately from your password. If you lose both, nobody can recover this vault.</p>
<p class="key">${esc(recoveryKey)}</p><div class="actions"><a class="primary" href="/">I have written it down — continue</a></div></section>`, true, 1), { 'set-cookie': setCookie });
          } catch (e) {
            return send(res, 409, page('Create vault', `<p>Could not create the vault: ${esc(hidePath((e as Error).message))}</p><p><a href="/">Back</a></p>`, false));
          } finally { busy = false; }
        }
        if (onb && (url.pathname === '/import' || url.pathname === '/reindex')) {
          const f = await readForm(req);
          if (!authed || !vault) return send(res, 401, page('Locked', '<p>Unlock the vault first.</p><p><a href="/">Back</a></p>', false));
          if (busy) return busyPage(res, true);
          busy = true; lastUse = Date.now();
          const v: Vault = vault;
          try {
            if (url.pathname === '/reindex') {
              index = new MemoryIndex(v.loadAll());
              return send(res, 303, '', { location: '/' });
            }
            const raw = (f.get('path') ?? '').trim().replace(/^"(.*)"$/, '$1'); // Windows "Copy as path" adds quotes
            if (!raw || !isAbsolute(raw)) return send(res, 400, page('Import', '<p>Enter the full path to the export file or folder (for example <code>C:\\Users\\you\\Downloads\\export.zip</code>).</p><p><a href="/">Back</a></p>', true));
            const p = resolvePath(raw);
            if (p === resolvePath(opts.vaultPath)) return send(res, 400, page('Import', '<p>That is the vault file itself, not an export.</p><p><a href="/">Back</a></p>', true));
            if (!existsSync(p)) return send(res, 404, page('Import', '<p>No file or folder at that path.</p><p><a href="/">Back</a></p>', true));
            const r = await importExport(v, p, { provider: 'auto', json: { maxDepth: 512, maxElementBytes: 256 * 2 ** 20 } });
            index = new MemoryIndex(v.loadAll()); // rebuild the index so the new conversations are searchable
            const where = (e: { entry: string; index: number | null; offset?: number | null; conversationId?: string | null; reason: string }) =>
              `${esc(e.entry)}${e.index !== null ? ` #${e.index}` : ''}${e.offset != null ? ` @byte ${e.offset}` : ''}${e.conversationId ? ` conv ${esc(e.conversationId)}` : ''}: ${esc(e.reason)}`;
            const actions = r.complete
              ? `<section class="card" id="next-step"><h2>Next step: Connect your AI</h2><p>Your imported history is ready in your vault.</p><div class="actions"><a class="primary" href="/connect">Connect your AI</a> <a href="/">Search your conversations</a> <a href="/#import">Import another platform</a></div><p class="meta">Setup steps for each AI client are on the Connect your AI page. Afterwards, <a href="#backup-next">keep a second copy of your vault</a>.</p></section>${backupNext(vaultKind(opts.vaultPath))}`
              : `<nav class="actions" aria-label="Next steps"><a href="/">Search your conversations</a> <a href="/#import">Import another platform</a></nav>`;
            const body = `<h1>Import ${r.complete ? 'complete' : 'INCOMPLETE'}</h1>${vaultLine()}
<section class="card${r.complete ? '' : ' warn'}"><p class="meta">${esc(r.exportLabel)} · import ${esc(r.importId)}</p>
<p>${r.conversationsSeen} conversations seen (${r.conversationsNew} new, ${r.conversationsRevised} revised, ${r.conversationsUnchanged} unchanged) · ${r.messagesSeen} messages seen (${r.messagesInserted} new)</p>
${r.complete ? '' : '<p>Some parts could not be read. Everything readable was imported.</p>'}
${r.errors.slice(0, 50).map((e) => `<div class="meta">ERROR ${where(e)}</div>`).join('')}</section>
${actions}`;
            return send(res, r.complete ? 200 : 422, page('Import', body, true, 2));
          } catch (e) {
            return send(res, 422, page('Import', `<p>Import failed: ${esc((e as Error).message)}</p><p><a href="/">Back</a></p>`, true));
          } finally { busy = false; }
        }
        // Only an authenticated session may lock (prevents unauthenticated local lock-out of the user's session).
        if (url.pathname === '/lock') {
          if (authed && busy) return busyPage(res, true);
          if (authed) lock();
          return send(res, 303, '', { location: '/', 'set-cookie': 'omneme_s=; Max-Age=0; Path=/' });
        }
        return send(res, 404, page('Not found', '', authed));
      }
      if (url.pathname === '/connect' && !onb) return send(res, 404, page('Not found', '', authed));
      if (!authed || !index) {
        if (url.pathname === '/connect') return send(res, 401, page('Locked', '<p>Unlock the vault first.</p><p><a href="/">Back</a></p>', false));
        if (onb && !existsSync(opts.vaultPath)) {
          return send(res, 200, page('Create vault', `<h1>Welcome to Omneme</h1><p class="lead">Omneme keeps your AI conversations in an encrypted vault on this computer. No vault exists yet. Create one to start.</p>${vaultLine()}
<section class="card"><h2>Create your vault</h2><form method="post" action="/create" class="stack">
<label for="pw">New password <span class="meta">(at least 8 characters)</span></label><input id="pw" type="password" name="password" minlength="8" autocomplete="new-password" autofocus required>
<label for="pw2">Repeat password</label><input id="pw2" type="password" name="repeat" minlength="8" autocomplete="new-password" required>
<p class="meta">After you create the vault you get a one-time recovery key. If you forget this password, the recovery key lets you set a new one (<code>reset-password</code> on the command line); without the key, nobody can reset it.</p>
<div><button class="go">Create vault</button></div></form></section>`, false, 1));
        }
        return send(res, 200, page('Unlock', `<h1>Unlock your vault</h1><p class="lead">Your vault is locked.</p>${onb ? vaultLine() : ''}<section class="card"><form method="post" action="/unlock" class="row">
<label class="sr" for="pw">Vault password</label><input id="pw" class="grow" type="password" name="password" placeholder="Vault password" autocomplete="current-password" autofocus required><button class="go">Unlock</button></form></section>`, false, step(1)));
      }
      lastUse = Date.now();
      const ix: MemoryIndex = index;
      if (onb && url.pathname === '/connect') {
        const client = parseClient(url.searchParams.get('client'));
        return send(res, client ? 200 : 400, page('Connect your AI', connectSection(opts.vaultPath, ix.stats(), url.searchParams.get('project') ?? '', client ?? DEFAULT_CLIENT, !client), true, 3));
      }
      if (url.pathname === '/conversation') {
        const v = ix.conversation(url.searchParams.get('id') ?? '');
        if (!v) return send(res, 404, page('Not found', '<p>Conversation not found.</p>', true));
        const c = v.conversation;
        const body = `<h3>${esc(c?.title ?? '(untitled)')}</h3><p class="meta">${esc(c?.provider)} · ${esc(c?.conversationId)} · created ${esc(c?.createdAt ?? 'unknown')}</p>` +
          v.messages.map(({ record: m, depth, siblings, position }) => `<div class="m ${esc(m.role)}" id="${esc(m.recordId)}" style="margin-left:${Math.min(depth, 8) * 18}px">
<div class="meta">${esc(m.role ?? 'unknown')} · ${esc(m.createdAt ?? 'no timestamp')}${m.model ? ' · ' + esc(m.model) : ''}${siblings > 1 ? ` · branch ${position}/${siblings}` : ''}${m.flags.includes('current_branch') ? ' · current' : ''}${m.flags.includes('hidden') ? ' · hidden' : ''} · <code>${esc(m.recordId)}</code></div>
<pre>${esc(m.text || '(no text content)')}</pre>${m.attachments.map((a) => `<div class="meta">📎 ${esc(a.name ?? a.ref ?? a.id ?? 'attachment')} — ${esc(a.availability)}</div>`).join('')}</div>`).join('');
        return send(res, 200, page(c?.title ?? 'Conversation', body, true));
      }
      const q = url.searchParams.get('q') ?? '';
      const provider = (url.searchParams.get('provider') || undefined) as Provider | undefined;
      const from = url.searchParams.get('from') || undefined, to = url.searchParams.get('to') || undefined;
      const s = ix.stats();
      let body = `<h1>Your vault</h1><p class="lead">${s.conversations} conversations · ${s.messages} messages · ${s.imports} imports</p>`;
      if (onb) body += `${vaultLine()}<section class="card" id="import"><h2>Import history</h2><p class="meta">ChatGPT, Claude, Gemini Takeout or CodingCat: a .zip, conversations.json, My Activity.html or an unzipped folder.</p>
<form method="post" action="/import" class="row"><label class="sr" for="import-path">Export file or folder</label><input id="import-path" class="grow" name="path" placeholder="Full path, e.g. C:\\Users\\you\\Downloads\\export.zip" required><button class="go">Import</button></form>
<p class="meta">Tip: in File Explorer, hold Shift, right-click the file and choose <strong>Copy as path</strong>, then paste it here.</p>
<form method="post" action="/reindex" class="row"><button>Rebuild index</button><span class="meta">re-reads the vault; imports do this automatically</span></form></section>
<section class="card" id="connect-next"><h2>Connect your AI</h2><p class="meta">Let Claude Code, ChatGPT Work or Antigravity search your vault and save handoffs.</p><a class="btn" href="/connect">Connect your AI</a></section>`;
      body += `<section class="card" id="search"><h2>Search</h2><form method="get" action="/" class="row" role="search"><label class="sr" for="q">Keyword</label><input id="q" class="grow" name="q" value="${esc(q)}" placeholder="Keyword search">
<select name="provider" aria-label="Provider"><option value="">All providers</option>${['chatgpt', 'claude', 'gemini', 'grok'].map((p) => `<option ${p === provider ? 'selected' : ''}>${p}</option>`).join('')}</select>
<input type="date" name="from" aria-label="From date" value="${esc(from ?? '')}"><input type="date" name="to" aria-label="To date" value="${esc(to ?? '')}"><button class="go">Search</button></form></section>`;
      if (q || provider || from || to) {
        const hits = q ? ix.search({ text: q, provider, from, to, limit: 200 }) : [];
        body += q ? `<p class="meta">${hits.length} result(s)${hits.length === 200 ? ' (first 200)' : ''}</p>` + hits.map((h) => `<div class="hit">
<a href="/conversation?id=${encodeURIComponent(convKey(h.record))}#${esc(h.record.recordId)}">${esc(h.conversationTitle ?? '(untitled)')}</a>
<div class="meta">${esc(h.record.provider)} · ${esc(h.record.role)} · ${esc(h.record.createdAt ?? 'no timestamp')} · source message ${esc(h.record.messageId)} · ${esc(h.record.provenance.exportLabel)}/${esc(h.record.provenance.exportEntry)}</div>
<div>${esc(h.snippet)}</div></div>`).join('') : '';
        if (!q) body += ix.listConversations(provider).filter((c) => (!from || (c.createdAt ?? '') >= from) && (!to || (c.createdAt ?? '') <= to + 'T23:59:59.999Z')).slice(0, 500)
          .map((c) => `<div class="hit"><a href="/conversation?id=${encodeURIComponent(convKey(c))}">${esc(c.title ?? '(untitled)')}</a> <span class="meta">${esc(convKey(c).split(':')[0])} · ${esc(c.createdAt ?? '')}</span></div>`).join('');
      } else {
        body += '<h2>Recent conversations</h2>' + ix.listConversations().slice(0, 100)
          .map((c) => `<div class="hit"><a href="/conversation?id=${encodeURIComponent(convKey(c))}">${esc(c.title ?? '(untitled)')}</a> <span class="meta">${esc(convKey(c).split(':')[0])} · ${esc(c.createdAt ?? '')}</span></div>`).join('');
      }
      return send(res, 200, page('Search', body, true, step(2)));
    } catch {
      return send(res, 500, page('Error', '<p>Internal error.</p>', false));
    }
  });
  return new Promise((resolve) => {
    server.listen(opts.port, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      resolve({ server, url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => { clearInterval(timer); lock(); server.close(() => r()); }) });
    });
  });
}
