// Secure mode's guard on a side tab an agent drives (25.11.2026, Konrad's decision a – after Andrea Griffiths' VM test:
// data could leave through any URL). The runtime's security gate checks the site of each browser.open; a click, a form,
// the page's own script or a server redirect moves the tab without a call it sees. While an agent drives the tab in
// Secure mode (the call carries `web`, side-browser.ts) every document request of its main frame – each hop of a
// redirect included – is paused (DevTools Fetch) and goes on only
// - to a site in `web.sites` (the person's chosen sites; subdomains count with them),
// - to the site of the open running now, for that open alone ("Allow once" is one call),
// - within the site the tab shows (or a subdomain of it) – like a step in an open tab,
// - for a new tab the page opened: within the site of the tab that opened it.
// Anything else fails (BlockedByClient) and the agent's next answer names the site. The guard goes off when the person
// uses the tab (a click or key in it, their own address, back or reload) and when a call comes without `web`.
// Frames inside the page load as the page wants: the page chose them, not the agent.
// Owns: that rule and the tab's Fetch interception. Never: asks the person (the runtime's gate does) or reads settings.

import { heldMoveText, siteListed, siteOfUrl } from '../../shared/model/security-settings.ts';
import type { SideWeb } from '../../shared/model/side-browser.ts';
import type { TabCdp } from './cdp.ts';

/** Fetch.requestPaused as the guard reads it. */
interface Paused { requestId?: string; request?: { url?: string }; frameId?: string }

const PATTERNS = [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }];

export class SideGuard {
  /** The sites open without asking while an agent drives this tab; undefined: no guard. */
  private web?: SideWeb;
  /** The sites of the opens running now (count per site). */
  private readonly passes = new Map<string, number>();
  /** A new tab's opener's site: its first page counts as within it. */
  private from = '';
  private intercepting = false;
  private held?: string;
  private readonly cdp: TabCdp;

  constructor(cdp: TabCdp) {
    this.cdp = cdp;
    cdp.on('Fetch.requestPaused', (event: Paused) => { void this.paused(event); });
  }

  get on(): boolean { return Boolean(this.web); }
  /** The open sites while on (a new tab the page opens takes them over). */
  get sites(): SideWeb | undefined { return this.web; }

  /** The guard as an agent's call wants it (`web` absent: off); resolves once the interception follows. */
  async set(web: SideWeb | undefined, from?: string): Promise<void> {
    this.web = web ? { sites: [...web.sites] } : undefined;
    if (from !== undefined) this.from = from;
    if (web) { // each time: after a re-attach of the debugger the interception is gone (enabling again is harmless)
      this.intercepting = true;
      try { await this.cdp.send('Fetch.enable', { patterns: PATTERNS }); } catch (error) { this.intercepting = false; this.web = undefined; throw error; }
    } else if (this.intercepting) {
      this.intercepting = false;
      this.passes.clear();
      await this.cdp.send('Fetch.disable').catch(() => undefined);
    }
  }

  /** The person uses the tab: the guard goes off. */
  off(): void { void this.set(undefined).catch(() => undefined); }

  /** Opens `url`'s site for the open running now; the returned call closes it again. */
  pass(url: string): () => void {
    const site = siteOfUrl(url);
    if (!site) return () => undefined;
    this.passes.set(site, (this.passes.get(site) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.passes.get(site) ?? 1) - 1;
      if (left > 0) this.passes.set(site, left); else this.passes.delete(site);
    };
  }

  /** The site a top-level move to `url` is held back from (undefined: it goes through). */
  heldSite(url: string): string | undefined {
    if (!this.web) return undefined;
    const site = siteOfUrl(url);
    if (!site) return undefined; // about:, data:, blob: – no site reached
    if (siteListed([...this.passes.keys()], site)) return undefined;
    const shown = siteOfUrl(this.cdp.mainUrl) || this.from;
    if (shown && siteListed([shown], site)) return undefined;
    if (siteListed(this.web.sites, site)) return undefined;
    return site;
  }

  /** Records a site held back elsewhere for this tab (a new tab it opened). */
  note(site: string): void { this.held = site; }

  /** The line for the site held back since the last call ('' when none). */
  take(): string {
    const site = this.held;
    this.held = undefined;
    return site ? heldMoveText(site) : '';
  }

  private async paused(event: Paused): Promise<void> {
    const requestId = event.requestId;
    if (!requestId) return;
    let held: string | undefined;
    try { if (event.frameId && event.frameId === this.cdp.mainFrame) held = this.heldSite(String(event.request?.url ?? '')); } catch { held = undefined; }
    if (held) {
      this.held = held;
      this.onHeld?.(held);
      await this.cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
      return;
    }
    await this.cdp.send('Fetch.continueRequest', { requestId }).catch(() => undefined);
  }

  /** Hears a site held back (a new tab tells the tab that opened it). */
  onHeld?: (site: string) => void;

  /** The tab's state goes (its page may stay): no request may wait on a handler that is gone. */
  dispose(): void {
    this.web = undefined;
    if (!this.intercepting) return;
    this.intercepting = false;
    try { if (!this.cdp.contents.isDestroyed()) void this.cdp.contents.debugger.sendCommand('Fetch.disable').catch(() => undefined); } catch { /* detached */ }
  }
}
