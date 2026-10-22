#!/usr/bin/env node
// Installs the nightly full gate run (tools/nightly.mjs) as a user LaunchAgent at about 02:00 local: fills the template
// tools/launchd/dev.larattalabs.architect-nightly.plist with this checkout, this node and a PATH that finds git, java and node,
// writes ~/Library/LaunchAgents/dev.larattalabs.architect-nightly.plist and loads it (launchctl bootstrap gui/<uid>).
// Persistent machine config: the coordinator runs it, from the main checkout once this is merged.
//
//   node tools/nightly-install.mjs --print       the filled plist, nothing written
//   node tools/nightly-install.mjs               write and load (replaces a loaded one)
//   node tools/nightly-install.mjs --uninstall   unload and remove

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'dev.larattalabs.architect-nightly';
const DEST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const domain = `gui/${process.getuid()}`;
const argv = process.argv.slice(2);

// node: mise's `lts` link survives a node upgrade (a versioned path wouldn't); else this node
const LTS = path.join(os.homedir(), '.local', 'share', 'mise', 'installs', 'node', 'lts', 'bin', 'node');
const NODE = fs.existsSync(LTS) ? LTS : process.execPath;
const pathDirs = [path.dirname(NODE), path.join(os.homedir(), '.local', 'share', 'mise', 'shims'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const fill = (t) => t.replaceAll('__NODE__', NODE).replaceAll('__REPO__', REPO).replaceAll('__HOME__', os.homedir())
  .replaceAll('__PATH__', [...new Set(pathDirs)].join(':')).replaceAll('__JAVA_HOME__', process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25');
const plist = fill(fs.readFileSync(path.join(REPO, 'tools', 'launchd', `${LABEL}.plist`), 'utf8'));

if (argv.includes('--print')) {
  process.stdout.write(plist);
  process.exit(0);
}
const bootout = () => spawnSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' });
if (argv.includes('--uninstall')) {
  bootout();
  fs.rmSync(DEST, { force: true });
  console.log(`nightly: unloaded ${LABEL} and removed ${DEST}`);
  process.exit(0);
}
fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.writeFileSync(DEST, plist);
execFileSync('plutil', ['-lint', DEST], { stdio: 'inherit' });
bootout();
execFileSync('launchctl', ['bootstrap', domain, DEST], { stdio: 'inherit' });
console.log(`nightly: ${DEST} loaded (${LABEL}, 02:00 local, ${REPO}/tools/nightly.mjs); logs ~/Library/Logs/architect-nightly.log, summaries ${path.resolve(REPO, '..', 'architect-mc', 'artifacts', 'nightly')}/<date>/`);
