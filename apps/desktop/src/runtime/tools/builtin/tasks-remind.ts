// tasks.remind (Quests round 20.11.2026, the one "look again later" an agent has – CONTRACT "Reminder"): my own note at
// a time, once or repeating (a routine is a repeating note), about a quest or to-do (default the task my turn is about –
// tasks-util.ts turnTask; a chat line's turn tied to a task names it, or "none"; a turn without a task: none). When it
// fires I get the note and the quest as it stands now (schedules/fire.ts wakes me; context/quest-text.ts renders the
// quest). `list` shows my notes and posts and those of agents I manage – a scheduled post the person or an older build set
// up among them – that still run; `all` adds the paused and ended ones (owner 21.11.2026: what no longer runs reaches me
// only when I ask for it – the one rule shared/model/tasks.ts `stillRuns`). `cancel` ends one (a new time is a new note).
// Times in the person's zone (schedules/when.ts).
// Owns: this tool. Never: changes or cancels a schedule of the person's or of an agent I do not manage, or makes hidden
// recurring work (every note is listed and the person sees it).

import type { ToolContext } from '../types.ts';
import { WHEN_PROPERTY, failure, json, text } from '../types.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { stillRuns, type Schedule } from '../../../shared/model/tasks.ts';
import { profileZone } from '../../context/time.ts';
import { previewTimes } from '../../schedules/preview.ts';
import { WHEN_SCHEMA, isoIn, ruleWords, specFromWhen, type RepeatArgs } from '../../schedules/when.ts';
import { clip, defineTool, internal } from './util.ts';
import { askForId, requireTask, turnTask } from './tasks-util.ts';

/** My own schedules or those of agents I manage – never the person's. */
function mayChange(schedule: Schedule, ctx: ToolContext): boolean {
  return schedule.ownerId === ctx.agent.id || (schedule.ownerId !== HUMAN_ID && ctx.services.org.canManage(ctx.agent.id, schedule.ownerId));
}

/** One schedule as a line: id, kind, rule, next time, whose, what it is about. */
function scheduleLine(schedule: Schedule, ctx: ToolContext): string {
  const next = !schedule.active ? (schedule.pausedBy ? ' · paused' : ' · ended') : schedule.nextAt !== undefined ? ` · next ${isoIn(schedule.nextAt, schedule.spec.tz)}` : '';
  const owner = schedule.ownerId === ctx.agent.id ? '' : ` · of ${ctx.services.org.get(schedule.ownerId)?.name ?? schedule.ownerId}`;
  const about = schedule.taskId ? ` · about ${schedule.taskId}` : '';
  return `- ${schedule.id} · ${schedule.kind === 'reminder' ? 'note' : 'post'} · ${ruleWords(schedule.spec)}${next}${owner}${about} · ${clip(schedule.payload.note ?? schedule.payload.body ?? schedule.title, 120)}`;
}

/** What a new note answers: its id, rule and the next three times as the scheduler takes them. */
function made(schedule: Schedule, ctx: ToolContext): Record<string, unknown> {
  let next: string[] = [];
  if (schedule.nextAt !== undefined) {
    const spec = schedule.spec.everyMs !== undefined && schedule.spec.at === undefined ? { ...schedule.spec, at: schedule.nextAt } : schedule.spec;
    try { next = previewTimes(spec, ctx.services.clock.now(), { runs: schedule.runs }).map((at) => isoIn(at, schedule.spec.tz)); } catch { next = [isoIn(schedule.nextAt, schedule.spec.tz)]; }
  }
  return { ok: true, noteId: schedule.id, rule: ruleWords(schedule.spec), next, ...(schedule.taskId ? { about: schedule.taskId } : {}) };
}

export const remindTool = defineTool<{ text?: string; at?: string; repeat?: RepeatArgs; about?: string; list?: boolean; all?: boolean; cancel?: string }>({
  name: 'tasks.remind',
  description: 'Sends me my own note at a time, once or repeating, in the words I want to read then. It arrives with the quest\'s open to-dos under it. When I leave no note for an open quest or a standalone to-do, the next morning brings it up (except standalone to-dos that are paused or waiting on another task).',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 4000, description: 'The note, in my words.' },
      at: { ...WHEN_PROPERTY, description: `Once, at this time. ${String(WHEN_PROPERTY.description)}` },
      repeat: WHEN_SCHEMA.properties.repeat,
      about: { type: 'string', description: 'The quest or to-do it is about, or "none"; default the one my turn is about when it began in its thread or from a note or wake on it.' },
      list: { type: 'boolean', description: 'My notes and posts that still run, and those of agents I manage.' },
      all: { type: 'boolean', description: 'With list: my paused and ended ones too – what no longer runs I see when I ask for it.' },
      cancel: { type: 'string', description: 'The id of a note or post that ends.' },
    },
    additionalProperties: false,
  },
  category: 'think',
  describe: (args) => internal(args.list ? 'List my notes' : args.cancel ? `Cancel note ${args.cancel}` : `Note: ${clip(args.text ?? '', 60)}`, args.cancel),
  async run(args, ctx) {
    const scheduler = ctx.services.scheduler;
    if (args.list) {
      const mine = scheduler.list().filter((schedule) => mayChange(schedule, ctx) && (args.all === true || stillRuns(schedule)));
      return text(mine.length ? mine.map((schedule) => scheduleLine(schedule, ctx)).join('\n') : args.all ? 'No notes or posts.' : 'No notes or posts that still run.');
    }
    if (args.cancel) {
      const schedule = scheduler.get(args.cancel.trim());
      if (!schedule) return failure('No such note.');
      if (!mayChange(schedule, ctx)) return failure('This one belongs to someone I do not manage; it stays.');
      scheduler.remove(schedule.id);
      return json({ ok: true, cancelled: schedule.id });
    }
    if (!args.text?.trim()) return failure('A note says in text what I want to read then.');
    if ((args.at === undefined) === (args.repeat === undefined)) return failure('A note has one time: at, or repeat with every, times or cron.');
    const spec = specFromWhen(args.at !== undefined ? { at: args.at } : { repeat: args.repeat }, ctx.services.clock.now(), profileZone(ctx.services));
    if (typeof spec === 'string') return failure(spec);
    const named = args.about?.trim();
    // Without `about`: the task my turn is about (turnTask); a chat line's turn tied to a task names one – or "none".
    const about = named === 'none' ? undefined : named ? requireTask(ctx, named).id : turnTask(ctx)?.id;
    if (!named && !about && ctx.taskId) return failure(askForId(ctx));
    const schedule = scheduler.create({
      ownerId: ctx.agent.id, ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}), ...(about ? { taskId: about } : {}),
      kind: 'reminder', title: clip(args.text.trim(), 60), spec, payload: { note: args.text.trim() },
    });
    return json(made(schedule, ctx));
  },
});
