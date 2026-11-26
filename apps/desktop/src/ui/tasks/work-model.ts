// Task ownership and filtering shared by the task surfaces, and the target of a result’s evidence chip (B-080).
// Owns: these rules. Never: imports the store, rpc or the DOM, or reads a clock – callers pass data and the time in.

import { isFinished, type Task } from '../../shared/model/tasks.ts';

export { isFinished };

/** F-52: 'person' – another human of the organisation (on a person's device the CEO is the person 'owner'). */
export type Owner = { kind: 'team' } | { kind: 'agent'; id: string } | { kind: 'human' } | { kind: 'person'; id: string };

export function ownerOf(task: Pick<Task, 'assigneeKind' | 'assigneeId'>): Owner {
  if (task.assigneeKind === 'human') return task.assigneeId && task.assigneeId !== 'human' ? { kind: 'person', id: task.assigneeId } : { kind: 'human' };
  if (task.assigneeKind === 'agent' && task.assigneeId) return { kind: 'agent', id: task.assigneeId };
  return { kind: 'team' };
}

/** The owner filter (?owner=, O5): 'team' (no owner), an agent or person id, or anyone (undefined). */
export function ownedBy(task: Pick<Task, 'assigneeKind' | 'assigneeId'>, owner: string | undefined): boolean {
  return !owner || (owner === 'team' ? task.assigneeKind === 'team' : task.assigneeId === owner);
}

const WEB = /^https?:\/\//i;
const ABSOLUTE = /^(?:[a-z]:[\\/]|\/|\\\\)/i; // C:\… or C:/…, /…, \\server\…
const IMAGE = /\.(?:png|jpe?g|gif|webp|bmp|avif|svg)$/i;

/** B-080: what a result's evidence chip opens (ResultView.tsx) – a link, an image path, another path – or nothing (a static chip). */
export function evidenceTarget(ref: string | undefined): { kind: 'link' | 'image' | 'path'; ref: string } | undefined {
  const value = ref?.trim() ?? '';
  if (WEB.test(value)) return { kind: 'link', ref: value };
  if (!ABSOLUTE.test(value)) return undefined;
  return { kind: IMAGE.test(value) ? 'image' : 'path', ref: value };
}
