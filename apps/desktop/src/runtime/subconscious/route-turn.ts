// Unterbewusstsein v1 (14.11.2026, owner 13.11.: "wie schwierig ist diese Anfrage … vordenken"): the look before a turn is one
// call, not a run. The cheap model reads who the agent is, the person's standing words about how to work ("What I have here" of
// its SYSTEM.md – review 14.11.: the person's word outweighs the call's weighing only when the call sees it), what wakes the turn
// (the person's message, a colleague's, else its task) and the chat before it, and sets the coming turn's effort – never 'none':
// thinking stays on (owner 09.11.) – as the subconscious's step for that one turn (agents/next-route.ts, by 'subconscious').
// 17.11.2026 (the model settles; measured 15.–17.11.: the call caused 77 model switches, 64 on a live cache, 36 onto the small
// tier inside contexts of 100k–880k tokens, its reasons repeating the prompt's own tier list; its 418 effort-only changes held –
// a receipt took 9 s at low against 27 s at high): the call names no model. Its text has no tier list, no model list and no
// stay-or-switch weighing; its answer has one question per field – its own weighing before it names the effort – and the
// effort with its why is what code takes. The model is the router's
// (routing/router.ts: the model the session is on, changed at a boundary).
// The caller's signal is the turn's stop and its wait (service.ts): an answer that comes after it sets nothing, so it never
// shapes a later turn. requestHolds runs first on every turn: a step this call set for an earlier message ends (a turn that
// never reached its engine leaves it stored), and an effort already decided – the agent's own request (model.set), its task's
// or its fixed effort – holds (review 14.11.: the call replaced such a request) – the call then leaves the effort out.
// v2 (owner 15.11.2026: "Es gibt nur das Unterbewusstsein", one call with its own system prompt; 13:27: the three-hits rule goes,
// no hand-off to a bigger model): the call the turn waits for also reads the word search's hits for what wakes the turn.
// Runde „Halb“ 21.11.2026 (measured 19.–20.11.: 461 of 493 efforts it set were high or xhigh, and code lifted every line of a
// person to high): ROUTE_SYSTEM weighs the hardest step over the whole scale – the least it needs – by three questions that are
// the answer's own fields (is its way fixed, would a miss show by itself, must several things fit together); who wrote the
// message weighs nothing. A hit it picks reaches the turn as its own one-line hint (look.ts hintsOf, hints.ts – the live block's
// "## From my memory"), not as an opened entry: that stood whole in the context, read again on every later model call.
// On a slow lane the call runs beside a turn that started already (`beside`, service.ts): it sets no effort and only picks
// hits for the next turn, and a `probe` runs it with none, so the lane is measured.
// The condense call beside each turn went (its marks only took effect at a rebuild; code sets old output aside better and for
// nothing – context/ledger/window.ts). condensePart stays for a forked part's first start, with its own system prompt
// (PART_SYSTEM): there the context is all the part's coming work reads; a done item is condensed – it does not hide (measured
// 15.11.: every value and critical item it lost beyond code's was a hide), one yes or no per item (17.11.: with one list to
// condense, 35 were condensed although the note said to keep them).
// What another effort costs (effortCost): measured, an effort change keeps the cache on Claude Code and Codex, whose cache
// lives an hour; on our own API engines the effort shapes the rendered prompt, so while their five-minute cache lives
// (cacheLife) another effort writes the context into it again – the line says so with the price table's write and read
// price (models/pricing.ts cachePrices), and only there.
// Each call hands back the model that answered and its tokens for the log line (service.ts).
// FIXES-3 D1: the why on the run's route is for the person – in their language (routeSystem) and about how heavy the turn is;
// my text says what wakes a turn is asked of the main AI, which does the work with its own tools.
// Owns: these two calls, their prompts (routeSystem, PART_SYSTEM, turnFacts, standingWords, effortCost) and the step. Never: waits longer than the caller
// allows, names or sets a model, sets the effort 'none', or replaces an effort the agent, its task or its fixed setting decided.

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { Effort } from '../../shared/model/providers.ts';
import type { StructuredRunner } from '../decision/types.ts';
import { EFFORT_ORDER } from '../models/efforts.ts';
import { pendingRoute, setNextRoute, takeNextRoute } from '../agents/next-route.ts';
import { CACHE_COLD_MS } from '../agents/compaction-policy.ts';
import { coreInstructions } from '../agent-core/prompt.ts';
import { splitAtHave } from '../org/hire.ts';
import { newestLineChoice } from '../routing/policies.ts';
import { priorFor } from '../models/catalog-merge.ts';
import { cachePrices } from '../models/pricing.ts';
import { Priors } from '../models/priors.ts';
import { languageName } from '../context/environment.ts';
import { askContext } from './exchange.ts';
import { contextItems, hintsOf, hitLines, itemLines, markItems, searchHits } from './look.ts';
import { HINT_CHARS, type MemoryHint } from './hints.ts';
import { MAIN_THREAD } from '../../shared/model/origin.ts';

export const ROUTE_SYSTEM = `I am the main AI's subconscious. I set the effort a turn runs at and hand it what it will need from its knowledge. What wakes a turn is asked of the main AI, which does the work with its own tools; I do none of it and weigh how heavy it is. The fields I am asked for are the ones that still hold for this turn, and the line about the coming turn says how it runs. A turn runs at one effort from what wakes it – the person's message, a colleague's or its task – to its reply, so I set it before it starts, by the hardest part the turn will meet: the work it sets going, not its length. Effort is how long the main AI thinks before each step: too little sends it down a wrong path that later turns follow, too much costs time and money on every step and changes nothing in the result – so I look for the least the hardest step needs.

I weigh three things in that hardest step: whether its way is already fixed, whether a miss would show by itself, and how much has to fit together. low: the way is fixed and the result can be held against what is given. medium: the way is clear and a miss shows at once when the step runs – the normal for everyday work. high: the way has to be chosen, or it hangs on meaning or tone, and a miss would pass unnoticed. xhigh: several things have to fit together at once, or the cause is still unknown. max: the result itself is the point – a wording or a decision that has to be the best one – or xhigh fell short. Neither the length of a message nor who wrote it changes the weight.

What the person said about how to work – in this chat or in the agent's standing facts and agreements – outweighs my weighing, and an effort they picked in this chat for their newest message is what they want now.

A word search ran over the agent's knowledge – its memory, skills, references, documents and the secrets catalog (names and handles, never values) – with the words of what wakes the turn; its hits stand below with how each begins. A hit I pick reaches the main AI as one line of mine: what it changes in this turn, in a sentence – a fact it would otherwise not think of, a wish or rule of the person, a way that worked or failed here, the login or key it will work with. The main AI opens the entry itself when it needs the rest. A line costs almost nothing and a missing one can cost a wrong path, so I pick every hit that could change what the turn does and leave those that only share its topic.

I answer with the JSON asked for. Each field is one question and I answer each on its own: the hardest step in a few words, whether its way is fixed, whether a miss in it would show by itself, whether several things have to fit together in it at once, the effort, and why – how heavy this turn is for the main AI, in one short sentence the person reads in the run log; and the hits I pick, each with my line for the main AI.`;

/**
 * The system prompt of the call at a forked part's first start (condensePart): the context it starts from is all its coming work
 * reads, so the call says for each of the biggest items whether its job is done there.
 */
export const PART_SYSTEM = `I am the main AI's subconscious. A part of the main AI starts now from its context and works on one piece alone, and I keep that context lean for it. Everything in it is paid again on every later model call and dilutes its attention; the biggest items still whole in it stand below. An item is still needed while the coming work will read it again or act on something that stands only there. Its job is done once what it was for went into what came after – the main AI's answer, a file it wrote, a later status that replaced it, a step that is done –, however long the task it belongs to still runs: that its topic is still open does not tell. A done item is condensed: in its place stays my note of what still matters from it – a result, a decision, an open point, in a few words –, code adds every id, path, file name and link in it, and a stamp brings the original back, so nothing I set aside loses what later work may look up. A skill or instruction the coming work still follows is not done.

I answer with the JSON asked for: for every item shown whether its job is done, with my note for a done one.`;

const PROMPT_CHARS = 4000;
const WHY_CHARS = 200;
/** At most this much of "What I have here" (the largest of the 6 live parts 14.11.2026: 15,183 characters – each is read whole). */
const STANDING_CHARS = 16_000;
/** The efforts the call sets: every one with thinking (owner 09.11.: thinking is never turned off). */
const EFFORTS: readonly Effort[] = EFFORT_ORDER.filter((effort) => effort !== 'none');
/** What wakes the turn, as the prompt names it. */
const WAKE_LABEL = { person: "The person's new message:", colleague: "The colleague's message that wakes the main AI:", task: 'The task that wakes the main AI:' } as const;
/** The agent's newest runs the prompt's lines read for its last turn. */
const RECENT_RUNS = 50;

/** What a call used, as its runner reports it (decision/types.ts StructuredRunner). */
export type CallUse = Pick<Awaited<ReturnType<StructuredRunner>>, 'by' | 'usage'>;

/**
 * The person's standing words as the agent keeps them: its own facts – "What I have here" of its SYSTEM.md to the end, as the app splits
 * it (org/hire.ts splitAtHave), with the parts and subheadings each agent sorts them into (agreements, ways of working, model wishes,
 * not by day); whole, as the main AI reads it every turn (reviews 14.11.: a cut by position or at the next heading lost live model
 * lines), within STANDING_CHARS; '' without that part.
 */
export function standingWords(services: RuntimeServices, agent: Agent): string {
  try {
    const { tail } = splitAtHave(coreInstructions(services, agent).replace(/\r\n?/g, '\n'));
    const part = tail.split('\n').slice(1).map((line) => line.trimEnd()).filter((line) => line.trim()).join('\n'); // without its heading
    const text = part.length > STANDING_CHARS ? `${part.slice(0, STANDING_CHARS)} …` : part;
    try { return services.secrets.redact(text); } catch { return text; }
  } catch {
    return '';
  }
}

/** A task's request ends with the task (done, dropped or gone), as planTurn reads it. */
const finished = (services: RuntimeServices) => (taskId: string): boolean => {
  const status = services.tasks.get(taskId)?.status;
  return !status || status === 'done' || status === 'dropped';
};

/**
 * Before my call, on every turn: a step I set for an earlier message ends here (it was that message's); then true when the
 * turn's effort is decided already – the agent's own step (model.set), its task's effort or its fixed effort. A model the
 * agent asked for that waits for its boundary decides no effort.
 */
export function requestHolds(services: RuntimeServices, agent: Pick<Agent, 'id' | 'modelPolicy'>, taskId: string | undefined): boolean {
  const step = pendingRoute(services.db, agent.id, undefined, () => false);
  if (step?.by === 'subconscious') takeNextRoute(services.db, agent.id, step.stepAt);
  const pending = pendingRoute(services.db, agent.id, taskId, finished(services));
  return pending?.stepAt !== undefined || pending?.effort !== undefined || agent.modelPolicy?.effort !== undefined;
}

/**
 * My system prompt (FIXES-3 D1, real run 18.11.2026: the why came in Russian, French, Spanish and Polish on an English profile):
 * ROUTE_SYSTEM and the person's profile language as a fact, as the call voice is given it (calls/talker-prompt.ts voiceSystem) –
 * stable per profile, so it stays in front with the rest; ROUTE_SYSTEM alone without one.
 */
export function routeSystem(services: RuntimeServices): string {
  try {
    const code = services.settings.get().profile?.language?.trim();
    return code ? `${ROUTE_SYSTEM}\n\nThe person's language is ${languageName(code)}, so my why and my lines are in ${languageName(code)}.` : ROUTE_SYSTEM;
  } catch {
    return ROUTE_SYSTEM;
  }
}

/**
 * The line the call reads about how the coming turn runs – the model and effort of my last turn (any chat: one context) and
 * the effort the person picked for their newest message (read off that line, routing/policies.ts newestLineChoice – a pick
 * applies to one message); '' when nothing is known. Runde „Halb“ 21.11.2026: no floor for a
 * person's line – the weighing decides for every wake alike.
 */
export function turnFacts(services: RuntimeServices, agent: Agent, conversationId: string | undefined): string {
  try {
    const last = services.runs.list(agent.id, RECENT_RUNS).find((item) => !item.splitId && item.model);
    const name = last?.model ? services.catalog.get(last.model)?.name ?? last.model : '';
    const parts = [name ? `its last turn ran on ${name}${last?.effort ? ` at effort ${last.effort}` : ''}` : 'no turn yet'];
    const effort = newestLineChoice(services, conversationId, agent.id).effort;
    if (effort) {
      const person = services.settings.get().profile?.name?.trim() || 'the person';
      parts.push(`${person} picked effort ${effort} for their newest message – what they want now`);
    }
    return `The main AI's coming turn: ${parts.join('; ')}.`;
  } catch {
    return '';
  }
}

/**
 * Whether another effort keeps the prompt cache on the engine and model of the main AI's last turn (sources read 15.11.2026;
 * measured 15.–17.11.2026: 388 of 388 effort changes on Claude Code read their context from the cache). Claude Code – each
 * Autark turn starts it with --resume and --effort – keeps it on Fable 5.1 and later, Opus 5.5, Sonnet 5.5 and Haiku 5.5 with
 * a plan or key; on other models each effort has its own cache (code.claude.com/docs/en/prompt-caching, "Changing effort level"; the API
 * does it with a per-message effort, platform.claude.com/docs/en/build-with-claude/effort-per-message). Codex keeps it on GPT-6 models
 * (E4 14.11.: Sol medium → high on the app server, 99 % cached; OpenAI keeps the prefix with a configuration_update item,
 * developers.openai.com/api/docs/guides/prompt-caching). Our own API engines put the effort at the top of each request, where it shapes
 * the rendered prompt (the same two docs): another effort writes the context again. Undefined where nothing is known.
 */
export function effortKeepsCache(engine: string | undefined, modelId: string): boolean | undefined {
  const model = modelId.slice(modelId.indexOf(':') + 1);
  if (engine === 'claude') return /^claude-(?:(?:opus|sonnet|haiku)-5-5|(?:fable|mythos)-(?:5-[1-9]|[6-9]))/.test(model);
  if (engine === 'codex') return /^gpt-(?:[6-9]|\d{2,})/.test(model) ? true : undefined;
  if (engine === 'anthropic' || engine === 'openai') return false;
  return undefined;
}

/** "4", "0.2", "2.5": a price per 1M without trailing zeros. */
const dollars = (value: number) => String(Math.round(value * 100) / 100);

/**
 * How long the prompt cache of the engine the main AI's last turn ran on lives: an hour on the plan engines (Claude Code with
 * CLAUDE_CODE_PROMPT_CACHE_TTL=1h, Codex – measured 15.–17.11.2026), five minutes on our own API calls (anthropic.ts sends
 * cache_control ephemeral without a ttl, the 5-minute cache; OpenAI evicts an idle prefix after 5–10 minutes).
 */
export function cacheLife(engine: string | undefined): { ms: number; text: string } {
  return engine === 'claude' || engine === 'codex' ? { ms: CACHE_COLD_MS, text: 'an hour' } : { ms: 5 * 60_000, text: 'five minutes' };
}

/**
 * What another effort costs now – a line only where it costs something: the main AI's last turn ran within the life of its
 * cache (cacheLife) on an engine where another effort does not keep it (effortKeepsCache false). The context is then written
 * into the cache again at the price table's write price (the prior's, else its input price) instead of read at its cached
 * price (the prior's, else a tenth of the input price); '' everywhere else – the effort is free.
 */
export function effortCost(services: RuntimeServices, agent: Agent, now: number): string {
  try {
    const last = services.runs.list(agent.id, RECENT_RUNS).find((run) => !run.splitId && run.model && (run.endedAt ?? run.startedAt));
    if (!last?.model || effortKeepsCache(last.engine, last.model) !== false) return '';
    const since = now - (last.endedAt ?? last.startedAt ?? 0);
    const life = cacheLife(last.engine);
    if (since > life.ms) return '';
    const info = services.catalog.get(last.model);
    const name = info?.name ?? last.model;
    const prior = priorFor(Priors.shipped(services.paths?.resources), info?.model ?? last.model.slice(last.model.indexOf(':') + 1), last.model);
    const { write, read } = cachePrices(prior, info);
    const price = write !== undefined && read !== undefined ? ` – $${dollars(write)} per 1M tokens written against $${dollars(read)} read` : '';
    const at = last.effort ? ` at effort ${last.effort}` : '';
    return `What another effort costs now: the main AI's last turn ran ${Math.max(0, Math.round(since / 60_000))} min ago on ${name}${at}, and its cache lives ${life.text}. On this engine another effort writes the whole context into the cache again${price}; the same effort reads it from there.`;
  } catch {
    return '';
  }
}

/** What the call before a turn did: the effort line it set (none: it set no effort), its lines for the hits it picked (hints.ts), and what the call used. */
export interface Look extends Partial<CallUse> { line?: string; hints: MemoryHint[] }

/** The prompt's line where the turn's effort is decided already (requestHolds): the call leaves it. */
const HELD_LINE = "The main AI's coming turn runs at the effort its own request, its task or its fixed setting names – I leave it.";

/** The prompt's line of a call beside a turn that runs already (service.ts: the lane is slow): what it picks reaches the next turn. */
const BESIDE_LINE = "The main AI's turn has started already; the lines I give reach its next turn.";

/** What both calls read about the turn: who works, the standing words, `facts` (the route call's line), the chat before and what wakes it. */
function promptHead(services: RuntimeServices, input: { agent: Agent; conversationId?: string; said: string; from?: keyof typeof WAKE_LABEL }, facts: string): string[] {
  const { agent } = input;
  const standing = standingWords(services, agent);
  return [
    `Agent: ${agent.name}${agent.role ? ` – ${agent.role}` : ''}${agent.mode ? ` (mode ${agent.mode})` : ''}.`,
    ...(standing ? ['What the agent has here – its standing facts and agreements (its SYSTEM.md):', standing, ''] : []), // the same each turn: early, so it is read from cache
    ...(facts ? [facts, ''] : []),
    'The chat before (oldest first):',
    askContext(services, { agentId: agent.id, conversationId: input.conversationId, context: 'recent' }) || '(nothing)',
    '',
    WAKE_LABEL[input.from ?? 'person'],
    input.said.length > PROMPT_CHARS ? `${input.said.slice(0, PROMPT_CHARS)} …` : input.said,
  ];
}

/** The effort of an answer as the subconscious's step for this one turn, with its why; 'effort <e>', or undefined when it names none. */
function takeEffort(services: RuntimeServices, agent: Agent, answer: { effort?: unknown; why?: unknown; hardest?: unknown }): string | undefined {
  const effort: Effort | undefined = EFFORTS.find((item) => item === String(answer.effort ?? '').toLowerCase());
  if (!effort) return undefined;
  const why = String(answer.why ?? answer.hardest ?? '').replace(/\s+/g, ' ').trim().slice(0, WHY_CHARS); // it stays on the run's route: the log carries no chat content
  setNextRoute(services.db, agent.id, { effort, ...(why ? { reason: why } : {}), by: 'subconscious', at: services.clock.now() });
  return `effort ${effort}`;
}

/**
 * The route call's answer, one question per field: the three weights of the hardest step (ROUTE_SYSTEM's second paragraph), the
 * effort and its why (unless it is decided already), and the hits it picks, each with its line for the main AI (hints.ts).
 */
function lookSchema(effort: boolean, hits: readonly string[]) {
  const properties: Record<string, unknown> = {};
  if (effort) {
    Object.assign(properties, {
      hardest: { type: 'string', description: 'What is the hardest step this turn will meet, in a few words?' },
      fixed: { type: 'boolean', description: 'Is the way of that step already fixed?' },
      shows: { type: 'boolean', description: 'Would a miss in it show by itself when the step runs?' },
      together: { type: 'boolean', description: 'Do several things have to fit together in it at once?' },
      effort: { type: 'string', enum: [...EFFORTS], description: 'The least effort that hardest step needs?' },
      why: { type: 'string', description: 'How heavy is this turn, in one short sentence for the person?' },
    });
  }
  if (hits.length) {
    properties.hints = {
      type: 'array', description: 'Which hits could change what this turn does?',
      items: { type: 'object', properties: { id: { type: 'string', enum: [...hits] }, line: { type: 'string', description: `What does it change in this turn, in one sentence of at most ${HINT_CHARS} characters?` } }, required: ['id', 'line'], additionalProperties: false },
    };
  }
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

/**
 * The call before a turn (v2, 15.11.2026): the coming turn's effort as the subconscious's step – unless it is decided already
 * (`held`) or the turn does not wait for the answer (`beside`: an effort that comes late would be another message's) – and its
 * lines for the word search's hits it picks (look.ts hintsOf). No call without anything to choose, except a `probe` that
 * measures a slow lane (service.ts). Undefined when no call ran, it failed or its signal ended it. Never throws.
 */
export async function routeTurn(services: RuntimeServices, runner: StructuredRunner, input: { agent: Agent; conversationId?: string; thread?: string; said: string; from?: keyof typeof WAKE_LABEL; mode?: string; held?: boolean; beside?: boolean; probe?: boolean; signal?: AbortSignal; deadlineMs: number }): Promise<Look | undefined> {
  try {
    const { agent } = input;
    const mode = input.mode ?? agent.mode;
    const looked = { agent, thread: input.thread ?? MAIN_THREAD, ...(input.conversationId ? { conversationId: input.conversationId } : {}), ...(mode ? { mode } : {}) };
    const sets = !input.held && !input.beside;
    const hits = await searchHits(services, { ...looked, text: input.said, ...(input.signal ? { signal: input.signal } : {}) });
    if ((!sets && !hits.length && !input.probe) || input.signal?.aborted) return undefined; // a probe measures the lane (service.ts)
    const cost = sets ? effortCost(services, agent, services.clock.now()) : '';
    const prompt = [
      ...promptHead(services, input, input.held ? HELD_LINE : input.beside ? BESIDE_LINE : turnFacts(services, agent, input.conversationId)),
      ...(hits.length ? ['', hitLines(hits)] : []),
      ...(cost ? ['', cost] : []),
    ].join('\n');
    const reply = await runner({ purpose: 'subconscious', system: routeSystem(services), prompt, schema: lookSchema(sets, hits.map((hit) => hit.id)), effort: 'low', deadlineMs: input.deadlineMs, ...(input.signal ? { signal: input.signal } : {}) });
    if (input.signal?.aborted) return undefined; // the turn runs already, or was stopped
    const answer = (reply.structured ?? JSON.parse(reply.text)) as { effort?: unknown; why?: unknown; hardest?: unknown; hints?: unknown };
    const line = sets ? takeEffort(services, agent, answer) : undefined;
    const hints = hits.length && Array.isArray(answer.hints) ? hintsOf(services, agent.id, answer.hints, hits) : [];
    return { ...(line ? { line } : {}), hints, by: reply.by, ...(reply.usage ? { usage: reply.usage } : {}) };
  } catch (error) {
    try { services.log.debug('subconscious look failed', { error: String(error) }); } catch { /* nothing to report to */ }
    return undefined;
  }
}

/** What the call at a part's first start did: how many items it condensed, and what the call used (absent: no call ran). */
export interface Tidy extends Partial<CallUse> { condensed: number }

/**
 * The call at a forked part's first start (F26, 16.11.2026; service.ts condensePart): the biggest items still whole in the
 * part's copy of the record (look.ts contextItems); the answer says for every one of them whether its job is done, and the done
 * ones are marked with its note (look.ts markItems, which checks the note's values against the item and against this prompt –
 * what the call was shown). Runde „Halb“ 21.11.2026: before an agent's own turn no such call runs any more – code sets old
 * output aside there (context/ledger/window.ts). Returns how many it condensed (0 without items or on failure). Never throws.
 */
export async function condensePart(services: RuntimeServices, runner: StructuredRunner, input: { agent: Agent; conversationId?: string; thread?: string; said: string; from?: keyof typeof WAKE_LABEL; signal?: AbortSignal; deadlineMs: number }): Promise<Tidy> {
  try {
    const thread = input.thread ?? MAIN_THREAD;
    const items = contextItems(services, input.agent.id, thread);
    if (!items.length || input.signal?.aborted) return { condensed: 0 };
    const ids = items.map((entry) => entry.item.itemId);
    const prompt = [...promptHead(services, input, ''), '', itemLines(items, services.clock.now())].join('\n');
    const item = {
      type: 'object', required: ['id', 'done', 'note'], additionalProperties: false,
      properties: {
        id: { type: 'string', enum: ids },
        done: { type: 'boolean', description: 'Did what this item was for go into what came after – is its job done?' },
        note: { type: 'string', description: 'For a done item: what still matters from it, in a few words? Else empty.' },
      },
    };
    const schema = { type: 'object', properties: { items: { type: 'array', description: 'Every item shown, one entry each.', items: item } }, required: ['items'], additionalProperties: false };
    const reply = await runner({ purpose: 'subconscious', system: PART_SYSTEM, prompt, schema, effort: 'low', deadlineMs: input.deadlineMs, ...(input.signal ? { signal: input.signal } : {}) });
    const use = { by: reply.by, ...(reply.usage ? { usage: reply.usage } : {}) };
    if (input.signal?.aborted) return { condensed: 0, ...use }; // stopped
    const answer = (reply.structured ?? JSON.parse(reply.text)) as { items?: unknown };
    return { condensed: markItems(services, input.agent.id, thread, items, answer.items, prompt), ...use };
  } catch (error) {
    try { services.log.debug('subconscious condense failed', { error: String(error) }); } catch { /* nothing to report to */ }
    return { condensed: 0 };
  }
}
