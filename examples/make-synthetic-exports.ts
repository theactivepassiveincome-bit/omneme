// Writes synthetic ChatGPT and Claude export ZIPs into the given directory (for demos).
import { writeChatgptZip, writeClaudeZip } from '../test/helpers.ts';
const dir = process.argv[2];
if (!dir) { console.error('usage: make-synthetic-exports.ts <dir>'); process.exit(1); }
console.log('Synthetic exports:', writeChatgptZip(dir), writeClaudeZip(dir));
