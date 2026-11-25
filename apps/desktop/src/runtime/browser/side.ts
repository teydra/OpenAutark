// browser.* calls in the person's browser (a chat's area, the person's pane or – browser.show – an agent's area on its
// page, place.ts): one SideBrowserCall to main
// (host op sideBrowser, main/side-driver answers – its tabs, refs 's123', change lists, the agent's named cursor in the
// page and the person-first rule are its own). The call names the agent and the chat it works for, so a tab it opens
// carries both. The side driver takes elements by ref (its refs from its snapshot or find); B-080 (live: 9 "address
// elements by ref" refusals): a step named by its words – role and name, label, placeholder or text – is looked up here
// first with one 'find' in that tab and goes on with the ref of the one element that matches (or the nth); several or
// none answer with the lines found. A css selector stays my own browser's. A stored secret's value is taken from the
// vault here and typed there (the tool output passes the vault's redaction). Without the host op (no desktop app here)
// the call fails with one sentence. 25.11.2026: in Secure mode with the web not open everywhere each call carries the
// sites open without asking (`web`, sideWeb), so the tab an agent drives holds back a move anywhere else
// (main/side-driver/guard.ts).
// Owns: that mapping. Never: talks to main except through the host.

import { WorkforceError } from '../../shared/errors.ts';
import { webDomainsOf } from '../../shared/model/security-settings.ts';
import type { SideActStep, SideBrowserCall, SideBrowserResult, SideStepAction, SideWeb } from '../../shared/model/side-browser.ts';
import type { ToolContext } from '../tools/types.ts';
import { describeTarget } from './page.ts';

export const SIDE_MISSING = "The person's browser is not open here (it lives in the app window on this PC).";
export const SECRET = /^secret:\/\/([A-Za-z0-9_-]{1,64})$/;
export const SIDE_CSS = "A css selector works in my own browser; in the person's browser I name the element by ref or by its words.";

const STEP_ACTIONS: ReadonlySet<string> = new Set<SideStepAction>([
  'click', 'double_click', 'right_click', 'hover', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'scroll', 'scroll_into_view', 'back', 'forward', 'reload',
]);
const PAGE_ACTIONS: ReadonlySet<string> = new Set(['press', 'scroll', 'back', 'forward', 'reload']);
/** Steps that may go to a point (x, y): in an element, or in the visible page without one (side-driver/validate.ts POINT). */
const POINT_ACTIONS: ReadonlySet<string> = new Set(['click', 'double_click', 'right_click', 'hover']);
/** The most matching lines a conflict lists. */
const LISTED = 8;

/** The step arguments the browser tools share. */
export interface StepArgs {
  action: string; ref?: string; role?: string; name?: string; label?: string; placeholder?: string; text?: string; css?: string;
  exact?: boolean; nth?: number; value?: string; values?: string[]; key?: string; files?: string[]; amount?: number;
  /** CSS px: inside the element from its top-left, or – without one – in the visible page (17.11.2026). */
  x?: number; y?: number;
}

/** The tab and space of a side call (place.ts sideOn). */
export type SideOn = Pick<SideBrowserCall, 'tab' | 'space'>;

/** One act step as the side driver takes it (a stored secret's value filled in, an element named by words resolved to its ref). */
export async function sideStep(ctx: ToolContext, on: SideOn, args: StepArgs): Promise<SideActStep> {
  if (!STEP_ACTIONS.has(args.action)) throw new WorkforceError('bad_request', `${args.action} works in my own browser, not in the person's.`);
  const words = Boolean(args.role || args.label || args.placeholder || args.text);
  if (!args.ref && args.css && !words) throw new WorkforceError('bad_request', SIDE_CSS);
  const point = args.x !== undefined && args.y !== undefined;
  if (!args.ref && !words && !PAGE_ACTIONS.has(args.action) && !(point && POINT_ACTIONS.has(args.action))) {
    throw new WorkforceError('bad_request', "This step needs an element: in the person's browser I name it by ref (browser.snapshot or browser.find there) or by its words.");
  }
  const ref = args.ref ?? (words ? await refByWords(ctx, on, args) : undefined);
  const secret = args.value !== undefined ? SECRET.exec(args.value)?.[1] : undefined;
  const value = secret ? await ctx.services.secrets.use(secret, ctx.agent.id) : args.value;
  return {
    action: args.action as SideStepAction, ...(ref ? { ref } : {}), ...(value !== undefined ? { value } : {}),
    ...(args.values ? { values: args.values } : {}), ...(args.key ? { key: args.key } : {}), ...(args.amount !== undefined ? { dy: args.amount } : {}),
    ...(point && POINT_ACTIONS.has(args.action) ? { x: args.x, y: args.y } : {}),
  };
}

/** The ref of the one element in the person's tab that matches the step's words (or its nth match). */
async function refByWords(ctx: ToolContext, on: SideOn, args: StepArgs): Promise<string> {
  const name = args.name ?? args.label ?? args.placeholder ?? args.text;
  const what = describeTarget({ role: args.role, name: args.name, label: args.label, placeholder: args.placeholder, text: args.text });
  const query = [args.role, name].filter(Boolean).join(' ');
  const found = await sideCall(ctx, { action: 'find', query, ...on });
  const role = args.role?.toLowerCase();
  const lines = (found.text ?? '').split('\n').map((line) => line.trim()).filter((line) => {
    if (!/\[ref=s\d+\]/.test(line)) return false;
    if (role && /^-\s+(\S+)/.exec(line)?.[1]?.toLowerCase() !== role) return false;
    return !(args.exact && name) || line.includes(`"${name}"`) || line.endsWith(`: ${name}`); // the quoted name, or a text line's text
  });
  const pick = args.nth !== undefined ? lines[args.nth] : lines.length === 1 ? lines[0] : undefined;
  if (pick) return /\[ref=(s\d+)\]/.exec(pick)![1]!;
  if (!lines.length) throw new WorkforceError('not_found', `Nothing in the person's tab matches ${what}.`);
  throw new WorkforceError('conflict', `${lines.length} elements match ${what}: ${lines.slice(0, LISTED).join('; ')} – I take the ref of the one I mean, or nth.`);
}

/**
 * Sends `call` as this agent (for this chat); a refusal there becomes the agent's error – except a batch that ran
 * partly (`partial`: a result with `done`) or any answer (`partial` 'any': browser.wait's "did not come").
 */
export async function sideCall(ctx: ToolContext, call: Omit<SideBrowserCall, 'agent'>, partial: boolean | 'any' = false): Promise<SideBrowserResult> {
  const host = ctx.services.host;
  if (!host.sideBrowser) throw new WorkforceError('unavailable', SIDE_MISSING);
  let result: SideBrowserResult;
  try {
    const web = sideWeb(ctx);
    result = await host.sideBrowser({ ...call, agent: { id: ctx.agent.id, name: ctx.agent.name }, ...(ctx.conversationId ? { chat: ctx.conversationId } : {}), ...(web ? { web } : {}) });
  } catch (error) {
    if (error instanceof WorkforceError && error.code === 'unavailable') throw new WorkforceError('unavailable', SIDE_MISSING);
    throw error;
  }
  if (!result || typeof result !== 'object') throw new WorkforceError('internal', "The person's browser gave no answer.");
  if (!result.ok && !(partial === 'any' && !result.personActive) && !(partial && typeof result.done === 'number')) {
    const why = result.error?.slice(0, 400) || "The person's browser could not do this.";
    throw new WorkforceError(result.personActive ? 'conflict' : 'unavailable', why);
  }
  return result;
}

/**
 * 25.11.2026: what Secure mode lets an agent's side tab reach without asking – the chosen sites ('chosen'), none ('ask');
 * undefined when nothing is held back (Trust AI mode, the web open everywhere).
 */
export function sideWeb(ctx: Pick<ToolContext, 'services'>): SideWeb | undefined {
  let now;
  try { now = ctx.services.security?.current(); } catch { return undefined; }
  if (!now || now.mode !== 'secure' || now.web === 'yes') return undefined;
  return { sites: now.web === 'chosen' ? webDomainsOf(now) : [] };
}

/** The tab line facts of a side result. */
export function sidePage(result: SideBrowserResult): { tab: string; url: string; title: string; humanCheck?: boolean } {
  return { tab: result.tab ?? 'side', url: result.url ?? '', title: result.title ?? '', ...(result.humanCheck ? { humanCheck: true } : {}) };
}
