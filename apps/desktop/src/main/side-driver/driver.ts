// Agents in the person's browser – the person's pane, each chat's area above its messages and each agent's area (host op `sideBrowser`,
// shared/model/side-browser.ts). The person works there with the AI all day, so an agent works like a careful colleague:
// it reads the page as an accessibility snapshot and then only what changed, finds elements by words, acts in batches
// that stop at the first failure, debugs with console, network and eval, and waits on page events. Its mouse moves along
// the shared motion model and travels here like a hand unless the call passes glide or instant (21.11.2026), so the
// person sees where it goes – and its named cursor (shared/model/agent-cursor.ts, leaning) is drawn in the page.
// The person goes first: a step within 2 s of their input in that tab is refused (personActive); a page showing a human check says so (humanCheck). A tab an agent opens
// carries the agent and its chat; without newTab it is the agent's preview tab there until the person's click or key in
// it keeps it (sideKeep). The person's pointer and every agent move go to the runtime's pointer hub
// (deps.pointer: host bridge message 'pointer', surface side:<tabId>). A call without a tab means its space's tab
// (call.space: global or chat:<id>; each space shows its own tab); a given tab id works from anywhere. B-076: `side` hands
// a tab to the caster (caster.ts) when the person watches it from another PC or a phone. B-081: `pick` switches a tab's
// Pin button picker (tab.ts, pick-script.ts; an act batch holds it, so agents' input reaches the page); pins: sidePicked.
// Owns: the call dispatch, the tab registry, the agents' last looks and the pointer reports.
// Never: imports electron (the workspace browser hands in the tabs, surface.ts), or hands out field values of passwords
// (snapshot.ts / logs.ts redact).

import { GLOBAL_SPACE, browserUrl } from '../../shared/api/workspace-browser.ts';
import { cursorColor, tilted } from '../../shared/model/agent-cursor.ts';
import { DEFAULT_MOTION, thinSteps, type MotionStep } from '../../shared/model/pointer-motion.ts';
import { POINTER_PATH_MAX, surfaceKey, type PointerAction } from '../../shared/model/pointers.ts';
import type { SideBrowserCall, SideBrowserResult, SideWeb } from '../../shared/model/side-browser.ts';
import { siteOfUrl } from '../../shared/model/security-settings.ts';
import type { PageOpener } from '../../shared/api/workspace-browser.ts';
import { SideError, type ContentsLike } from './cdp.ts';
import { dialogError, evaluate, pageText, responseBody, screenshot, takeLook } from './read.ts';
import { changeList, findLines, maskUrl, type Look } from './snapshot.ts';
import { newStepGroup, release, runStep, type StepContext } from './steps.ts';
import type { SideDriverDeps } from './surface.ts';
import { SideTab, type PersonInput } from './tab.ts';
import { checkCall } from './validate.ts';
import { waitFor } from './wait.ts';
import type { TabGuardHooks } from '../workspace-guard.ts';

export const PERSON_PRIORITY_MS = 2000;
const LOAD_MS = 15_000;
const LOOKS_MAX = 64;
const BUSY = 'The person is using this tab right now – wait a moment, then try again.';
/** 25.11.2026: the calls that move or change a tab – Secure mode's guard goes on with them (guard.ts). */
const DRIVES: ReadonlySet<SideBrowserCall['action']> = new Set(['open', 'act', 'eval']);
const NO_BROWSER = 'The side browser is not available right now.';

export class SideDriver {
  private readonly deps: SideDriverDeps;
  private readonly tabs = new Map<string, SideTab>();
  /** Each agent's last look per tab ('agent|tab'). */
  private readonly looks = new Map<string, Look>();
  private lastPersonTab: string | null = null;
  /** The tab each agent last named or opened, per space ('agent|space'). */
  private readonly agentTabs = new Map<string, string>();

  constructor(deps: SideDriverDeps) {
    this.deps = deps;
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private sleep(ms: number): Promise<void> { return this.deps.sleep ? this.deps.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms)); }

  /** The workspace browser's tab hook: a tab's page was made, or it is gone (null). */
  tab(id: string, contents: ContentsLike | null): void {
    const old = this.tabs.get(id);
    if (old && old.contents !== contents) {
      old.dispose();
      this.tabs.delete(id);
      for (const key of [...this.looks.keys()]) if (key.endsWith(`|${id}`)) this.looks.delete(key);
    }
    // From the start: the person's pointer, and console/network history for a later look.
    if (contents && !this.tabs.has(id)) void this.make(id, contents).cdp.ready().catch(() => {});
  }

  private make(id: string, contents: ContentsLike): SideTab {
    const tab = new SideTab(id, contents, {
      now: () => this.now(), person: (from, input) => this.personInput(from, input),
      pick: (from, pick) => this.deps.browser()?.sidePicked?.(from.id, pick), // a pin (or the picker's end) for the app window
    });
    this.tabs.set(id, tab);
    return tab;
  }

  /** B-081: the Pin button – tab `id`'s picker on or off; false when its page cannot take it (the button goes back). */
  async pick(id: string, on: boolean): Promise<boolean> {
    const tab = this.tabs.get(id), ok = await tab?.setPicking(on) ?? false;
    if (on && !tab?.picking) this.deps.browser()?.sidePicked?.(id, null); // (a later off or on of the button decides itself)
    return ok;
  }

  private personInput(tab: SideTab, input: PersonInput): void {
    this.lastPersonTab = tab.id;
    if (input.action === 'click' || input.action === 'type') {
      tab.guard.off(); // 25.11.2026: the person drives this tab now – Secure mode's guard is for an agent's moves (guard.ts)
      this.deps.browser()?.sideKeep?.(tab.id);
    }
    if (input.x === undefined || input.y === undefined) return;
    const person = this.deps.person?.() ?? { kind: 'person', id: 'owner', name: 'Owner' };
    this.deps.pointer?.({ surface: surfaceKey('side', tab.id), actor: person, x: input.x, y: input.y, action: input.action, ...(input.target ? { target: input.target } : {}) });
  }

  /** The tab a call means: the given one, else in its space the one this agent last named or opened, the one the person looks at (or the shown or used last), else the first. */
  private choose(id: string | undefined, space: string, agentId: string): SideTab {
    const browser = this.deps.browser();
    if (!browser) throw new SideError(NO_BROWSER);
    const { pages, active, last } = browser.sideTabs(space);
    const here = pages.filter((page) => (page.space ?? GLOBAL_SPACE) === space);
    const known = (tab: string | null | undefined) => (tab && here.some((page) => page.id === tab) ? tab : undefined);
    const chosen = id ?? known(this.agentTabs.get(`${agentId}|${space}`)) ?? known(active) ?? known(last) ?? known(this.lastPersonTab) ?? here[0]?.id;
    if (!chosen) throw new SideError('This browser has no open tab – open a page first (action open).');
    if (!pages.some((page) => page.id === chosen)) throw new SideError(`There is no side-browser tab ${chosen} – list the tabs (action tabs).`);
    let contents: ContentsLike | undefined;
    try { contents = browser.sideContents(chosen); } catch { throw new SideError(NO_BROWSER); }
    if (!contents || contents.isDestroyed()) throw new SideError(`The tab ${chosen} cannot be reached right now – try again.`);
    if (id) this.agentTabs.set(`${agentId}|${space}`, chosen); // a tab it named or opened; otherwise it goes on following what the person looks at
    const tab = this.tabs.get(chosen);
    return tab && tab.contents === contents ? tab : this.make(chosen, contents);
  }

  /** B-076: tab `id` with its page awake for the person watching it from another PC or a phone (caster.ts); undefined when it is not open. */
  side(id: string): SideTab | undefined {
    let contents: ContentsLike | undefined;
    try { contents = this.deps.browser()?.sideContents(id, true); } catch { return undefined; }
    if (!contents || contents.isDestroyed()) return undefined;
    const tab = this.tabs.get(id);
    return tab && tab.contents === contents ? tab : this.make(id, contents);
  }

  /** 25.11.2026: the hooks the workspace browser asks (main/workspace-guard.ts). */
  guardHooks(): TabGuardHooks {
    return { beforeLoad: (id, contents, from) => this.beforeLoad(id, contents, from), mayOpen: (from, url) => this.mayOpen(from, url), personUsed: (id) => this.personUsed(id) };
  }

  /** 25.11.2026: the person used tab `id` from the pane (their own address, back, forward, reload): its guard goes off. */
  personUsed(id: string): void {
    this.tabs.get(id)?.guard.off();
  }

  /**
   * 25.11.2026: may tab `from`'s page open a new tab at `url`? Not while an agent drives it in Secure mode and the site is
   * held back (the agent's next answer says so).
   */
  mayOpen(from: string, url: string): boolean {
    const parent = this.tabs.get(from);
    if (!parent?.guard.on) return true;
    const held = parent.guard.heldSite(url);
    if (held) parent.guard.note(held);
    return !held;
  }

  /**
   * 25.11.2026: the workspace browser is about to load a page in tab `id` – an agent's open running now (open()), or a new
   * tab that tab `from`'s page opened. In Secure mode the tab's guard goes on first, so even the first load's redirect hops
   * are checked: the promise says whether to load (false: the guard could not go on). Undefined: load at once.
   */
  beforeLoad(id: string, contents: ContentsLike, from?: string): Promise<boolean> | undefined {
    const opening = this.opening;
    const known = this.tabs.get(id);
    if (opening && !opening.web) { if (known?.contents === contents) known.guard.off(); return undefined; }
    const parent = !opening && from ? this.tabs.get(from) : undefined;
    const web = opening?.web ?? parent?.guard.sites;
    if (!web) return undefined;
    if (known && known.contents !== contents) known.dispose();
    const tab = known && known.contents === contents ? known : this.make(id, contents);
    if (opening) { tab.guard.take(); opening.release.push(tab.guard.pass(opening.url)); } // this open's site, for this call alone
    else if (parent) tab.guard.onHeld = (site) => parent.guard.note(site);
    const opener = parent ? siteOfUrl(parent.cdp.mainUrl) : undefined;
    return tab.cdp.ready().then(() => tab.guard.set(web, opener)).then(() => true, () => false);
  }

  /** The agent's open running now (open() around sideOpen): what beforeLoad gives the tab. */
  private opening?: { web?: SideWeb; url: string; release: Array<() => void> };

  /** The guard as this call wants it: on for a call that drives the tab, kept up to date while on, off without `web`. */
  private async guardFor(tab: SideTab, call: SideBrowserCall): Promise<void> {
    if (!DRIVES.has(call.action) && !tab.guard.on) return;
    try { await tab.guard.set(call.web); } catch {
      if (call.web) throw new SideError('Secure mode could not watch where this tab goes, so nothing ran there – try again.');
    }
  }

  /** Checks, then runs the call; every failure comes back as one sentence. */
  async call(raw: unknown): Promise<SideBrowserResult> {
    const checked = checkCall(raw);
    if ('error' in checked) return { ok: false, error: checked.error };
    try {
      return await this.run(checked.call);
    } catch (error) {
      if (error instanceof SideError) return { ok: false, error: error.message, ...(error.personActive ? { personActive: true } : {}) };
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `The side browser could not do that (${message.slice(0, 200)}).` };
    }
  }

  private where(tab: SideTab): Pick<SideBrowserResult, 'tab' | 'url' | 'title'> {
    return { tab: tab.id, url: maskUrl(tab.contents.getURL(), undefined, 2000), title: tab.contents.getTitle() };
  }

  private async run(call: SideBrowserCall): Promise<SideBrowserResult> {
    if (call.action === 'tabs') return this.tabList(call.space);
    if (call.action === 'open') return this.open(call);
    if (call.action === 'close') {
      const browser = this.deps.browser();
      if (!browser) throw new SideError(NO_BROWSER);
      try { browser.sideClose(call.tab!); } catch (error) { throw new SideError(error instanceof Error ? error.message : 'This tab could not be closed.'); }
      return this.tabList(call.space);
    }
    const tab = this.choose(call.tab, call.space ?? GLOBAL_SPACE, call.agent.id);
    await tab.cdp.ready();
    await this.guardFor(tab, call); // 25.11.2026: Secure mode's guard (guard.ts)
    const key = `${call.agent.id}|${tab.id}`;
    switch (call.action) {
      case 'snapshot': {
        const { look, human } = await takeLook(tab);
        const before = this.looks.get(key);
        this.remember(key, look);
        const diff = call.full ? { text: '', full: true } : changeList(before, look);
        return { ok: true, ...this.where(tab), ...(diff.full ? { text: [diff.text, look.lines.join('\n')].filter(Boolean).join('\n') } : { changes: diff.text }), ...(human ? { humanCheck: true } : {}) };
      }
      case 'find': {
        const { snap, human } = await takeLook(tab);
        const hits = findLines(snap.lines, call.query!);
        const text = hits.lines.length ? [...hits.lines, ...(hits.more ? [`… ${hits.more} more – use more words`] : [])].join('\n') : `Nothing on the page matches ${JSON.stringify(call.query)}.`;
        return { ok: true, ...this.where(tab), text, ...(human ? { humanCheck: true } : {}) };
      }
      case 'act': return this.act(tab, call, key);
      case 'screenshot': return { ok: true, ...this.where(tab), ...(await screenshot(tab, call)) };
      case 'text': return { ok: true, ...this.where(tab), text: await pageText(tab) };
      case 'console': return { ok: true, ...this.where(tab), text: tab.console.text(call) };
      case 'network': {
        if (!call.requestId) return { ok: true, ...this.where(tab), text: tab.network.text(call) };
        const body = await responseBody(tab, call.requestId);
        const detail = tab.network.detail(call.requestId, body);
        if (!detail) throw new SideError(`There is no request ${call.requestId} in this tab's list – list the requests again (network without requestId).`);
        return { ok: true, ...this.where(tab), text: body ? detail : `${detail}\n(No body is kept for this request – it failed, was a redirect, or the tab moved on since.)` };
      }
      case 'eval':
        if (tab.dialog) throw dialogError(tab)!; // the page is blocked until the dialog is answered
        return { ok: true, ...this.where(tab), text: await evaluate(tab, call.expression!) };
      case 'wait': {
        const out = await waitFor(tab, call.wait!, { now: () => this.now() });
        return out.ok ? { ok: true, ...this.where(tab), text: out.note } : { ok: false, ...this.where(tab), error: out.error };
      }
    }
    return { ok: false, error: 'Unknown side-browser action.' };
  }

  private remember(key: string, look: Look): void {
    this.looks.delete(key);
    this.looks.set(key, look);
    while (this.looks.size > LOOKS_MAX) this.looks.delete(this.looks.keys().next().value!);
  }

  private tabList(space = GLOBAL_SPACE): SideBrowserResult {
    const browser = this.deps.browser();
    if (!browser) throw new SideError(NO_BROWSER);
    const { pages, active } = browser.sideTabs(space);
    const tabs = pages.filter((page) => (page.space ?? GLOBAL_SPACE) === space).map((page) => ({ id: page.id, url: maskUrl(page.url, undefined, 2000), title: page.title, active: page.id === active, ...(page.opener ? { by: page.opener.agentName || page.opener.agentId } : {}) }));
    const text = tabs.length ? tabs.map((t) => `${t.id}${t.active ? ' (the person looks at it)' : ''} · ${t.title || '(no title)'} · ${t.url}${t.by ? ` · opened by ${t.by}` : ''}`).join('\n') : 'This browser has no open tab.';
    return { ok: true, tabs, text };
  }

  /** Waits (on page events) until the main document is parsed – or nothing loads any more – at most `ms`. */
  private loaded(tab: SideTab, ms: number): Promise<boolean> {
    const ready = () => !tab.contents.isLoading() || (tab.domReady && !tab.navigating);
    if (ready()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (value: boolean) => { off(); clearTimeout(timer); resolve(value); };
      const off = tab.onEvent(() => { if (ready()) done(true); });
      const timer = setTimeout(() => done(ready()), ms);
    });
  }

  private async open(call: SideBrowserCall): Promise<SideBrowserResult> {
    let url: string;
    try { url = new URL(browserUrl(call.url!)).href; } catch (error) { throw new SideError(error instanceof Error ? error.message : 'Use an HTTP or HTTPS address.'); }
    let tab: SideTab;
    // 25.11.2026: Secure mode – this open's site passes the tab's guard for this call alone (beforeLoad, guard.ts)
    const release: Array<() => void> = [];
    try {
      if (call.newTab !== false) {
        const browser = this.deps.browser();
        if (!browser) throw new SideError(NO_BROWSER);
        let id: string;
        const opener: PageOpener = { agentId: call.agent.id, agentName: call.agent.name, ...(call.chat ? { chatId: call.chat } : {}) };
        this.opening = { ...(call.web ? { web: call.web } : {}), url, release };
        try { id = browser.sideOpen(url, opener, call.show === true, call.space, call.newTab === true); } catch (error) { throw new SideError(error instanceof Error ? error.message : 'The page could not be opened.'); }
        finally { this.opening = undefined; }
        tab = this.choose(id, call.space ?? GLOBAL_SPACE, call.agent.id);
        if (call.web) release.push(tab.guard.pass(url)); // also when the page loads without asking beforeLoad first
        tab.domReady = false; // the load already started: its document counts as not parsed until it says so (a reused preview tab still holds its last one)
        await tab.cdp.ready();
        await this.guardFor(tab, call); // on already when the workspace browser asked first (beforeLoad); kept up to date
      } else {
        tab = this.choose(call.tab, call.space ?? GLOBAL_SPACE, call.agent.id);
        if (tab.personActive(PERSON_PRIORITY_MS)) throw new SideError(BUSY, { personActive: true });
        await tab.cdp.ready();
        await this.guardFor(tab, call);
        if (call.web) release.push(tab.guard.pass(url));
        tab.guard.take();
        tab.domReady = false;
        const out = await tab.cdp.send('Page.navigate', { url }) as { errorText?: string };
        if (out.errorText) throw new SideError(tab.guard.take() || `The page could not be loaded (${out.errorText}).`);
      }
      const ready = await this.loaded(tab, LOAD_MS);
      const held = tab.guard.take(); // a redirect of this open to a site not open yet
      if (held) return { ok: false, ...this.where(tab), error: held };
      const { look, human } = await takeLook(tab);
      this.remember(`${call.agent.id}|${tab.id}`, look);
      return { ok: true, ...this.where(tab), text: `${ready ? '' : 'The page is still loading.\n'}${look.lines.join('\n')}`, ...(human ? { humanCheck: true } : {}) };
    } finally {
      for (const done of release) done();
    }
  }

  /** The steps, with a move Secure mode held back on the way said first (25.11.2026, guard.ts). */
  private async act(tab: SideTab, call: SideBrowserCall, key: string): Promise<SideBrowserResult> {
    tab.guard.take();
    const result = await this.steps(tab, call, key);
    const held = tab.guard.take();
    if (held) result.changes = [held, result.changes].filter(Boolean).join('\n');
    return result;
  }

  /** Steps in order, stopping at the first that fails; then what changed since the agent's last look. */
  private async steps(tab: SideTab, call: SideBrowserCall, key: string): Promise<SideBrowserResult> {
    const agent = call.agent;
    const style = call.motion ?? DEFAULT_MOTION; // like everywhere: a hand unless the call passes glide or instant
    const group = newStepGroup(); // this act's own object group, so a parallel act's release never frees these nodes
    const ctx: StepContext = {
      tab, agentId: agent.id, style, group, now: () => this.now(), sleep: (ms) => this.sleep(ms),
      moved: (path, action, ref) => this.agentMoved(tab, agent, path, action, ref),
    };
    const steps = call.steps!;
    let done = 0;
    let failure: SideError | undefined;
    try {
      await tab.holdPicking(true); // B-081: my clicks and keys reach the page, never the person's Pin picker there
      for (const step of steps) {
        if (tab.personActive(PERSON_PRIORITY_MS)) { failure = new SideError(BUSY, { personActive: true }); break; }
        try { await runStep(ctx, step); } catch (error) {
          failure = error instanceof SideError ? error : new SideError(`Step ${done + 1} (${step.action}) failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
          break;
        }
        done += 1;
        await this.settle(tab, done < steps.length ? 40 : 120);
      }
    } finally { release(tab, group); void tab.holdPicking(false); }
    if (failure && done > 0 && !/^Step \d/.test(failure.message)) failure = new SideError(`Step ${done + 1} (${steps[done]!.action}): ${failure.message}`, failure);
    const result: SideBrowserResult = { ok: !failure, ...this.where(tab), done, ...(failure ? { error: failure.message } : {}), ...(failure?.personActive ? { personActive: true } : {}) };
    // A page dialog blocks the page: it is the change (the page itself cannot be read until it is answered).
    if (tab.dialog) { result.changes = `Dialog: ${tab.dialog.type} ${JSON.stringify(tab.dialog.message)} – press Enter to accept or Escape to dismiss it.`; return result; }
    if (done === 0) return result;
    const { look, human } = await takeLook(tab).catch(() => ({ look: undefined, human: false }));
    if (!look) return result;
    const diff = changeList(this.looks.get(key), look);
    this.remember(key, look);
    if (diff.full) { if (diff.text) result.changes = diff.text; result.text = look.lines.join('\n'); } else result.changes = diff.text;
    if (human) result.humanCheck = true;
    return result;
  }

  /** After a step: a navigation it started is waited for (≤ 10 s), otherwise a short breath for the page. */
  private async settle(tab: SideTab, ms: number): Promise<void> {
    await this.sleep(ms);
    if (tab.navigating && !tab.dialog) await this.loaded(tab, 10_000);
  }

  /** The agent's cursor moves: drawn in the page with its lean and reported to the runtime (surface side:<tab>). */
  private agentMoved(tab: SideTab, agent: { id: string; name: string }, path: MotionStep[], action: PointerAction, ref?: string): void {
    const last = path[path.length - 1];
    if (!last) return;
    const drawn = JSON.stringify(tilted(thinSteps(path, 80)).map((s) => ({ x: Math.round(s.x * 10) / 10, y: Math.round(s.y * 10) / 10, t: Math.round(s.t), r: s.r })));
    void tab.cdp.inWorld(`__wfSide.cursor(${JSON.stringify(agent.id)}, ${JSON.stringify(agent.name.slice(0, 40))}, ${JSON.stringify(cursorColor(agent.id))}, ${drawn}, ${action === 'click'})`).catch(() => {});
    const info = ref ? tab.refs.get(ref) : undefined;
    this.deps.pointer?.({
      surface: surfaceKey('side', tab.id), actor: { kind: 'agent', id: agent.id, name: agent.name }, x: last.x, y: last.y, action,
      ...(ref ? { target: { ...(info?.role ? { role: info.role } : {}), ...(info?.name ? { name: info.name.slice(0, 80) } : {}), ref } } : {}),
      path: thinSteps(path, POINTER_PATH_MAX),
    });
  }

  /** The window went: every tab's state goes with it. */
  dispose(): void {
    for (const tab of this.tabs.values()) tab.dispose();
    this.tabs.clear();
    this.looks.clear();
  }
}
