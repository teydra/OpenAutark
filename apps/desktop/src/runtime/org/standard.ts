// The standard SYSTEM.md (owner 14.11.2026, .local/offen-einfach-20261114/OWNER-2026-11-14.md: "als Kommentar in dieser
// Datei … der Standard-Systemprompt … einmal das für den Project Manager und einmal das für den Unteragent"). An agent's
// SYSTEM.md is its whole own standing text; one HTML comment at its end holds the standard of its kind –
// resources/prompts/standard-manager.md for an agent who leads (people report to it, or it was hired from the manager or
// head template), standard-agent.md for everyone else (or the person's own version in <data>/prompts) – rendered for this
// team. Comments never reach a model (prompt-stable.ts). Only active reports count, and an agent that starts or stops
// leading gets the other kind's text the same way a changed standard arrives.
// When the comment held another kind or an older standard (S2 17.11.2026, no wake – the change rides with the agent's next
// turn, whenever that comes): an own "# How I work" that is still the one the comment held – whitespace apart – is swapped
// for the new one by code; an own text that differs gets the standard's changed lines (was / now), or past the bound one
// line naming its own file, once as a note with its next turn
// (media/outputs.ts saveOutputNotes, the row agents/turn-finish.ts hands over). A comment that is missing (a hire, an edit
// that dropped it) or only renders other names comes back quietly. Only the agent's home PC writes it, so two PCs on
// different versions never take turns. 25.11.2026: nor does a row from a PC on an older release put its older comment over this
// one (keepNewerStandard, called where a synced agents row is written – devices/sync/tables.ts), and a wake that PC raises
// about it is dropped on arrival (devices/sync/rows.ts wakeHere).
// Owns: the comment's form, which standard an agent has, keeping it current, the swap and that note. Never: changes the
// agent's own text above the comment except the swap of an untouched standard part.

import { createHash } from 'node:crypto';
import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { renderTemplate } from '../context/templates.ts';
import { homeElsewhere } from '../devices/sync/home.ts';
import { saveOutputNotes } from '../media/outputs.ts';
import { CHANGED_MAX, changedLines } from '../agents/volatile-delta.ts';
import { systemMdValues } from './hire.ts';
import { ownHowIWork } from './system-parts.ts';

export type StandardKind = 'manager' | 'agent';
export interface Standard { kind: StandardKind; rev: string; text: string }
type Deps = Pick<RuntimeServices, 'db' | 'org' | 'clock' | 'settings' | 'log'> & Partial<Pick<RuntimeServices, 'prompts'>>;

/** Templates whose hires lead an area from the start. */
export const LEAD_TEMPLATES: ReadonlySet<string> = new Set(['manager', 'head']);
export const standardKind = (leads: boolean): StandardKind => (leads ? 'manager' : 'agent');
export const standardName = (kind: StandardKind) => `standard-${kind}` as const;

/** Whether `agent` leads: someone active reports to it, or it was hired from a leading template (the one answer for
 *  the standard text and for routing – routing/kind.ts); an org that cannot list its agents gives false. */
export function leads(org: Pick<RuntimeServices['org'], 'list'>, agent: Pick<Agent, 'id' | 'template'>): boolean {
  if (agent.template !== undefined && LEAD_TEMPLATES.has(agent.template)) return true;
  try { return org.list().some((other) => other.managerId === agent.id && other.archivedAt === undefined); } catch { return false; }
}

const MARK = '<!-- Autark standard:';
/** Every standard comment, wherever it stands (an agent may have copied one into its text). */
const BLOCKS = /\n*<!-- Autark standard: (manager|agent) · ([0-9a-f]{8})\n[\s\S]*?-->[ \t]*/g;
const INTRO = 'The team\'s standard SYSTEM.md for this kind of agent, as the app ships it now. My text above is my own; the app keeps only this comment current, and no comment reaches the model. How I make it my own: skill system-prompt.';

/** The standard of `kind` in force, rendered with `values`; rev names the unrendered text. */
export function standardOf(prompts: Pick<NonNullable<RuntimeServices['prompts']>, 'text'>, kind: StandardKind, values: Readonly<Record<string, string>>): Standard {
  const raw = prompts.text(standardName(kind));
  return { kind, rev: createHash('sha256').update(raw).digest('hex').slice(0, 8), text: renderTemplate(raw, values) };
}

/** `text` without its standard comments, and the kind, rev and text of the last one. */
export function splitStandard(text: string): { own: string; kind?: StandardKind; rev?: string; held?: string } {
  let kind: StandardKind | undefined;
  let rev: string | undefined;
  let held: string | undefined;
  const own = text.replace(BLOCKS, (all: string, k: StandardKind, r: string) => {
    kind = k; rev = r;
    const at = all.indexOf(`${INTRO}\n\n`);
    held = at < 0 ? undefined : all.slice(at + INTRO.length + 2).replace(/\n-->[ \t]*$/, '');
    return '';
  }).trimEnd();
  return { own, ...(kind ? { kind, rev, ...(held !== undefined ? { held } : {}) } : {}) };
}

/** `own` with `standard` as the comment at its end (a "-->" inside could not end the comment early). */
export function withStandard(own: string, standard: Standard): string {
  const body = standard.text.replaceAll('-->', '-- >');
  return `${splitStandard(own).own}\n\n${MARK} ${standard.kind} · ${standard.rev}\n${INTRO}\n\n${body}\n-->`;
}

/** The note that rides with my next turn when the standard changed and my own text is not its old form, in my voice. */
export function standardNote(kind: StandardKind, before: StandardKind | undefined, lines: readonly string[]): string {
  const lead = before && before !== kind
    ? `The team's standard for my SYSTEM.md is now the one for agents who ${kind === 'manager' ? 'lead people' : 'lead no one'}.`
    : 'The team\'s standard for my SYSTEM.md changed with this version of the app.';
  const text = lines.join('\n');
  // The bound of the was/now lines (agents/volatile-delta.ts): past it the whole new standard stands in my own file.
  const body = text.length > CHANGED_MAX
    ? 'More of it changed than reads as lines: the whole new standard stands as the comment at the end of my SYSTEM.md.'
    : `The changed lines of the standard:\n${text}`;
  return `${lead} My own text differs from the standard it replaces, so it stays as it is; where a changed line fits my work, I bring my own text in line with it (skill system-prompt). ${body}`;
}

/**
 * The revisions (the `rev` of a comment) of every standard this app shipped before the one in force – the shipped files
 * standard-agent.md and standard-manager.md (git log of resources/prompts). A comment naming one of them is an older
 * standard; a hash alone cannot say which of two is newer, so whoever edits a shipped standard adds the revision it
 * replaces here (the test prints the current ones). 25.11.2026: ORENDA – a 0.3.9 PC wrote its own older standard back.
 */
export const OLDER_REVS: ReadonlySet<string> = new Set([
  'dbc85f70', '6e355391', '4625c7cb', '9f832c5f', // standard-agent.md: 0.3.6, 0.3.6+, 0.3.9, 0.3.10
  'd899ddc2', '7d0c498a', 'be0d6424', '6463e3d3', // standard-manager.md: the same releases
]);

/**
 * `incoming` instructions of an agent from another PC, with this PC's comment kept when the incoming one only holds an
 * older standard (a PC on an older release keeps writing its own): never an older standard over a newer one. The text
 * above the comment is the incoming one, so a real edit arrives. Only on the PC that keeps the comment itself (not
 * the agent's home elsewhere), and only against a revision known to be older – an unknown one may be newer.
 */
export function keepNewerStandard(s: Pick<RuntimeServices, 'org' | 'db'>, agentId: string, local: string, incoming: string): string {
  const here = splitStandard(local);
  const there = splitStandard(incoming);
  if (!here.rev || !there.rev || !OLDER_REVS.has(there.rev) || OLDER_REVS.has(here.rev)) return incoming;
  if (here.kind === there.kind && here.rev === there.rev) return incoming;
  if (homeElsewhere(s, agentId)) return incoming;
  const kept = [...local.matchAll(BLOCKS)].at(-1)?.[0].trim();
  return kept ? `${there.own}\n\n${kept}` : incoming;
}

/** The same text: whitespace (a paragraph split over two lines) reads alike, so it counts as untouched. */
const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/** Brings the standard comment of `agent` up to date; returns what happened. */
export function syncStandard(s: Deps, agent: Agent): 'same' | 'quiet' | 'swapped' | 'noted' {
  if (agent.archivedAt !== undefined || !s.prompts || homeElsewhere(s, agent.id)) return 'same';
  const standard = standardOf(s.prompts, standardKind(leads(s.org, agent)), systemMdValues(s.settings.get()));
  if (!standard.text) return 'same'; // a broken install: no standard to keep
  const { own, kind, rev, held } = splitStandard(agent.instructions);
  const fresh = !kind || (kind === standard.kind && rev === standard.rev); // missing, or only other names rendered
  const oldHow = held !== undefined ? ownHowIWork(held.replaceAll('-- >', '-->')).how : '';
  const mine = ownHowIWork(own);
  const swap = oldHow !== '' && sameText(mine.how, oldHow) ? ownHowIWork(standard.text).how : '';
  const text = swap ? [swap, mine.rest].filter(Boolean).join('\n\n') : own;
  const next = withStandard(text, standard);
  if (next === agent.instructions) return 'same';
  s.org.update(agent.id, { instructions: next }, { by: HUMAN_ID, reason: swap ? 'The standard part of SYSTEM.md follows the new standard.' : 'The standard comment in SYSTEM.md is current again.' });
  if (swap || fresh) return swap && !fresh ? 'swapped' : 'quiet';
  const lines = held !== undefined ? changedLines(held, standard.text) : [];
  if (!lines.length) return 'quiet';
  saveOutputNotes(s.db, s.clock.now(), agent.id, [standardNote(standard.kind, kind, lines)]);
  return 'noted';
}

/** 24.11.2026 (ORENDA, 672 identical lines): one failure per agent is reported once in this process; the same agent with
 *  the same failure stays quiet, another failure or another agent is reported. */
const keepFailuresSeen = new Set<string>();
export function warnKeepFailure(log: Deps['log'], agentId: string, error: unknown): void {
  const message = String((error as Error)?.message ?? error);
  const key = `${agentId}\n${message}`;
  if (keepFailuresSeen.has(key)) return;
  keepFailuresSeen.add(key);
  log.warn('standard comment not kept', { agentId, error: message });
}

/** At runtime start every agent's comment, then each agent the org announces (a hire, an edit, a new manager) and everyone
 *  whose kind that changed. */
export function startStandards(s: Deps & Pick<RuntimeServices, 'bus'>): () => void {
  const busy = new Set<string>(); // the update below announces the agent again
  const sync = (agent: Agent | undefined) => {
    if (!agent || busy.has(agent.id)) return;
    busy.add(agent.id);
    try { syncStandard(s, agent); } catch (error) {
      warnKeepFailure(s.log, agent.id, error);
    } finally { busy.delete(agent.id); }
  };
  for (const agent of s.org.list()) sync(agent);
  return s.bus.on('agent.upserted', (agent: Agent) => {
    sync(agent);
    // Everyone whose comment now holds the other kind: the new manager of a report, one whose last report left or moved on.
    try {
      const all = s.org.list();
      const org = { list: () => all }; // one read of the org for every check
      for (const other of all) if (other.id !== agent.id && kindChanged(org, other)) sync(other);
    } catch (error) {
      s.log.warn('standard kinds not re-checked', { agentId: agent.id, error: String((error as Error)?.message ?? error) });
    }
  });
}

/** True when the kind in `agent`'s comment is no longer the kind it leads by. */
function kindChanged(org: Pick<RuntimeServices['org'], 'list'>, agent: Agent): boolean {
  if (agent.archivedAt !== undefined) return false;
  const { kind } = splitStandard(agent.instructions);
  return kind !== undefined && kind !== standardKind(leads(org, agent));
}
