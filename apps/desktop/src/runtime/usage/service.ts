// The anonymous usage count (owner 25.11.2026: "wann Autark verwendet wird … pro Endgerät, vom Handy direkt, von jedem
// PC direkt … niemand soll IP-Adresse oder so … automatisch und so wenig wie möglich … vielleicht jede Stunde").
// When this PC is in use, it adds 1 to a counter of ours at Google Firestore – at most once per UTC hour, sent by this
// PC itself (never through another one). "In use" is the simplest thing that cannot be faked by a background loop: in
// this hour the person sent a line here (chat/service.ts send) or an agent's turn started here (agents/turn.ts). Nothing
// polls and nothing keeps a clock: the count is a consequence of that line or turn, and only the first one of an hour
// does anything.
// What goes out: the request of signal.ts – the platform word, the UTC day and hour in the document name, `n` +1 and, on
// the first count of a UTC day, `dev` +1. No device or install id, no version, no language, no company, no agent or chat
// data, no cookie, no header of ours (README › What Autark counts; signal.ts is the whole request). Google sees the
// connection's address as with any request; we store none.
// What is kept: one string, the last UTC hour counted ('2026-11-25T15'), in one small file beside the companies of this
// PC (so two companies on one PC are still one device); settings.usage.count off drops it. A build that is not packaged
// (a developer's, a test, headless) never reaches Google: only a loopback receiver of a test is answered.
// A failed count is dropped: no retry in the same hour, no queue, never awaited by the app, nothing logged.
// Owns: when a count is due, the state file and the request. Never: blocks a turn or a send, retries, or reads what it sends.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import { documentsUrl } from '../feedback/drop.ts';
import { readReceiver } from '../feedback/receiver.ts';
import { request } from '../feedback/transport.ts';
import { commitBody, firstOfDay, hourKey, platformOf, readHour } from './signal.ts';

/** The state file's name, beside this PC's companies (or in the data folder where there is no companies folder). */
export const USAGE_FILE = 'usage-count-hour.txt';

export class UsageCount {
  private readonly services: () => RuntimeServices;
  private readonly run: typeof fetch;
  private readonly platform: string;
  /** The hour this process already tried (counted or not): one try per hour, never a retry loop. */
  private tried: string | undefined;

  constructor(deps: { services: () => RuntimeServices; run?: typeof fetch; platform?: string }) {
    this.services = deps.services;
    this.run = deps.run ?? fetch;
    this.platform = deps.platform ?? process.platform;
  }

  /** Listens for the switch going off, to drop the stored hour at once; returns the stop. */
  start(): () => void {
    return this.services().bus.on('settings.updated', (settings) => { if (settings.usage?.count === false) this.drop(); });
  }

  /** The person sent a line or an agent's turn started here: counts this hour once, if the switch is on. Never throws, never waits. */
  touch(): void {
    try { this.count(); } catch { /* a count never disturbs the app */ }
  }

  private file(): string {
    const s = this.services();
    return path.join(s.host.app.companies?.dir ?? s.paths.data, USAGE_FILE);
  }

  private drop(): void {
    try { rmSync(this.file(), { force: true }); } catch { /* nothing kept is nothing to drop */ }
  }

  private count(): void {
    const s = this.services();
    const hour = hourKey(s.clock.now());
    if (hour === this.tried) return;
    if (s.settings.get().usage?.count === false) { this.drop(); return; }
    const platform = platformOf(this.platform);
    const receiver = readReceiver(s);
    if (!platform || !receiver) return;
    if (!s.host.app.packaged && !receiver.endpoint) return; // a build from source never reaches Google
    this.tried = hour;
    let last: string | undefined;
    try { last = readHour(readFileSync(this.file(), 'utf8')); } catch { last = undefined; }
    if (last === hour) return; // another company of this PC counted this hour
    const body = commitBody(receiver.project, hour, platform, firstOfDay(hour, last));
    const url = `${documentsUrl(receiver)}:commit?key=${encodeURIComponent(receiver.apiKey)}`;
    void request(this.run, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, 0)
      .then((reply) => { if (reply.status === 200) this.remember(hour); })
      .catch(() => undefined);
  }

  private remember(hour: string): void {
    try {
      const file = this.file();
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, hour);
    } catch { /* then the next hour counts the day's `dev` once more – a rounding, not a leak */ }
  }
}
