// Publishes the phone apps' interface file by file (owner 27.11.2026: an update fetches only the files that changed) into
// the versioned GitHub release beside its APK (Konrad 27.11.2026: ui.json belongs in the release, not in a release of its
// own). It builds the interface (`node scripts/build.mjs --only ui`), writes and signs ui.json (scripts/ui-list.mjs, with
// the interface key from the secrets catalog) and fills the release with tag --tag of teydra/OpenAutark – a draft the
// release step made or a published one: every file under its sha256 as the asset name, uploaded only when that name is
// not there yet, then ui.json.sig and ui.json (each replaced), then the sha256 names no file of this list names any more
// go. Every other asset (the APK, the installer, their checksums) stays untouched. The apps read
// https://github.com/teydra/OpenAutark/releases/latest/download/ui.json (+ .sig) and fetch .../<sha256> (Android
// relay/UiUpdate.BASE): so each release carries the whole interface, and an app reads the newest one its shell fits.
// Talks to the GitHub REST API itself (no `gh` needed) with a token in GITHUB_TOKEN (or GH_TOKEN), never printed.
//   node scripts/ui-publish.mjs --tag v0.3.22 (--key <private key file> | --key-env <variable>) [--dry-run]
// Owns: that one release step and its plan (publishPlan). Never: creates or publishes a release, touches an asset that is
// not the interface's, or prints the private key or the token.

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIST, SIGNATURE, keyOptions, writeUiList } from './ui-list.mjs';

export const REPOSITORY = 'teydra/OpenAutark';
const SHA = /^[0-9a-f]{64}$/;

/** True for a versioned release tag (v0.3.22, v1.0.0-rc.1): the interface goes only beside an app version. */
export function versionTag(tag) {
  return typeof tag === 'string' && /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag);
}

/** What one publish does: the list's sha256 names the release lacks (one path each), and the assets to remove afterwards
 *  (a sha256 name no file of the list names; never the list, its signature or any other asset such as the APK). */
export function publishPlan(files, assetNames) {
  const have = new Set(assetNames);
  const upload = new Map();
  for (const [file, entry] of Object.entries(files)) if (!have.has(entry.sha256) && !upload.has(entry.sha256)) upload.set(entry.sha256, file);
  const keep = new Set(Object.values(files).map((entry) => entry.sha256));
  return { upload: [...upload].map(([sha256, file]) => ({ sha256, file })), remove: assetNames.filter((name) => SHA.test(name) && !keep.has(name)) };
}

async function api(token, method, url, body) {
  const response = await fetch(url.startsWith('https://') ? url : `https://api.github.com${url}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/octet-stream' } : {}),
    },
    body,
  });
  if (!response.ok && !(method === 'DELETE' && response.status === 404)) throw new Error(`ui publish: ${method} ${url.replace(/\?.*$/, '')} answered ${response.status}`);
  return response.status === 204 || method === 'DELETE' ? null : response.json();
}

/** The release with `tag`, drafts included (the tag endpoint does not see drafts). */
async function findRelease(token, tag) {
  for (let page = 1; page <= 10; page++) {
    const releases = await api(token, 'GET', `/repos/${REPOSITORY}/releases?per_page=100&page=${page}`);
    const found = releases.find((release) => release.tag_name === tag);
    if (found) return found;
    if (releases.length < 100) break;
  }
  throw new Error(`ui publish: no release with tag ${tag} in ${REPOSITORY}; the release step makes it first`);
}

async function assetsOf(token, release) {
  const out = [];
  for (let page = 1; ; page++) {
    const assets = await api(token, 'GET', `/repos/${REPOSITORY}/releases/${release.id}/assets?per_page=100&page=${page}`);
    out.push(...assets);
    if (assets.length < 100) return out;
  }
}

async function upload(token, release, name, file) {
  const url = `https://uploads.github.com/repos/${REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  await api(token, 'POST', url, await readFile(file));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const tag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : undefined;
  const dry = args.includes('--dry-run');
  if (!versionTag(tag)) throw new Error('ui publish: --tag <vX.Y.Z> is needed – the interface goes into the versioned release beside its APK');
  const keys = keyOptions(args);
  if (!keys.key && !keys.keyText) throw new Error('ui publish: --key <file> or --key-env <variable> is needed; an unsigned list is never published');
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error('ui publish: GITHUB_TOKEN (or GH_TOKEN) with write access to the repository is needed');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const built = spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs'), '--only', 'ui'], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (built.status !== 0) throw new Error('ui publish: the interface build failed');
  const dir = path.join(root, 'app/ui');
  const { list } = await writeUiList(dir, { key: keys.key, keyText: keys.keyText });
  const release = await findRelease(token, tag);
  const assets = await assetsOf(token, release);
  const plan = publishPlan(list.files, assets.map((asset) => asset.name));
  console.log(`ui list n ${list.n}: ${Object.keys(list.files).length} files; ${plan.upload.length} to upload, ${plan.remove.length} to remove; release ${tag}${release.draft ? ' (draft)' : ''}`);
  if (dry) { for (const item of plan.upload) console.log(`upload ${item.sha256} (${item.file})`); for (const name of plan.remove) console.log(`remove ${name}`); process.exit(0); }
  for (const item of plan.upload) await upload(token, release, item.sha256, path.join(dir, item.file));
  // The signature first: a phone that reads the new signature with the old list (or the reverse) refuses both and keeps
  // what it has; between delete and upload it reads a 404 and keeps what it has too.
  for (const name of [SIGNATURE, LIST]) {
    for (const asset of assets.filter((entry) => entry.name === name)) await api(token, 'DELETE', `/repos/${REPOSITORY}/releases/assets/${asset.id}`);
    await upload(token, release, name, path.join(dir, name));
  }
  for (const asset of assets.filter((entry) => plan.remove.includes(entry.name))) await api(token, 'DELETE', `/repos/${REPOSITORY}/releases/assets/${asset.id}`);
  console.log(`published ui.json n ${list.n} to ${REPOSITORY} release ${tag}`);
}
