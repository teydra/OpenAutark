// The walk of files.delete (task_7ja3mcr6): what a delete would take (planTree, the dry run and the check before every
// real delete) and the delete itself (removeTree). A link – symlink or junction, which Node's lstat reports as a symbolic
// link on Windows too – is removed as the link alone, never entered; a folder holding a data mark (delete-zones.ts
// DATA_MARKS: a company's workforce.db, a browser profile's Local State or profiles.ini) stops the plan, so nothing of it
// goes – unless the caller lets marks pass for a throwaway copy (`allowMarks`, files-delete.ts dataCopy). A read-only file
// loses that flag right before its delete (Windows refuses it otherwise). Both walks read and delete a folder's entries a
// few at a time (a node_modules tree has tens of thousands) and look at the abort signal between entries.
// Owns: the walk, the counts and the delete order. Never: follows a link, decides where a delete may go (delete-zones.ts).

import { chmod, lstat, opendir, rmdir, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { DATA_MARKS } from './delete-zones.ts';

export interface TreePlan { files: number; folders: number; links: number; bytes: number; /** The first folder holding a data mark, with its mark. */ marked?: string }

/** Entries handled at once in one folder: enough to hide the file system's latency, few enough not to exhaust handles. */
const PARALLEL = 24;

/** Runs `each` over `items`, at most `PARALLEL` at a time; the first failure is thrown once the running ones ended. */
async function inBatches<T>(items: T[], each: (item: T) => Promise<void>, stop: () => boolean): Promise<void> {
  for (let at = 0; at < items.length && !stop(); at += PARALLEL) {
    const results = await Promise.allSettled(items.slice(at, at + PARALLEL).map(each));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

async function namesIn(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of await opendir(dir)) names.push(entry.name);
  return names;
}

/** What deleting `full` would take; stops at the first data mark unless `allowMarks` (the first one is still named). */
export async function planTree(full: string, signal?: AbortSignal, allowMarks = false): Promise<TreePlan> {
  const plan: TreePlan = { files: 0, folders: 0, links: 0, bytes: 0 };
  const stop = () => signal?.aborted === true || (plan.marked !== undefined && !allowMarks);
  const walk = async (at: string, info: Stats): Promise<void> => {
    if (stop()) return;
    if (info.isSymbolicLink()) { plan.links++; return; }
    if (!info.isDirectory()) { plan.files++; plan.bytes += info.size; return; }
    plan.folders++;
    const names = await namesIn(at);
    const mark = names.find((name) => DATA_MARKS.some((one) => one.toLowerCase() === name.toLowerCase()));
    if (mark !== undefined) {
      const markInfo = await lstat(path.join(at, mark));
      if (!markInfo.isSymbolicLink() && plan.marked === undefined) plan.marked = `${at} (${mark})`;
      if (plan.marked !== undefined && !allowMarks) return;
    }
    await inBatches(names, async (name) => { const child = path.join(at, name); await walk(child, await lstat(child)); }, stop);
  };
  await walk(full, await lstat(full));
  return plan;
}

/** Removes a link as the link alone (a folder link on Windows goes with rmdir, a file link with unlink). */
async function removeLink(at: string): Promise<void> {
  try { await unlink(at); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EISDIR' && code !== 'EACCES') throw error;
    await rmdir(at); // a directory junction or directory symlink: rmdir removes the link, not what it points at
  }
}

async function removeFile(at: string, info: Stats): Promise<void> {
  try { await unlink(at); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM' || process.platform !== 'win32') throw error;
    await chmod(at, info.mode | 0o200); // read-only on Windows
    await unlink(at);
  }
}

export interface Removal { removed: number; failed?: { path: string; code: string } }

/** Deletes `full` – a file, a link (the link alone) or a folder with everything in it, links inside removed as links. A set `signal` stops it between entries (`failed.code` ABORTED). */
export async function removeTree(full: string, signal?: AbortSignal): Promise<Removal> {
  let removed = 0;
  const walk = async (at: string): Promise<void> => {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED', path: at });
    const info = await lstat(at);
    if (info.isSymbolicLink()) { await removeLink(at); removed++; return; }
    if (!info.isDirectory()) { await removeFile(at, info); removed++; return; }
    await inBatches(await namesIn(at), (name) => walk(path.join(at, name)), () => signal?.aborted === true);
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED', path: at });
    await rmdir(at);
    removed++;
  };
  try { await walk(full); } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    return { removed, failed: { path: failure.path ?? full, code: failure.code ?? 'error' } };
  }
  return { removed };
}
