# Reuse assessment (Stage 1)

Research date: 2026-11-03. **Environment constraint:** this build ran in a sandbox where the npm registry
was blocked by network policy (HTTP 403) and GitHub API access to third-party repos was unavailable. So
**no third-party package could be installed**, and licenses were checked from public web pages, not from
inspecting package tarballs. Every point where an established package should replace local code is listed
below. Re-check each one when the registry is reachable.

| Requirement | Existing project / package | License | Decision | Reason |
|---|---|---|---|---|
| ChatGPT importer | pionxzh/chatgpt-exporter (userscript); LLMmempipe (Rust); khive-pack-session (Rust); PAM converters | various / unverified | **Learn from, write adapter** | None is a maintained TypeScript library that keeps the full branching tree *and* provenance. Format knowledge (mapping/parent/children, current_node, content_type variants) taken from public descriptions. ~120 lines. |
| Claude importer | pond-db (Rust), txcript (Rust), Portable AI Memory (PAM) mappings | unverified | **Learn from, write adapter** | Same as above. Notes: `parent_message_uuid` / `current_leaf_message_uuid` appear in some exports, so the importer uses them when present and marks parents as *inferred* otherwise. |
| X archive posts (OMN-059) | Archivist providers/twitter (Go) — github.com/johnnycube/archivist @8ef61acc41401791c6b88e863b70d9df14752819; Timelinize | MIT; Timelinize AGPL-3.0 | **Learn from (MIT, attributed in NOTICE), write TypeScript adapter** | Go code is not a drop-in and needs Postgres/S3 interfaces; the documented file mapping, wrapper, date and media-path conventions were reused. Timelinize code not used (AGPL). Grok chats, DMs and likes are not imported yet. ~250 lines. |
| Canonical schema | Portable AI Memory (PAM) spec v1.0 — github.com/portable-ai-memory/portable-ai-memory | not verified | **Align, don't adopt yet** | Closest open schema (provider ids, parts, attachments, raw_metadata). Ours adds keyed record ids, content hashes, original/derived/event classes, revisions and export provenance. A PAM exporter is a cheap future adapter. |
| Indelible record format | indelible-federation/indelible-docs | **BSL 1.1** (converts to MIT 2030-04-30) | **Do not reuse code; don't adopt format** | Commercial use of competing storage is restricted. Its documented design derives the AES-256-GCM data key from SHA-256 of the wallet WIF, which conflicts with our rule to keep data keys separate from spending keys. A read-only compatibility adapter could be written later from the public docs. |
| Local encrypted vault | SQLCipher / better-sqlite3-multiple-ciphers; libsodium | BSD / MIT / ISC | **Deferred → Node built-ins** | Registry blocked. Implemented with `node:sqlite` (rows hold only AES-256-GCM ciphertext) + `node:crypto`. No crypto primitives written. |
| Password KDF | Argon2id via `@noble/hashes` (MIT), `argon2` (MIT), or Node ≥ 24.7 `crypto.argon2` | MIT | **Deferred → scrypt** | Not installable on Node 22. scrypt (memory-hard, RFC 7914, OpenSSL) N=2¹⁷ r=8 (128 MiB, ~0.3 s). KDF params are stored per vault, and changing the KDF only re-wraps the key (no data re-encryption). |
| AEAD | XChaCha20-Poly1305 via `@noble/ciphers` / libsodium | MIT / ISC | **Deferred → AES-256-GCM (OpenSSL)** | Random 96-bit nonces under one DEK. Safe well beyond 2³² records/backups. Acceptable for a personal vault. Revisit if the record count approaches 10⁸. |
| ZIP reading | `yauzl` 2.10 (MIT) | MIT | **Kept: `src/zip.ts` (hardened in 1.1)** | Registry still blocked in 1.1. Now has size, ratio, entry and overlap limits, bounds and safe-int checks, and a 400-case fuzz test. Still prefer yauzl when installable. |
| Streaming JSON | `stream-json` (BSD-3) | BSD-3 | **Kept: `src/jsonstream.ts` (hardened in 1.1)** | Registry blocked. Now validates array separators, depth, element size and UTF-8 (exact byte offsets), with a 250-case fuzz test. `JSON.parse` still does all value parsing. |
| Claude projects / frames import | pdlourenco/ClaudeProjectExport, Brads777/ClaudeProjectExport (Python), basic-memory `import claude projects` | not verified | **Format knowledge only; own adapter** | Python tools, no TS library. Layout taken from public issue text (projects/<uuid>.json; artifacts/<id>/artifact.json + versions/). npm still blocked. |
| Blob/archive store | restic, Kopia, age; BagIt (manifest + checksums) idea | BSD/Apache | **Own minimal store in vault.ts** | Must share the vault's keys, record-set integrity and backup format. ~80 lines on node:crypto/sqlite. BagIt-style SHA-256 per file adopted conceptually. |
| Local file vault | `@serve.zone/containerarchive` (Rust core, FastCDC, AES-GCM+Argon2id), restic, Kopia, `@plaindb/drive` | various | **Learn from; extend own blob store** | containerarchive/restic/Kopia are separate repositories, which would be a second storage engine (excluded by the brief). drive is unencrypted. Ideas noted: content-defined chunking (FastCDC) and Reed-Solomon parity as future options. ~200 lines added. |
| Search & indexing | SQLite FTS5, MiniSearch (MIT), Orama | MIT | **In-memory exact keyword search** | FTS5 on disk would persist a plaintext index (forbidden). Index is built in RAM at unlock: 100k msgs ≈ 3 s. |
| Backup & recovery | restic, age, Kopia | BSD/Apache | **Own backup file format** | Backups must be restorable into an Omneme vault and later published as Mode-B payloads. Format is a small line-based container (header + ciphertext rows + HMAC trailer), documented in SECURITY.md. |
| BSV writer/reader | `@bsv/sdk` and wallet packages from **bsv-blockchain/ts-stack** (monorepo successor of the archived ts-sdk) | **Open BSV License v6** (standardised across all ts-stack packages, PR #346, Jul 2026). Not SPDX; use is limited to BSV blockchains; earlier versions (v5) are revocable by the BSV Association and governed by Swiss law/arbitration. Re-read the v6 text before adopting | **Approved by owner for BSV-only code (Stage 3)** | Must live in an isolated package (e.g. `packages/omneme-bsv`), with its own LICENSE notice, and never imported by the Apache-2.0 core. The core keeps only the dependency-free envelope + `BlockchainStorageAdapter` interface. |
| MCP server | modelcontextprotocol/servers `memory` (reference, MIT); `@modelcontextprotocol/sdk` | MIT | **Adopt SDK in Stage 4** | Reference server is explicitly "not production-ready". Use the official SDK with our scoped retrieval. |
| Memory synthesis | Mem0 (Apache-2.0), Zep/Graphiti (Apache-2.0) | Apache-2.0 | **Evaluate in Stage 5** | Both are good candidates for derived memory/knowledge graphs. Out of scope for Stage 1. Outputs must be stored as `class: derived` records. |
| Exclusive vault / agent-file ownership (OMN-041, 18 Nov 2026) | Own `scripts/task-worker.ts` SQLite guard (`BEGIN IMMEDIATE` held open); SQLite file locking, https://www.sqlite.org/lockingv3.html and https://www.sqlite.org/pragma.html#pragma_locking_mode; PID/lock-file packages (e.g. proper-lockfile) | project code (Apache-2.0); SQLite public domain | **Reuse own guard pattern via `node:sqlite`** (`src/ownership.ts`, ~60 lines) | Settled by the coordinator. OS-held SQLite locks are atomic and released by the OS when the owner dies, so no PID/timestamp stale-lock takeover is needed. Lock-file packages add a dependency and use age-based takeover that can evict a live owner. No new dependency. |

## Lines of original code (src/, excluding tests)
Roughly 1,300 lines total. Those above ~100 lines, with justification:
- `vault.ts`: key hierarchy, encrypted record store, backup/restore. This is core Omneme logic, and no package does it.
- `importers/*`: provider-specific normalisation into our schema. This is a core differentiator.
- `search.ts`, `web.ts`, `cli.ts`: thin product surfaces.
- `zip.ts`: temporary stand-in for yauzl (registry blocked).

## GitHub reuse audit (6 Nov 2026), verified table
LICENSE files read at the commit shown, via read-only shallow git clones. Nothing installed or executed. Activity = latest
commit date (issue activity not measurable: GitHub API unavailable). Tests = number of test files present.
Decision: **REUSE NOW** · **INTEGRATE LATER** · **STUDY ONLY** · **REJECT**. Details and rationale: `COMPETITIVE_LANDSCAPE.md`.

| Repo | License @ commit (date) | Lang / key deps | Tests | Verified functionality | Fit / effort | Decision |
|---|---|---|---|---|---|---|
| nikolaylosev/ai-chat-exporter (CodingCat) | MIT @6c8f52f (10-31) | TS, Chrome MV3; fflate, preact, zod | 136 | Adapters for Claude/ChatGPT/Gemini/Grok; branches, projects, files; JSON `ai-chat-exporter/conversation@1` | Use as external capture tool; we write a ZIP/JSON importer (~200 lines) | **REUSE NOW** (tool + importer next) |
| rclone/rclone | MIT (COPYING) @7c60060 (11-05) | Go binary | 451 | ~70 backends incl. dropbox, box, drive, onedrive, s3, webdav, iclouddrive; Google Photos read limited since 2025-03-31 | Zero code: copy → `omneme add`; replicate backups | **REUSE NOW** (external tool, docs) |
| kopia/kopia | Apache-2.0 @7498348 (11-02) | Go binary + KopiaUI | 399 | CDC dedup, compression, E2E encryption, many storage targets | Zero code: incremental offsite copies of vault + .omnbak | **REUSE NOW** (external tool, docs) |
| restic/restic | BSD-2-Clause @c2c046c (11-05) | Go binary | 228 | AES-256-CTR + Poly1305, CDC, documented repo format (`doc/design.rst`), `--json` | Same role as Kopia (CLI) | **REUSE NOW** (alternative to Kopia) |
| MacPaw/portable-memory | MIT @f341f07 (09-21) | Spec + JSON Schemas; Python/Swift SDKs, no TS | 17 | `.mem` bundle: JSONL kinds, manifest, CHECKSUMS, tombstones, Ed25519 | Interchange for derived memories; small TS writer | **INTEGRATE LATER** (Stage 5) |
| mem0ai/mem0 (`mem0-ts`, npm `mem0ai`) | Apache-2.0 @ed1f10f (11-04); `mem0-ts/src/oss/package.json` says MIT | TS (+Python); peer deps optional: ollama, fastembed, better-sqlite3 | 329 | Memory extraction + retrieval; in-memory/SQLite stores; local LLM/embedder adapters | In-process Node, local, $0; derived records only | **INTEGRATE LATER** (first memory prototype) |
| doobidoo/mcp-memory-service | Apache-2.0 @547264a (11-05) | Python ≥3.11; sqlite-vec, local ONNX embeddings | 609 | MCP + REST memory service | Python service; design reference for Stage 4 | **STUDY ONLY** |
| EverMind-AI/EverOS | Apache-2.0 @6a937cd (11-05) | Python ≥3.12; LanceDB, openai; OpenRouter key to start | 543 | Markdown + SQLite + LanceDB memory runtime | Overlapping engine, Python | **STUDY ONLY** |
| MemTensor/MemOS | Apache-2.0 @d326a64 (11-04) | Python; transformers, pymysql, ollama | 475 | Agent memory OS, plugins | Heavy | **STUDY ONLY** |
| getzep/graphiti | Apache-2.0 @fb60e59 (11-03) | Python; Neo4j/FalkorDB/Neptune + LLM | 106 | Temporal context graph | Needs graph DB + LLM | **INTEGRATE LATER** (only if justified) |
| letta-ai/letta | Apache-2.0 @8816d3a (10-18) | stub; code moved to letta-code | 0 | Agent harness, not a memory store | Not our layer | **REJECT** |
| Covai-Labs/ace | AGPL-3.0 + FOSS linking exception @b91cc43 (11-04) | TS (WXT ext.), DOM extraction, `<all_urls>` | 136 | Many chat sites, multiple formats | Overlaps CodingCat; heavier license | **REJECT** (fallback reference) |
| dmcslab/chat-exporter | MIT @401dc28 (04-12) | TS, Chrome CDP | 9 | ChatGPT + Claude via debug browser | Less coverage, stale 7 months | **STUDY ONLY** |
| immich-app/immich | AGPL-3.0 @037e5bc (11-06) | TS server + Docker + Postgres | 355 | Photo/video server | Separate app; don't link | **REJECT** (as dependency) |
| cryptomator/cryptomator | GPL-3.0 @2820306 (11-05) | Java desktop | 48 | Encrypted cloud vault | GPL, different model | **STUDY ONLY** |
| zcoolz/indelible-indexer | MIT @d5ca4c9 (06-12) | Node ≥18; zeromq; **full bitcoind** | 1 | UTXO check + Merkle proofs from own node | Needs full node; SDK SPV suffices | **STUDY ONLY** |
| zcoolz/indelible-overlay | MIT @2bc5828 (06-10) | Node ≥18; @bsv/sdk | 1 | Signed capability announcements; lookup | Young; UHRP overlay is the standard | **STUDY ONLY** (provider-discovery option) |
| indelible-federation/indelible-docs | BSL 1.1 @27f12f7 (05-17) | docs | 0 | Web-app docs | No code reuse | **REJECT** (code) |
| bsv-blockchain/ts-stack (`@bsv/sdk`, `@bsv/wallet-toolbox`, `@bsv/402-pay`, `@bsv/overlay-topics`) | Open BSV License v6 @eb13114 (11-04) | TS monorepo | 1845 | UHRP StorageUploader/Downloader, MerklePath, ChainTracker, Beef, Chaintracks (headers-only), BRC-100 wallet, 402 payments | Isolated `packages/omneme-bsv` | **INTEGRATE LATER** (Stage 3) |
| Calhooon/bsv-rs | Apache-2.0 OR MIT @8729f8a (10-30) | Rust | 207 | SDK parity incl. UHRP storage, overlay | Not our language; cross-check vectors | **STUDY ONLY** |
| bitcoin-apps-suite/bitcoin-drive | Open BSV v5 + BOCL v1.0 @2d8a01e (10-16) | Next.js, Prisma, Google OAuth | 2 | File upload/NFT app | App, restrictive licenses | **REJECT** |
| p2ppsr/metanet-notes-obsidian-plugin | Open BSV v4 @3d01d0f (2025-09-11) | TS; Metanet Desktop required | 0 | Notes via SDK LocalKVStore | Old license, wallet app required | **REJECT** (pattern noted) |
| Imonda/lore | MIT @175ba89 (04-26) | PHP | 0 | Encrypted archive of AI chat imports | Competitor; PHP | **STUDY ONLY** |
| memoriqme/memoriq | AGPL-3.0-only @3d7292c (11-01) | PHP/Laravel + extension | 5 | E2E-encrypted AI chat vault | Closest competitor; AGPL | **STUDY ONLY** |

REUSE NOW items need **no vendored code**: they are user-installed tools (rclone, Kopia/restic, CodingCat). Omneme reads their
outputs or they handle Omneme's ciphertext. This is cheaper and safer than writing connectors, backup engines or browser scrapers,
which have the highest maintenance cost of anything on our roadmap.

### Review qualifications (6 Nov 2026)
Kopia/restic: back up verified `.omnbak` files or a closed vault only; benchmark dedup first. CodingCat: external tool,
importer only; official exports stay authoritative. Google Photos: Takeout + `omneme add` first. Mem0 and other engines:
**not adopted**; suitability to be demonstrated separately. BSV: on-chain payloads ≠ UHRP-hosted payloads ≠ commitments.

## Stage 2.5 (9 Nov 2026): Bstore storage market
| Requirement | Project | Licence | Decision | Reason |
|---|---|---|---|---|
| Paid, competing, provable storage of encrypted backups | lightwebinc/bstore `6e570de` (v0.26.1), bcommon, bstore-bridge | Apache-2.0; binaries link go-sdk (Open BSV License v5) | **Watch; optional S3/rclone backend later; do not build our own** | Experimental, one maintainer, no public providers/directory, no Windows build; `.omnbak` works unchanged in its proof code (measured). See `docs/BSTORE_AUDIT.md` |
| Fork-proof checkpoint sequencing | Bstore bucket token chain design (spec §3, §13.3) | Apache-2.0 (spec) | **Adopt the idea** in Mode B (spend-linked checkpoints) | Small change, removes forks, tip = unspent output |
