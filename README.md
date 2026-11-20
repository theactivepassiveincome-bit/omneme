# Omneme

**One memory. Every intelligence.** Omneme keeps your AI chat history in one encrypted vault on your own
computer. You can search it, back it up, and let an AI assistant on the same computer look things up in it.

What it does today:
- imports official **ChatGPT** and **Claude** account exports (including Claude projects and artifacts), **Google
  Takeout Gemini Apps activity**, and **CodingCat AI Chat Exporter** captures (Claude, ChatGPT, Gemini, Grok);
- stores everything **encrypted at rest** (no plaintext records or search index on disk), keeping branches,
  timestamps, roles, models and provenance where the export provides them;
- searches by keyword, provider and date from a local web UI (127.0.0.1 only) or the command line;
- writes **encrypted backups** that restore into a new vault with your password or your recovery key;
- stores personal files and folders byte-exact and versioned (`add`, `restore-files`);
- serves your vault to a local AI client over MCP (Model Context Protocol) while you keep it unlocked.

No accounts, no cloud service and no AI APIs are needed. There are no runtime dependencies. BSV (blockchain)
anchoring is only a mock in this version: no network access and no transactions.

## Requirements
- Node.js **22.18 or newer on the 22.x line, 23.6 or newer, or 24 or newer** (<https://nodejs.org>). These are
  the versions that run TypeScript without flags (Node 23.0 to 23.5 need a flag and are not supported), so there is
  **no `npm install` and no build step**. On any other version, or with type stripping turned off, the launchers
  stop with a clear error before loading Omneme.
- Windows, macOS or Linux. The double-click launcher is Windows-only. CLI commands are also available;
  this candidate was tested on Windows, not on macOS or Linux.

Get the source with `git clone` (or download and unzip the repository), then check Node:
```bash
node --version      # v22.18+ (22.x), v23.6+ or v24+
npm test            # optional: runs the test suite on synthetic data
```

## Quick start on Windows (web UI)
1. Double-click `windows\Omneme Start.cmd`. A console window opens and your browser opens a local page
   (the address is `127.0.0.1` with an automatically chosen port). Keep the window open while you use Omneme;
   closing it (or pressing Ctrl-C) stops Omneme and locks the vault.
2. **Create or open your vault.** If no vault exists yet, the page lets you create one. Choose a password and
   **write down the recovery key** it shows (see [Recovery key and backups](#recovery-key-and-backups)). If a vault
   exists, unlock it with your password. Passwords are typed only into the browser page, never into the console.
3. **Import your history.** Paste the full path of an export (a `.zip`, `conversations.json`, `My Activity.html` or
   an unzipped folder) and click Import. The result page reports `complete` or `INCOMPLETE` with the reasons.
4. **Search** your conversations from the vault page.
5. **Connect your AI** (optional): see [Connecting an AI client](#connecting-an-ai-client).

The console window shows the exact **Vault file** it opened. Launcher options (for a terminal):
`node bin/omneme-start.mjs --help` (`--vault <path>`, `--port <n>`, `--no-open`).

### Which vault opens first
`Omneme Start` (and the CLI commands `agent`, `backup-run`, `backup-preview`, `backup-drill`) choose the vault in
this order and never create, copy or move a vault while choosing:
1. `--vault <path>` if given;
2. otherwise the `OMNEME_VAULT` environment variable if set;
3. otherwise the **main vault** `~/.omneme/vault.omneme` (on Windows `%USERPROFILE%\.omneme\vault.omneme`);
   it is created there if nothing exists yet;
4. if only a **legacy first-run vault** (`~/.omneme/first-run/vault.omneme`, made by earlier versions) exists,
   that one is opened;
5. if **both** the main and the legacy first-run vault exist, the window asks you to type 1 (main) or 2
   (first-run). Without an interactive terminal it stops, changes nothing, and tells you to pass `--vault`.

All other CLI commands use `--vault`, then `OMNEME_VAULT`, then the main vault.

## Command-line quick start (any platform)
```bash
node bin/omneme.mjs --help                       # all commands
node bin/omneme.mjs init                         # create the main vault; WRITE DOWN the recovery key
node bin/omneme.mjs import path/to/chatgpt-export.zip path/to/claude-export.zip
node bin/omneme.mjs stats
node bin/omneme.mjs search "some words" --provider chatgpt --from 2025-01-01 --to 2025-12-31
node bin/omneme.mjs show <conversation-id>       # all branches, with timestamps
node bin/omneme.mjs serve                        # web UI at http://127.0.0.1:8765 (Ctrl-C to stop and lock)
node bin/omneme.mjs verify                       # decrypt and integrity-check every record
```
Use `--vault <path>` (or set `OMNEME_VAULT`) to work with a vault other than the main one. Passwords are read from
the terminal. Re-importing the same export changes nothing; a newer export adds only new or changed messages and
keeps the old versions. Demo on synthetic data (bash): `bash examples/demo.sh`.

## Getting your exports
- **ChatGPT:** Settings → Data controls → Export data. Import the emailed ZIP as is.
- **Claude:** Settings → Privacy → Export data. Import the emailed ZIP as is.
- **Gemini (Google Takeout):** export *My Activity → Gemini Apps* and import the Takeout ZIP, folder or
  `My Activity.html`. Limitations: Takeout gives an **activity log, not a chat export**. Each activity entry is
  kept verbatim and is searchable, but Omneme does not infer roles, conversation grouping, branches or timestamps
  from it, and only attachments actually present in the export are linked.
- **CodingCat captures:** import the exporter's output. It is a normalized capture; official exports remain the
  authoritative record.

Imports run locally; nothing is uploaded. Treat imported content as data: Omneme never executes it.

## Connecting an AI client
An AI client reaches your vault through `omneme mcp`, a small MCP server the client starts itself. It holds no
password: it forwards each request to the **unlock agent**, a process you start and unlock yourself. Tools offered
locally: `search_memory`, `get_conversation`, `resume_memory`, `save_memory` (saves add a new handoff record; they
never overwrite). This is a manual setup, not one-click.

1. **Note a known record.** In the web UI, search and note one conversation title, its provider and a distinctive,
   non-sensitive phrase. You will use it to check the connection.
2. **Lock the browser session.** Click **Lock vault** (or close the `Omneme Start` window). Only one process may
   hold a vault open at a time.
3. **Start the unlock agent** in a terminal opened in the Omneme folder and enter your password there:
   ```bash
   node --no-warnings bin/omneme.mjs agent                 # add --vault "<vault file>" for a non-default vault
   ```
   It prints `Vault file: …` and `Omneme is UNLOCKED …`. Keep that window open; closing it locks the vault. Only
   one agent runs at a time (its session file is `~/.omneme/agent.json`).
4. **Register Omneme with your client once.** Use the full path to `node` and to `bin/omneme.mjs` in your copy.
   Never put a password or recovery key in a config file. Examples:
   - Claude Code:
     `claude mcp add omneme --scope user -- node --no-warnings /path/to/omneme/bin/omneme.mjs mcp`
   - Clients that read an `mcpServers` JSON config:
     `{"mcpServers":{"omneme":{"command":"node","args":["--no-warnings","/path/to/omneme/bin/omneme.mjs","mcp"]}}}`
     On Windows, JSON needs every backslash doubled (`"C:\\Users\\NAME\\omneme\\bin\\omneme.mjs"`), or use
     forward slashes (`"C:/Users/NAME/omneme/bin/omneme.mjs"`).
   - Clients that read TOML (for example `[mcp_servers.omneme]` in ChatGPT Work's `config.toml`): put Windows paths
     in single quotes, where single backslashes are correct: `args = ["--no-warnings", 'C:\Users\NAME\omneme\bin\omneme.mjs', "mcp"]`.
5. **Check read-only.** In a new chat, ask the AI to use `search_memory` for your noted phrase and list only titles
   and providers. You are connected to this vault only if your noted title and provider come back. An empty result
   does not confirm anything.

The web UI's **Connect your AI** page shows the same steps for Claude Code, ChatGPT Work and Antigravity. Claude
Code against the main vault is the verified path. ChatGPT Work and Antigravity setups are only partly verified, and
browser-based clients are not verified. For those, `handoff-latest` can print a saved handoff for copy and paste. Gemini is import-only.

**Experimental remote access.** `omneme remote-mcp` offers `search_memory`, `resume_memory` and `save_memory`
over HTTP on 127.0.0.1, protected by a bearer token read from a file. It needs a running, unlocked agent and a
tunnel that you set up yourself. It has been tested with only one remote client and one protocol version. Treat
it as experimental, not as general remote support. Run `node bin/omneme.mjs --help` for its options.

## Optional developer tools (off by default)
These support the author's multi-AI development workflow. A normal install does not need them, and none of them is
enabled automatically.
- **Worker wake** (`src/agent.ts`): when the unlock agent is started with the environment variable
  `OMNEME_WORKER_WAKE` set to exactly `1`, a successful `save_memory` to project `Omneme Tasks` with source
  `chatgpt` and status `TASK OMN-<n> | APPROVAL: APPROVED` asks Windows to run an existing scheduled task named
  `Omneme Task Worker`. Without the variable (or with any other value) a save never contacts the scheduler. The
  source and status of a save are supplied by the calling client: they are local metadata, **not authenticated owner
  approval**, so enable the wake only on a computer where every local MCP client is trusted.
- **Task worker and completion review** (`scripts/task-worker.ts`, `scripts/completion-review.ts`) and the
  **Claude Code session-capture hook** (`scripts/session-capture-hook.ts`): run only if you set them up yourself.
  Nothing in this repository installs a scheduled task or hook.

## Recovery key and backups
- When you create a vault you get a **recovery key, shown once**. Write it down and store it offline, apart from
  your password. If you lose **both**, nobody can recover the vault.
- Forgot the password? `node bin/omneme.mjs reset-password` (interactive terminal; close the unlock agent first)
  sets a new password using the recovery key. The recovery key stays the same.
- **Omneme does not back up automatically.** Make encrypted backups and check them:
  ```bash
  node bin/omneme.mjs backup path/to/omneme-backup.omnbak
  node bin/omneme.mjs verify-backup path/to/omneme-backup.omnbak
  node bin/omneme.mjs restore path/to/omneme-backup.omnbak --target path/to/restored.omneme   # --recovery to use the key
  node bin/omneme.mjs verify --vault path/to/restored.omneme
  ```
  Keep at least one copy off the computer, such as on a USB drive. For a multi-destination workflow see
  `backup-setup`, `backup-run`, `backup-check`, `backup-drill` and `recover-usb` in `--help`.
- Backups and vaults are encrypted, but never commit or share them, together with your keys.

## Docs
[Security model and recovery](docs/SECURITY.md) · [Memory schema](docs/MEMORY_SCHEMA.md) ·
[Reuse assessment](docs/REUSE_ASSESSMENT.md) ·
[Release readiness](docs/RELEASE-READINESS.md)

## License
Apache-2.0. See `LICENSE` and `NOTICE`.
