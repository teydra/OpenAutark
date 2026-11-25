// Runs check.mjs against the Firestore emulator with the shipped rules. Needs Java 21+ and the Firebase CLI
// (`npm i -g firebase-tools`); the CLI downloads the emulator on first use.
//   node services/firestore-rules/run.mjs
import { cpSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const rules = join(here, '..', '..', 'apps', 'desktop', 'resources', 'feedback', 'firestore.rules');
const tmp = mkdtempSync(join(tmpdir(), 'autark-rules-'));
try {
  cpSync(rules, join(tmp, 'firestore.rules'));
  writeFileSync(join(tmp, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' }, emulators: { firestore: { host: '127.0.0.1', port: 18080 }, ui: { enabled: false } } }));
  // One command string: on Windows `firebase` is a .cmd file, which needs a shell, and the inner command needs its own quotes.
  const inner = `node \\"${join(here, 'check.mjs')}\\"`;
  const done = spawnSync(`firebase emulators:exec --only firestore --project demo-autark --config "${join(tmp, 'firebase.json')}" "${inner}"`, { stdio: 'inherit', shell: true, cwd: tmp });
  process.exitCode = done.status ?? 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
