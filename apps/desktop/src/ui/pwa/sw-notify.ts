// Web Push in a service worker, shared by the PC-served PWA (ui/pwa/sw.ts) and the iPhone web app's worker
// (ui/hosted/sw.ts): a push shows its notice (tag, url, id, silent), tells the open app windows to load what changed
// ('wf.wake'), and a tap focuses an open window and routes it in-app ('wf.navigate') or opens one at `home` + the route.
// The PC worker ({home:'/', alwaysShow:false}) shows a notice already open under its tag with the same id (the same
// notification pushed by another of the owner's PCs) not again, and a `{clear: tag}` push (runtime/pwa/read-clear.ts)
// closes that tag's notices and shows nothing. iOS revokes a subscription that gets pushes without a notice, so the
// hosted worker ({alwaysShow:true}) always shows one: a duplicate replaces the open notice quietly. A clear puts the
// pushed notice back quietly only when this worker's own subscription is Apple's (the PC sends Apple no clear at all);
// B-087: the hosted app in Chrome or Edge (FCM, WNS) gets clears, and there a clear only closes, as on the PC.
// B-081: an agent's call (`ring: true`, runtime/calls/ring.ts) stays until it is touched and vibrates like a call; the
// clear at the ring's end closes it. 16.11.2026: a notice carries the worker's `badge` (the Autark mark, white on
// transparent – Android's status bar shows only its shape), else its icon.
// Owns: these handlers. Never: caches, fetches, or opens the origin root unless `home` is it.

import { noticeCount, syncAppBadge } from './badge.ts';
import { DUE_SHOW_MS, DUE_TAG, dueItems, groupDue, isDuePush, type DueData } from './due-notice.ts';

export interface NotifyEvent extends Event { waitUntil(promise: Promise<unknown>): void }
export interface PushEvent extends NotifyEvent { data: { json(): unknown; text(): string } | null }
export interface NotificationClick extends NotifyEvent { notification: Notification & { data?: unknown }; action: string }
export interface NotifyMessage extends NotifyEvent { data: unknown }
export interface WindowClientLike { url: string; focus(): Promise<unknown>; postMessage(message: unknown): void }

export interface NotifyScope {
  registration: ServiceWorkerRegistration;
  clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  location: Location;
  navigator?: unknown;
  addEventListener(type: 'push', fn: (event: PushEvent) => void): void;
  addEventListener(type: 'notificationclick', fn: (event: NotificationClick) => void): void;
  addEventListener(type: 'notificationclose', fn: (event: NotifyEvent) => void): void;
  addEventListener(type: 'message', fn: (event: NotifyMessage) => void): void;
}

export interface NotifyOptions {
  /** Where the app lives ('/' on the PC, the hosted scope on the iPhone); a tap opens it plus the notice's route. */
  home: string;
  /** The notice icon. */
  icon: string;
  /** The status-bar badge (Android: a white mark on transparent, the PC's /badge.png); the icon when absent. */
  badge?: string;
  /** Every push shows a notice (iOS): duplicates replace quietly; a clear shows its notice quietly on Apple's push service. */
  alwaysShow: boolean;
  /** How long a Due notice stays (due-notice.ts DUE_SHOW_MS); tests shorten it. */
  dueMs?: number;
}

/** `clear`: the chat or to-do with this tag was read on some device (runtime/pwa/read-clear.ts); `ring`: an agent calls (B-081). */
export interface PushPayload { title?: string; body?: string; url?: string; tag?: string; kind?: string; silent?: boolean; id?: string; clear?: string; ring?: boolean }

/** B-081: how a ringing call vibrates (ms on, off, …). */
export const RING_VIBRATE = [400, 200, 400, 200, 400];

export function wireNotifications(sw: NotifyScope, options: NotifyOptions): void {
  const notices = async (tag?: string) => (await sw.registration.getNotifications?.(tag ? { tag } : undefined).catch(() => [])) ?? [];
  const badge = () => syncAppBadge(sw.registration, sw.navigator);
  // Pushes can overlap while getNotifications/showNotification await the browser. Count each replacement in order.
  let pending = Promise.resolve();
  /** The last Due notice's stamp: each push gets its own, also two in the same millisecond (the older timer must not close the newer notice). */
  let lastStamp = 0;
  function enqueue(work: () => Promise<void>): Promise<void> {
    const next = pending.then(work);
    pending = next.catch(() => undefined);
    return next;
  }

  async function clearPush(tag: string): Promise<void> {
    for (const old of await notices(tag)) old.close();
  }

  /**
   * A newer notice for the same to-do or chat (same tag) replaces the older one and still alerts (renotify in Chromium;
   * closing the old one first covers browsers that ignore it). renotify without a tag would throw.
   */
  async function showPush(payload: PushPayload, quiet = false, due?: DueData): Promise<void> {
    const tag = payload.tag || undefined;
    const open = tag ? await notices(tag) : [];
    const ids = new Set(open.flatMap((old) => {
      const data = old.data as { id?: unknown; ids?: unknown } | undefined;
      return [...(Array.isArray(data?.ids) ? data.ids.filter((id): id is string => typeof id === 'string') : []), ...(typeof data?.id === 'string' ? [data.id] : [])];
    }));
    const duplicate = Boolean(payload.id && ids.has(payload.id));
    if (duplicate && !options.alwaysShow) return; // once within this origin, not across PCs
    // iOS still needs a visible notice for a duplicate push; keep the newest preview when an older event arrives late.
    const latest = open.at(-1);
    if (duplicate && latest) {
      const data = latest.data as { id?: unknown; url?: unknown } | undefined;
      payload = {
        ...payload, title: latest.title ?? payload.title, body: latest.body ?? payload.body,
        ...(typeof data?.id === 'string' ? { id: data.id } : {}), ...(typeof data?.url === 'string' ? { url: data.url } : {}),
      };
    }
    // Tasks and calls remain one outstanding item. Chat notices retain the number of bundled messages.
    const count = quiet ? 0 : tag?.startsWith('chat:') && !payload.ring ? noticeCount(open) + (duplicate ? 0 : 1) : 1;
    if (payload.id) ids.add(payload.id);
    const silent = quiet || duplicate || payload.silent === true; // F-52: a person's "Sound" off (pwa/push.ts sendToPerson)
    for (const old of open) old.close();
    const ring = payload.ring === true && !silent;
    const shown: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
      body: payload.body ?? '',
      icon: options.icon,
      badge: options.badge ?? options.icon,
      tag,
      renotify: Boolean(tag) && !quiet && !duplicate,
      silent,
      data: {
        url: payload.url ?? '/', ...(payload.id ? { id: payload.id } : {}), ...(count !== 1 ? { count } : {}), ...(due ? due : {}),
        ...(tag?.startsWith('chat:') && ids.size > 1 ? { ids: [...ids] } : {}),
      },
      ...(ring ? { requireInteraction: true, vibrate: RING_VIBRATE } : {}),
    };
    await sw.registration.showNotification(payload.title ?? 'Autark', shown);
  }

  /** B-087: this worker's own subscription is Apple's (as runtime/pwa/read-clear.ts isApplePush; the UI imports no runtime). */
  async function onApple(): Promise<boolean> {
    const endpoint = (await sw.registration.pushManager?.getSubscription().catch(() => null))?.endpoint ?? '';
    try { return /(^|\.)push\.apple\.com$/i.test(new URL(endpoint).hostname); } catch { return false; }
  }

  /** Every push tells the open app windows that something changed (ui/pwa/install.ts loads it at once). */
  async function wake(): Promise<void> {
    for (const client of await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage({ type: 'wf.wake' });
  }

  sw.addEventListener('push', (event) => {
    let payload: PushPayload = {};
    try { payload = (event.data?.json() as PushPayload) ?? {}; } catch { payload = { body: event.data?.text() }; }
    if (typeof payload.clear === 'string' && payload.clear) {
      const shown = enqueue(async () => {
        await clearPush(payload.clear!);
        if (options.alwaysShow && (await onApple())) await showPush({ ...payload, tag: payload.tag || payload.clear }, true);
        await badge();
      });
      event.waitUntil(Promise.all([shown, wake()]));
      return;
    }
    if (isDuePush(payload)) { // one notice for what is due, replaced not stacked, closed after a few seconds (due-notice.ts)
      const stamp = lastStamp = Math.max(Date.now(), lastStamp + 1);
      const shown = enqueue(async () => {
        const grouped = groupDue({ ...payload, url: payload.url ?? '/#/tasks' }, (await notices(DUE_TAG)).flatMap((old) => dueItems(old.data)), stamp);
        await showPush(grouped.payload, false, grouped.data);
        await badge();
      });
      const closed = shown.then(() => new Promise<void>((resolve) => setTimeout(resolve, options.dueMs ?? DUE_SHOW_MS))).then(() => enqueue(async () => {
        for (const old of await notices(DUE_TAG)) if ((old.data as { stamp?: unknown } | undefined)?.stamp === stamp) old.close(); // a newer Due notice has its own timer
        await badge();
      }));
      event.waitUntil(Promise.all([closed, wake()]));
      return;
    }
    event.waitUntil(Promise.all([enqueue(async () => { await showPush(payload); await badge(); }), wake()]));
  });

  sw.addEventListener('notificationclick', (event) => {
    const url = String((event.notification.data as { url?: string } | undefined)?.url ?? '/');
    const home = new URL(options.home, sw.location.origin);
    // The notice carries a PC route ('/#/chat/<id>'): its hash under this app's home (the hosted app never opens the origin root).
    const hash = new URL(url, home).hash;
    const target = hash ? new URL(hash, home).href : options.home === '/' ? new URL(url, home).href : home.href;
    event.waitUntil((async () => {
      await enqueue(async () => { event.notification.close(); await badge(); });
      const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((client) => new URL(client.url).origin === sw.location.origin && new URL(client.url).pathname.startsWith(home.pathname));
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: 'wf.navigate', url: target }); // the page routes in-app (no reload)
        return;
      }
      await sw.clients.openWindow(target);
    })());
  });

  sw.addEventListener('notificationclose', (event) => { event.waitUntil(enqueue(badge)); });
  sw.addEventListener('message', (event) => {
    if ((event.data as { type?: unknown } | null)?.type === 'wf.badge') event.waitUntil(enqueue(badge));
  });
}
