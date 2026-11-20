# Memory schema — `omneme.record/1`

Every stored item is one JSON record (encrypted at rest). Source: `src/schema.ts`.

| Field | Meaning |
|---|---|
| `schema` | `"omneme.record/1"` |
| `recordId` | `omr_` + 32 hex. A keyed HMAC of lineage + content hash, stable across backup/restore and meaningless outside the vault. |
| `class` | `original` (imported verbatim), `derived` (AI/tool-generated later), `event` (imports, corrections) |
| `kind` | `conversation`, `message`, `import`, `correction`, and others in `src/schema.ts`; `social_event` = one item from a social-media archive (an X post), never a chat message |
| `scope` | Permission scope. Stage 1 always uses `private`. Reserved: `business`, `shared-project`, `agent`, `restricted` |
| `provider` | `chatgpt` \| `claude` \| `gemini` \| `grok` (AI chats); `x` (X archive posts, `social_event` records only) |
| `conversationId`, `messageId`, `parentMessageId` | Original provider identifiers (ChatGPT: mapping node ids) |
| `parentInferred` | `true` if the parent was inferred from order rather than supplied |
| `role`, `authorName` | `user` / `assistant` / `system` / `tool` / provider value, or null |
| `title` | Conversation title (conversation records) |
| `createdAt`, `updatedAt` | ISO-8601 UTC, or null when the export has none (never invented) |
| `importedAt` | When this record was imported |
| `model` | Model slug when known |
| `text` | Plain searchable text, derived from `parts` |
| `parts[]` | `{type, text?, ref?, mime?, availability?, originalType?}`. Types: text, code, thinking, tool_use, tool_result, context, image, audio, video, file, attachment_text, unknown |
| `attachments[]` | `{id, name, mime, size, ref, exportEntry, availability}` |
| `flags[]` | `current_branch`, `branch_point`, `hidden`, `incomplete` |
| `relations[]` | `{type, target}`, e.g. `supersedes`, later `corrects`, `derived_from` |
| `provenance` | `{importId, importer, importerVersion, exportLabel, exportSha256, exportEntry, elementIndex}` |
| `contentHash` | SHA-256 of canonical JSON (sorted keys) of `raw` |
| `raw` | The original provider object, verbatim |

## X posts (`social_event`, provider `x`)
One record per post: `conversationId` = `x-account:<accountId>` (account namespace from `data/account.js`, so two
accounts never collide), `messageId` = `tweet:<id>` or `note:<noteTweetId>` (native ids), `role` = `author`,
`title` = `X post` / `X reply` / `X repost` / `X deleted post` / `X long-form note`, `createdAt` from `created_at`
(UTC). `relations`: `reply_to`, `edit_of`, `note_of` (only when the archive supplies the link; note text is never
merged into a post). `flags`: `deleted` (from `deleted-tweets.js`, content kept), `repost`. Media are attachments
with `referenced_in_export` (or `missing_from_export`); bytes are not copied. `raw` = `{tweet}` (or
`{deleted: true, tweet}` / `{noteTweet}`) verbatim, so the same post in another split file is a duplicate, a changed
post is a revision, and a post missing from a later export is never treated as deleted. Social records are
searchable but are not conversations or messages and are not grouped into threads.
MCP `get_conversation` with a post id returns the post in pages of at most 16,000 characters: follow
`nextTextOffset` by passing it back as `textOffset` (character offset; pages never split a surrogate pair) until it
is null; concatenating the returned `text` pages gives the exact stored text. `textOffset` applies only to posts.

## Attachment availability
`text_extracted` (provider-supplied text stored), `referenced_in_export` (file is in the archive, bytes not
yet vaulted), `missing_from_export` (referenced but absent), `metadata_only`. Nothing is ever reported as
imported unless it was.

## Reconstructing originals
- ChatGPT conversation record `raw` is the conversation object with each `mapping[*].message` replaced by
  `{"$omneme_ref": <message id>}`. Substitute the message records' `raw` to get the original back.
- Claude conversation record `raw` is the conversation object with each `chat_messages[i]` replaced the same way.

## Versioning and corrections
- Same lineage (`provider|kind|conversationId|messageId`) + same `contentHash` → duplicate, ignored.
- Same lineage + new hash → new record with `relations: [{type: "supersedes", target: <old recordId>}]`.
  Views show the latest version, and the old record stays in the vault.
- User corrections (Stage 2+) will be `class: event, kind: correction` records pointing at their target.
  They never edit the target.
- Breaking schema changes bump the version (`omneme.record/2`). Readers must accept older versions.

## What "preserved" means (and doesn't)
- **Preserved:** every conversation and message object's JSON *content*, verbatim in `raw` (values, key names, nesting).
  This includes fields Omneme doesn't understand. ChatGPT mapping nodes that aren't objects are kept in the
  conversation record's skeleton.
- **Exact bytes:** for projects, artifacts and other non-conversation categories, every file and the whole original
  ZIP are stored byte-exact (Stage 1.2). For conversation exports this happens only with `--archive-original`. Without
  it, the export bytes, other files in that ZIP and attachment contents are not stored, and you should keep the original ZIPs.
- **Attachments:** only references and availability flags. Claude's provider-extracted text is stored, but files and images are not yet.
- **Completeness:** each import reconciles conversation objects (imported + failed) and nodes (messages + structural +
  unreadable) per conversation. Anything unaccounted for is an error and marks the import incomplete. Fields
  dropped by the provider *before* export can't be detected.
- **Duplicate JSON keys** inside one object keep only the last value (JSON.parse semantics).

## Stage 1.2: archival kinds and exact bytes
| kind | conversationId | messageId | holds |
|---|---|---|---|
| `export_file` | `export` | SHA-256 of the file | the exact original export file (always for archive categories; `--archive-original` for conversation exports) |
| `export_entry` | first path segment (e.g. `artifacts`) | path inside the export | exact bytes of one file; `raw` = {path, size, sha256, zip:{crc32, compressedSize, method, mtime}} |
| `project` | project uuid | — | project object (docs → `$omneme_ref`); `parts`: description, instructions (prompt_template) |
| `project_doc` | project uuid | doc uuid | embedded document, verbatim |
| `artifact` | artifact id | — | `artifact.json` manifest verbatim; flags `kind:*`, `visibility:*` |
| `artifact_version` | artifact id | version id | version object verbatim; flags `active`, `files:N` |

`blob: {sha256, size, chunks[]}` points into the encrypted, content-addressed chunk store (4 MiB chunks, deduplicated).
`export_entry.relations` link a file to an artifact and version **only** when the path segment equals an id in that
artifact's manifest. Otherwise the file is linked to the artifact only (if its manifest exists) or not at all.
A changed file at the same path in a later export is a revision (`supersedes`); identical bytes are deduplicated.

## Stage 1.3: local files and folders
| kind | conversationId | messageId | raw |
|---|---|---|---|
| `local_file` | source label (default: folder/file name; `--label`) | relative path (`/`-separated) | {relativePath, relativePathBytes?, size, sha256, mtime, birthtime, ctime, mode} + `blob` |
| `local_dir` | label | relative path | {relativePath, relativePathBytes?, mode} (keeps empty folders; no mtime, which changes constantly) |
| `local_symlink` | label | relative path | {relativePath, target, mtime}; never followed, no blob |

`provenance.importer = omneme.local-files`, and `provenance.exportLabel` = the absolute source path, which distinguishes local
files from Claude/ChatGPT export records (`omneme.claude-archive`, `omneme.chatgpt`, …). `relativePathBytes` (base64url per
segment) is present only when a name is not valid UTF-8, so it can be recreated exactly on POSIX. A changed file (bytes or
mtime) at the same label + path becomes a new version with `supersedes`. All versions are kept and extractable. atime is not
recorded (it changes on every read). Owner, ACLs, extended attributes and resource forks are **not** preserved.

## Stage 1.4: CodingCat captures
CodingCat AI Chat Exporter output (`ai-chat-exporter/conversation@1`) becomes `conversation` and `message` records with
`provider` = platform (`claude` | `chatgpt` | `gemini` | `grok`) and `provenance.importer = omneme.codingcat`, plus
`export_entry` records with exact bytes for **every** file (notes, `files/`, project knowledge, reports) and an `export_file`
for the ZIP. Captures use a separate lineage namespace (`codingcat|…`) and view key (`codingcat/<platform>:<id>`), so they
**never revise or merge with** official-export records of the same chat. Both are kept side by side; official exports stay authoritative.
- Visible branch: `messages[i].parent = messages[i-1]`, flag `current_branch`. Side branches: first message's parent =
  `forkAfterMessageId` (null = root), flags `branch` and `branch_start`.
- Attachments: `archived_in_vault` when the note's relative `path` resolves to a file in the export (linked via
  `attachment_of` on the export_entry); `missing_from_export` otherwise. The platform's `note` (`recompressed`,
  `extracted-text-only`, `rebuilt-from-chat`, `unavailable`) is kept in raw and `originalType` and reported. Those files are not byte-exact originals.
- `raw` = the note's message object verbatim; conversation `raw` = note conversation with message refs. `exportedAt` and
  the exact note bytes are in the archived note file.
- Not detectable from the output: whether the user's export settings omitted thinking, tool calls or branches. Enable them all.
