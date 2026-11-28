// Texts of Settings › Devices (DevicesGroup.tsx, connect-rows.tsx – also the first run's Connect card): Remote IDs in
// groups of three, the Remote ID row's hint, what this PC's own connect request shows (the line under "Connect"), the
// hint of each device row, a phone's dot, the hint of a browser's Notifications row (B-084: inside the Android app the
// app's own notifications) and "Forget this phone", and – B-078 – the phone QR's hint (two IDs 23.11.2026: the QR beside
// My ID, scan it or type My ID) and the words of a phone's request (role 'phone'). F09: the PCs on this network grouped
// by PC (nearbyGroups: a PC's companies under it). F17: a request waiting on another of my PCs names that PC. F29: a phone's
// connection row (direct or via the meeting server, bytes of each today) and the iPhone web app's line. Sicher-Runde
// 19.11.2026: a PC that said goodbye (device.bye, Device.away) reads "App closed · 14:02" / "Updating… · since 14:02" /
// "Signed out or shut down · 14:02" instead of "Not reachable".
// Eine-ID 22.11.2026 (owner: one ID per company, one per person, no role to pick): the "Company ID" and "My ID" rows'
// hints, the waiting line by the role the PC asked answered ("Joining Dojo as a new member" / "Adding to your devices"),
// a request's words by its role ("… wants to join Dojo as a new member" / "… wants to be one of your devices") and the ID
// a nearby row's Connect asks with (its company's ID). Fest round 22.11.2026 (G): a device row's round trip (linkHint).
// Owns: these pure formatters (test/unit/devices/connect-text.test.ts, test/unit/ui/push-hint.test.ts). Never: RPC or rendering.

import { compareAppVersions, LINK_STALE_MS, type Device } from '../../shared/model/devices.ts';
import type { NearbyPc, RemoteIncoming, RemoteOutgoing } from '../../shared/model/remote.ts';
import type { PhoneLink, RelayState } from '../../shared/model/relay.ts';
import { fileSize } from '../lib/format.ts';
import type { PushStatus } from '../pwa/install.ts';

/** How long after its last request a paired phone still counts as in use (its dot is green). */
export const PHONE_IN_USE_MS = 5 * 60_000;

/** "482 913 071" / "482 913". */
export function groupDigits(value: string): string {
  return value.replace(/\D/g, '').replace(/(\d{3})(?=\d)/g, '$1 ');
}

/** A typed Remote ID shows grouped while it is digits; an address stays as typed. */
export function typedTarget(value: string): string {
  return /^[\d\s]+$/.test(value) && /\d{4}/.test(value.replace(/\s/g, '')) ? groupDigits(value) : value;
}

/** The line under "Connect": this PC's own request (with the code both screens show), the last error, or the help. */
export interface ConnectLine {
  text: string;
  tone?: 'ok' | 'error';
  code?: string;
  action?: 'cancel' | 'close';
}

export const CONNECT_HINT = 'PCs nearby are listed above; others by ID or address';

/** The company a request joins as the PC asked named it, else that PC. */
const companyOf = (out: Pick<RemoteOutgoing, 'company' | 'name'>): string => out.company?.trim() || out.name;

export function connectLine(out: RemoteOutgoing | undefined, error: string | null): ConnectLine {
  if (error) return { text: error, tone: 'error' };
  if (!out) return { text: CONNECT_HINT };
  switch (out.status) {
    // Review H1: one of another person's devices only with this side's yes (remote.confirm); the code comes after it
    case 'confirm': return { text: `Add this PC to ${out.person?.trim() || out.name}'s devices? Everything here is shared with them.`, action: 'cancel' };
    case 'waiting': return {
      text: out.role === 'employee' ? `Joining ${companyOf(out)} as a new member` : out.role === 'ceo' ? 'Adding to your devices' : `Asking ${out.name}`,
      code: out.code, action: 'cancel',
    };
    case 'accepted': return {
      text: out.role === 'employee' ? `Joined ${companyOf(out)} as a new member` : out.role === 'ceo' ? `${out.name} is one of your devices now` : `Connected with ${out.name}`,
      tone: 'ok', action: 'close',
    };
    case 'declined': return { text: `${out.name} declined${out.reason ? `: ${out.reason}` : ''}`, tone: 'error', action: 'close' };
    case 'expired': return { text: `Nobody accepted on ${out.name} in time`, tone: 'error', action: 'close' };
    case 'cancelled': return { text: 'Cancelled', action: 'close' };
    default: return { text: `Could not connect to ${out.name}${out.reason ? `: ${out.reason}` : ''}`, tone: 'error', action: 'close' };
  }
}

/** The Remote ID row's hint: how other PCs find this one – through the meeting server, or only on this network. */
export function remoteIdHint(relay: RelayState | undefined, findable: boolean | undefined, base = 'Type it on another PC to connect'): string {
  if (findable === false) return 'This PC does not accept connection requests (settings.json devices.findable)';
  if (!relay) return base;
  if (relay.status === 'connected') return `${base} · meeting server connected`;
  if (relay.status === 'off') return `${base} · only this network (meeting server off)`;
  // 'error' retries: its own reason ("The meeting server refused this PC" …), lower-cased inside the brackets.
  const why = relay.status === 'connecting' ? 'meeting server connecting…' : relay.error ? relay.error.charAt(0).toLowerCase() + relay.error.slice(1) : 'meeting server not reachable';
  return `${base} · only this network for now (${why})`;
}

/** Eine-ID: the "Company ID" row's start (remoteIdHint adds the meeting server's state) and the "My ID" row's hint. */
export const COMPANY_ID_BASE = 'New members type it';
export const MY_ID_HINT = 'Type it on another PC of yours to add it · phones scan the QR';

/** Eine-ID: while this PC's request waits as a new member, the "Your name" field shows (remote.name). */
export const waitsAsMember = (out: Pick<RemoteOutgoing, 'status' | 'role'> | undefined): boolean => out?.status === 'waiting' && out.role === 'employee';

/** Eine-ID: a nearby row's Connect asks with its company's ID (a new member there); an older PC's own Remote ID. */
export const nearbyTarget = (pc: Pick<NearbyPc, 'companyId' | 'remoteId'>): string => pc.companyId ?? pc.remoteId;

/** A paired phone's dot: 'online' while it was used in the last minutes. */
export function phoneDot(device: { lastSeenAt?: number }, now = Date.now()): 'online' | 'offline' {
  return device.lastSeenAt !== undefined && now - device.lastSeenAt < PHONE_IN_USE_MS ? 'online' : 'offline';
}

/**
 * The hint on the phone QR beside My ID (the Android app, or the iPhone web app from the website on the Home Screen –
 * chat sweep 16.11.2026: no App Store, no Apple account; F17: the QR carries this PC's own ID, so the phone's
 * request lands here; typing My ID works too). An employee's phone asks the same way; Accept says whose it is.
 */
export const PHONE_QR_HINT = 'This PC · in the Autark app on Android scan this or type My ID – on an iPhone in the web app from openautark.com, added to the Home Screen from Safari – then accept here when both show the same code';

/** A request is the owner's phone app (B-078; shared/model/remote.ts types the PC roles). */
export const isPhoneRequest = (request: Pick<RemoteIncoming, 'role'>): boolean => request.role === 'phone';

/**
 * The label and hint of a request: a new member of `company` (this company's name, where it has one), one of my devices,
 * or my phone – waiting here or (F17) on `via`, another of my PCs.
 */
export function incomingText(request: Pick<RemoteIncoming, 'role' | 'name' | 'code' | 'via'>, company?: string): { label: string; hint: string } {
  const to = request.via ? ` ${request.via.name}` : '';
  if (isPhoneRequest(request)) return { label: `Phone ${request.name} asks${to} to connect`, hint: `Accept only if the phone shows the code ${request.code}` };
  const wants = request.role === 'employee' ? `wants to join${company?.trim() ? ` ${company.trim()}` : ''} as a new member` : 'wants to be one of your devices';
  return { label: `${request.name} ${wants}${request.via ? ` · on ${request.via.name}` : ''}`, hint: `Accept only if ${request.name} shows the code ${request.code}` };
}

/** F09: one PC on this network with the companies on it that answered (each its own key and Remote ID). */
export interface NearbyGroup { key: string; name: string; pcs: NearbyPc[] }

const hostOf = (address: string): string | undefined => {
  try { return new URL(address).hostname || undefined; } catch { return undefined; }
};

/**
 * F09: the PCs on this network, one group per PC: answers with the same name that share an address host are one PC's
 * companies (two PCs that happen to share a name never merge); an answer without a company (an older PC) stays alone.
 */
export function nearbyGroups(list: readonly NearbyPc[]): NearbyGroup[] {
  const groups: Array<NearbyGroup & { hosts: Set<string> }> = [];
  for (const pc of list) {
    const hosts = new Set(pc.addresses.map(hostOf).filter((host): host is string => Boolean(host)));
    const same = pc.company ? groups.find((group) => group.name === pc.name && group.pcs[0].company && [...hosts].some((host) => group.hosts.has(host))) : undefined;
    if (same) { same.pcs.push(pc); for (const host of hosts) same.hosts.add(host); continue; }
    groups.push({ key: `${pc.deviceId}:${pc.fingerprint}`, name: pc.name, pcs: [pc], hosts });
  }
  return groups.map(({ key, name, pcs }) => ({ key, name, pcs }));
}

/** The hint of a nearby row: a PC alone ("On this network · Teydra Lab · Company ID …"), or one company under its PC. */
export function nearbyHint(pc: Pick<NearbyPc, 'company' | 'companyId' | 'remoteId'>, underPc: boolean): string {
  const id = `${pc.companyId ? 'Company ID' : 'ID'} ${groupDigits(nearbyTarget(pc))}`;
  return underPc ? id : ['On this network', pc.company, id].filter(Boolean).join(' · ');
}

/** B-084: the Notifications row inside the Android app (the app shows them; Android's own settings turn them off). */
export const ANDROID_APP_NOTIFY = 'The Autark app shows new messages itself · turn them off in Android’s settings for Autark';

/** B-084: the "Forget this phone" row (Settings › Devices › This phone). */
export const FORGET_HINT = 'Signs this phone out of this company · connecting again needs Accept on the PC';

/**
 * The hint under "Notifications" on a phone or browser: what reaches it once on (a person of the organisation: the new
 * messages of their chats – pwa/person-push.ts; the owner's phone: to-dos and blockers, replies when it may chat), or why it
 * cannot be turned on. Undefined while off or not yet read. `iosTab`: the iPhone app opened in a Safari tab, where iOS
 * gives web pages no notifications – they work in the Home Screen app, which keeps its own pairing. `androidApp`: B-084 –
 * inside the Android app the app itself shows them (its WebView has no web push), whatever the browser status says.
 */
export function pushHint(status: PushStatus | undefined, who: { person: boolean; chat: boolean; iosTab?: boolean; androidApp?: boolean }): string | undefined {
  if (who.androidApp) return ANDROID_APP_NOTIFY;
  if (status === 'on') return who.person ? 'New messages in your chats reach this phone' : who.chat ? 'To-dos, blockers and replies reach this phone' : 'To-dos and blockers reach this phone';
  if (status === 'blocked') return 'Blocked for this site in the browser settings';
  if (status === 'unsupported' && who.iosTab) return 'On iPhone: Share › Add to Home Screen, open Autark there and connect again; notifications work in the Home Screen app';
  if (status === 'unsupported') return 'This browser cannot show notifications';
  if (status === 'insecure') return 'Needs HTTPS – open the app through an HTTPS address';
  return undefined;
}

const STATUS_TEXT: Partial<Record<Device['status'], string>> = { online: 'Online', connecting: 'Connecting…', offline: 'Not reachable' };
/** An update that has not brought its PC back after this long did not land (the installer's own wait is far shorter). */
export const UPDATE_BACK_MS = 20 * 60_000;

/** What a PC that said goodbye is doing now ("App closed · 14:02"); '' while it is online or said nothing. */
export function awayText(device: Pick<Device, 'away' | 'status'>, time: (at: number) => string, now = Date.now()): string {
  const away = device.status === 'online' ? undefined : device.away;
  if (!away) return '';
  if (away.reason === 'update') return now - away.at < UPDATE_BACK_MS ? `Updating… · since ${time(away.at)}` : `Not back after its update · ${time(away.at)}`;
  if (away.reason === 'session-end') return `Signed out or shut down · ${time(away.at)}`;
  return `App closed · ${time(away.at)}`;
}

/** "PC · Employee · Anna · Online", "PC · App closed · 14:02", "Phone · Last used 09:12", "This PC". */
export function deviceHint(device: Device, personName: (id: string) => string | undefined, time: (at: number) => string, now = Date.now()): string {
  if (device.self) return 'This PC';
  if (device.kind !== 'pc') return [device.kind === 'phone' ? 'Phone' : 'Browser', device.lastSeenAt ? `Last used ${time(device.lastSeenAt)}` : ''].filter(Boolean).join(' · ');
  const employee = device.personId ? `Employee · ${personName(device.personId) ?? 'a person'}` : '';
  const away = awayText(device, time, now);
  if (away) return ['PC', employee, away].filter(Boolean).join(' · ');
  const status = STATUS_TEXT[device.status] ?? device.status;
  return ['PC', employee, status, device.status !== 'online' && device.lastSeenAt ? `Last seen ${time(device.lastSeenAt)}` : ''].filter(Boolean).join(' · ');
}

/**
 * 24.11.2026 (ORENDA find: a PC that refused this PC's sign-ins was asked every few seconds and nobody was told): the line on
 * a PC's row when it takes none of this PC's plan sign-ins (runtime/devices/logins-refused.ts) – why, in plain words, and what
 * the person can do. '' when it refuses nothing. `list` names the newest Autark among the PCs, to see an older one.
 */
export function loginsHint(device: Pick<Device, 'kind' | 'caps' | 'personId' | 'joinedAs' | 'loginsRefused'>, list: ReadonlyArray<Pick<Device, 'kind' | 'caps' | 'status'>> = []): string {
  if (device.kind !== 'pc' || !device.loginsRefused) return '';
  const lead = 'Your sign-ins aren’t shared with this PC';
  if (device.joinedAs === 'employee') return `${lead} – you’re connected there as an employee. Sign in on that PC itself (Settings › Models).`;
  if (device.personId) return `${lead} – it belongs to an employee, who signs in there themselves.`;
  const own = device.caps.version;
  const newest = list.reduce<string | undefined>((best, other) => {
    const version = other.kind === 'pc' && other.status !== 'revoked' ? other.caps.version : undefined;
    return version && (!best || compareAppVersions(version, best) > 0) ? version : best;
  }, undefined);
  if (own && newest && compareAppVersions(own, newest) < 0) return `${lead} – its Autark is older (${own}). Update it there, or sign in on that PC itself (Settings › Models).`;
  return `${lead} – it doesn’t accept them from here. Sign in on that PC itself (Settings › Models).`;
}

/**
 * G (22.11.2026): a device row's connection now – "45 ms", "1.2 s", "Slow connection · 450 ms" (runtime/devices/
 * link-quality.ts decides `slow`); '' while unmeasured, for a PC that is not online and for a figure older than
 * LINK_STALE_MS (a phone's kept list, device-wake.ts) – an old figure says nothing about now.
 */
export function linkHint(device: Pick<Device, 'kind' | 'status' | 'link'>, now = Date.now()): string {
  const link = device.link;
  if (!link || now - link.at > LINK_STALE_MS || (device.kind === 'pc' && device.status !== 'online')) return '';
  const time = link.rttMs < 1000 ? `${link.rttMs} ms` : `${(link.rttMs / 1000).toFixed(1)} s`;
  return link.slow ? `Slow connection · ${time}` : time;
}

/** F29: "Direct · 12.4 MB direct, 310 KB via the meeting server today" – a phone's way to this PC now and its bytes. */
export function phoneLinkHint(link: PhoneLink, now: number, clock: (at: number) => string): string {
  const way = link.via === 'direct' || link.via === 'rtc' ? 'Direct' : link.via === 'relay' ? 'Via the meeting server' : 'Not connected'; // F25: WebRTC is direct too
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const period = link.since <= midnight ? 'today' : `since ${clock(link.since)}`;
  return `${way} · ${fileSize(link.direct + link.rtc)} direct, ${fileSize(link.relay)} via the meeting server ${period}`;
}

/** The iPhone web app's connection row (18.11.2026, F25 P3: the web app goes direct over WebRTC too, ui/hosted/rtc.ts). */
export const IPHONE_LINK = 'Directly to the PC when the network allows, else via the meeting server – encrypted end to end either way';

/**
 * 18.11.2026: the one line on how devices connect, over the Connection rows. 28.11.2026 (Mac test of 0.3.22: it said
 * "directly device to device" while the link ran through the meeting server): it names the way the links run now, from
 * what RelayState already knows – a phone's `via` ('direct'/'rtc' are direct, 'relay' is the server) and the PCs whose
 * link is a tunnel there (`relayed`). Both ways: partly; neither known (not connected, no state yet): either.
 */
export function connectionLine(relay: Pick<RelayState, 'relayed' | 'phones'> | undefined): string {
  const phones = relay?.phones ?? [];
  const direct = phones.some((phone) => phone.via === 'direct' || phone.via === 'rtc');
  const server = (relay?.relayed.length ?? 0) > 0 || phones.some((phone) => phone.via === 'relay');
  if (direct && server) return 'End-to-end encrypted, directly device to device where the network allows – right now partly through the meeting server, which only passes sealed data on.';
  if (server) return 'End-to-end encrypted. Right now your devices connect through the meeting server, which only passes sealed data on and cannot read it.';
  if (direct) return 'End-to-end encrypted, directly device to device. The meeting server only helps your devices find each other.';
  return 'End-to-end encrypted, directly device to device or through the meeting server when no direct way works. The meeting server cannot read it.';
}
export const PRIVACY_URL = 'https://openautark.com/privacy/#meeting-server';

/** The meeting server's fallback today: its daily limit is used up, or its operator paused it (RelayState.held). */
export function heldLine(held: RelayState['held']): string {
  if (held === 'quota') return ' · fallback at today’s limit, direct only';
  if (held === 'off') return ' · fallback paused, direct only';
  return '';
}

/** "Your own meeting server": the line that starts the server shipped with this app (PowerShell on Windows, else sh). */
export function ownServerCommand(meet: { program: string; file: string }): string {
  if (/^[A-Za-z]:\\|\\/.test(meet.program)) return `$env:ELECTRON_RUN_AS_NODE=1; $env:RELAY_PORT=8787; & "${meet.program}" "${meet.file}"`;
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
  return `ELECTRON_RUN_AS_NODE=1 RELAY_PORT=8787 ${quote(meet.program)} ${quote(meet.file)}`;
}

/** The same server as a container, built straight from the public source. */
export const OWN_SERVER_DOCKER = 'docker build -t autark-meet https://github.com/teydra/OpenAutark.git#main:services/remote-relay && docker run -d --restart unless-stopped -p 127.0.0.1:8787:8787 autark-meet';

/** The meeting server's state in a few words (pure). */
export function relayLine(relay: RelayState | undefined, address: string): string {
  // 'off' with an address: the runtime keeps it unused (as the Remote ID row says) – never "Connecting…" forever
  if (!address || relay?.status === 'off') return 'Off · PCs in other networks find each other there by Remote ID';
  if (relay?.status === 'connected') return `Connected · ${relay.peersOnline} linked ${relay.peersOnline === 1 ? 'PC' : 'PCs'} online there${heldLine(relay.held)}`;
  if (relay?.status === 'error') return `Not connected${relay.error ? `: ${relay.error}` : ''}`;
  return 'Connecting…';
}

/** 0.3.19: Settings › Devices › Connection › "Wake while closed" (devices.wakeHelper). */
export const WAKE_HELPER_HINT = 'While Autark is closed, a small helper waits so Wake from your phone or another PC and scheduled work start it again';
