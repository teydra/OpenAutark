// Value redaction: replaces known secret values (and their common encodings) in any text
// with the secret's handle `secret://<id>`. X05: a 2FA setup key is learnt as a `pattern` (any
// case and grouping, totp.ts seedPattern) – never its stored JSON.
// 22.11.2026 (a stored card number showed in three agents' tool results, written in groups of four by the page):
// a value of MIN_SECRET_CHARS or more also matches in any grouping, and a shorter one (a CVC, a PIN, an expiry, from
// MIN_PLACE_CHARS) is replaced where it stands in a secret place – after a card, code or password label – but not in
// running text (shared/secrets/secret-places.ts).
// Owns: the in-memory matcher. Never: logs values, matches a value shorter than MIN_SECRET_CHARS outside a secret
// place, or one shorter than MIN_PLACE_CHARS at all.

import { looseKey, looseReplace, maskInPlaces } from '../../shared/secrets/secret-places.ts';
import { findKeys } from '../../shared/secrets/token-patterns.ts';

export const MIN_SECRET_CHARS = 8;
/** A stored value this long or longer (and under MIN_SECRET_CHARS) is replaced in secret places only. */
export const MIN_PLACE_CHARS = 3;

/**
 * 18.11.2026 (a live Stripe key printed by an error text – the third case in two days): what a tool prints is masked by the
 * shape of a key too, not only by the values the vault knows. The mark names the kind and never the value: "‹secret:stripe-live›".
 * Used for a tool's output, the run journal's previews and stored outputs (tools/outputs.ts) and an engine's own calls
 * (agents/turn-attempt.ts). Not for chat messages or app pages (a web key inside an app is public there; secrets.redact leaves them).
 */
export function keyMark(key: { name: string; value: string }): string {
  const value = key.value;
  const slug = key.name === 'Stripe key' ? (/^(?:sk|rk)_live_/.test(value) ? 'stripe-live' : 'stripe-test')
    : key.name === 'Stripe webhook secret' ? 'stripe-webhook'
    : key.name === 'API key' ? (/^sk-ant-/.test(value) ? 'anthropic-key' : /^sk-proj-/.test(value) ? 'openai-key' : 'api-key')
    : key.name === 'GitHub token' ? 'github-token'
    : key.name === 'Slack token' ? 'slack-token'
    : key.name === 'AWS key' ? 'aws-key'
    : key.name === 'Google API key' ? 'google-api-key'
    : key.name === 'Private key' ? 'private-key'
    : key.name === 'Token' ? (/^eyJ/.test(value) ? 'jwt' : 'bearer-token')
    : 'key';
  return `‹secret:${slug}›`;
}

/** `text` with every key that shows itself by its shape replaced by its mark (see keyMark); idempotent. */
export function maskKeyShapes(text: string): string {
  if (!text || text.length < 16) return text;
  const keys = findKeys(text, { apps: false });
  if (!keys.length) return text;
  let out = '';
  let at = 0;
  for (const key of keys) { out += text.slice(at, key.start) + keyMark(key); at = key.end; }
  return out + text.slice(at);
}

export function handleFor(id: string): string {
  return `secret://${id}`;
}

/** All encodings of a value we look for (raw, base64, URL-encoded, hex). */
function variants(value: string): string[] {
  const out = new Set<string>([value]);
  out.add(Buffer.from(value, 'utf8').toString('base64'));
  out.add(Buffer.from(value, 'utf8').toString('base64url'));
  out.add(encodeURIComponent(value));
  out.add(Buffer.from(value, 'utf8').toString('hex'));
  return [...out].filter(variant => variant.length >= MIN_SECRET_CHARS);
}

export class Redactor {
  private byValue = new Map<string, string>(); // variant → secret id
  private ordered: string[] = []; // variants, longest first (prefer the most specific match)
  private patterns = new Map<string, RegExp>(); // secret id → every spelling of a 2FA key (global)
  private loose = new Map<string, string>(); // a long value without its grouping → secret id
  private short = new Map<string, string>(); // a short value without its grouping → secret id (secret places only)
  private marks = new Map<string, string>(); // id → its own mark where it is no catalog handle (runtime-values.ts)

  /**
   * 28.11.2026: a value that is no catalog entry – the runtime's owner token, a wake key – learnt under `id`, replaced by
   * `mark` (never a `secret://` handle: nothing can resolve it) in every spelling `set` knows (raw, base64, URL, hex, grouped).
   * A value under MIN_SECRET_CHARS is not learnt (a short string would match running text).
   */
  setMarked(id: string, value: string, mark: string): void {
    this.remove(id);
    if (value.length < MIN_SECRET_CHARS) return;
    this.set(id, value);
    this.marks.set(id, mark); // after set(): set() starts with remove(id), which drops the mark
  }

  private markOf = (id: string): string => this.marks.get(id) ?? handleFor(id);

  set(id: string, value: string | undefined, pattern?: RegExp): void {
    this.remove(id);
    if (pattern?.global) this.patterns.set(id, pattern);
    if (!value) return;
    const key = looseKey(value);
    if (value.length < MIN_SECRET_CHARS) {
      if (key.length >= MIN_PLACE_CHARS) this.short.set(key, id);
      return;
    }
    if (key.length >= MIN_SECRET_CHARS) this.loose.set(key, id);
    for (const form of variants(value)) this.byValue.set(form, id);
    this.reorder();
  }

  remove(id: string): void {
    this.patterns.delete(id);
    this.marks.delete(id);
    for (const map of [this.loose, this.short]) for (const [key, owner] of map) if (owner === id) map.delete(key);
    let changed = false;
    for (const [variant, owner] of this.byValue) if (owner === id) { this.byValue.delete(variant); changed = true; }
    if (changed) this.reorder();
  }

  redact(text: string): string {
    if (!text || (this.ordered.length === 0 && this.patterns.size === 0 && this.short.size === 0)) return text;
    let out = text;
    for (const [id, pattern] of this.patterns) out = out.replace(pattern, () => this.markOf(id));
    for (const variant of this.ordered) {
      if (out.includes(variant)) out = out.split(variant).join(this.markOf(this.byValue.get(variant)!));
    }
    out = looseReplace(out, this.loose, this.markOf);
    return maskInPlaces(out, this.short, this.markOf);
  }

  private reorder(): void {
    this.ordered = [...this.byValue.keys()].sort((a, b) => b.length - a.length);
  }
}
