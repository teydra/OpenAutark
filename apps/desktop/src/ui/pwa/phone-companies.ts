// B-084 (decision 7) the Android app's companies as the page sees them, over the native port (native-port.ts): the
// 'companies' list (each pairing its own origin, the current one ticked) and the 'status' of the link ("<company> ·
// <PC>" in the profile sheet, shell/ProfileMenu.tsx). A pick and "Add a company" are one message each; the app does the
// switching. There is no PC picker (owner 27.11.2026: every PC of the company that is online is linked). Back to the
// app go this company's card (name + a 64 px JPEG of the profile photo, the picture the app shows in its list) and the colours of the top row and the tab bar (decision 2: the app paints its
// status and navigation strips with them) – on the port's arrival, on a theme or screen change and on 'resume'.
// Owns: those signals and messages. Never: switches, adds or forgets a company itself (the app does), draws anything.

import { effect, signal } from '@preact/signals';
import { companyLabel } from '../../shared/model/companies.ts';
import type { Profile } from '../../shared/model/system.ts';
import { theme } from '../blocks/host.ts';
import { route } from '../lib/router.ts';
import { rpc } from '../lib/rpc.ts';
import { settings } from '../lib/store.ts';
import { hasNativePort, onNative, sendNative } from './native-port.ts';
import { startShare } from './share.ts';

export interface PhoneCompany { id: string; name: string; avatar?: string; current: boolean; pc?: string }
/** `online` of `total` PCs of the company have a channel now (0.3.20; absent from an app before that: the PC's name is shown). */
export interface PhoneStatus { pc?: string; connected: boolean; online?: number; total?: number }

/** The companies this phone is paired with (empty outside the Android app). */
export const phoneCompanies = signal<PhoneCompany[]>([]);
/** The link to the PC (null until the app says). */
export const phoneStatus = signal<PhoneStatus | null>(null);

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const AVATAR = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const AVATAR_MAX = 32 * 1024;

/** The 'companies' message's list; rows without an id are skipped, a picture is kept only as a small image data URL. */
export function parseCompanies(msg: Record<string, unknown>): PhoneCompany[] {
  if (!Array.isArray(msg.list)) return [];
  const out: PhoneCompany[] = [];
  for (const row of msg.list.slice(0, 50) as unknown[]) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    const id = text(item.id, 64);
    if (!id) continue;
    const avatar = typeof item.avatar === 'string' && item.avatar.length <= AVATAR_MAX && AVATAR.test(item.avatar) ? item.avatar : undefined;
    const pc = text(item.pc, 80);
    out.push({ id, name: text(item.name, 80) || id, current: item.current === true, ...(avatar ? { avatar } : {}), ...(pc ? { pc } : {}) });
  }
  return out;
}

export function parseStatus(msg: Record<string, unknown>): PhoneStatus {
  const pc = text(msg.pc, 80);
  const count = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 999 ? value : undefined);
  const online = count(msg.online);
  const total = count(msg.total);
  return { connected: msg.connected === true, ...(pc ? { pc } : {}), ...(online !== undefined && total !== undefined && total > 0 && online <= total ? { online, total } : {}) };
}

/**
 * The profile sheet's one status line: "<company> · 2 of 3 PCs online" (no PC is named – none outranks another; a single
 * PC: "1 PC online"), the PC's name from an app before 0.3.20, or "Connecting…" while the link is down.
 */
export function statusLine(company: string, status: PhoneStatus | null): string {
  if (!status?.connected) return 'Connecting…';
  if (status.online !== undefined && status.total !== undefined) {
    return status.total === 1 ? `${company} · 1 PC online` : `${company} · ${status.online} of ${status.total} PCs online`;
  }
  return status.pc ? `${company} · ${status.pc}` : company;
}

export const switchCompany = (id: string): boolean => sendNative({ t: 'switch', id });
export const addCompany = (): boolean => sendNative({ t: 'add' });

const CARD_PX = 64;

/** A 64 px square JPEG data URL of an image (centre crop); null where the browser can't draw it. */
async function thumbnail(blob: Blob): Promise<string | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  const bitmap = await createImageBitmap(blob);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = CARD_PX;
  canvas.height = CARD_PX;
  canvas.getContext('2d')?.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, CARD_PX, CARD_PX);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.8);
}

/** Sends this company's card to the app: its name (companyLabel) and the profile photo as a small picture. */
export async function keepCompanyCard(profile: Pick<Profile, 'name' | 'company' | 'avatarFileId'> | undefined): Promise<boolean> {
  const name = companyLabel(profile, null);
  let avatar: string | null = null;
  if (profile?.avatarFileId) {
    try {
      const { dataBase64, mime } = await rpc.call('files.read', { id: profile.avatarFileId, maxBytes: 8 * 1024 * 1024 });
      const binary = atob(dataBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      avatar = await thumbnail(new Blob([bytes], { type: mime }));
    } catch { avatar = null; } // the name alone still tells the companies apart
  }
  return sendNative({ t: 'card', name, ...(avatar ? { avatar } : {}) });
}

/** The colour an element shows: its own background, else the nearest painted ancestor's. */
function painted(element: Element | null): string {
  for (let at = element; at; at = at.parentElement) {
    const color = getComputedStyle(at).backgroundColor;
    if (color && color !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(color)) return color;
  }
  return getComputedStyle(document.body).backgroundColor || '#ffffff';
}

/** The top row's and the tab bar's colours (a pushed screen has no tab bar: then whatever ends the screen). */
export function barColors(): { top: string; bottom: string } {
  const shell = document.querySelector('.mobile-shell');
  const top = shell?.querySelector(':scope > .mobile-top, :scope.own-header > .mobile-main > * > .frame-header') ?? document.elementFromPoint(innerWidth / 2, 1);
  const bottom = shell?.querySelector(':scope > .tab-bar') ?? document.elementFromPoint(innerWidth / 2, innerHeight - 1);
  return { top: painted(top ?? shell), bottom: painted(bottom ?? shell) };
}

let sent = '';
function sendColors(force = false): void {
  requestAnimationFrame(() => {
    const colors = barColors();
    const key = `${colors.top}|${colors.bottom}`;
    if ((force || key !== sent) && sendNative({ t: 'colors', ...colors })) sent = key;
  });
}

let wired = false;
/** Wires the Android app's port (main.tsx, once): companies, status, share, the card, the bar colours. */
export function startPhoneShell(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  onNative('companies', (msg) => { phoneCompanies.value = parseCompanies(msg); });
  onNative('status', (msg) => { phoneStatus.value = parseStatus(msg); });
  startShare();
  let card = '';
  const sendCard = (force: boolean) => {
    const profile = settings.peek()?.profile;
    const key = profile ? `${profile.name}|${profile.company}|${profile.avatarFileId ?? ''}` : '';
    if (!profile || !hasNativePort() || (!force && key === card)) return;
    card = key;
    void keepCompanyCard(profile);
  };
  onNative('port', () => { sendColors(true); sendCard(true); });
  onNative('resume', () => sendColors(true));
  effect(() => { void theme.value; void route.value; if (hasNativePort()) sendColors(); });
  effect(() => { void settings.value?.profile; sendCard(false); });
}
