// Repository for tasks (quests, to-dos – the person's included) and `tasks_fts`.
// Owns: row ↔ model mapping (a row an older PC sends is read with its due_at / estimate_min, bridge/quests-2011.ts),
// list queries, the reads of the watcher (the person's rings at
// `at`) and of the morning pass, the FTS index. A task's chat changes only at insert or through chat deletion. A save
// without files (an older PC's row) keeps the stored ones; a save of an older PC's row keeps the stored kind.
// Never: emits events, posts chat lines or wakes agents (tasks/service.ts does).

import { json, toJson, type Db } from '../db/database.ts';
import { nul, opt } from '../store/rows.ts';
import { foldText, ftsQuery } from '../../shared/text/normalize.ts';
import type { UiBlock } from '../../shared/blocks/catalog.ts';
import type { Attachment } from '../../shared/model/chat.ts';
import { isPaused, type Task, type TaskFilter, type TaskLedger, type TaskResult } from '../../shared/model/tasks.ts';
import type { Origin } from '../../shared/model/origin.ts';
import { readableTasksSql } from '../people/access.ts';
import { isOlder, markOlder, olderPiece, questsRead } from '../bridge/quests-2011.ts';

type Row = Record<string, unknown>;

export function toTask(row: Row): Task {
  const read = questsRead(row); // bridge 0.3.x: at ?? due_at, minutes ?? estimate_min
  const task: Task = {
    id: String(row.id),
    kind: read.kind,
    title: String(row.title),
    notes: String(row.notes),
    status: String(row.status) as Task['status'],
    assigneeKind: String(row.assignee_kind) as Task['assigneeKind'],
    createdBy: String(row.created_by),
    priority: Number(row.priority) as Task['priority'],
    ledger: json<TaskLedger>(row.ledger, {}),
    sort: Number(row.sort),
    rev: Number(row.rev),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  const set = <K extends keyof Task>(key: K, value: Task[K] | undefined) => { if (value !== undefined) task[key] = value; };
  set('conversationId', opt<string>(row.conversation_id));
  set('spaceId', opt<string>(row.space_id));
  set('origin', originOf(row));
  set('messageId', opt<string>(row.message_id));
  set('parentId', opt<string>(row.parent_id));
  set('assigneeId', opt<string>(row.assignee_id));
  set('at', read.at);
  set('minutes', read.minutes);
  set('doneWhen', opt<string>(row.done_when));
  set('widget', row.widget === null ? undefined : json<UiBlock | undefined>(row.widget, undefined));
  set('waitingOn', row.waiting_on === null ? undefined : json<Task['waitingOn']>(row.waiting_on, undefined));
  set('result', row.result === null ? undefined : json<TaskResult | undefined>(row.result, undefined));
  set('completedAt', row.completed_at === null || row.completed_at === undefined ? undefined : Number(row.completed_at));
  set('assignedBy', opt<string>(row.assigned_by));
  if (Number(row.private) === 1) task.private = true; // 0 = absent (compact rows)
  const after = json<string[]>(row.depends_on, []);
  if (after.length) task.dependsOn = after; // [] = absent (compact rows)
  const files = json<Attachment[]>(row.files, []);
  if (Array.isArray(files) && files.length) task.files = files; // [] or no column = absent
  return read.older ? markOlder(task) : task;
}

/** The stored origin (source_label falls back to the source). */
function originOf(row: Row): Origin | undefined {
  const source = opt<string>(row.source);
  return source === undefined ? undefined : { source: String(source), label: String(opt<string>(row.source_label) ?? source) };
}

/** The own-place columns (migration 082) at insert: space_id, source, source_label. The space is stored only without a chat. */
const ownValues = (t: Task) => [t.conversationId ? null : nul(t.spaceId), nul(t.origin?.source), nul(t.origin?.source ? t.origin.label : undefined)];

const STATUS_RANK = `CASE status WHEN 'open' THEN 0 WHEN 'waiting' THEN 1 WHEN 'done' THEN 2 ELSE 3 END`;
/** When a finished task finished (rows without completed_at fall back like the UI's finishedAt). */
const FINISHED_AT = 'COALESCE(t.completed_at, t.updated_at)';
const UNFINISHED_SQL = `status IN ('open', 'waiting')`;
/** The person's own to-dos (the owner's have no assignee id). */
const OWNERS_TODO = `assignee_kind = 'human' AND (assignee_id IS NULL OR assignee_id = 'human')`;

export class TaskRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  get(id: string): Task | undefined {
    const row = this.db.get<Row>('SELECT * FROM tasks WHERE id = ?', [id]);
    return row ? toTask(row) : undefined;
  }

  byClientId(clientId: string): Task | undefined {
    const row = this.db.get<Row>('SELECT * FROM tasks WHERE client_id = ?', [clientId]);
    return row ? toTask(row) : undefined;
  }

  insert(t: Task, clientId?: string): void {
    this.db.run(
      `INSERT INTO tasks (id, conversation_id, message_id, parent_id, kind, title, notes, status, assignee_kind, assignee_id, created_by,
         priority, "at", minutes, done_when, widget, waiting_on, result, ledger, sort, rev,
         client_id, created_at, updated_at, completed_at, assigned_by, private, space_id, source, source_label, depends_on, files)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [t.id, nul(t.conversationId), nul(t.messageId), nul(t.parentId), t.kind, t.title, t.notes, t.status, t.assigneeKind, nul(t.assigneeId), t.createdBy,
        t.priority, nul(t.at), nul(t.minutes), nul(t.doneWhen), t.widget ? toJson(t.widget) : null,
        t.waitingOn ? toJson(t.waitingOn) : null, t.result ? toJson(t.result) : null, toJson(t.ledger), t.sort, t.rev,
        nul(clientId), t.createdAt, t.updatedAt, nul(t.completedAt), nul(t.assignedBy), t.private ? 1 : 0,
        ...ownValues(t), toJson(t.dependsOn ?? []), toJson(t.files ?? [])],
    );
    olderPiece(this.db, t); // bridge 0.3.x
    this.index(t);
  }

  /**
   * Writes all mutable fields with optimistic concurrency: only when `rev` still matches. The chat is not one of
   * them (set at insert, detached only by chat deletion), so a stale copy never re-points a detached row; the space is
   * kept only on a chat-free row, and an absent space or origin keeps the stored one.
   */
  save(t: Task, expectedRev: number): boolean {
    const changes = this.db.run(
      `UPDATE tasks SET message_id = ?, parent_id = ?, kind = COALESCE(?, kind), title = ?, notes = ?, status = ?, assignee_kind = ?, assignee_id = ?,
         priority = ?, "at" = ?, minutes = ?, done_when = ?, widget = ?, waiting_on = ?, result = ?, ledger = ?,
         sort = ?, rev = ?, updated_at = ?, completed_at = ?, assigned_by = ?, private = ?, depends_on = ?,
         files = COALESCE(?, files),
         space_id = CASE WHEN conversation_id IS NULL THEN COALESCE(?, space_id) END,
         source = COALESCE(?, source), source_label = CASE WHEN ? IS NULL THEN source_label ELSE ? END
       WHERE id = ? AND rev = ?`,
      [nul(t.messageId), nul(t.parentId), isOlder(t) ? null : t.kind, t.title, t.notes, t.status, t.assigneeKind, nul(t.assigneeId),
        t.priority, nul(t.at), nul(t.minutes), nul(t.doneWhen), t.widget ? toJson(t.widget) : null,
        t.waitingOn ? toJson(t.waitingOn) : null, t.result ? toJson(t.result) : null, toJson(t.ledger), t.sort, t.rev,
        t.updatedAt, nul(t.completedAt), nul(t.assignedBy), t.private ? 1 : 0, toJson(t.dependsOn ?? []), t.files?.length ? toJson(t.files) : null, nul(t.spaceId),
        nul(t.origin?.source), nul(t.origin?.source), nul(t.origin?.source ? t.origin.label : undefined), t.id, expectedRev],
    ).changes;
    if (changes) { olderPiece(this.db, t); this.index(t); }
    return changes > 0;
  }

  delete(id: string): void {
    this.db.run('DELETE FROM tasks_fts WHERE rowid IN (SELECT rowid FROM tasks WHERE id = ? OR parent_id = ?)', [id, id]);
    this.db.run('DELETE FROM tasks WHERE id = ?', [id]);
  }

  children(parentId: string): Task[] {
    return this.db.all<Row>('SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort, created_at', [parentId]).map(toTask);
  }

  childrenOf(ids: string[]): Map<string, Task[]> {
    const out = new Map<string, Task[]>();
    if (!ids.length) return out;
    const rows = this.db.all<Row>(`SELECT * FROM tasks WHERE parent_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort, created_at`, ids);
    for (const row of rows) {
      const task = toTask(row);
      const list = out.get(task.parentId!) ?? [];
      list.push(task);
      out.set(task.parentId!, list);
    }
    return out;
  }

  list(filter: TaskFilter = {}): Task[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (!filter.includeSteps) where.push('t.parent_id IS NULL');
    if (filter.conversationId) { where.push('t.conversation_id = ?'); params.push(filter.conversationId); }
    if (filter.kind) { where.push('t.kind = ?'); params.push(filter.kind); }
    if (filter.status?.length) { where.push(`t.status IN (${filter.status.map(() => '?').join(',')})`); params.push(...filter.status); }
    if (filter.assigneeKind) { where.push('t.assignee_kind = ?'); params.push(filter.assigneeKind); }
    if (filter.assigneeId) { where.push('t.assignee_id = ?'); params.push(filter.assigneeId); }
    if (filter.givenBy) {
      where.push(`t.${UNFINISHED_SQL} AND COALESCE(t.assigned_by, t.created_by) = ? AND COALESCE(t.assignee_id, 'human') <> ?`);
      params.push(filter.givenBy, filter.givenBy);
    }
    // The chat's space, else the chat-free task's own (a chat-free task without a space is in none).
    if (filter.spaceId) { where.push('COALESCE((SELECT c.space_id FROM conversations c WHERE c.id = t.conversation_id), t.space_id) = ?'); params.push(filter.spaceId); }
    if (filter.readableByPerson) { const readable = readableTasksSql(filter.readableByPerson); where.push(readable.sql); params.push(...readable.params); } // a person's queries
    if (filter.search?.trim()) {
      const query = ftsQuery(filter.search);
      if (!query) return [];
      where.push('t.rowid IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH ?)');
      params.push(query);
    }
    // "Recently done" window: finished tasks only, newest first (finish time as the UI reads it).
    const recent = filter.completedSince !== undefined;
    if (recent) {
      where.push(`t.status IN ('done', 'dropped') AND ${FINISHED_AT} >= ?`);
      params.push(filter.completedSince!);
    }
    params.push(Math.min(Math.max(filter.limit ?? 200, 1), 1000));
    const order = recent
      ? `${FINISHED_AT} DESC, t.created_at DESC`
      : filter.givenBy ? 't.updated_at DESC'
        : `${STATUS_RANK.replaceAll('status', 't.status')}, t.priority DESC, COALESCE(t."at", 9e15), t.sort, t.created_at`;
    return this.db.all<Row>(
      `SELECT t.* FROM tasks t ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ?`,
      params,
    ).map(toTask);
  }

  /** A person's unfinished to-dos (the owner's without `personId`): open first, each by its time → priority → age. */
  todos(limit: number, personId?: string): Task[] {
    const whose = personId ? `assignee_kind = 'human' AND assignee_id = ?` : OWNERS_TODO;
    return this.db.all<Row>(
      `SELECT * FROM tasks WHERE ${whose} AND kind = 'todo' AND ${UNFINISHED_SQL}
       ORDER BY CASE WHEN status = 'waiting' THEN 1 ELSE 0 END, CASE WHEN "at" IS NULL THEN 1 ELSE 0 END, "at", priority DESC, created_at LIMIT ?`,
      personId ? [personId, limit] : [limit],
    ).map(toTask);
  }

  openFor(agentId: string): Task[] {
    return this.db.all<Row>(
      `SELECT * FROM tasks WHERE assignee_kind = 'agent' AND assignee_id = ? AND ${UNFINISHED_SQL}
       ORDER BY priority DESC, COALESCE("at", 9e15), created_at`,
      [agentId],
    ).map(toTask);
  }

  /** People's unfinished to-dos whose time falls in (from, to] – the rings the watcher sends. */
  ringsBetween(from: number, to: number): Task[] {
    return this.db.all<Row>(
      `SELECT * FROM tasks WHERE assignee_kind = 'human' AND ${UNFINISHED_SQL} AND "at" > ? AND "at" <= ? ORDER BY "at" LIMIT 200`, [from, to],
    ).map(toTask);
  }

  /** The earliest time of a person's unfinished to-do after `now` (the watcher's ring timer). */
  nextRingAfter(now: number): number | undefined {
    const row = this.db.get<{ at: number | null }>(`SELECT MIN("at") AS at FROM tasks WHERE assignee_kind = 'human' AND ${UNFINISHED_SQL} AND "at" > ?`, [now]);
    return row?.at === null || row?.at === undefined ? undefined : Number(row.at);
  }

  /**
   * The open quests of an agent – its own, and those it holds an open to-do in – for which it has no active reminder on
   * the quest or one of its to-dos (the morning pass).
   */
  questsWithoutNote(agentId: string): Task[] {
    return this.db.all<Row>(
      `SELECT q.* FROM tasks q WHERE q.kind = 'quest' AND q.${UNFINISHED_SQL}
         AND ((q.assignee_kind = 'agent' AND q.assignee_id = ?)
           OR EXISTS (SELECT 1 FROM tasks d WHERE d.parent_id = q.id AND d.assignee_kind = 'agent' AND d.assignee_id = ? AND d.${UNFINISHED_SQL}))
         AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.owner_id = ? AND s.kind = 'reminder' AND s.active = 1
           AND (s.task_id = q.id OR s.task_id IN (SELECT d.id FROM tasks d WHERE d.parent_id = q.id)))
       ORDER BY q.priority DESC, q.created_at LIMIT 50`,
      [agentId, agentId, agentId],
    ).map(toTask);
  }

  /** An agent's unfinished to-dos outside a quest, with neither a reminder nor a pause or dependency wait. */
  todosWithoutNote(agentId: string): Task[] {
    return this.db.all<Row>(
      `SELECT t.* FROM tasks t WHERE t.kind = 'todo' AND t.parent_id IS NULL AND t.${UNFINISHED_SQL}
         AND t.assignee_kind = 'agent' AND t.assignee_id = ?
         AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.owner_id = ? AND s.kind = 'reminder' AND s.active = 1 AND s.task_id = t.id)
       ORDER BY t.priority DESC, t.created_at`,
      [agentId, agentId],
    ).map(toTask).filter((todo) => !isPaused(todo) && todo.waitingOn?.on !== 'task');
  }

  /** The unfinished tasks that come after `id` (tasks/depends.ts). */
  dependents(id: string): Task[] {
    return this.db.all<Row>(`SELECT * FROM tasks WHERE depends_on LIKE ? AND ${UNFINISHED_SQL}`, [`%"${id}"%`]).map(toTask);
  }

  byStatus(status: Task['status']): Task[] {
    return this.db.all<Row>('SELECT * FROM tasks WHERE status = ? ORDER BY created_at', [status]).map(toTask);
  }

  /**
   * An open human to-do anchored to a block id in a chat (block "id" replaces earlier ones) – only one the same author
   * created: another agent's block with that id never replaces it.
   */
  openByBlockId(conversationId: string, blockId: string, createdBy: string): Task | undefined {
    const row = this.db.get<Row>(
      `SELECT * FROM tasks WHERE conversation_id = ? AND assignee_kind = 'human' AND ${UNFINISHED_SQL}
       AND json_extract(widget, '$.id') = ? AND created_by = ? ORDER BY created_at DESC LIMIT 1`,
      [conversationId, blockId, createdBy],
    );
    return row ? toTask(row) : undefined;
  }

  private index(t: Task): void {
    this.db.run('DELETE FROM tasks_fts WHERE rowid = (SELECT rowid FROM tasks WHERE id = ?)', [t.id]);
    const text = foldText([t.title, t.notes, t.doneWhen ?? '', t.result?.summary ?? ''].join(' ')).trim();
    if (!text) return;
    this.db.run('INSERT INTO tasks_fts (rowid, task_id, text) SELECT rowid, id, ? FROM tasks WHERE id = ?', [text, t.id]);
  }
}
