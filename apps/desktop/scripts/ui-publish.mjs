// Publishes the phone apps' interface file by file (owner 27.11.2026: an update fetches only the files that changed): it
// builds the interface (`node scripts/build.mjs --only ui`), writes and signs ui.json (scripts/ui-list.mjs, the key
// apps/android/new-ui-key.ps1 made), and fills the release `phone-ui` of teydra/OpenAutark (a pre-release, so it never
// becomes the repository's latest release): every file under its sha256 as the asset name, uploaded only when that
// name is not there yet, then ui.json.sig and ui.json, then the assets no file of this list names any more go. A phone
// reads https://github.com/teydra/OpenAutark/releases/download/phone-ui/ui.json (+ .sig) and fetches .../<sha256>.
// Needs the GitHub CLI (`gh`) signed in with write access to the repository.
//   node scripts/ui-publish.mjs --key <private key file> [--dry-run]
// Owns: that one release step and its plan (publishPlan). Never: touches another release, or prints the private key.

import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIST, SIGNATURE, writeUiList } from './ui-list.mjs';

export const REPOSITORY = 'teydra/OpenAutark';
export const TAG = 'phone-ui';

/** What one publish does: the list's sha256 names the release lacks (one path each), and the assets to remove
 *  afterwards (any name that is neither a file of the list nor the list and its signature). */
export function publishPlan(files, assetNames) {
  const have = new Set(assetNames);
  const upload = new Map();
  for (const [file, entry] of Object.entries(files)) if (!have.has(entry.sha256) && !upload.has(entry.sha256)) upload.set(entry.sha256, file);
  const keep = new Set([LIST, SIGNATURE, ...Object.values(files).map((entry) => entry.sha256)]);
  return { upload: [...upload].map(([sha256, file]) => ({ sha256, file })), remove: assetNames.filter((name) => !keep.has(name)) };
}

function run(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'pipe', 'inherit'] });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, out: result.stdout ?? '' };
}

function gh(args) {
  const result = run('gh', [...args, '--repo', REPOSITORY]);
  if (result.code !== 0) throw new Error(`gh ${args.join(' ')} failed (exit ${result.code})`);
  return result.out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const key = args.includes('--key') ? args[args.indexOf('--key') + 1] : undefined;
  const dry = args.includes('--dry-run');
  if (!key) throw new Error('ui publish: --key <private key file> is needed (apps/android/new-ui-key.ps1 made it); an unsigned list is never published');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (run(process.execPath, [path.join(root, 'scripts/build.mjs'), '--only', 'ui']).code !== 0) throw new Error('ui publish: the interface build failed');
  const dir = path.join(root, 'app/ui');
  const { list } = await writeUiList(dir, { key });
  const view = run('gh', ['release', 'view', TAG, '--repo', REPOSITORY, '--json', 'assets'], { quiet: true });
  const names = view.code === 0 ? JSON.parse(view.out).assets.map((asset) => asset.name) : [];
  const plan = publishPlan(list.files, names);
  console.log(`ui list n ${list.n}: ${Object.keys(list.files).length} files; ${plan.upload.length} to upload, ${plan.remove.length} to remove${view.code === 0 ? '' : `; release ${TAG} is new`}`);
  if (dry) { for (const item of plan.upload) console.log(`upload ${item.sha256} (${item.file})`); for (const name of plan.remove) console.log(`remove ${name}`); process.exit(0); }
  if (view.code !== 0) gh(['release', 'create', TAG, '--prerelease', '--title', 'Phone interface', '--notes', 'The phone apps fetch their interface from here, file by file (scripts/ui-publish.mjs).']);
  const stage = await mkdtemp(path.join(tmpdir(), 'autark-ui-'));
  try {
    for (let at = 0; at < plan.upload.length; at += 40) {
      const batch = [];
      for (const item of plan.upload.slice(at, at + 40)) { const target = path.join(stage, item.sha256); await copyFile(path.join(dir, item.file), target); batch.push(target); }
      gh(['release', 'upload', TAG, ...batch]);
    }
    // The signature first: a phone that reads the new signature with the old list (or the reverse) refuses both and keeps what it has.
    gh(['release', 'upload', TAG, path.join(dir, SIGNATURE), path.join(dir, LIST), '--clobber']);
    for (const name of plan.remove) gh(['release', 'delete-asset', TAG, name, '--yes']);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  console.log(`published ui.json n ${list.n} to ${REPOSITORY} release ${TAG}`);
}
