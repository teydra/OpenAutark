// Checklist items use the existing string-only ledger.plan and RPC. Older PCs still read the same strings.
// Owns: the conversion between plan strings and checklist items. Never: writes a task.
export interface PlanItem { text: string; done: boolean }

export function readPlan(lines: readonly string[] = []): PlanItem[] {
  return lines.map((line) => ({ text: line.replace(/^(?:✓\s*|☐ )/, ''), done: line.startsWith('✓') }));
}

export function writePlan(items: readonly PlanItem[]): string[] {
  return items.flatMap(({ text, done }) => {
    const clean = text.trim();
    if (!clean) return [];
    return [done ? `✓ ${clean}` : clean.startsWith('✓') || clean.startsWith('☐ ') ? `☐ ${clean}` : clean];
  });
}

export function planProgress(lines?: readonly string[]) {
  const items = readPlan(lines);
  return { done: items.filter((item) => item.done).length, total: items.length, next: items.find((item) => !item.done)?.text };
}
