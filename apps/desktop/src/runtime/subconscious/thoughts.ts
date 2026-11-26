// The subconscious's own thoughts (B-078 D14, owner 06.11.2026: "dass es … sich Gedanken auch wirklich speichert. Muss
// nicht immer so schön sein, sondern kann auch so stichwortartig sein"): thought.keep appends keyword lines, each with its
// day, to the memory file agents/<id>/thoughts.md – a memory file like any other, so knowledge.find finds it with the
// rest; the newest THOUGHTS_SHOWN lines open each run (flow.ts). The same thought is kept once; the file keeps the newest
// MAX_LINES lines, each thought whole (B-080, live 08.11.2026: a cut at 200 characters ended 6 of 7 lines mid-word). Also
// the card of the agent a run works beside (agentCard, Unterbewusstsein v1 14.11.2026, DESIGN-v1.md "Agentenkarte"): in place
// of the main AI's whole stable prompt, which cost 37–53k characters a step on the live agents (measured
// .local/unterbewusstsein-20261113/offen/subconscious) – the person's standing words still whole (B-080, live 08.11.: a cut at
// 12,000 characters hid most of the agents' agreements).
// Owns: the thoughts file's form, the tool and the card's form. Never: keeps a secret value or lists memory into a context.

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { Run } from '../../shared/model/runs.ts';
import '../contracts/open-fs.ts';
import { dayText } from '../knowledge/age.ts';
import { profileZone } from '../context/time.ts';
import { newestLineChoice } from '../routing/policies.ts';
import { standingWords } from './route-turn.ts';
import type { FlowRun, FlowTool } from './tools.ts';

export const THOUGHTS_SHOWN = 12;
const MAX_LINES = 200;
const LINES_PER_CALL = 5;
/** The agent's newest runs the card reads for the model it runs on and its context size. */
const CARD_RUNS = 20;

export const thoughtsPath = (agentId: string): string => `agents/${agentId}/thoughts.md`;

function lines(text: string | undefined): string[] {
  return (text ?? '').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('- '));
}

/** The newest kept thoughts of this agent's subconscious ('' when there are none). */
export function recentThoughts(services: RuntimeServices, agentId: string, count = THOUGHTS_SHOWN): string {
  try { return lines(services.knowledge.memoryRead(thoughtsPath(agentId))?.text).slice(-count).join('\n'); } catch { return ''; }
}

export const thoughtTool: FlowTool = {
  name: 'thought.keep',
  args: '{text}',
  line: 'Keeps a thought of mine in keywords – what I noticed, suspect, want to look at again, how things hang together – in my own thoughts file, one line each (up to five). The newest open each of my runs; knowledge.find finds the file like any memory. Rough is fine; a secret value stays out.',
  run(args, run: FlowRun) {
    const given = typeof args.text === 'string' ? args.text : Array.isArray(args.text) ? args.text.join('\n') : '';
    const redact = (value: string) => (run.services.secrets ? run.services.secrets.redact(value) : value);
    let day = '';
    try { day = dayText(run.services.clock.now(), profileZone(run.services)); } catch { day = ''; }
    const fresh = given.split('\n').map((line) => redact(line.replace(/^[-*\s]+/, '').replace(/\s+/g, ' ').trim())).filter(Boolean).slice(0, LINES_PER_CALL);
    if (!fresh.length) return 'thought.keep needs a text.';
    const file = thoughtsPath(run.agent.id);
    const old = lines(run.services.knowledge.memoryRead(file)?.text);
    const known = new Set(old.map((line) => line.replace(/^- (\d{4}-\d{2}-\d{2}: )?/, '')));
    const added = fresh.filter((line) => !known.has(line));
    if (!added.length) return 'kept already';
    const next = [...old, ...added.map((line) => `- ${day ? `${day}: ` : ''}${line}`)].slice(-MAX_LINES);
    run.services.knowledge.memoryWrite({ path: file, title: `Thoughts of ${run.agent.name}'s subconscious`, text: next.join('\n'), description: 'My own keyword notes as the subconscious: what I noticed and want to look at again.', by: 'subconscious' });
    return `kept: ${added.length}`;
  },
};

function safe<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

/** A route's parts as one text: model · effort · temperature ('' when none is given). */
function routeText(services: RuntimeServices, value: { model?: string; effort?: string; temperature?: number }): string {
  const model = value.model ? safe(() => services.catalog.get(value.model!)?.name, undefined) ?? value.model : '';
  return [model, value.effort ? `effort ${value.effort}` : '', value.temperature !== undefined ? `temperature ${value.temperature}` : ''].filter(Boolean).join(' · ');
}

/** 26.11.2026: the person's pick on the card – made for their newest message only (it is gone from the chat once sent). */
function suggestedLine(person: string, suggested: string): string {
  return `- ${person} picked ${suggested} for it for their newest message – what they want now.`;
}

/**
 * The card of the agent a run works beside, redacted. Stable first, so a run's steps and the agent's runs share a cached prefix: who it is
 * (name, role, team, the mode of the turn that asks) and the person's standing words as it keeps them – "What I have here" of its SYSTEM.md
 * whole, the text the routing call reads (route-turn.ts standingWords). Then what moves: the engine and model it runs on, its task, the
 * person's suggestion in this chat and how big its context is per model call (its newest run that counted it).
 */
export function agentCard(services: RuntimeServices, agent: Agent, now: { mode: string; conversationId?: string; taskId?: string }): string {
  const mode = safe(() => services.modes.get(now.mode)?.name, undefined) ?? now.mode;
  const role = agent.role?.trim() ? ` – ${agent.role.trim()}` : '';
  const team = agent.team?.trim() ? `, team ${agent.team.trim()}` : '';
  const standing = standingWords(services, agent);
  const runs = safe(() => services.runs.list(agent.id, CARD_RUNS).filter((run) => !run.splitId), [] as Run[]);
  const on = runs.find((run) => run.model);
  const sized = runs.find((run) => run.inputTokens && run.modelCalls);
  const task = now.taskId ? safe(() => services.tasks.get(now.taskId!), undefined) : undefined;
  const chip = safe(() => newestLineChoice(services, now.conversationId, agent.id), {});
  const suggested = routeText(services, { model: chip.pin, effort: chip.effort, temperature: chip.temperature });
  const person = safe(() => services.settings.get().profile?.name?.trim(), undefined) || 'The person';
  const moving = [
    on ? `- It runs on ${[on.engine, routeText(services, { model: on.model, effort: on.effort })].filter(Boolean).join(' · ')}.` : '',
    task ? `- Its task: "${task.title}" (${task.status}).` : '',
    suggested ? suggestedLine(person, suggested) : '',
    sized ? `- Its context: about ${Math.round(sized.inputTokens! / sized.modelCalls! / 1000)}k tokens per model call.` : '',
  ].filter(Boolean);
  const text = [
    '# The agent I work beside',
    `${agent.name}${role}${team}; it works in the mode ${mode}.`,
    ...(standing ? ['', 'What it has here – its standing facts and agreements with the person (its SYSTEM.md):', standing] : []),
    ...(moving.length ? ['', '## Now', ...moving] : []),
  ].join('\n');
  return services.secrets ? services.secrets.redact(text) : text;
}
