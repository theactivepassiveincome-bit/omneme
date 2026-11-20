#!/usr/bin/env node
// Omneme command-line interface. The vault is locked except while a command runs (or while
// `serve` holds it unlocked in memory).
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Vault, type Credentials } from './vault.ts';
import { importExport } from './importers/index.ts';
import { importLocal } from './importers/localFiles.ts';
import { restoreLocalFiles } from './restoreFiles.ts';
import { MemoryIndex, convKey } from './search.ts';
import { contentHash, sourceTag, type Provider } from './schema.ts';
import { startWeb } from './web.ts';
import { selectVault, resolveVaultSelection, terminalIsInteractive, askLine } from './start.ts';
import { openKit, previewBackup, advice, runBackup, checkBackups, drill, recover, latestPerDest, overdueWarnings, defaultConfigPath, type BackupConfig, type DestConfig } from './backupkit.ts';
import { serveMcp, recall, formatRecall, callTool } from './mcp.ts';
import { runAgent, callAgent, agentFile } from './agent.ts';
import { parseRemoteOptions, startRemoteMcp, remoteUsage } from './remote-mcp.ts';
import { normalise, saveHandoff, latestHandoff, formatHandoff, textHash } from './handoff.ts';
import { recoverFromUsb, vaultSummary, printSummary } from './recovery.ts';
import { MockLedgerAdapter, anchorCommitment, verifyCommitment } from './bsv/storage.ts';

const HELP = `Omneme — encrypted personal AI memory vault (Stage 1)

Usage: omneme <command> [options]

  init                               Create a vault (prints a one-time recovery key)
  import <path...> [--provider p] [--max-conversation-mb n] [--archive-original]
                                     Import ChatGPT/Claude exports (.zip, conversations.json or folder)
  stats                              Counts, date ranges and import status per provider
  imports                            Import history with status, reconciliation and errors
  list [--provider p] [--random n]   List conversations (or n random ones for spot checks)
  search <words...> [--provider p] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit n] [--json]
  show <conversation-id|record-id>   Show a conversation, all branches, with timestamps
  add <file-or-folder...> [--label name]
                                     Store personal files/folders byte-exact (any format; symlinks not followed)
  sources                            Local file sources with file/byte counts
  history <label> <relative-path>    Every stored version of one file
  restore-files <label> --to <new-folder> [--prefix sub/dir]
                                     Recreate files/folders (verified) into a new, empty folder
  projects                           Claude projects, instructions and documents
  artifacts                          Claude artifacts, versions and archived files
  files [filter]                     Archived files (exact bytes) with record ids and SHA-256
  extract <record-id> --out <path>   Write archived bytes (an export file or entry) to a NEW file (never executed)
  verify                             Decrypt and integrity-check every record and archived blob
  reset-password                     Set a new password using the recovery key (interactive terminal only;
                                     refused while the unlock agent runs; recovery key stays the same)
  backup <file>                      Write an encrypted backup
  restore <file> --target <vault>    Restore a backup into a new vault [--recovery]
  verify-backup <file>               Read and authenticate a whole backup without restoring it
Owner backup workflow (config: ~/.omneme/backup-config.json):
  backup-setup --usb <folder> [--remote <name:folder>] [--rclone <exe>] [--rclone-config <file>]
  backup-run                         New backup written straight to every available destination, each copy fully verified
  backup-check [--full]              Check every copy (full download + authentication when due or with --full)
  backup-drill                       Restore the newest backup into a temporary vault, verify, compare, remove it
  recover-usb [--from <folder>] [--target <new vault>] [--recovery] [--report <file>] [--file <name>]
                                     New computer: find the USB backups on any drive, restore the newest valid one
                                     into a NEW vault, verify every record and file, and check search
  recall <question>                  Memory lookup: conversations + excerpts (keyword-tolerant)
  handoff-save --file <json>         Save a project handoff (new record; never overwrites)
  handoff-latest [project] [--copy]  Latest handoff in copy-paste form (default project: Omneme)
  agent                              Unlock once for Claude: serves the MCP tools on 127.0.0.1 until closed
  mcp                                MCP server (stdio) for a local AI client: search_memory, get_conversation,
                                     resume_memory, save_memory. Holds no password: forwards each call to the
                                     running unlock agent (start it with "agent")
  remote-mcp --port n --token-file f [--allow-host h]... [--allow-origin o]...
                                     EXPERIMENTAL: MCP over HTTP on 127.0.0.1 for Muse (search/resume/save via the running unlock agent;
                                     bearer token from file; never opens the vault)
  vault-compare --other <vault> [--out <file>]  Compare two vaults (one password prompt)
  vault-summary [--json] [--out <file>]  Content-free summary and fingerprints of a vault (to compare two vaults)
  backup-preview [--usb <folder>] [--existing <folder>]  Read-only preview of the next backup (no password, nothing written)
  backup-status                      Latest backup per destination and overdue warnings
  backup-recover --target <vault>    New-machine recovery from the newest verified copy
  serve [--port 8765]                Local web UI on 127.0.0.1 (Ctrl-C to stop and lock)
  anchor <file> [--ledger dir]       MOCK BSV commitment of a file's SHA-256 (no network)
  verify-anchor <txid> <file> [--ledger dir]

Global: --vault <path>  (default: $OMNEME_VAULT or ~/.omneme/vault.omneme; for agent, backup-run, backup-preview
                        and backup-drill, like Omneme Start: the earlier first-run vault if it is the only one, and a
                        choice if both exist; these commands show the selected vault file)
        --recovery      unlock with the recovery key instead of the password
Passwords are read from the terminal. OMNEME_PASSWORD / OMNEME_RECOVERY_KEY are accepted for automation and tests only.`;

/** Strip terminal control sequences and bidi overrides from untrusted imported text before printing. */
const safe = (s: unknown) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '�');

async function prompt(q: string, hidden: boolean): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) { rl.close(); return line; }
    return '';
  }
  process.stderr.write(q);
  return new Promise((res, rej) => {
    const stdin = process.stdin; let buf = '';
    stdin.setRawMode(hidden); stdin.resume(); stdin.setEncoding('utf8');
    const onData = (s: string) => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stderr.write('\n'); return res(buf); }
        if (ch === '\u0003') { stdin.setRawMode(false); process.stderr.write('\n'); return rej(new Error('Cancelled')); }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1); else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function credentials(recovery: boolean): Promise<Credentials> {
  if (recovery) return { recoveryKey: process.env.OMNEME_RECOVERY_KEY ?? await prompt('Recovery key: ', true) };
  return { password: process.env.OMNEME_PASSWORD ?? await prompt('Vault password: ', true) };
}

/** OMNEME_KDF_N (test-strength only in test mode), shared by init and reset-password. */
function kdfNFromEnv(): number | undefined {
  const kdfN = process.env.OMNEME_KDF_N ? Number(process.env.OMNEME_KDF_N) : undefined;
  if (kdfN !== undefined && kdfN < 2 ** 17 && process.env.OMNEME_TEST_MODE !== '1')
    throw new Error('OMNEME_KDF_N below 131072 is only allowed in test mode (OMNEME_TEST_MODE=1)');
  return kdfN;
}

/** True if the unlock agent's session file names a live process (a stale file from a dead process is ignored). */
function agentRunning(): boolean {
  const f = agentFile();
  if (!existsSync(f)) return false;
  let pid: unknown;
  try { pid = JSON.parse(readFileSync(f, 'utf8')).pid; } catch { return true; } // unreadable: assume running
  if (!Number.isInteger(pid) || (pid as number) <= 0) return true;
  try { process.kill(pid as number, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Commands that choose their vault like Omneme Start (OMN-033, extended in OMN-034). */
const SHARED_VAULT_COMMANDS: readonly string[] = ['agent', 'backup-run', 'backup-preview', 'backup-drill'];

async function main(argv: string[]) {
  const { values: o, positionals: pos } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      vault: { type: 'string' }, provider: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
      limit: { type: 'string' }, json: { type: 'boolean' }, target: { type: 'string' }, recovery: { type: 'boolean' },
      port: { type: 'string' }, ledger: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      'token-file': { type: 'string' }, 'allow-host': { type: 'string', multiple: true }, 'allow-origin': { type: 'string', multiple: true },
      random: { type: 'string' }, usb: { type: 'string' }, remote: { type: 'string' }, rclone: { type: 'string' }, 'rclone-config': { type: 'string' }, full: { type: 'boolean' }, yes: { type: 'string' }, 'no-drill': { type: 'boolean' }, drill: { type: 'boolean' }, existing: { type: 'string' }, dest: { type: 'string' }, label: { type: 'string' }, to: { type: 'string' }, prefix: { type: 'string' }, 'max-conversation-mb': { type: 'string' }, 'archive-original': { type: 'boolean' }, out: { type: 'string' }, report: { type: 'string' }, file: { type: 'string' }, other: { type: 'string' }, receipt: { type: 'string' }, copy: { type: 'boolean' },
    },
  });
  const [cmd, ...args] = pos;
  if (!cmd || o.help) { console.log(HELP); return 0; }
  // OMN-033/034: `agent` (Omneme Unlock), `backup-run` (Omneme Backup), `backup-preview` and `backup-drill` share
  // Omneme Start's vault rule (--vault, then OMNEME_VAULT, then main / legacy first-run; both → deliberate choice or
  // a clear failure). Every other command keeps its existing default.
  const sharedRule = SHARED_VAULT_COMMANDS.includes(cmd);
  const vaultPath = sharedRule
    ? await resolveVaultSelection(selectVault(o.vault, process.env), `node "${process.argv[1] ?? 'omneme.mjs'}" ${cmd}`, { interactive: terminalIsInteractive(), ask: askLine })
    : resolve(o.vault ?? process.env.OMNEME_VAULT ?? join(homedir(), '.omneme', 'vault.omneme'));
  // OMN-034: name the selected vault file before anything is opened (backup-preview prints it in its own report).
  if (sharedRule && cmd !== 'backup-preview') console.log(`Vault file: ${vaultPath}`);
  const provider = o.provider as Provider | 'auto' | undefined;
  if (provider && !['auto', 'chatgpt', 'claude', 'gemini', 'grok', 'x'].includes(provider)) throw new Error('--provider must be auto, chatgpt, claude, gemini, grok or x');
  const ledger = resolve(o.ledger ?? join(homedir(), '.omneme', 'mock-ledger'));

  const withVault = async <T>(fn: (v: Vault) => Promise<T> | T): Promise<T> => {
    const v = await Vault.unlock(vaultPath, await credentials(!!o.recovery));
    try { return await fn(v); } finally { v.lock(); }
  };

  switch (cmd) {
    case 'init': {
      let pw = process.env.OMNEME_PASSWORD;
      if (!pw) {
        pw = await prompt('New vault password (min 8 chars): ', true);
        if ((await prompt('Repeat password: ', true)) !== pw) throw new Error('Passwords do not match');
      }
      const kdfN = kdfNFromEnv();
      const { vault, recoveryKey } = await Vault.create(vaultPath, pw, { kdfN });
      vault.lock();
      console.log(`Vault created: ${vaultPath}`);
      console.log('\nRECOVERY KEY (shown once — write it down and store it offline, separately from your password):\n');
      console.log('  ' + recoveryKey + '\n');
      console.log('If you lose BOTH the password and this key, the vault cannot be recovered by anyone.');
      return 0;
    }
    case 'import': {
      if (!args.length) throw new Error('import requires at least one path');
      let failed = false;
      const mb = o['max-conversation-mb'] ? Number(o['max-conversation-mb']) : 256;
      if (!(mb > 0)) throw new Error('--max-conversation-mb must be a positive number');
      await withVault(async (v) => {
        for (const p of args) {
          const r = await importExport(v, resolve(p), { provider: (provider ?? 'auto') as 'auto' | Provider, json: { maxDepth: 512, maxElementBytes: mb * 2 ** 20 }, archiveOriginal: !!o['archive-original'] });
          console.log(`\n${safe(r.exportLabel)}  (import ${r.importId})`);
          if (r.originalArchived) console.log(`  original file:  archived byte-exact (${r.originalArchived.size} bytes, sha256 ${r.originalArchived.sha256.slice(0, 16)}…)`);
          if (r.capture) {
            const c = r.capture;
            console.log(`  capture:       CodingCat export · ${c.entriesArchived}/${c.entries} files archived byte-exact (${c.bytesArchived} bytes)`);
            console.log(`  notes:         ${c.notesJson} JSON parsed (${Object.entries(c.platforms).map(([k, n]) => `${k}=${n}`).join(' ') || 'none'}), ${c.notesNotJson} Markdown/HTML/DOCX archived only, ${c.projectNotes} project notes archived`);
            console.log(`  conversations: ${r.conversationsSeen} seen, ${r.conversationsNew} new, ${r.conversationsRevised} revised, ${r.conversationsUnchanged} unchanged`);
            console.log(`  messages:      ${r.messagesSeen} seen (${c.branches} side branches, ${c.branchMessages} branch messages), ${r.messagesInserted} new, ${r.messagesRevised} revised, ${r.messagesDuplicate} already present`);
            console.log(`  attachments:   ${c.attachmentsSaved} saved and archived, ${c.attachmentsNotProvided} not provided by platform, ${c.attachmentsListedButMissing} listed but missing from export`);
            console.log('  note:          CodingCat output is a normalized capture; official exports remain the authoritative record');
          } else if (r.social) {
            const x = r.social;
            console.log('  X archive:     POSTS ONLY. This is not a complete copy of the X account (see "not imported" below).');
            console.log(`  posts:         ${x.postsSeen} read (${x.notes} long-form notes, ${x.deleted} deleted posts), ${x.postsNew} new, ${x.postsRevised} revised, ${x.postsDuplicate} already present, ${x.malformed} malformed`);
            console.log(`  media:         ${x.mediaReferenced} referenced in the archive, ${x.mediaMissing} not in the export; media files are NOT copied into the vault, keep the original ZIP`);
            console.log(`  not imported:  ${x.notImported.length} other data file(s) (${x.notImported.reduce((n, e) => n + e.bytes, 0)} bytes), e.g. DMs, Grok chats, likes; ${x.mediaFiles.files} media files (${x.mediaFiles.bytes} bytes); ${x.viewerAssets.files} archive viewer files (not user data)`);
          } else if (r.archive) {
            const a = r.archive;
            console.log(`  archive:       ${a.entriesArchived}/${a.entries} files archived byte-exact (${a.bytesArchived} bytes)`);
            console.log(`  projects:      ${a.projects} projects, ${a.projectDocs} documents, ${a.promptTemplates} with instructions`);
            console.log(`  artifacts:     ${a.artifacts} artifacts, ${a.versionsListed} versions listed (${a.versionsWithFiles} with files), ${a.filesLinkedToVersion} files linked to versions`);
            console.log(`  records:       ${r.messagesInserted} new, ${r.messagesRevised} revised, ${r.messagesDuplicate} already present`);
          } else {
          console.log(`  conversations: ${r.conversationsSeen} seen, ${r.conversationsNew} new, ${r.conversationsRevised} revised, ${r.conversationsUnchanged} unchanged`);
          console.log(`  messages:      ${r.messagesSeen} seen, ${r.messagesInserted} new, ${r.messagesRevised} revised, ${r.messagesDuplicate} already present`);
          }
          if (!r.archive && !r.social) console.log(`  reconciliation: ${r.elementsSeen} conversation objects in source = ${r.conversationsSeen} imported + ${r.conversationsFailed} failed; ${r.sourceUnits} source nodes = ${r.messagesSeen} messages + ${r.structuralNodes} structural + ${r.skippedUnits} unreadable`);
          if (!r.archive && !r.social) console.log(`  providers:     ${Object.entries(r.providers).map(([k, n]) => `${k}=${n}`).join(' ') || 'none'}`);
          const at = r.attachments;
          if (!r.archive && !r.social) console.log(`  attachments:   ${at.text_extracted} text extracted, ${at.referenced_in_export} in export (bytes not vaulted), ${at.missing_from_export} missing from export, ${at.metadata_only} metadata only`);
          const where = (e: { entry: string; index: number | null; offset?: number | null; conversationId?: string | null }) =>
            `${safe(e.entry)}${e.index !== null ? ` #${e.index}` : ''}${e.offset != null ? ` @byte ${e.offset}` : ''}${e.conversationId ? ` conv ${safe(e.conversationId)}` : ''}`;
          for (const e of r.errors) console.log(`  ERROR   ${where(e)}: ${safe(e.reason)}`);
          for (const w of r.warnings.slice(0, 20)) console.log(`  warning ${where(w)}: ${safe(w.reason)}`);
          if (r.warnings.length > 20) console.log(`  … ${r.warnings.length - 20} more warnings`);
          console.log(r.complete ? '  status:        complete' : '  status:        INCOMPLETE — see errors above (everything readable was imported)');
          if (!r.complete) failed = true;
        }
      });
      return failed ? 2 : 0;
    }
    case 'stats': return withVault((v) => {
      const s = new MemoryIndex(v.loadAll()).stats();
      console.log(`Conversations: ${s.conversations}\nMessages:      ${s.messages}\nImports:       ${s.imports}${s.importsNotComplete ? ` (${s.importsNotComplete} NOT complete — run "omneme imports")` : ''}\nStored records: ${s.records} (${s.revisedRecords} with earlier revisions)`);
      for (const [p, c] of Object.entries(s.perProvider))
        console.log(`  ${p}: ${c.conversations} conversations, ${c.messages} messages, ${c.earliest?.slice(0, 10) ?? '?'} → ${c.latest?.slice(0, 10) ?? '?'}${c.undated ? `, ${c.undated} without timestamp` : ''}`);
      if (s.socialEvents) console.log(`Social posts:  ${s.socialEvents} (X; not counted as conversations or messages)`);
      if (s.localFiles) console.log(`Local files: ${s.localFiles} (${s.localBytes} bytes) in ${s.localSources} source(s)`);
      if (s.projects || s.artifacts || s.archivedFiles || s.originalExports)
        console.log(`Projects: ${s.projects} (${s.projectDocs} documents) · Artifacts: ${s.artifacts} (${s.artifactVersions} versions) · Archived files: ${s.archivedFiles} (${s.archivedBytes} bytes) · Original export files: ${s.originalExports}`);
      const kdf = v.header.slots.find((x) => x.type === 'password')?.kdf;
      if (kdf && kdf.N < 2 ** 17) console.log(`WARNING: this vault uses test-strength KDF parameters (N=${kdf.N}); do not store real data in it.`);
      return 0;
    });
    case 'imports': return withVault((v) => {
      for (const i of new MemoryIndex(v.loadAll()).imports()) {
        const r = i.report ?? {};
        const what = r.category === 'local' ? `local files "${safe(r.exportLabel)}": ${r.filesSeen} files, ${r.filesNew} new, ${r.filesRevised} changed` : `${safe(i.exportLabel)}  sha256 ${i.exportSha256?.slice(0, 16) ?? '-'}…  ${r.conversationsSeen ?? 0} conversations, ${r.messagesSeen ?? 0} messages`;
        console.log(`${i.startedAt}  ${i.status.toUpperCase().padEnd(11)} ${what}, ${(r.errors ?? []).length} errors`);
        for (const e of (r.errors ?? []).slice(0, 10)) console.log(`    ERROR ${safe(e.entry)}${e.index != null ? ` #${e.index}` : ''}${e.offset != null ? ` @byte ${e.offset}` : ''}: ${safe(e.reason)}`);
        if (i.status === 'interrupted') console.log('    This import never finished (process stopped). Re-run the same import; existing records are kept and duplicates skipped.');
      }
      return 0;
    });
    case 'list': return withVault((v) => {
      const ix = new MemoryIndex(v.loadAll());
      const list = o.random ? ix.randomConversations(Number(o.random)) : ix.listConversations(provider === 'auto' ? undefined : provider as Provider);
      for (const c of list)
        console.log(`${c.createdAt ?? '(no date)'}  ${safe(convKey(c))}  ${safe(c.title ?? '(untitled)')}`);
      return 0;
    });
    case 'recall': { // natural-language memory lookup (same engine the MCP tool uses)
      if (!args.length) throw new Error('recall requires a query');
      return withVault((v) => { const q = args.join(' '); console.log(formatRecall(q, recall(new MemoryIndex(v.loadAll()), q, { limit: o.limit ? Number(o.limit) : 5 }))); return 0; });
    }
    case 'mcp': { // MCP server on stdio. Without a password it forwards to the unlock agent ("omneme agent").
      if (!process.env.OMNEME_PASSWORD && !process.env.OMNEME_RECOVERY_KEY) {
        console.error('omneme mcp: forwarding to the Omneme unlock agent (no password here)');
        serveMcp(callAgent, { version: '0.3' }); await new Promise(() => {}); return 0;
      }
      const v = await Vault.unlock(vaultPath, await credentials(!!o.recovery)); const records = v.loadAll();
      const ix = new MemoryIndex(records); const store = { vault: v, records };
      console.error(`omneme mcp: ready (${ix.stats().messages} messages)`);
      serveMcp(async (n, a) => callTool(n, a, ix, store), { version: '0.3' }); await new Promise(() => {}); return 0;
    }
    case 'agent': { // unlock once; serve Claude's MCP tools on 127.0.0.1 until this window is closed
      const v = await Vault.unlock(vaultPath, await credentials(!!o.recovery));
      await runAgent(v, (t) => console.log(t)); return 0;
    }
    case 'remote-mcp': { // OMN-036: HTTP MCP for Muse; forwards to the unlock agent, never opens the vault or reads a password
      if (args.length) throw new Error('remote-mcp takes no positional arguments');
      const cfg = parseRemoteOptions({ port: o.port, tokenFile: o['token-file'], allowHost: o['allow-host'], allowOrigin: o['allow-origin'] });
      const srv = await startRemoteMcp({ ...cfg, call: callAgent, log: (t) => console.log(t), version: '0.3' });
      for (const line of remoteUsage(srv)) console.log(line);
      await new Promise<void>((r) => process.once('SIGINT', () => r()));
      await srv.close();
      return 0;
    }
    case 'handoff-save': { // save a project handoff from a JSON file: {project,status,decisions[],completed[],outstanding[],next,source}
      if (!o.file) throw new Error('handoff-save needs --file <handoff.json>');
      const h = normalise(JSON.parse(readFileSync(resolve(o.file), 'utf8')), 'claude');
      return withVault((v) => {
        const r = saveHandoff(v, h);
        console.log(`Saved handoff for "${h.project}" (${h.source}, ${h.savedAt}). sha256 ${r.sha256}`);
        if (o.receipt) writeFileSync(resolve(o.receipt), JSON.stringify({ action: 'save', project: h.project, savedAt: h.savedAt, source: h.source, sha256: r.sha256 }, null, 1));
        return 0;
      });
    }
    case 'handoff-latest': { // print the latest handoff for a project in a copy-paste format (and copy it on Windows with --copy)
      const project = args.join(' ') || 'Omneme';
      return withVault((v) => {
        const h = latestHandoff(v.loadAll(), project);
        if (!h) { console.log(`No saved handoff for "${project}".`); return 3; }
        const t = formatHandoff(h); console.log('\n' + t);
        if (o.copy && process.platform === 'win32') {
          spawnSync('clip', { input: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')]) });
          console.log('(Copied to the clipboard: paste it into ChatGPT.)');
        }
        if (o.receipt) writeFileSync(resolve(o.receipt), JSON.stringify({ action: 'resume', project: h.project, savedAt: h.savedAt, source: h.source, sha256: textHash(t) }, null, 1));
        return 0;
      });
    }
    case 'search': {
      if (!args.length) throw new Error('search requires keywords');
      return withVault((v) => {
        const hits = new MemoryIndex(v.loadAll()).search({
          text: args.join(' '), provider: provider === 'auto' ? undefined : provider as Provider, from: o.from, to: o.to, limit: o.limit ? Number(o.limit) : 50,
        });
        if (o.json) { console.log(JSON.stringify(hits.map((h) => ({ recordId: h.record.recordId, provider: h.record.provider, conversationId: h.record.conversationId, messageId: h.record.messageId, role: h.record.role, createdAt: h.record.createdAt, title: h.conversationTitle, snippet: h.snippet, provenance: h.record.provenance })), null, 2)); return 0; }
        for (const h of hits) {
          console.log(`\n[${h.record.provider}${sourceTag(h.record) ? ' via CodingCat' : ''}] ${safe(h.conversationTitle ?? '(untitled)')}  ${h.record.createdAt ?? '(no date)'}  ${h.record.role}`);
          console.log(h.record.kind === 'social_event'
            ? `  source: ${safe(h.record.provider)} post ${safe(h.record.messageId)} (account ${safe(h.record.conversationId)}, ${h.record.recordId}) from ${safe(h.record.provenance.exportLabel)}/${safe(h.record.provenance.exportEntry)}`
            : `  source: conversation ${safe(h.record.conversationId)} message ${safe(h.record.messageId)} (${h.record.recordId}) from ${safe(h.record.provenance.exportLabel)}/${safe(h.record.provenance.exportEntry)}`);
          console.log('  ' + safe(h.snippet));
        }
        console.log(`\n${hits.length} result(s)`);
        return 0;
      });
    }
    case 'show': {
      if (!args[0]) throw new Error('show requires a conversation id or record id');
      return withVault((v) => {
        const view = new MemoryIndex(v.loadAll()).conversation(args[0]);
        if (!view) { console.error('Conversation not found'); return 1; }
        const c = view.conversation;
        console.log(`# ${safe(c?.title ?? view.messages[0]?.record.title ?? '(untitled)')}\n${c ? safe(convKey(c)) : view.messages[0]?.record.kind === 'social_event' ? 'social post (' + safe(view.messages[0].record.provider) + ')' : '?'}  created ${c?.createdAt ?? view.messages[0]?.record.createdAt ?? 'unknown'}  updated ${c?.updatedAt ?? view.messages[0]?.record.updatedAt ?? 'unknown'}\n`);
        for (const { record: m, depth, siblings, position } of view.messages) {
          const ind = '  '.repeat(Math.min(depth, 10));
          const tags = [siblings > 1 ? `branch ${position}/${siblings}` : '', m.flags.includes('current_branch') ? 'current' : '', m.flags.includes('hidden') ? 'hidden' : '', m.model ?? ''].filter(Boolean).join(', ');
          console.log(`${ind}── ${m.role ?? 'unknown'} · ${m.createdAt ?? 'no timestamp'}${tags ? ` · ${tags}` : ''} · ${m.recordId}`);
          for (const line of safe(m.text || '(no text content)').split('\n')) console.log(`${ind}   ${line}`);
          for (const a of m.attachments) console.log(`${ind}   [attachment] ${safe(a.name ?? a.ref ?? a.id)} — ${a.availability}`);
        }
        return 0;
      });
    }
    case 'add': {
      if (!args.length) throw new Error('add requires at least one file or folder');
      if (o.label && args.length > 1) throw new Error('--label can only be used with a single path');
      let failed = false;
      await withVault(async (v) => {
        for (const p of args) {
          const r = await importLocal(v, resolve(p), { label: o.label });
          console.log(`\n${safe(r.exportLabel)}  (source ${safe(r.sourcePath)}, import ${r.importId})`);
          console.log(`  files:     ${r.filesSeen} seen, ${r.filesNew} new, ${r.filesRevised} changed (new version kept), ${r.filesUnchanged} unchanged`);
          console.log(`  bytes:     ${r.bytesSeen} read, ${r.newBytes} newly stored, ${r.reusedChunks} chunk(s) deduplicated`);
          console.log(`  folders:   ${r.dirs} · symlinks recorded (not followed): ${r.symlinks} · special files skipped: ${r.skippedSpecial}${r.skippedVaultFiles ? ` · vault files skipped: ${r.skippedVaultFiles}` : ''}`);
          for (const e of r.errors) console.log(`  ERROR   ${safe(e.entry)}: ${safe(e.reason)}`);
          for (const w of r.warnings.slice(0, 20)) console.log(`  warning ${safe(w.entry)}: ${safe(w.reason)}`);
          if (r.warnings.length > 20) console.log(`  … ${r.warnings.length - 20} more warnings`);
          console.log(r.complete ? '  status:    complete' : '  status:    INCOMPLETE — see errors above');
          if (!r.complete) failed = true;
        }
      });
      return failed ? 2 : 0;
    }
    case 'sources': return withVault((v) => {
      for (const s of new MemoryIndex(v.loadAll()).localSources()) console.log(`${safe(s.label)}  ${s.files} files, ${s.bytes} bytes, ${s.dirs} folders, ${s.symlinks} symlinks`);
      return 0;
    });
    case 'history': {
      if (!args[0] || !args[1]) throw new Error('history requires <label> <relative-path>');
      return withVault((v) => {
        const h = new MemoryIndex(v.loadAll()).history(args[0], args[1]);
        if (!h.length) { console.error('No such file in that source'); return 1; }
        for (const r of h) console.log(`${r.importedAt}  ${r.recordId}  ${String(r.blob?.size).padStart(12)}  sha256 ${r.blob?.sha256}  mtime ${(r.raw as any)?.mtime ?? '?'}`);
        return 0;
      });
    }
    case 'restore-files': {
      if (!args[0] || !o.to) throw new Error('restore-files requires <label> --to <new-folder>');
      return withVault((v) => {
        const ix = new MemoryIndex(v.loadAll());
        const recs = ix.localRecords(args[0]);
        if (!recs.length) { console.error('No local source with that label (see "omneme sources")'); return 1; }
        const rep = restoreLocalFiles(v, recs, o.to!, o.prefix ?? '');
        console.log(`Restored ${rep.files} files (${rep.bytes} bytes, SHA-256 verified) and ${rep.dirs} folders into ${resolve(o.to!)}`);
        for (const l of rep.symlinksListed) console.log(`  symlink not recreated: ${safe(l)}`);
        for (const sk of rep.skipped) console.log(`  SKIPPED ${safe(sk.path)}: ${sk.reason}`);
        for (const f of rep.failed) console.log(`  FAILED  ${safe(f.path)}: ${safe(f.reason)}`);
        return rep.failed.length || rep.skipped.length ? 2 : 0;
      });
    }
    case 'projects': return withVault((v) => {
      for (const { project: p, docs } of new MemoryIndex(v.loadAll()).projects()) {
        console.log(`\n# ${safe(p.title ?? '(unnamed)')}  claude:${safe(p.conversationId)}  created ${p.createdAt ?? '?'}  updated ${p.updatedAt ?? '?'}${p.flags.length ? '  [' + p.flags.join(', ') + ']' : ''}`);
        for (const part of p.parts) console.log(`  ${part.type}:\n` + safe(part.text).split('\n').map((l) => '    ' + l).join('\n'));
        for (const d of docs) console.log(`  doc ${safe(d.title ?? d.messageId)}  ${d.createdAt ?? '?'}  ${d.text.length} chars  ${d.recordId}`);
      }
      return 0;
    });
    case 'artifacts': return withVault((v) => {
      for (const { artifact: a, versions, files } of new MemoryIndex(v.loadAll()).artifacts()) {
        console.log(`\n# ${safe(a.title ?? '(untitled)')}  ${safe(a.conversationId)}  ${a.flags.join(' ')}  updated ${a.updatedAt ?? '?'}`);
        for (const ver of versions) console.log(`  version ${safe(ver.messageId)}${ver.flags.includes('active') ? ' (active)' : ''}  ${ver.createdAt ?? '?'}  ${safe(ver.title ?? '')}  ${ver.flags.find((f) => f.startsWith('files:'))}`);
        for (const f of files) console.log(`    file ${safe(f.messageId)}  ${f.blob?.size} bytes  sha256 ${f.blob?.sha256.slice(0, 16)}…  ${f.recordId}`);
      }
      return 0;
    });
    case 'files': return withVault((v) => {
      for (const f of new MemoryIndex(v.loadAll()).blobRecords()) {
        if (args[0] && !(f.messageId ?? f.title ?? '').includes(args[0])) continue;
        console.log(`${f.recordId}  ${f.kind.padEnd(12)} ${String(f.blob!.size).padStart(10)}  ${f.blob!.sha256}  ${safe(f.kind === 'export_file' ? f.title : f.kind === 'local_file' ? `${f.conversationId}/${f.messageId}` : f.messageId)}`);
      }
      return 0;
    });
    case 'extract': {
      if (!args[0] || !o.out) throw new Error('extract requires <record-id> --out <new-file>');
      const out = resolve(o.out);
      if (existsSync(out)) throw new Error('Output file already exists; choose a new path');
      return withVault((v) => {
        const r = new MemoryIndex(v.loadAll()).all.find((x) => x.recordId === args[0] && x.blob); // any version, not only the latest
        if (!r?.blob) { console.error('No archived file with that record id'); return 1; }
        const tmp = out + '.partial';
        const fd = openSync(tmp, 'wx', 0o600);
        try { for (const b of v.readBlob(r.blob)) writeSync(fd, b); } catch (e) { closeSync(fd); rmSync(tmp, { force: true }); throw e; }
        closeSync(fd); renameSync(tmp, out);
        console.log(`Wrote ${r.blob.size} bytes (sha256 verified) to ${out}`);
        if (/\.(html?|js|mjs|svg)$/i.test(out)) console.log('Note: this is exported code/markup. Inspect it as text; opening it in a browser runs it.');
        return 0;
      });
    }
    case 'verify': return withVault((v) => {
      const r = v.verify(contentHash);
      console.log(`Records: ${r.total} (expected ${r.expected}), verified: ${r.ok}, failed: ${r.failed}, archived blobs: ${r.blobs} (${r.blobsFailed} failed), record set: ${r.recordSetOk ? 'intact' : 'MISMATCH (records missing, added or rolled back)'}`);
      return r.failed || !r.recordSetOk ? 3 : 0;
    });
    case 'reset-password': {
      // OMN-025. Secrets only from the terminal with echo off: never from arguments or environment variables.
      if (args.length) throw new Error('reset-password takes no arguments; secrets are prompted for');
      if (!process.stdin.isTTY) throw new Error('reset-password must be run interactively in a terminal');
      if (!existsSync(vaultPath)) throw new Error('No vault found at that path');
      if (agentRunning()) throw new Error('The Omneme unlock agent is running. In the terminal running "node bin/omneme.mjs agent", press Ctrl+C or close that terminal, then retry.');
      const kdfN = kdfNFromEnv();
      const recoveryKey = await prompt('Recovery key: ', true);
      const newPassword = await prompt('New vault password (min 8 chars): ', true);
      const confirmPassword = await prompt('Repeat new password: ', true);
      if (agentRunning()) throw new Error('The Omneme unlock agent started during the reset; nothing was changed. Stop it (Ctrl+C or close its terminal), then retry.');
      await Vault.resetPassword(vaultPath, { recoveryKey, newPassword, confirmPassword, kdfN });
      console.log('Password reset. Unlock with the new password from now on; the recovery key is unchanged and still valid.');
      return 0;
    }
    case 'backup': {
      if (!args[0]) throw new Error('backup requires an output file');
      return withVault((v) => { const r = v.exportBackup(resolve(args[0])); console.log(`Encrypted backup written: ${resolve(args[0])} (${r.records} records)`); return 0; });
    }
    case 'verify-backup': {
      if (!args[0]) throw new Error('verify-backup requires a backup file');
      const r = await Vault.verifyBackup(resolve(args[0]), await credentials(!!o.recovery));
      console.log(`Backup OK: ${r.records} records, ${r.chunks} chunks, ${r.size} bytes, sha256 ${r.sha256}`);
      return 0;
    }
    case 'backup-setup': {
      const cfgPath = defaultConfigPath();
      if (existsSync(cfgPath)) throw new Error(`A backup configuration already exists at ${cfgPath}; edit it or move it aside first`);
      if (!o.usb && !o.remote) throw new Error('backup-setup needs --usb <folder> and/or --remote <name:folder>');
      const destinations: DestConfig[] = [];
      if (o.usb) destinations.push({ name: 'usb', kind: 'folder', path: resolve(o.usb), offline: true, overdueDays: 7, label: 'USB drive' });
      if (o.remote) destinations.push({ name: 'cloud', kind: 'rclone', remote: o.remote, overdueDays: 7, label: 'Cloud' });
      const cfg: BackupConfig = { version: 1, destinations, rclone: o.rclone, rcloneConfig: o['rclone-config'], fullCheckDays: 30, drillDays: 30 };
      mkdirSync(dirname(cfgPath), { recursive: true });
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { flag: 'wx', mode: 0o600 });
      console.log(`Backup configuration written: ${cfgPath}`);
      return 0;
    }
    case 'vault-summary': return withVault((v) => {
      const s = vaultSummary(v);
      if (o.json) console.log(JSON.stringify(s, null, 2)); else printSummary((t) => console.log(t), s);
      if (o.out) writeFileSync(resolve(o.out), JSON.stringify(s, null, 2));
      return s.failed || !s.recordSetOk || s.archivedFilesFailed ? 3 : 0;
    });
    case 'vault-compare': {
      // Compare two vaults with one password prompt: content-free summaries and fingerprints must be identical.
      if (!o.other) throw new Error('vault-compare needs --other <second vault>');
      const creds = await credentials(!!o.recovery);
      const sum = async (p: string) => { const v = await Vault.unlock(p, creds); try { return vaultSummary(v); } finally { v.lock(); } };
      const a = await sum(vaultPath), b = await sum(resolve(o.other));
      console.log(`Vault A: ${vaultPath}`); printSummary((t) => console.log(t), a);
      console.log(`Vault B: ${resolve(o.other)}`); printSummary((t) => console.log(t), b);
      const diff = Object.keys(a).filter((k) => JSON.stringify((a as any)[k]) !== JSON.stringify((b as any)[k]));
      const ok = !diff.length && !a.failed && !b.failed && !a.archivedFilesFailed && !b.archivedFilesFailed && a.recordSetOk && b.recordSetOk;
      console.log(ok ? 'RESULT: IDENTICAL (every record, archived file and search entry matches; no integrity errors)' : `RESULT: DIFFERENT in ${diff.join(', ') || 'integrity'}`);
      if (o.out) writeFileSync(resolve(o.out), JSON.stringify({ comparedAt: new Date().toISOString(), a: { path: vaultPath, ...a }, b: { path: resolve(o.other), ...b }, identical: ok, differences: diff }, null, 2));
      return ok ? 0 : 3;
    }
    case 'recover-usb': {
      // Target: the normal vault location if it is free, otherwise a new, uniquely named vault next to it.
      const home = join(homedir(), '.omneme');
      const target = o.target ? resolve(o.target)
        : existsSync(join(home, 'vault.omneme')) ? join(home, `vault-recovered-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}.omneme`) : join(home, 'vault.omneme');
      try {
        await recoverFromUsb({ say: (t) => console.log(t), credentials: () => credentials(!!o.recovery), from: o.from ? resolve(o.from) : undefined,
          target, report: o.report ? resolve(o.report) : `${target}.recovery-report.json`, file: o.file });
        if (target !== join(home, 'vault.omneme')) console.log(`Note: to use it as your main vault, set OMNEME_VAULT=${target} or pass --vault "${target}".`);
        return 0;
      } catch (e) { console.log(`\nRECOVERY DID NOT COMPLETE: ${(e as Error).message}`); return 2; }
    }
    case 'backup-preview': {
      const r = previewBackup({ say: (t) => console.log(t), vaultPath, usb: o.usb ? resolve(o.usb) : undefined, existingDir: o.existing ? resolve(o.existing) : undefined });
      return r.ok ? 0 : 3;
    }
    case 'backup-run': case 'backup-check': case 'backup-drill': case 'backup-status': case 'backup-recover': {
      const logFile = process.env.OMNEME_BACKUP_LOG;
      const ui = { say: (t: string) => { console.log(t); if (logFile) appendFileSync(logFile, `${new Date().toISOString()} ${cmd} ${t}\n`); }, ask: (q: string) => prompt(q, false), credentials: () => credentials(!!o.recovery) };
      const k = openKit(ui, vaultPath);
      if (cmd === 'backup-run') {
        const yes = (o.yes ?? process.env.OMNEME_BACKUP_ASSUME_YES ?? '').split(',').filter(Boolean);
        const r = await runBackup(k, { assumeYes: yes, drill: o['no-drill'] ? false : o.drill || yes.length ? true : 'ask' });
        return r.results.some((x) => x.status === 'OK') && !r.results.some((x) => x.status === 'FAILED') ? 0 : r.results.some((x) => x.status === 'OK') ? 3 : 2;
      }
      if (cmd === 'backup-check') { const r = await checkBackups(k, { full: !!o.full }); return r.items.every((i) => i.status.startsWith('OK')) && !r.unavailable.length ? 0 : 3; }
      if (cmd === 'backup-drill') { await drill(k, { dest: o.dest }); return 0; }
      if (cmd === 'backup-status') {
        const l = await latestPerDest(k);
        for (const d of k.cfg.destinations) { const x = l[d.name]; console.log(`  ${d.name}: ${x === 'unavailable' ? 'not connected' : x ? `latest ${x.file} (${x.createdAt})` : 'no backups yet'}`); }
        const w = await overdueWarnings(k); if (!w.length) console.log('No overdue destinations.');
        console.log(k.state.lastDrill ? `Last restore drill: ${k.state.lastDrill.at} ${k.state.lastDrill.result}` : 'No restore drill yet.');
        advice(k);
        return w.length ? 3 : 0;
      }
      if (!o.target) throw new Error('backup-recover requires --target <new vault path>');
      await recover(k, resolve(o.target), { dest: o.dest });
      return 0;
    }
    case 'restore': {
      if (!args[0] || !o.target) throw new Error('restore requires <file> --target <new-vault-path>');
      const r = await Vault.restoreBackup(resolve(args[0]), resolve(o.target), await credentials(!!o.recovery));
      console.log(`Restored ${r.records} records and ${r.chunks} archived-file chunks into ${resolve(o.target)}`);
      return 0;
    }
    case 'serve': {
      const web = await startWeb({ vaultPath, port: o.port ? Number(o.port) : 8765 });
      console.log(`Omneme web UI: ${web.url}  (local only; Ctrl-C to stop and lock)`);
      await new Promise<void>((r) => process.once('SIGINT', () => r()));
      await web.close();
      return 0;
    }
    case 'anchor': {
      if (!args[0]) throw new Error('anchor requires a file');
      const r = await anchorCommitment(new MockLedgerAdapter(ledger), readFileSync(resolve(args[0])));
      console.log(`MOCK anchor (no blockchain transaction was made)\n  digest: ${r.digest}\n  txid:   ${r.txid}\n  ledger: ${ledger}`);
      return 0;
    }
    case 'verify-anchor': {
      if (!args[0] || !args[1]) throw new Error('verify-anchor requires <txid> <file>');
      const r = await verifyCommitment([new MockLedgerAdapter(ledger)], args[0], readFileSync(resolve(args[1])));
      console.log(r.ok ? `OK: file matches commitment (source: ${r.source})` : `FAILED: ${r.reason ?? 'digest mismatch'}`);
      return r.ok ? 0 : 4;
    }
    default:
      console.error(`Unknown command: ${cmd}\n`); console.log(HELP); return 1;
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: Error) => {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
});
