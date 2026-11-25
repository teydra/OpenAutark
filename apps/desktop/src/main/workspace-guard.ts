// Secure mode's guard in the person's browser (25.11.2026, Konrad's decision a): the hooks main/side-driver gives
// WorkspaceBrowser so the guard on a tab an agent drives (side-driver/guard.ts) goes on before an agent's page loads,
// holds back a new tab its page opens to a site not open yet, passes on to a new tab it lets through, and goes off when
// the person moves the tab themselves (their own address, back, forward or reload). Without hooks – no driver – every
// tab opens and loads at once as before.
// Owns: when the browser asks the hooks, and which tab opens the one being opened. Never: decides what is held back
// (the driver's guard does).

import type { WebContents } from 'electron';

export interface TabGuardHooks {
  /**
   * Before a page loads in tab `id` – an agent's open, or a new tab tab `from`'s page opened – the driver may put the
   * tab's guard on first: the page loads when the promise says true, not at all on false, at once without a promise.
   */
  beforeLoad?(id: string, contents: WebContents, from?: string): Promise<boolean> | undefined;
  /** May tab `from`'s page open a new tab at `url` (false: an agent drives it and Secure mode holds the site back)? */
  mayOpen?(from: string, url: string): boolean;
  /** The person used tab `id` from the pane. */
  personUsed?(id: string): void;
}

/** The person's commands that move a tab. */
const PERSON_MOVES: ReadonlySet<string> = new Set(['open', 'back', 'forward', 'reload']);

export const UNWATCHED = 'Secure mode could not watch this tab, so the page was not loaded.';

export class TabGuards {
  private readonly hooks?: TabGuardHooks;
  /** The tab whose page opens the tab being opened right now (opening → load). */
  private from?: string;

  constructor(hooks?: TabGuardHooks) { this.hooks = hooks; }

  /** Tells the hooks when a command of the person's pane moves a tab. */
  person(command: { action: string }): void {
    const id = (command as { id?: unknown }).id;
    if (PERSON_MOVES.has(command.action) && typeof id === 'string') this.hooks?.personUsed?.(id);
  }

  /** Tab `from`'s page opens `url` in a new tab: `open` runs when the guard lets it (a full space is no error here). */
  opening(from: string, url: string, open: () => void): void {
    if (this.hooks?.mayOpen?.(from, url) === false) return;
    this.from = from;
    try { open(); } catch { /* the space is full */ } finally { this.from = undefined; }
  }

  /** Loads `url` in tab `id` once its guard allows it (`failed`: it did not go on, the page stays unloaded). */
  load(id: string, contents: WebContents, url: string, failed: (why: string) => void): void {
    const go = () => { if (!contents.isDestroyed()) void contents.loadURL(url).catch(() => {}); }; // did-fail-load publishes the visible failure
    const guarded = this.hooks?.beforeLoad?.(id, contents, this.from);
    if (guarded) void guarded.then((ok) => { if (ok) go(); else failed(UNWATCHED); }, () => failed(UNWATCHED));
    else go();
  }
}
