#!/usr/bin/env node
// First-run launcher: hides Node's ExperimentalWarning (TypeScript stripping, node:sqlite),
// then starts the local web UI in onboarding mode. No passwords on the command line.
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });
// OMN-045: runtime preflight BEFORE any TypeScript is imported. Built-in type stripping runs without flags only on
// Node 22.18+ (22.x line), 23.6+ and 24+ (Node docs, "Modules: TypeScript" history); 23.0-23.5 need a flag.
{
  const [maj, min] = process.versions.node.split('.').map(Number);
  const versionOk = (maj === 22 && min >= 18) || (maj === 23 && min >= 6) || maj >= 24;
  const stripOff = process.features && 'typescript' in process.features && !process.features.typescript;
  if (!versionOk || stripOff) {
    console.error(`Error: Omneme needs Node.js 22.18 or newer on the 22.x line, 23.6 or newer, or 24 or newer, with built-in TypeScript type stripping enabled. This is Node.js ${process.versions.node}${stripOff ? ' with type stripping turned off' : ''}. Install a supported version from https://nodejs.org (no npm install is needed).`);
    process.exit(1);
  }
}
const { main } = await import('../src/start.ts');
main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
});
