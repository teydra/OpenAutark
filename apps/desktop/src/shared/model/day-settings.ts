// Settings sections `day` and `calendar` (B-041; Quests round 20.11.2026: what still has a reader): working hours, the
// free minutes kept around appointments when a free time is looked for, the end of the night (planAt), the Tasks line's
// "AI helps" (each line is the person's to-do at once, sorted by their assistant; off: every line is "Only me" – sorted
// too, never handed to an agent; tasks/quick.ts);
// plus the Google OAuth client the person connects
// (the client secret lives in the vault – settings hold only its id). They join Settings by module
// augmentation. All day math uses settings.profile.timezone; DAY_BOUNDARY_HOUR says until when a night still belongs
// to the day before (the time finder's "morgen", the UI's day).
// Quests round 20.11.2026 – a to-do for a day without a time ("morgen", the person's "Fr"): ONE representation, read
// the same everywhere (isDayOnly): `at` is the start of that day (local midnight in the person's zone) and `minutes` is
// absent. A timed to-do always has its clock time in `at`; one at exactly 00:00 carries `minutes`. Such a day rings at
// the start of the working day (ringAt: workStart), the calendar shows it in the day's strip, not at 00:00, and the
// Google mirror writes it as an all-day event (runtime/calendar/repo.ts todoRow).
// Owns: these shapes, their defaults, DAY_BOUNDARY_HOUR and the day-only rule. Never: reads, validates or
// stores settings (runtime/settings/*), a secret value, or zone math of its own (shared/text/when.ts has the one).

import { addDays, wallOf, wallTime } from '../text/when.ts';

/** Settings › day. */
export interface DaySettings {
  workStart: string; // 'HH:MM', default '08:00'
  workEnd: string; // default '20:00'
  bufferMin: number; // 0–60, default 10: kept free around appointments when a free time is looked for (calendar/rules.ts)
  planAt: string; // default '06:00': the night window for queued agent work ends then (day/keep-awake.ts)
  aiHelps: boolean; // the Tasks line: each line stands at once as the person's to-do and their assistant sorts it (false: each is "Only me" – sorted too, never handed to an agent), default true
}

/** Before 04:00 "tomorrow" means the coming day; one constant for parser, planner, Timer. */
export const DAY_BOUNDARY_HOUR = 4;
/** Upper bound of day.bufferMin (minutes kept free around appointments). */
export const MAX_BUFFER_MIN = 60;

export const DEFAULT_DAY_SETTINGS: Readonly<DaySettings> = Object.freeze({
  workStart: '08:00', workEnd: '20:00', bufferMin: 10, planAt: '06:00', aiHelps: true,
});

/** Settings › calendar: the person's own Google OAuth client (Desktop app type). */
export interface CalendarSettings {
  googleClientId?: string;
  googleSecretId?: string; // vault id of the client secret – never the secret itself
}

/** The day settings with every key (defaults for keys missing in older stored settings). */
export function daySettingsOf(settings: { day?: Partial<DaySettings> } | undefined): DaySettings {
  return { ...DEFAULT_DAY_SETTINGS, ...(settings?.day ?? {}) };
}

/** 'HH:MM' → minutes after local midnight (undefined when it is no valid clock time). */
export function clockMinutes(value: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

/** A to-do for a day without a time (see the header): `at` at local midnight in `zone`, no `minutes`. */
export function isDayOnly(task: { at?: number; minutes?: number }, zone?: string): boolean {
  return task.at !== undefined && task.minutes === undefined && wallOf(task.at, zone).minutes === 0;
}

/** When a person's to-do rings: its `at` – a day-only one at the start of the working day (`workStart`, else 08:00) of its day. */
export function ringAt(task: { at?: number; minutes?: number }, zone?: string, workStart?: string): number | undefined {
  if (task.at === undefined || !isDayOnly(task, zone)) return task.at;
  return wallTime(wallOf(task.at, zone).date, clockMinutes(workStart ?? '') ?? 8 * 60, zone);
}

/** The next start of the working day after `now` (a day-only to-do may ring then). */
export function nextWorkStart(now: number, zone?: string, workStart?: string): number {
  const wall = wallOf(now, zone);
  const minutes = clockMinutes(workStart ?? '') ?? 8 * 60;
  const today = wallTime(wall.date, minutes, zone);
  return today > now ? today : wallTime(addDays(wall.date, 1), minutes, zone);
}

declare module './system.ts' {
  interface Settings {
    /** Addition (B-041); missing in settings stored before it – read with daySettingsOf. */
    day?: DaySettings;
    /** Addition (B-041): optional, no defaults. */
    calendar?: CalendarSettings;
  }
}
