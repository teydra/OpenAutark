// A task's checklist (Mika's task system, P4 stage 1 and P5 stage 2). Stage 1 stored only lines in ledger.plan ("✓ " before
// a ticked one); stage 2 keeps each item with a stable id, its owner when it was handed over and the task that does it
// (ledger.checklist). Both are written together, so a PC that only knows ledger.plan still reads and writes the same list:
// when ledger.plan no longer matches ledger.checklist (an older PC changed the lines), the lines win and each keeps the
// id, owner and task of the item with the same text – nothing is lost either way. A plan that never had items reads with
// the ids p1, p2 … in its order, the same on every read until it is first written.
// Owns: the conversion between plan lines and checklist items, item ids and the progress. Never: writes a task.
import type { ChecklistItem, TaskLedger } from './tasks.ts';

export type { ChecklistItem } from './tasks.ts';

/** A checklist item as a caller gives it (an agent's tool call, a person's edit): an id only for an item that exists. */
export interface PlanItem { id?: string; text: string; done: boolean; owner?: string; taskId?: string }

export const MAX_ITEMS = 20;

export function readPlan(lines: readonly string[] = []): PlanItem[] {
  return lines.map((line) => ({ text: line.replace(/^(?:✓\s*|☐ )/, ''), done: line.startsWith('✓') }));
}

export function writePlan(items: readonly Pick<PlanItem, 'text' | 'done'>[]): string[] {
  return items.flatMap(({ text, done }) => {
    const clean = text.trim();
    if (!clean) return [];
    return [done ? `✓ ${clean}` : clean.startsWith('✓') || clean.startsWith('☐ ') ? `☐ ${clean}` : clean];
  });
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const number = (id: string) => (/^p(\d+)$/.exec(id) ? Number(id.slice(1)) : 0);

/** The next free item id after `taken` (p1, p2 …). */
export function nextItemId(taken: Iterable<string>): string {
  let max = 0;
  for (const id of taken) max = Math.max(max, number(id));
  return `p${max + 1}`;
}

/**
 * `given` as stored items: an item keeps the id it names, else the id of a known item with the same text, and that item's
 * owner and task unless it gives its own (an `owner` or `taskId` key set to undefined clears them); a new one gets the
 * next free id. Empty lines go, at most MAX_ITEMS stay.
 */
export function settleItems(given: readonly PlanItem[], known: readonly ChecklistItem[] = []): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  const used = new Set<string>();
  const taken = new Set(known.map((item) => item.id));
  for (const item of given) {
    const text = item.text.trim();
    if (!text || out.length >= MAX_ITEMS) continue;
    const match = (item.id ? known.find((old) => old.id === item.id && !used.has(old.id)) : undefined)
      ?? known.find((old) => !used.has(old.id) && sameText(old.text, text));
    const id = match?.id ?? (item.id && !taken.has(item.id) && !used.has(item.id) ? item.id : nextItemId([...taken, ...used]));
    used.add(id);
    taken.add(id);
    const owner = 'owner' in item ? item.owner : match?.owner; // a key given as undefined clears it
    const taskId = 'taskId' in item ? item.taskId : match?.taskId;
    out.push({ id, text, done: item.done, ...(owner ? { owner } : {}), ...(taskId ? { taskId } : {}) });
  }
  return out;
}

/** The checklist a ledger holds (see the header): stage-2 items while they match the plan lines, else the lines with what is known of them. */
export function readChecklist(ledger: Pick<TaskLedger, 'plan' | 'checklist'> | undefined): ChecklistItem[] {
  const lines = ledger?.plan ?? [];
  const known = ledger?.checklist ?? [];
  if (known.length && lines.length === known.length && writePlan(known).every((line, index) => line === lines[index])) return known.map((item) => ({ ...item }));
  return settleItems(readPlan(lines), known);
}

/** The ledger fields that store `items`: both the items and their lines (an older PC reads the lines). */
export function checklistLedger(items: readonly ChecklistItem[]): Pick<TaskLedger, 'plan' | 'checklist'> {
  const kept = items.filter((item) => item.text.trim()).slice(0, MAX_ITEMS);
  return {
    plan: writePlan(kept),
    checklist: kept.map(({ id, text, done, owner, taskId }) => ({ id, text: text.trim(), done, ...(owner ? { owner } : {}), ...(taskId ? { taskId } : {}) })),
  };
}

export function planProgress(lines?: readonly string[]) {
  const items = readPlan(lines);
  return { done: items.filter((item) => item.done).length, total: items.length, next: items.find((item) => !item.done)?.text };
}
