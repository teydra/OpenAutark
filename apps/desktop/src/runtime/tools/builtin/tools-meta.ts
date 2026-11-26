// tools.find / tools.call: the two meta tools beside every core set (tools/core-sets.ts), and the prompt's list of the
// tools they reach (moreToolsSection: one line per tool – name and the description's first sentence).
// tools.find answers which tools fit a job, best first, out of every tool that can work here (the registry's specsFor –
// every mode reaches every tool; a tool that cannot work here, phone.* without a linked phone or adb on this PC, answers
// why: cannotWork).
// Its first answer carries what a call needs: the best hit's whole description and argument schema, and the schema of
// every other hit that is small (else its compact arguments). A full tool name answers that tool's description and schema. Ranking: the name's parts, a short keyword index per tool family, the description's words.
// The prompt's list opens with one line on how a name from it is called on the calling engine (howToCall: the engine's
// own name for a tool, and the call tool as that engine names it – live 17.11.2026: Sonnet parts called web__fetch and failed).
// tools.call runs one of those tools: the registry unwraps it (registry.ts callThrough) and runs the target under its
// own name and this call's id, so validation, journal and result are a direct call's; a target that succeeded joins
// the agent's direct offer when its session next starts anew (tools/learned.ts).
// tools.call's `company` runs the target in another company on this PC (placement.ts placeCompany); companies.list
// (builtin/companies.ts), which names those companies, is registered with these two.
// A mail query while no mailbox is connected adds one line on where mail tools come from.
// Owns: their wording and argument shapes, the keyword index, the compact argument line, the one-line purpose (a
// tool's first sentence), the prompt's tool list, the name normalisation (wire names, the hub's mcp__workforce__
// prefix), what a tools.call may run (callRefusal, cannotWork) and calledTool for counting.
// Never: runs a tool itself, offers a tool that cannot work here, or nests tools.call.

import type { ModeInfo } from '../../../shared/model/knowledge.ts';
import type { ToolContext, ToolDef, ToolSpec } from '../types.ts';
import { failure, text } from '../types.ts';
import { CALL_TOOL, FIND_TOOL, META_TOOLS, coreNames, nativeWebSearchName } from '../core-sets.ts';
import { learnedTools } from '../learned.ts';
import { COMPANY_ARG, isRecord } from '../placement.ts';
import { companyTools } from './companies.ts';
import { APP_TOOL_PREFIX } from '../../apps/tools-schema.ts';
import { clip, defineTool, internal } from './util.ts';

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 12;
/** A hit after the first shows its whole schema up to this size (else its compact arguments). */
const SMALL_SCHEMA = 400;
/** A line in the prompt's tool list names what the tool does in at most this many characters. */
const BRIEF_CHARS = 100;
const HUB_PREFIX = 'mcp__workforce__';
/** The engine that names our tools under HUB_PREFIX (engines/claude/engine.ts id). */
const CLAUDE_ENGINE = 'claude';

/** A short keyword index: a family prefix ('calendar.') or a full name → words people use for that work. */
const KEYWORDS: Readonly<Record<string, string>> = {
  'calendar.': 'calendar appointment meeting event free slot gap day agenda busy connect ics google',
  'agents.': 'agent colleague team hire staff org role',
  'agents.split': 'split parallel fork worker subtask fan-out pipeline verify ultra', // B-057
  'chat.': 'chat message conversation post channel notes members invite direct dm edit delete archive reply',
  'people.': 'people person colleague employee human staff directory coworker',
  'tasks.': 'task quest to-do todo work give delegate handoff hand over assign ask person question wait done finish drop status owner thread prepare errand',
  'tasks.remind': 'schedule later remind reminder note recurring routine repeat daily weekly timer follow-up look again',
  'knowledge.': 'memory recall note fact preference source document skill procedure instructions how-to reference style example wrote person voice tone library open load',
  'memory.': 'memory remember note fact preference pin pinned forget',
  'skills.': 'skill procedure instructions how-to save write',
  'media.': 'image picture photo video audio sound music speech voice transcribe generate draw clip',
  'browser.': 'browser website page site click form login sign-in tab download',
  'computer.': 'screen desktop window mouse keyboard click app gui',
  'phone.': 'phone android mobile adb smartphone', // 17.11.2026: phone questions found mail tools
  // A code or a notification is read off the screen, so these words rank the two reading tools, not the ADB setup ones.
  'phone.key': 'notification notifications sms code authenticator 2fa otp quick settings back home recents',
  'phone.ui_tree': 'screen notification sms code authenticator 2fa otp text read elements',
  'secrets.': 'password secret credential token key vault login 2fa',
  'secrets.import': 'import export csv env dotenv file bitwarden', // 04.11.2026: a password export or a .env by its path
  'secrets.export': 'export download file passwords logins backup', // B-075
  'secrets.delete': 'delete remove clear passwords logins', // B-075
  'spend.': 'money budget purchase payment receipt invoice cost',
  'files.': 'file folder read write directory path',
  'files.write': 'save create append binary bytes base64 image screenshot',
  'shell.': 'terminal command run script bash powershell cmd console linked pc remote secret env environment',
  'web.': 'web internet search url page online',
  'models.': 'model llm compare stronger cheaper',
  'devices.': 'pc device linked computer transfer send fetch',
  'modes.': 'mode specialist',
  'accounts.': 'account sign-in login plan subscription',
  'spaces.': 'space area branch brand private', // B-075: "company" finds companies.list – a space is an area inside one company
  'companies.': 'company firm firma profile other', // B-075: the companies on this PC; tools.call with company acts in one
  decide: 'choose choice pick option decision',
  'chat.call': 'call ring phone talk voice speak', // B-081
  'ui.help': 'rich answer block chart table mini-app widget',
  'feedback.report': 'bug idea problem report maker developer feedback screen',
};

const STOP: ReadonlySet<string> = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'by', 'with', 'from', 'my', 'me', 'i', 'it', 'is', 'do', 'how', 'what', 'which', 'tool', 'tools', 'want', 'need', 'can', 'this', 'that', 'some', 'find', 'use', 'get', 'make']);

const words = (value: string): string[] => value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1 && !STOP.has(word));
/** Same word, or one a prefix of the other when both have at least four letters ("remind" ~ "reminders"). */
const same = (a: string, b: string): boolean => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** Our dotted name for what an agent wrote: a wire name ("ui__help"), the hub's qualified name or the dotted name. */
export function normalizeName(raw: string): string {
  const name = raw.trim().startsWith(HUB_PREFIX) ? raw.trim().slice(HUB_PREFIX.length) : raw.trim();
  return name.replace(/__/g, '.').toLowerCase();
}

/** The target of a tools.call: its normalised name and arguments ({} when none; top-level extras as arguments). B-075:
 *  `company` beside args is the company it runs in, kept apart from the arguments (a tool may have its own `company`). */
export function callTarget(args: unknown): { name: string; args: Record<string, unknown>; company?: unknown } | { error: string } {
  if (!isRecord(args) || typeof args.name !== 'string' || !args.name.trim()) return { error: 'tools.call needs the tool\'s name: {"name": "<a tool from tools.find>", "args": {…}}.' };
  let inner: unknown = args.args;
  if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { /* reported below */ } }
  const extra = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'name' && key !== 'args'));
  const { [COMPANY_ARG]: company, ...rest } = extra;
  if (inner === undefined) inner = extra; // a model that put the arguments beside the name (a `company` there is placed like one in args)
  else if (Object.keys(rest).length) return { error: `tools.call takes only name, args and company – put ${Object.keys(rest).join(', ')} inside args.` };
  if (!isRecord(inner)) return { error: 'tools.call: args must be an object with the tool\'s arguments.' };
  const name = normalizeName(args.name);
  return company === undefined || inner === extra ? { name, args: inner } : { name, args: inner, company };
}

/** A tools.call as the tool it runs (turn-attempt counts and labels it so); any other call unchanged. */
export function calledTool(name: string, args: unknown): { name: string; args: unknown } {
  if (name !== CALL_TOOL) return { name, args };
  const target = callTarget(args);
  return 'error' in target ? { name, args } : target;
}

/** The one family that needs something linked before it can work here (tools/registry.ts allowed). */
export const PHONE_FAMILY = 'phone.';

/** Why a registered tool is not offered here, with the reason the registry judged by (`tool`: the registered definition). */
export function cannotWork(name: string, tool?: Pick<ToolDef, 'modes'>): string {
  if (name.startsWith(PHONE_FAMILY)) {
    return `${name} needs a linked phone or adb on this PC, and neither is here: the person links theirs with the Autark app (skill phone-access); adb is set up by an agent in computer mode (skill phone-adb).`;
  }
  if (tool?.modes?.length) return `${name} works in mode ${tool.modes.join(' or ')}.`;
  return `${name} cannot work here right now.`;
}

/** A tool of this name is registered (a registry without the lookup counts as none). */
const registered = (ctx: ToolContext, name: string): boolean => { try { return Boolean(ctx.services.tools.get(name)); } catch { return false; } };

function modeOf(ctx: ToolContext): ModeInfo | undefined {
  try { return ctx.services.modes.get(ctx.mode); } catch { return undefined; }
}

/** The calling engine (the run's live activity) – its direct offer; undefined when unknown. */
function engineOf(ctx: ToolContext): { ownTools: boolean; via: 'mcp' | 'native' } | undefined {
  try {
    const id = ctx.services.dispatcher?.activity?.().find((entry) => entry.runId === ctx.runId)?.engine;
    if (!id) return undefined;
    const caps = ctx.services.engines.get(id).caps;
    return { ownTools: caps.ownTools, via: caps.dynamicTools ? 'native' : 'mcp' };
  } catch {
    return undefined;
  }
}

/** What the agent can use here on its engine, without the meta tools; undefined when the mode is unknown. */
function usableSpecs(ctx: ToolContext, mode: ModeInfo | undefined): ToolSpec[] | undefined {
  if (!mode) return undefined;
  try { return ctx.services.tools.specsFor(ctx.agent, mode, engineOf(ctx)).filter((spec) => !META_TOOLS.includes(spec.name)); } catch { return undefined; }
}

/** Why tools.call may not run `name` for this call (undefined: it may – the registry's own checks still apply). */
export function callRefusal(ctx: ToolContext, name: string): string | undefined {
  if (name === CALL_TOOL) return 'tools.call runs another tool, not itself: name the tool I want.';
  if (name === FIND_TOOL) return undefined;
  const usable = usableSpecs(ctx, modeOf(ctx));
  if (!usable || usable.some((spec) => spec.name === name)) return undefined;
  const tool = ctx.services.tools.get(name);
  return tool ? cannotWork(name, tool) : `Unknown tool "${name}". tools.find lists what I can use here.`;
}

function typeOf(prop: Record<string, unknown>): string {
  if (Array.isArray(prop.enum)) { const values = prop.enum.map(String); return values.length > 6 ? `${values.slice(0, 6).join('|')}|…` : values.join('|'); }
  const type = Array.isArray(prop.type) ? prop.type.join('|') : typeof prop.type === 'string' ? prop.type : prop.oneOf || prop.anyOf ? 'several forms' : 'any';
  if (type === 'array') { const items = isRecord(prop.items) ? typeOf(prop.items) : 'any'; return items.includes('|') ? `(${items})[]` : `${items}[]`; }
  if ((type === 'integer' || type === 'number') && (typeof prop.minimum === 'number' || typeof prop.maximum === 'number')) return `${type} ${prop.minimum ?? ''}–${prop.maximum ?? ''}`;
  return type;
}

/** "query*: string, limit: integer 1–20, kinds: (a|b)[]" – * marks a required argument. */
export function compactArgs(schema: Record<string, unknown>): string {
  const props = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const parts = Object.entries(props).map(([key, prop]) => `${key}${required.has(key) ? '*' : ''}: ${isRecord(prop) ? typeOf(prop) : 'any'}`);
  return parts.length ? clip(parts.join(', '), 300) : 'none';
}

/** The description's first sentence ("e.g." / "i.e." do not end it). */
const firstSentence = (description: string): string => description.split(/(?<=[.!?])(?<!\b(?:e\.g|i\.e)\.)\s/)[0]?.trim() ?? '';

/** The one-line purpose: the first sentence, clipped. */
export const purpose = (description: string): string => clip(firstSentence(description), 160);

function keywordsOf(name: string): string[] {
  const family = `${name.split('.')[0]}.`;
  return words([KEYWORDS[family] ?? '', Object.hasOwn(KEYWORDS, name) ? KEYWORDS[name] : ''].join(' '));
}

/** The specs that fit `query`, best first (score: name part 4, keyword 3, description word 1 per query word). */
export function rankTools(specs: readonly ToolSpec[], query: string, limit: number): ToolSpec[] {
  const asked = [...new Set(words(query))];
  if (!asked.length) return [];
  const scored = specs.map((spec) => {
    const parts = words(spec.name.replace(/[._-]/g, ' '));
    const keys = keywordsOf(spec.name);
    const described = words(spec.description);
    const score = asked.reduce((sum, word) => sum + (parts.some((part) => same(part, word)) ? 4 : keys.some((key) => same(key, word)) ? 3 : described.some((item) => same(item, word)) ? 1 : 0), 0);
    return { spec, score };
  });
  return scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || (a.spec.name < b.spec.name ? -1 : 1)).slice(0, limit).map((item) => item.spec);
}

/** The names this agent is offered directly here (its core set and learned tools). */
function directNames(ctx: ToolContext, mode: ModeInfo): Set<string> {
  const names = coreNames(mode, engineOf(ctx));
  try { for (const name of learnedTools(ctx.services.db, ctx.agent.id)) names.add(name); } catch { /* core set only */ }
  return names;
}

/** B-080 (live 06.–08.11.: mail queries found chat and device tools while no mailbox was connected): a mail query names where my mail tools come from. */
const MAIL = /\b(e-?mails?|mail|mailbox|smtp|imap|inbox|bounces?|postfach)\b/i;

/** The mail line – only for a mail query and only while no app.<id>.send is usable here, so it never reads as a setup step (G1). */
export const mailHint = (query: string, usable: readonly ToolSpec[]): string => MAIL.test(query) && !usable.some((spec) => /^app\.[^.]+\.send$/.test(spec.name))
  ? 'My mail tools (app.<name>.send, reply, search, read) come from a mailbox in <data>/connectors/mail.json – address plus password as secret://<id>, skill connect-apps; it connects within a second, and its Sent folder then holds every mail I send.'
  : '';

/** A query about a phone (17.11.2026: an agent asked the person for an SMS code while no phone was linked). */
const PHONE_WORDS = /\b(phones?|android|smartphone|adb|sms|otp|2fa|authenticator)\b/i;

/** The phone line – only for a phone query and only while no phone tool can work here: why, and the two ways to link one. */
export const phoneHint = (query: string, usable: readonly ToolSpec[]): string => (PHONE_WORDS.test(query) && !usable.some((spec) => spec.name.startsWith(PHONE_FAMILY))
  ? cannotWork(`${PHONE_FAMILY}*`)
  : '');

function families(specs: readonly ToolSpec[]): string {
  const counts = new Map<string, number>();
  for (const spec of specs) { const family = spec.name.split('.')[0]; counts.set(family, (counts.get(family) ?? 0) + 1); }
  return [...counts].map(([family, count]) => (count > 1 ? `${family}.* (${count})` : [...specs].find((spec) => spec.name.split('.')[0] === family)!.name)).join(', ');
}

/** The prompt list's line text: the description's first sentence without its asides in parentheses, cut at a word. */
export function brief(description: string): string {
  const sentence = firstSentence(description).replace(/\s*\([^()]*\)/g, '').replace(/[.!?]$/, '');
  if (sentence.length <= BRIEF_CHARS) return sentence;
  const cut = sentence.slice(0, BRIEF_CHARS);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), BRIEF_CHARS / 2)).replace(/[\s,;:–-]+$/, '')}…`;
}

export const MORE_TOOLS_HEADER = '## More tools (tools.find shows a tool\'s full arguments)';

/**
 * The list's first line: how a name from it is called on this engine (live 17.11.2026: 24 calls used the dotted name
 * itself – `web__fetch`, `tools__find` – because no engine is given our dotted names). Every engine gets our names with
 * each dot as two underscores; Claude Code sees them under `mcp__workforce__` as well (engines/claude/transcript.ts
 * hubWireName). `engine`: the calling engine's id.
 */
export function howToCall(engine?: string): string {
  const hub = engine === CLAUDE_ENGINE;
  const own = hub
    ? `${HUB_PREFIX} plus the name with each dot as two underscores (web.fetch is ${HUB_PREFIX}web__fetch)`
    : 'the name with each dot as two underscores (web.fetch is web__fetch)';
  return `A name below is written with dots here; my engine's own name for a tool is ${own}. Any name below I run through ${hub ? HUB_PREFIX : ''}tools__call {"name": "<the name as written here>", "args": {…}}.`;
}

/** A connected app's tool (app.<id>.<tool>): it comes and goes with the app, so the volatile apps line names it. */
const appTool = (name: string): boolean => name.startsWith(APP_TOOL_PREFIX) && name.split('.').length > 2;

// No calls in the 26.11.2026 audit. Leave registered, findable and learnable; chat.call stays visible for live calls.
const ON_DEMAND = new Set([
  'vector.search', 'vector.embed',
  'library.find', 'library.open', 'library.publish', 'library.rate',
  'patterns.find', 'patterns.load', 'decide', 'telegram.connect',
  'media.segments', 'media.describe', 'spaces.list', 'spaces.save', 'browser.save_secret',
]);
const MORE_TOOLS_HINT = 'I can find other tools (e.g. media annotations and team patterns) with tools.find.';

/**
 * The prompt's shortlist from `usable` beyond the `direct` offer: one line per tool family, with a hint if more
 * tools are discoverable on demand. No duplicate search when the engine already brings one. Sorted for caching.
 */
export function moreToolsSection(usable: readonly ToolSpec[], direct: ReadonlySet<string>, engine?: string): string {
  if (!direct.has(CALL_TOOL)) return '';
  const candidates = usable.filter((spec) => !direct.has(spec.name) && !META_TOOLS.includes(spec.name) && !appTool(spec.name));
  const hasOnDemand = candidates.some((spec) => ON_DEMAND.has(spec.name));
  const nativeSearch = nativeWebSearchName(engine);
  const more = candidates.filter((spec) => !ON_DEMAND.has(spec.name) && !(nativeSearch && spec.name === 'web.search'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (!more.length && !hasOnDemand) return '';
  const byFamily = new Map<string, string[]>();
  for (const spec of more) {
    const family = spec.name.split('.')[0];
    byFamily.set(family, [...(byFamily.get(family) ?? []), `${spec.name} – ${brief(spec.description)}`]);
  }
  return [
    MORE_TOOLS_HEADER,
    ...(more.length ? [howToCall(engine)] : []),
    ...(hasOnDemand ? [MORE_TOOLS_HINT] : []),
    ...[...byFamily.values()].map((tools) => tools.join(' · ')),
  ].join('\n');
}

const find = defineTool<{ query: string; limit?: number }>({
  name: FIND_TOOL,
  description: "Gives a tool's full arguments by its name, or finds tools for a job.",
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1, maxLength: 300, description: 'A tool name, or the job in words.' }, limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT } },
    required: ['query'], additionalProperties: false,
  },
  category: 'read',
  describe: (args) => internal(`Find tools for "${clip(args.query, 60)}"`),
  async run(args, ctx) {
    const mode = modeOf(ctx);
    const usable = usableSpecs(ctx, mode);
    if (!mode || !usable) return failure('My tools cannot be listed right now.');
    const named = normalizeName(args.query);
    const meta = META_TOOLS.includes(named) ? ctx.services.tools.get(named) : undefined; // always mine, and out of `usable`
    const exact = meta ?? usable.find((spec) => spec.name === named);
    if (!exact && registered(ctx, named)) return text(cannotWork(named, ctx.services.tools.get(named)));
    const direct = () => directNames(ctx, mode);
    if (exact) {
      return text([`${exact.name} – ${exact.description}`, `Arguments: ${JSON.stringify(exact.inputSchema)}`,
        direct().has(exact.name) ? 'It is in my list: I call it directly.' : `I run it with tools.call {"name": "${exact.name}", "args": {…}}.`].join('\n'));
    }
    const found = rankTools(usable, args.query, args.limit ?? DEFAULT_LIMIT);
    const mail = mailHint(args.query, usable);
    const phone = phoneHint(args.query, usable);
    if (!found.length) return text([`Nothing fits "${clip(args.query, 80)}". I can use these here: ${families(usable)}. Ask with other words or a tool name.`, mail, phone].filter(Boolean).join('\n'));
    const listed = direct();
    const lines = found.map((spec, index) => {
      const head = `- ${spec.name}${listed.has(spec.name) ? ' (in my list)' : ''}:`;
      const schema = JSON.stringify(spec.inputSchema);
      if (index === 0) return `${head} ${spec.description}\n  Arguments: ${schema}`;
      return `${head} ${purpose(spec.description)} Arguments: ${schema.length <= SMALL_SCHEMA ? schema : `${compactArgs(spec.inputSchema)} (* = required; its name as query gives the schema)`}`;
    });
    return text([`Tools for "${clip(args.query, 80)}", best first – tools.call {"name": …, "args": {…}} runs one:`, ...lines, mail, phone].filter(Boolean).join('\n'));
  },
});

const call = defineTool<{ name: string; args?: Record<string, unknown>; company?: string }>({
  name: CALL_TOOL,
  description: 'Runs a tool from More tools or tools.find, just as a direct call.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 }, args: { type: 'object' },
      [COMPANY_ARG]: { type: 'string', minLength: 1, maxLength: 120, description: 'Another company on this PC (companies.list).' },
    },
    required: ['name'], additionalProperties: false,
  },
  category: 'read', // never judged itself: the registry runs the target under its own category
  describe: (args) => internal(`Run ${clip(String(args.name), 60)}`),
  // The registry unwraps tools.call before it would get here; a direct run takes the same path.
  async run(args, ctx) {
    const { services, ...base } = ctx;
    return services.tools.call(CALL_TOOL, args, base, ctx.callId ?? '');
  },
});

export const metaTools: ToolDef[] = [find, call, ...companyTools]; // B-075: companies.list names tools.call's companies
