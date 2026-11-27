// The phone apps' list of their interface (owner 27.11.2026: an update of the interface fetches only the files that
// changed). For a built app/ui it writes ui.json – {n, shell, needs, files: {<path>: {sha256, bytes}}} as compact JSON,
// paths sorted – and, given the interface key (apps/android/new-ui-key.ps1), ui.json.sig beside it: the raw 64-byte
// Ed25519 signature over the exact bytes of ui.json. n is the build's time in whole seconds since 1970 (it only grows
// from build to build on a PC with a right clock); shell is SHELL of src/ui/pwa/native-port.ts (the lowest bridge
// number of the phone app this interface needs); needs is OLDEST_PC of src/ui/lib/pc-floor.ts. Without a key the list
// is unsigned (what an app carries in its own package needs none) and a stale ui.json.sig goes. The rules of the apps
// that read it: docs/ARCHITECTURE.md §8, "The interface updates file by file".
//   node scripts/ui-list.mjs [<dir, default app/ui>] [--key <private key file>]
// Owns: listing, hashing, writing and signing the list. Never: uploads, or prints or copies the private key.

import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIST = 'ui.json';
export const SIGNATURE = 'ui.json.sig';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The interface's files below `dir` as sorted posix paths, without the list and its signature and without dot-led names
 *  (the apps never answer those). */
export async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
    if (file === LIST || file === SIGNATURE || file.split('/').some((part) => part.startsWith('.'))) continue;
    out.push(file);
  }
  return out.sort();
}

/** SHELL and OLDEST_PC as the page's sources name them (`base`: this package). */
export async function pageNumbers(base = root) {
  const port = await readFile(path.join(base, 'src/ui/pwa/native-port.ts'), 'utf8');
  const floor = await readFile(path.join(base, 'src/ui/lib/pc-floor.ts'), 'utf8');
  const shell = /^export const SHELL = (\d+);/m.exec(port)?.[1];
  const needs = /^export const OLDEST_PC = '([^']+)';/m.exec(floor)?.[1];
  if (!shell || !needs) throw new Error('ui list: SHELL (src/ui/pwa/native-port.ts) or OLDEST_PC (src/ui/lib/pc-floor.ts) not found');
  return { shell: Number(shell), needs };
}

/** The list of `dir`; `n` defaults to now in whole seconds. */
export async function uiList(dir, { n = Math.floor(Date.now() / 1000), shell, needs } = {}) {
  if (shell === undefined || needs === undefined) ({ shell, needs } = await pageNumbers());
  const files = {};
  for (const file of await listFiles(dir)) {
    const bytes = await readFile(path.join(dir, file));
    files[file] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  }
  return { n, shell, needs, files };
}

/** The exact bytes of ui.json (and what the signature covers). */
export function listBytes(list) {
  return Buffer.from(JSON.stringify(list), 'utf8');
}

/** The raw 64-byte Ed25519 signature of `bytes` under the PEM private key `pem`. */
export function signList(bytes, pem) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('ui list: the key is not an Ed25519 private key');
  return sign(null, bytes, key);
}

/** Writes ui.json (and ui.json.sig when `key`, a private key file, is given) into `dir`. */
export async function writeUiList(dir, { key, ...options } = {}) {
  const list = await uiList(dir, options);
  const bytes = listBytes(list);
  await writeFile(path.join(dir, LIST), bytes);
  if (key) await writeFile(path.join(dir, SIGNATURE), signList(bytes, await readFile(key, 'utf8')));
  else await rm(path.join(dir, SIGNATURE), { force: true });
  return { list, bytes, signed: Boolean(key) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--key');
  const key = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && !key) throw new Error('ui list: --key needs the private key file');
  const dir = path.resolve(args.find((arg, index) => !arg.startsWith('--') && (at < 0 || index !== at + 1)) ?? path.join(root, 'app/ui'));
  const { list, signed } = await writeUiList(dir, { key });
  const files = Object.values(list.files);
  console.log(`${LIST}: n ${list.n}, shell ${list.shell}, needs ${list.needs}, ${files.length} files, ${files.reduce((sum, file) => sum + file.bytes, 0)} bytes, ${signed ? 'signed' : 'unsigned (no --key)'}`);
}
