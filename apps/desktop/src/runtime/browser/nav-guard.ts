// Secure mode's guard on the agents' own browsers (25.11.2026, after Andrea Griffiths' VM test: data could leave through
// any URL). With the web on 'chosen' the security gate checks the site of each browser.open (security/tool-gate.ts
// webNeed); a click on a link or a form sent from a page moves the tab without a call the gate sees. So, while the guard
// is active, every top-level navigation of an agent's own browser – a click, a form, the page's own script, a new tab –
// goes through only to a site this session passed through the gate (browser.open / the person's own open) or one the
// policy lets through without asking (webDomains); any other is held back (net::ERR_BLOCKED_BY_CLIENT) and the step's
// answer says which site, so the agent opens it with browser.open and the app asks the person.
// Frames inside a page (ads, embedded videos, payment fields) load as the page wants: the page chose them, not the agent.
// Known limit: Playwright's route sees a navigation's first request, not the hops of a server redirect.
// Owns: the guard's rule and its install on a context. Never: asks the person (the gate does) or reads settings.

import { siteListed, siteOfUrl } from '../../shared/model/security-settings.ts';

/** What the guard knows of the security settings (compose/network.ts builds it on services.security). */
export interface NavGuard {
  /** True while moves to new sites are checked: Secure mode with the web not open everywhere. */
  active(): boolean;
  /** True when the policy lets the agent reach `site` without asking. */
  open(agentId: string, site: string): boolean;
}

/** The part of Playwright's Route a guard uses. */
export interface RouteLike { abort(code?: string): Promise<void>; continue(): Promise<void>; fallback?(): Promise<void> }
/** The part of Playwright's Request a guard uses. */
export interface RequestLike { url(): string; isNavigationRequest(): boolean; frame(): { parentFrame(): unknown } }

/** A session's guard state: the sites passed through the gate, the last site held back, whether the route is on. */
export interface GuardState { agentId: string; passed?: Set<string>; held?: string; guarded?: boolean }

/** Whether a top-level navigation of `state`'s browser to `url` goes through (undefined) or the site it holds back. */
export function heldSite(guard: NavGuard, state: GuardState, url: string): string | undefined {
  if (!guard.active()) return undefined;
  const site = siteOfUrl(url);
  if (!site) return undefined; // about:, data:, blob: – no site reached
  if (siteListed([...(state.passed ?? [])], site) || guard.open(state.agentId, site)) return undefined;
  return site;
}

/** The route handler of a guarded context. */
export function guardRoute(guard: NavGuard, state: GuardState): (route: RouteLike, request: RequestLike) => Promise<void> {
  return async (route, request) => {
    let held: string | undefined;
    try {
      if (request.isNavigationRequest() && !request.frame().parentFrame()) held = heldSite(guard, state, request.url());
    } catch { /* a request without a frame (a service worker's) is no navigation */ }
    if (held) {
      state.held = held;
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    await (route.fallback ? route.fallback() : route.continue()).catch(() => undefined);
  };
}

/** A context that can route its requests (Playwright's BrowserContext.route). */
export interface RoutableContext { route?(url: (url: URL) => boolean, handler: (route: RouteLike, request: RequestLike) => Promise<void>): Promise<void> }

/** Turns the guard on for a session's context once it is active (routing everything costs the HTTP cache, so only then). */
export async function installGuard(guard: NavGuard | undefined, state: GuardState, context: RoutableContext): Promise<void> {
  if (!guard || state.guarded || !context.route) return;
  let active = false;
  try { active = guard.active(); } catch { active = false; }
  if (!active) return;
  state.guarded = true;
  await context.route(() => true, guardRoute(guard, state)).catch(() => { state.guarded = false; });
}

/** Marks `url`'s site as passed through the gate for this session (browser.open, the person's own open). */
export function passSite(state: GuardState, url: string): void {
  const site = siteOfUrl(url);
  if (!site) return;
  (state.passed ??= new Set()).add(site);
}

/** The site held back since the last call, with the line the agent reads ('' when none). */
export function takeHeld(state: GuardState): string {
  const site = state.held;
  state.held = undefined;
  return site ? `Secure mode held back the move to ${site}: that site is not open to me yet. I open it with browser.open, and the app asks the person first.` : '';
}
