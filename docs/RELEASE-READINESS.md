# Release readiness: source-only candidate (verification pending)

Status: **local candidate, not published.** No new product features. Code changes since the reviewed baseline are limited to the OMN-038 onboarding text and OMN-039 error-text corrections, the OMN-041/OMN-044 vault/agent ownership integrity corrections, the OMN-045 release defaults, guidance and runtime preflight, the OMN-047/OMN-048/OMN-049 fixes to the optional developer review pipeline, and the OMN-054 prepublication cleanup.

## Scope
- Included: source (`src/`, `bin/`), tests and synthetic fixtures (`test/`), scripts, examples,
  docs, `LICENSE`, `NOTICE`, and one portable launcher, `windows/Omneme Start.cmd`.
- Excluded: all personal material (exports, vaults, backups, keys, handoffs, logs, test evidence from real data)
  and legacy machine-specific Windows launchers (for example Unlock, Backup, Handoff and Claude Code install
  launchers).
- Excluded after coordinator review: legacy recovery templates, packaging script and Windows recovery guide,
  which assume the old Stage3 distribution. Encrypted backup/restore commands remain in the CLI and README.
- OMN-038 correction (`src/web.ts`): the *Connect your AI* and post-import pages no longer mention the excluded
  launchers. They give the existing CLI commands, run in Command Prompt from the folder that contains
  `package.json`: `node --no-warnings bin\omneme.mjs agent --vault "…"`, `backup "BACKUP-FILE" --vault "…"` then
  `verify-backup "BACKUP-FILE"`, `handoff-latest … --vault "…" --copy` and `handoff-save --file … --vault "…"`.
  Every command that opens a vault names the selected vault: `%USERPROFILE%\.omneme\vault.omneme` (main),
  `%USERPROFILE%\.omneme\first-run\vault.omneme` (first-run) or the explained `YOUR-VAULT-FILE` placeholder (custom).
  Client configs (Claude Code `claude mcp add`, ChatGPT Work TOML, Antigravity JSON) start `node` from PATH, with a
  `where node` fallback; the hardcoded `C:\Program Files\nodejs\node.exe` is gone. Step order, read-only check,
  Work caveat, single-writer and "no automatic backup" text are unchanged.
- OMN-039 correction (text only): locked/unreachable errors in `src/agent.ts` and `src/remote-mcp.ts` no longer
  rely on the excluded "Omneme Unlock" shortcut. They tell the user to run `node bin/omneme.mjs agent --vault
  "YOUR-VAULT-FILE"` in a terminal in the source folder that contains `package.json`, enter the password only there,
  and leave it open. The remote texts say this happens on the owner's own computer. `reset-password` now says to
  stop the agent with Ctrl+C or by closing its terminal, then retry; the race refusal still says nothing was changed.
  The save-timeout and failed-save wording, error scrubbing and behaviour are unchanged. One existing assertion in
  `test/remote-mcp.test.ts` was updated to the new wording. Coordinator verification passed; see below.
- OMN-041 / OMN-044 integrity corrections (**coordinator review passed**, verification limits below): exclusive vault ownership and
  single-agent discovery ownership. Baseline defect: two processes could open the same vault, and interleaved
  saves left the record-set state stale (`recordSetOk=false`, backup refused). New `src/ownership.ts` holds a SQLite
  `BEGIN IMMEDIATE` transaction on an empty sidecar `<vault>.owner` (canonical real path, so relative/absolute and
  symlinked-parent aliases share it). `Vault.create` (including the `.creating` temp file, with a recheck under
  ownership), `unlock`, `resetPassword` and the restore target take ownership before any read or write. An unlocked
  vault keeps ownership until `lock()`, and every failure path releases it. A second opener, in the same or another
  process, fails at once with a "vault is already open" message. If the owner dies, the OS releases ownership.
  The sidecar is never deleted or replaced, and there is no age-based takeover. The agent takes `<agent file>.owner`
  before it listens or publishes. It requires a positive safe-integer `pid` proven dead (`ESRCH`) before replacing an
  existing record, refusing missing, `null`, string, non-positive, fractional, unsafe-integer, or live (including
  same-process) PIDs while preserving the record bytes, and on refusal or startup failure it closes its listener,
  locks its vault and releases its guard. `src/importers/localFiles.ts` reuses `guardFileFor` and `canonicalPath` to
  exclude the active vault's exact `.owner` guard and `-journal`/`-wal`/`-shm` companions across lexical and
  canonical-parent spellings while still importing unrelated `.owner` and `.sqlite` files, binary files and non-UTF-8
  filenames.
  Vault/backup format, crypto, transactions and approval/wake/MCP behaviour are unchanged. Multi-writer merging is
  not implemented: a second writer is refused. Tests: `test/ownership.test.ts`, `test/localfiles.test.ts` and
  `test/backupkit.test.ts` (child processes, fixture HOME and agent files).

- OMN-045 release cleanup (candidate only, local commit; no deployment or publication):
  - Public default: the OMN-022 worker wake in `src/agent.ts` is an **opt-in developer tool, OFF by default**. It
    runs only when the agent's environment has `OMNEME_WORKER_WAKE` set to exactly `1`; otherwise an approved-looking
    `save_memory` from a caller claiming source `chatgpt` is stored normally and never reaches the scheduler. When
    enabled, the exact project/source/status checks, the single in-flight request and the worker's own approval,
    pause, guard and duplicate checks are unchanged. README documents that save source/status is local, unauthenticated
    metadata. MCP read/save, session capture, vault ownership and durable saves are unchanged.
  - Guidance: Windows JSON path escaping (doubled backslashes or forward slashes) and TOML single-quoted paths are
    explained on the Connect page and in the README; `mcp` help now lists the four local tools and says it forwards
    password-free to the running agent; the create-vault page now says the recovery key can reset a forgotten password
    (`reset-password`); ChatGPT Work and Antigravity are labelled "partly verified"; backup preview/drill/overdue
    texts and the remote startup text name `node bin/omneme.mjs backup-run` / `backup-drill` / `agent` instead of the
    excluded launchers; the two-vault choice message names `node "<path>\bin\omneme-start.mjs" --vault "…"`.
  - Runtime: `bin/omneme.mjs` and `bin/omneme-start.mjs` check the runtime before importing any TypeScript and stop
    with a clear error unless Node is 22.18+ (22.x), 23.6+ or 24+ with type stripping enabled (Node docs: type
    stripping enabled by default in v22.18.0 and v23.6.0). `package.json` engines is now `^22.18.0 || >=23.6.0`.
  - Tests: `test/worker-wake.test.ts` (existing cases opt in explicitly; new default-off/exact-value test),
    `test/bootstrap.test.ts` (new: unsupported runtime simulated with `--no-experimental-strip-types`; supported
    runtime launches), `test/onboarding.test.ts` (labels and escaping text). GUI-client registration from this
    candidate is **not verified** in OMN-045.
- OMN-047 / OMN-048 / OMN-049 developer review-pipeline fixes (optional tools in `scripts/`; a normal install does
  not use them):
  - OMN-047: a Claude BLOCKED or FAILED result gets the same single completion review, notification and PENDING
    decision as DONE, with the worker-recorded status carried as structured data and never labelled complete.
    The legacy Claude DONE format and the Antigravity path are unchanged.
  - OMN-048: Codex CLI discovery also checks the user-profile installation when `LOCALAPPDATA` points to a missing
    app-sandbox folder; missing or unreadable folders are skipped and an absent binary gives a clear error.
  - OMN-049: a failed Codex review is reported as bounded, redacted metadata (exit or spawn code, structured error
    type, coarse category, at most 120 sanitised characters). Raw output, prompt, environment, tokens, paths,
    e-mail addresses and URLs are never included.
- OMN-054 prepublication cleanup: the synthetic hostile path in `test/codex-failure.test.ts` now uses a generic user
  name (the redaction assertions are unchanged in strength), `remote-mcp` CLI help is labelled experimental to match
  the README, and this document was updated.

## Verification
- OMN-045 coordinator review passed on Windows: inspected commit `30a0f9d` against `8a018f6`, including
  whitespace-insensitive inspection of files whose line endings changed. Bootstrap, worker-wake, onboarding and
  remote-MCP suites passed 34 tests, 0 failures, 0 skips on the current supported Windows Node runtime.
  Claude separately reports Linux Node 22.23.5 full-suite results of 157 tests (148 passed, 0 failed, 9 skipped)
  plus 1 bounded-memory test passed. These are distinct test environments and results. Real older Node binaries,
  Node 23.0-23.5, and actual GUI-client registration from this candidate remain unverified. Unsupported type
  stripping was simulated with Node's `--no-experimental-strip-types` flag. No live vault or client was changed.
- OMN-047: coordinator Windows worker tests passed 4, 0 failed.
- OMN-048: coordinator Windows focused discovery and worker tests passed 8, 0 failed.
- OMN-049: Claude Linux focused tests passed 13, 0 failed. Coordinator Windows verification was **partial**: an
  automatic approval review blocked part of the run over a Visual Studio telemetry request (not traced to Omneme
  code), and the POSIX-stub end-to-end case is skipped on Windows. The owner accepted this partial evidence for a
  narrow diagnostic deployment; it is **not** a complete Windows pass. The earlier Linux full-suite result (148
  passed, 9 skipped, plus 1 bounded-memory test passed) is a separate environment and is reported separately above.
- After OMN-047 to OMN-049 were deployed to the owner's installed worker, it saved completion reviews, notification
  submissions and PENDING decisions (19 November 2026, 12:20 UTC). The worker does not wake an existing ChatGPT Work
  chat; the scheduled task's battery restrictions are unchanged.
- Reviews before OMN-054: Antigravity (OMN-052) gave an independent static review; Claude (OMN-053) did a
  self-review and static check with git limitations; Muse reviewed current excerpts only, not a full source audit.
  Their findings led to the OMN-054 cleanup above. None of these is a complete independent audit.
- OMN-044 integration verification reported by Antigravity:
  - Focused suites (`ownership`, `localfiles` excluding bounded memory, `backupkit`, `recovery`) with isolated
    fixture `HOME`/`USERPROFILE`/`OMNEME_AGENT_FILE`: 42 tests, 32 passed, 0 failed, 10 skipped.
  - Full `npm test` (with isolated fixture `HOME`/`USERPROFILE`/`OMNEME_AGENT_FILE`): Stage 1 ran 154 tests
    (144 passed, 0 failed, 10 skipped); Stage 2 (`test:memory` bounded-memory streaming) ran 1 test (1 passed,
    0 failed, 0 skipped). Total: 155 tests, 145 passed, 0 failed, 10 skipped.
  - The 10 skips are 8 rclone/cloud-destination tests (`no rclone executable found`) and 2 POSIX-only tests on
    Windows (`symlinks/FIFOs/non-UTF-8` in `localfiles.test.ts` and POSIX file mode `0o600` in `hardening.test.ts`).
    Windows junction parent aliases (`symlinkSync(..., 'junction')`) were exercised in both `ownership.test.ts` and
    `localfiles.test.ts`; POSIX symlinks remain untested on Windows.
- OMN-044 independent coordinator review: inspected the combined ownership, lifecycle, importer exclusions and
  PID-validation changes. Targeted ownership/local-file/backup/recovery suites passed 32 tests, 0 failures,
  10 skips. Junction-parent aliases were unavailable in this Work environment; Antigravity reports exercising them.
  The coordinator's full-suite attempt was interrupted by automatic approval review detecting an external Visual
  Studio telemetry request. That attempt is not counted as a pass. Full-suite evidence above is Antigravity's
  reported result, kept distinct from the coordinator's independent targeted verification. No telemetry exception,
  live-vault test, deployment or publication was performed.
- Prior OMN-041 coordinator check (superseded by OMN-044 fixes above): **BLOCKED** at 140 passes, 4 failures and
  10 skips before the three OMN-044 integration corrections (active-vault guard exclusion in `localFiles.ts`,
  persistent drill `.owner` sidecar expectation in `backupkit.test.ts`, and strict positive safe-integer dead-PID
  requirement in `agent.ts`).
- Coordinator baseline verification (OMN-037), 18 November 2026: `npm test` exited 0; 136 passed, 0 failed, 10 skipped.
  Skips cover optional rclone checks and platform-specific cases; cloud backup was not verified in this run.
  A fresh isolated first-run page returned HTTP 200 with create-vault guidance and created no vault.
  Tests used generated fixtures, not personal archives. macOS/Linux and full human onboarding remain untested.
- OMN-038 coordinator verification: onboarding and web/CLI regression suites passed all 18 tests, with no skips.
  New coverage renders source setup for all three clients and main/first-run/custom vault locations.
  An isolated browser flow created a vault, imported and searched a generated export, then locked it; a separate
  CLI agent opened that explicit vault and a password-free stdio MCP client retrieved the matching fixture title.
  CLI handoff save/resume and backup/verify-backup also passed with paths containing spaces and an intentionally
  incorrect default vault. No personal vault or live client configuration was changed.
- OMN-039 coordinator verification: remote MCP and password-reset suites passed all 18 tests, no skips.
  Manual isolated checks exercised a missing agent session and an unreachable fixture endpoint: both return
  source-compatible instructions naming an explicit vault placeholder without leaking local paths. A reset attempt
  with a running fixture agent stopped before asking for secrets, explained Ctrl+C, and left vault bytes identical.
  No live agent, client registration or personal vault was changed.
- Local MCP: Claude Code against the main vault through the unlock agent is the verified path. ChatGPT Work is
  verified only through a dedicated desktop test connector. The generic ChatGPT Work config and browser setup are
  **not fully verified**.
- Remote MCP (`remote-mcp`, for the Muse client) is **experimental**. It needs an unlocked agent and a temporary
  tunnel run by the user. Protocol `2025-03-26` is verified. Initialization with protocol `2025-11-25` returns
  HTTP 400, which **remains a release blocker for broad remote support**. The README does not claim broad remote
  compatibility.

## Deferred
- BSV anchoring: only a mock ledger (no network, no transactions). Real anchoring is deferred.

## Before publication
The source onboarding and portable-help corrections have passed coordinator verification. Actual GUI-client
registration from this source candidate, including PATH resolution and full app restart, still needs a final
fresh-user check; no live client registration was changed by the coordinator tests. Resolve protocol negotiation
before broad remote support. Owner approval is required for publication.

**History privacy:** the OMN-054 cleanup removes a machine-specific owner identifier from the current tree only. Earlier local commits still contain it. Public publication must use a separately approved, sanitized initial history or snapshot; the current local history must not be pushed. The local audit commits are kept unchanged.
