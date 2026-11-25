// The open work a line is about (Quests round 20.11.2026, THREADS-SEARCH.md Recommendation 2): the word index
// (knowledge/words.ts – an OR of prefixes, the app's one stem, compounds by their parts, the DE/EN pairs) over the open
// quests and the open to-dos outside a quest. A quest is one text – its title; its to-dos' titles and plan lines; its notes,
// done-when and facts – so a to-do's words find the quest it belongs to; a to-do without a quest is its own text. It feeds
// "## Related open work" of an agent's turn, the person's assistant sorting a new line and tasks.list search.
// Fresh by reading, not by events: each call reads the unfinished rows and their quests' to-dos in one light query
// of short columns and re-indexes only texts whose version changed (500 unfinished tasks, measured 20.11.: ≈ 1.5 ms read,
// ≈ 4 ms the whole call; the long columns are read only for a changed text).
// Owns: which text stands for a quest or a lone to-do, the ranking call. Never: writes a task, or decides which work is
// "mine" (the caller's skip).

import type { RuntimeServices } from '../contracts.ts';
import type { Task, TaskKind } from '../../shared/model/tasks.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { similarity } from '../subconscious/text.ts';
import { WordIndex, type WordDoc, type WordText } from '../knowledge/words.ts';

/** A found quest or lone to-do, best first (score relative to the best hit, 0..1). */
export interface RelatedHit extends RelatedRow { score: number }
/** What a hit carries – and what a caller's skip reads (its own work, the line's own new to-do). */
export type RelatedRow = Pick<Task, 'id' | 'kind' | 'title' | 'assigneeKind' | 'assigneeId'>;

interface Row {
  id: string; kind: string; parent_id: string | null; status: string; title: string; rev: number;
  assignee_kind: Task['assigneeKind']; assignee_id: string | null; private: number;
}
/** The long columns, read only for a text whose version changed. */
interface Long { notes: string; done_when: string | null; ledger: string }

type Deps = Pick<RuntimeServices, 'db'> & Partial<Pick<RuntimeServices, 'tasks'>>;

const OPEN = `status IN ('open', 'waiting')`;
/** The unfinished rows, and every to-do (finished ones too) of an unfinished quest – their titles say what the quest is about. */
const READ = `SELECT id, kind, parent_id, status, title, rev, assignee_kind, assignee_id, private
  FROM tasks WHERE ${OPEN} OR parent_id IN (SELECT id FROM tasks WHERE parent_id IS NULL AND ${OPEN})`;

const indexes = new WeakMap<object, WordIndex>();

/**
 * The open quests and lone to-dos `text` is about, best first, at most `limit`; `skip` leaves some out before the limit
 * counts (e.g. the reader's own work).
 */
export function relatedWork(services: Deps, text: string, limit = 3, skip?: (row: RelatedRow) => boolean): RelatedHit[] {
  if (!text.trim()) return [];
  const rows = services.db.all<Row>(READ);
  const parts = new Map<string, Row[]>();
  for (const row of rows) if (row.parent_id) parts.set(row.parent_id, [...(parts.get(row.parent_id) ?? []), row]);
  const work = new Map<string, { row: Row; hit: RelatedRow }>();
  const docs: WordDoc[] = [];
  for (const row of rows) {
    if (row.parent_id || (row.status !== 'open' && row.status !== 'waiting')) continue; // a to-do of a quest speaks through its quest
    const todos = parts.get(row.id) ?? [];
    const kind: TaskKind = row.kind === 'quest' || parts.has(row.id) ? 'quest' : 'todo';
    work.set(row.id, { row, hit: { id: row.id, kind, title: row.title, assigneeKind: row.assignee_kind, ...(row.assignee_id ? { assigneeId: row.assignee_id } : {}) } });
    const long = () => services.db.get<Long>('SELECT notes, done_when, ledger FROM tasks WHERE id = ?', [row.id]) ?? { notes: '', done_when: null, ledger: '{}' };
    docs.push({ id: row.id, version: [row.rev, ...todos.map((todo) => `${todo.id}:${todo.rev}`)].join('|'), text: () => textOf({ title: row.title, ...long() }, todos) });
  }
  let index = indexes.get(services);
  if (!index) { index = new WordIndex(); indexes.set(services, index); }
  index.sync(docs);
  const keep = (id: string) => {
    const found = work.get(id);
    return !!found && !skip?.(found.hit);
  };
  return index.search(text, limit, keep).map((hit) => ({ ...work.get(hit.id)!.hit, score: hit.score }));
}

const titleIndexes = new WeakMap<object, WordIndex>();

/** Like relatedWork, but index titles individually (including steps), never their parent's notes or finished steps. */
export function similarOpen(services: Deps, task: Task): Pick<Task, 'id' | 'title' | 'assigneeId'> | undefined {
  const rows = services.db.all<Row>(READ).filter((row) => !row.private && (row.status === 'open' || row.status === 'waiting'));
  let index = titleIndexes.get(services.db);
  if (!index) { index = new WordIndex(); titleIndexes.set(services.db, index); }
  const candidates = new Map(rows.map((row) => [row.id, row]));
  index.sync(rows.map((row) => ({ id: row.id, version: String(row.rev), text: () => ({ title: row.title, description: '', body: '' }) })));
  const owner = task.assigneeId ?? (task.assigneeKind === 'human' ? HUMAN_ID : undefined);
  const hit = index.search(task.title, 1, (id) => {
    const row = candidates.get(id);
    if (!row || id === task.id) return false;
    const other = row.assignee_id ?? (row.assignee_kind === 'human' ? HUMAN_ID : undefined);
    return ((owner !== undefined && owner === other) || (task.parentId !== undefined && task.parentId === row.parent_id)) && similarity(task.title, row.title) >= 1 / 3;
  })[0];
  const row = hit && candidates.get(hit.id);
  return row ? { id: row.id, title: row.title, assigneeId: row.assignee_id ?? (row.assignee_kind === 'human' ? HUMAN_ID : undefined) } : undefined;
}

/** A quest's text: title 10, its to-dos' titles and plan lines 4, notes, done-when and facts 1 (the word index's weights). */
export function textOf(task: Pick<Row, 'title'> & Long, todos: ReadonlyArray<Pick<Row, 'title'>>): WordText {
  const ledger = parseLedger(task.ledger);
  return {
    title: task.title,
    description: [...todos.map((todo) => todo.title), ...(ledger.plan ?? []).map((line) => line.replace(/^✓\s*/, ''))].join('\n'),
    body: [task.notes, task.done_when ?? '', ...(ledger.facts ?? [])].filter(Boolean).join('\n'),
  };
}

function parseLedger(text: string): { plan?: string[]; facts?: string[] } {
  try {
    const ledger = JSON.parse(text) as { plan?: unknown; facts?: unknown };
    const lines = (value: unknown) => (Array.isArray(value) ? value.filter((line): line is string => typeof line === 'string') : undefined);
    return { plan: lines(ledger.plan), facts: lines(ledger.facts) };
  } catch {
    return {};
  }
}
