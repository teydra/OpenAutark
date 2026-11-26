// Test fixture for My day's runtime (src/runtime/day/*): the task-center harness (chats, tasks, wakes, a running
// task center) plus settings in the Berlin zone with the day defaults, an in-memory calendar that keeps the
// CalendarService contract (one block per task, a person-set block is never moved by anyone else), the learned
// estimates, an optional scripted split/briefing helper, a host that counts keep-awake holds, and the one intake of a
// person's line (tasks/quick.ts, Quests round 20.11.2026).
// Owns: fixtures only. Never imported by src/.

import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { CalendarEvent, CalendarList, CalendarSource } from '../../../src/shared/model/calendar.ts';
import { DEFAULT_DAY_SETTINGS, type DaySettings } from '../../../src/shared/model/day-settings.ts';
import type { Space } from '../../../src/shared/model/org.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { CalendarService, CalendarSources } from '../../../src/runtime/contracts/calendar.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import { quickCreate, type QuickInput } from '../../../src/runtime/tasks/quick.ts';
import { center } from '../task-center/fixture.ts';

export { agent, tick } from '../task-center/fixture.ts';

export const BERLIN = 'Europe/Berlin';

/** The CalendarService contract over an array (no sources, no events on the bus). */
export class FakeCalendar implements CalendarService {
  events: CalendarEvent[] = [];
  removed: string[] = [];
  stale: string[] = [];
  private seq = 0;
  private readonly now: () => number;
  constructor(now: () => number) { this.now = now; }

  /** A meeting or appointment row. */
  event(startAt: number, endAt: number, extra: Partial<CalendarEvent> = {}): CalendarEvent {
    const row = this.row({ kind: 'event', title: 'Meeting', startAt, endAt, setBy: 'person', ...extra });
    this.events.push(row);
    return row;
  }

  list(ownerId: string, from: number, to: number): CalendarList {
    return { events: this.events.filter((e) => e.ownerId === ownerId && e.startAt < to && e.endAt > from), tasks: [], agentRuns: [], tz: BERLIN, staleSources: [...this.stale] };
  }

  add(): Promise<{ event: CalendarEvent }> { return Promise.reject(new WorkforceError('unavailable', 'not in the fake')); }

  move(id: string, startAt: number, endAt: number): CalendarEvent {
    const found = this.events.find((e) => e.id === id);
    if (!found) throw new WorkforceError('not_found', 'no row');
    return Object.assign(found, { startAt, endAt, setBy: 'person' as const, rev: found.rev + 1 });
  }

  remove(id: string): void {
    this.events = this.events.filter((e) => e.id !== id);
    this.removed.push(id);
  }

  busy(ownerId: string, from: number, to: number): Array<{ startAt: number; endAt: number }> {
    return this.list(ownerId, from, to).events.filter((e) => e.kind === 'event' || e.setBy === 'person').map(({ startAt, endAt }) => ({ startAt, endAt }));
  }

  onLocalChange(): () => void { return () => undefined; }

  private row(fields: Partial<CalendarEvent> & Pick<CalendarEvent, 'kind' | 'startAt' | 'endAt' | 'setBy'>): CalendarEvent {
    const now = this.now();
    return { id: `cev_${++this.seq}`, ownerId: HUMAN_ID, sourceId: 'local', state: 'planned', createdBy: HUMAN_ID, rev: 0, createdAt: now, updatedAt: now, ...fields };
  }
}

/** Connected calendars that only count their syncs. */
export function fakeSources(sources: CalendarSource[]): CalendarSources & { syncs: string[] } {
  const syncs: string[] = [];
  return {
    syncs,
    list: () => sources,
    listWithRooms: () => sources,
    addIcs: () => Promise.reject(new Error('no')),
    update: () => { throw new Error('no'); },
    remove: () => Promise.reject(new Error('no')),
    sync: async (_id?: string, reason?: string) => { syncs.push(reason ?? ''); return sources; },
    google: () => ({ configured: false, connected: false }),
    connectGoogle: () => Promise.reject(new Error('no')),
  };
}

export interface DayOptions {
  day?: Partial<DaySettings>;
  keepPcAwake?: boolean;
  now?: number;
  /** The split/briefing helper (false: none – the rules decide). */
  helper?: StructuredRunner | false;
  spaces?: Space[];
}

export function dayFixture(options: DayOptions = {}) {
  const h = center({ spaces: options.spaces });
  const s = h.s as RuntimeServices & { splitHelper?: StructuredRunner | false };
  let settings = {
    profile: { timezone: BERLIN }, day: { ...DEFAULT_DAY_SETTINGS, ...options.day },
    preferences: { keepPcAwake: options.keepPcAwake ?? true },
    org: { reportDelayMin: 20, autoAssignTasks: true },
  };
  s.settings = { get: () => settings, update: () => { throw new Error('no settings writes'); } } as unknown as RuntimeServices['settings'];
  const setKeepPcAwake = (keepPcAwake: boolean) => {
    settings = { ...settings, preferences: { ...settings.preferences, keepPcAwake } };
    h.bus.emit('settings.updated', settings as never);
  };
  /** Changes Settings › day and announces it like the settings service. */
  const setDay = (patch: Partial<DaySettings>) => {
    settings = { ...settings, day: { ...settings.day, ...patch } };
    h.bus.emit('settings.updated', settings as never);
  };
  if (options.now !== undefined) h.clock.set(options.now);
  const calendar = new FakeCalendar(() => h.clock.now());
  s.calendar = calendar;
  s.splitHelper = options.helper ?? false;
  const holds: string[] = [];
  let awake = 0;
  Object.assign(s.host, { keepAwake: (reason: string) => { holds.push(reason); awake++; let done = false; return () => { if (!done) { done = true; awake--; } }; } });
  /** The person's line through the one intake. */
  const line = (input: QuickInput, by: string = HUMAN_ID) => quickCreate(s, input, by);
  /** The microtasks of the last writes ran. */
  const settled = async () => { await h.settle(); };
  const todoChat = (): string | undefined => undefined; // B-054: no To-do chat – the person's to-dos are chat-free
  return { ...h, s, calendar, line, setDay, setKeepPcAwake, holds, awake: () => awake, settled, todoChat };
}
