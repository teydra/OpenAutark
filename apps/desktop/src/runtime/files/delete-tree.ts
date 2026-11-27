// The walk of files.delete (task_7ja3mcr6): what a delete would take (planTree, the dry run and the check before every
// real delete) and the delete itself (removeTree). A link – symlink or junction, which Node's lstat reports as a symbolic
// link on Windows too – is removed as the link alone, never entered; a folder holding a data mark (delete-zones.ts
// DATA_MARKS: a company's workforce.db, a browser profile's Local State or profiles.ini) stops the plan, so nothing of it
// goes. A read-only file loses that flag right before its delete (Windows refuses it otherwise).
// Owns: the walk, the counts and the delete order. Never: follows a link, decides where a delete may go (delete-zones.ts).

import { chmod, lstat, opendir, rmdir, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { DATA_MARKS } from './delete-zones.ts';

export interface TreePlan { files: number; folders: number; links: number; bytes: number; /** The first folder holding a data mark, with its mark. */ marked?: string }

/** What deleting `full` would take; stops at the first data mark. */
export async function planTree(full: string, signal?: AbortSignal): Promise<TreePlan> {
  const plan: TreePlan = { files: 0, folders: 0, links: 0, bytes: 0 };
  const walk = async (at: string, info: Stats): Promise<void> => {
    if (plan.marked || signal?.aborted) return;
    if (info.isSymbolicLink()) { plan.links++; return; }
    if (!info.isDirectory()) { plan.files++; plan.bytes += info.size; return; }
    plan.folders++;
    const dir = await opendir(at);
    for await (const entry of dir) {
      if (DATA_MARKS.some((mark) => mark.toLowerCase() === entry.name.toLowerCase()) && !entry.isSymbolicLink()) { plan.marked = `${at} (${entry.name})`; return; }
      const child = path.join(at, entry.name);
      await walk(child, await lstat(child));
      if (plan.marked) return;
    }
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

/** Deletes `full` – a file, a link (the link alone) or a folder with everything in it, links inside removed as links. */
export async function removeTree(full: string): Promise<Removal> {
  let removed = 0;
  const walk = async (at: string): Promise<void> => {
    const info = await lstat(at);
    if (info.isSymbolicLink()) { await removeLink(at); removed++; return; }
    if (!info.isDirectory()) { await removeFile(at, info); removed++; return; }
    const names: string[] = [];
    for await (const entry of await opendir(at)) names.push(entry.name);
    for (const name of names) await walk(path.join(at, name));
    await rmdir(at);
    removed++;
  };
  let current = full;
  try { await walk(full); } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    current = failure.path ?? current;
    return { removed, failed: { path: current, code: failure.code ?? 'error' } };
  }
  return { removed };
}
