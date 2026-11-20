# Security model and assessment (Stage 1.1)

> This is a self-assessment by the implementing engineer, cross-checked by ChatGPT's code review.
> **No independent security audit has been performed. Omneme is not production-secure.**

## Key hierarchy
```
password ──scrypt(N=2^17,r=8,p=1, random 16-byte salt)──► KEK_pw ─┐
recovery key (32 random bytes, CSPRNG) ──HKDF──► KEK_rc ──────────┼─ AES-256-GCM wrap ─► DEK (32 random bytes)
DEK ──HKDF-SHA256(salt=vaultId)──► record key ("omneme/v1/records")   AES-256-GCM per record, random 96-bit nonce
                               ├─► id key     ("omneme/v1/record-id") HMAC record ids and lineage
                               └─► mac key    ("omneme/v1/mac")       header, record-set state, backup MAC
```
- Record AAD = `omneme/rec/v1|vaultId|id`. On decrypt, both the row `id` and the row `lineage` must equal the keyed
  hashes recomputed from the record's own content, so swapping, renaming or relabelling rows is detected.
- **Record-set commitment.** `meta.state` = {count, XOR of HMAC(mac key, id) over all rows}, MAC'd. It is updated in
  the same SQLite transaction as each insert. Checked by `loadAll`, `verify` and `backup`, it detects deleted, added or
  transplanted rows and tampered state. A crash mid-transaction rolls back data and state together (tested with SIGKILL).
- The header (KDF params, key slots) is plaintext but MAC'd and checked after unlock. KDF parameters are bounds-checked
  *before* use (N ∈ [2¹⁴, 2²⁰], r ≤ 32, p ≤ 16, salt ≥ 16 bytes, **and combined: memory 128·N·r ≤ 256 MiB, work N·r·p ≤ 2²²**),
  so a tampered header can't exhaust memory or CPU. Default (2¹⁷, 8, 1) = 128 MiB. The CLI
  refuses N < 2¹⁷ outside test mode, and `stats` warns about test-strength vaults.
- Data keys are fully separate from BSV spending keys. No wallet key exists in Stage 1.

### What the record-set commitment does NOT give you
It proves the vault is internally consistent. It **cannot detect rollback of the whole vault file** to an older,
equally valid copy (tested and documented as a limitation), because the commitment lives inside the same file.
Detecting that needs an external checkpoint: a record count and digest you keep elsewhere, or a BSV-anchored
commitment (Stage 3, Mode B). Until then, keep dated backups and compare `stats` counts with your import history.

## At rest
- The vault holds only HMAC ids and ciphertext. SQLite uses `journal_mode=DELETE`, `temp_store=MEMORY`,
  `secure_delete=ON`, and the file is mode 0600 (POSIX; on Windows it inherits your user-profile ACLs).
- No plaintext search index exists on disk. No temp files are written. Create, backup and restore write to
  `*.creating` or `*.partial` and rename only after success (backups are fsynced).
- A test scans every byte in the vault directory and backup for synthetic plaintext in UTF-8 and UTF-16.
- Not controlled by Omneme: OS swap and hibernation files, crash dumps, and terminal scroll-back of `show`/`search` output.

## Archived files (Stage 1.2)
Exact bytes live in a `chunks` table: 4 MiB chunks, gzip then AES-256-GCM, id = HMAC(id key, SHA-256(chunk)),
AAD binds the vault id and chunk id. The owning record (itself authenticated and in the record-set commitment) lists
the chunk hashes, size and whole-file SHA-256. `verify` re-reads every blob. Backups include and authenticate all
chunks and refuse a vault with a missing or altered chunk. Restore checks that every referenced chunk arrived.
Orphan chunks (from an interrupted import) are harmless ciphertext.
**Exported HTML/JS/CSS is inert data:** it is never executed, rendered or served by the web UI. `extract` writes bytes
only to a new file you name, and warns that opening HTML in a browser runs it.

## Local files (Stage 1.3)
- Symlinks are recorded, never followed (no escaping the chosen folder, no loops). Files are opened with `O_NOFOLLOW` where
  supported. FIFOs, sockets and devices are never opened. The vault's own files are excluded.
- A file whose size or mtime changes while being read is rejected and reported (re-run the import), never stored half-changed.
- Nothing is executed or parsed. Format-agnostic bytes only.
- `restore-files` writes only into a new or empty folder. Every path is validated (no absolute paths, `..`, NUL; Windows
  reserved names and characters), must resolve inside the target, is written via `.omneme-partial` + rename, never
  overwrites, is SHA-verified, and setuid/setgid/sticky bits are dropped. Symlinks are listed, not recreated.
- Residual: dedup is per vault, so a chunk's presence doesn't leak across vaults. Within a vault, an attacker with the file
  and the vault can confirm a guess only with the keys. Fixed 4 MiB chunking means an edit early in a large file re-stores
  the rest of it (no content-defined chunking yet).

## Backup format (`omneme.backup/2`; v1 still restorable)
`H <json {format, header, state}>`, then `R <id> <lineage> <ciphertext>` per record, `C <id> <ciphertext>` per chunk, then `T <json {count, chunks, mac}>`,
where mac = HMAC over all H/R lines. Backup creation first verifies every record (authentication, content hash, record set) and refuses if any fail, writing nothing. Restore verifies key unwrap, header MAC, every record's AEAD tag and id/lineage,
the count, the trailer MAC and the record-set state. It then commits and renames. Any failure leaves nothing behind.

## Key loss and recovery
| You still have | Outcome |
|---|---|
| Password | Normal unlock |
| Recovery key only | `--recovery` unlocks the vault and restores backups, on any machine |
| Neither | **Unrecoverable**, by design |

The recovery key is **displayed once** but **stays valid for this vault and every backup of it**, permanently.
There is no rotation yet, and rotation would not invalidate backups already made. Anyone who finds the paper copy
plus a backup can read everything. Store it like a master key.

## Assessment

### Verified protections (with tests)
| Area | Protection | Tests |
|---|---|---|
| AEAD | Wrong key, wrong AAD and bit flips all fail. 20k nonces were all unique. 16-byte tags enforced | core, hardening |
| KDF | Strong default, random salts, bounded header params, weak N refused outside test mode | core, hardening |
| Records | Tampered blob, swapped lineage, renamed id, deleted row, transplanted row, tampered state | vault, hardening |
| Recovery | Recovery-key unlock; restore of a copied backup on a "fresh machine" gives deep-identical records | vault, hardening |
| Backup | Truncated, reordered, dropped, flipped or wrong-password backups are refused with no partial output | vault |
| ZIP | Lying sizes, ratio bomb, size cap, entry-count cap, overlapping entries, OOB offsets, unsafe ZIP64 ints, CRC; 400-case fuzz | core, hardening |
| JSON | Missing, leading, double or trailing commas; depth cap; size cap; truncation; invalid UTF-8 reported with byte offset; 250-case fuzz | core, hardening |
| Import integrity | Per-conversation atomic commits; started/finished markers (SIGKILL → "interrupted"); reconciliation of source nodes and elements; idempotent re-import; revisions instead of overwrites | import, hardening |
| Web | Loopback bind; Host allowlist (DNS rebinding → 421); Origin and Sec-Fetch-Site checks; throttling after 3 failures; lock needs a session; failed unlock keeps the session; idle (15 min) and absolute (8 h) expiry; CSP with no scripts | web tests |
| Untrusted text | HTML escaping; terminal control and bidi chars stripped; content never logged or executed | web, cli |

### Remaining weaknesses
| # | Weakness | Severity |
|---|---|---|
| 1 | Whole-vault rollback is undetectable without an external checkpoint | Medium |
| 2 | Hand-written ZIP and JSON parsers on untrusted input (npm was blocked, so yauzl/stream-json couldn't be used). Mitigated by limits and fuzzing, but not battle-tested | Medium |
| 3 | Recovery key never expires or rotates | Medium |
| 4 | An unlocked web session gives full read access to anything on the machine holding the cookie or able to drive your browser | Medium |
| 5 | JS cannot guarantee key zeroisation; plaintext lives in RAM while unlocked; swap/hibernation can capture it | Medium |
| 6 | scrypt instead of Argon2id; random-nonce AES-GCM instead of XChaCha20 (owner-accepted) | Low |
| 7 | Row count and approximate record sizes are visible in the vault file | Low |
| 8 | A malicious backup with gigantic lines could exhaust memory during restore (backups are your own files) | Low |
| 9 | Duplicate keys inside a JSON object are resolved last-wins by `JSON.parse` (export-format edge case) | Low |
| 10 | No `tsc` type-check (no `@types/node` available) | Low |

### Cannot yet be guaranteed
That parsers match every real-world export variant (they are untested on real exports). Rollback detection.
Protection against malware running as your user. Attachment content preservation. Long-term format
compatibility beyond `omneme.record/1`.
