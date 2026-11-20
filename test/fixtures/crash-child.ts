// Test-only child process: imports an export and SIGKILLs itself mid-transaction after N inserts,
// simulating power loss / a killed process. Usage: crash-child.ts <vault> <export> <killAfterInserts>
import { Vault } from '../../src/vault.ts';
import { importExport } from '../../src/importers/index.ts';
const [vaultPath, exportPath, n] = process.argv.slice(2);
const v = await Vault.unlock(vaultPath, { password: process.env.OMNEME_PASSWORD! });
const start = v.count();
Vault.testHooks.afterInsert = (count) => { if (count - start >= Number(n)) process.kill(process.pid, 'SIGKILL'); };
await importExport(v, exportPath);
console.log('finished without crash');
