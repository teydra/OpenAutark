// web.fetch: read a web page or text resource as plain text (size-capped, untrusted). B-047 D6: web.search
// (web-search.ts: a stored search API by handle, else a keyless endpoint) comes with it.
// B-044: `headers` may carry a stored secret by handle ("Authorization": "Bearer secret://<id>"), replaced by the
// value only when the request is sent, for this host (secrets/handles.ts; owner 29.10.2026: a secret is tied to no site, so any host takes it – the
// 'secret' category; what comes back has each sent value masked by its handle). Such a request follows no redirect – a
// redirect is reported instead – so the secret never goes on to another host. What comes back passes the redactor;
// fetch quotes a header value in its own errors, so a value with a line break is refused before sending and an error
// text is redacted before it is shortened (a cut value would escape the exact-match redactor).
// B-080 (live: 33 HTTP 403 bot checks, 3 YouTube 429s and 20 bare "fetch failed" since 05.11.): a bot-check answer – HTTP
// 403/429/503 with a cf-mitigated header or a check page's words, or LinkedIn's HTTP 999 (live 08.11.) – or a reset
// connection is read again in my own browser (services.browserRead, browser/read-page.ts; in every mode, not for a request
// with a stored secret – the browser would fetch another page without it). Its head names where it was read and why; a
// page that shows my browser the check too comes back as a failed fetch, with no added line; while the person has my
// browser, the answer says so with the direct fetch's own answer. A failed fetch names its cause ("getaddrinfo ENOTFOUND
// <host>"). The request headers stay as they are – nothing hides that I am automated.
// 25.11.2026 (Secure mode, web not open everywhere): redirects are followed hop by hop, each only to the site the gate let
// through or one open without asking (redirectCheck); a redirect elsewhere is reported, not followed – an open redirect
// of an allowed site would otherwise carry data on to any site.
// Owns: http(s) fetching with a byte cap and timeout, HTML → text extraction, the header checks, the bot-check fallback.
// Never: follows non-http schemes, sends the person's cookies, puts a secret value anywhere but the request,
// or presents page text as instructions (it is labelled untrusted content).

import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';
import { failure, text } from '../types.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { handlesIn, judgeHandles, resolveMasked, withHandles } from '../../secrets/handles.ts';
import { defineTool } from './util.ts';
import { siteListed, siteOf } from '../../../shared/model/security-settings.ts';
import { webSearchTool, type SearchFetch } from './web-search.ts';
import type { BrowserRead } from '../../browser/read-page.ts';

export type FetchFn = (url: string, init: { signal: AbortSignal; headers: Record<string, string>; redirect: 'follow' | 'manual' }) => Promise<Response>;

type FetchArgs = { url: string; maxChars?: number; headers?: Record<string, string> };
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const FIXED_HEADERS: ReadonlySet<string> = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

/** The headers as given, checked (names, at most 20); throws bad_request. */
function checkHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const entries = Object.entries(headers ?? {});
  if (entries.length > 20) throw new WorkforceError('bad_request', 'At most 20 headers.');
  for (const [name] of entries) {
    if (!HEADER_NAME.test(name) || FIXED_HEADERS.has(name.toLowerCase())) throw new WorkforceError('bad_request', `"${name.slice(0, 40)}" cannot be set as a header.`);
  }
  return Object.fromEntries(entries);
}

const hostOfUrl = (url: string): string | undefined => { try { return new URL(url).hostname || undefined; } catch { return undefined; } };

/**
 * 25.11.2026 (Secure mode, the web not open everywhere): whether a redirect may go on to a host – the site the gate let
 * through (and its subdomains), or one the policy opens without asking. undefined: no check (Trust AI mode, web open).
 */
function redirectCheck(ctx: ToolContext, first: string): ((host: string) => boolean) | undefined {
  const security = ctx.services.security;
  if (!security) return undefined;
  try {
    const now = security.current();
    if (now.mode !== 'secure' || now.web === 'yes') return undefined;
  } catch { return undefined; }
  const start = siteOf(first);
  return (host) => {
    const site = siteOf(host);
    if (!site) return false;
    if (siteListed([start], site)) return true;
    try { return security.check({ agentId: ctx.agent.id, capability: 'web', site, fingerprint: '' }) === 'open'; } catch { return false; }
  };
}

const MAX_BYTES = 2 * 1024 * 1024;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Crude but robust HTML → text: drops scripts/styles/nav chrome, keeps headings and links. */
export function htmlToText(html: string): string {
  let value = html
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => `${label} (${href})`)
    .replace(/<h([1-6])[^>]*>/gi, (_m, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
  value = value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const point = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : ' ';
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
  return value.replace(/[ \t\f\v\r]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** B-080: the answers of a bot check – these statuses with a cf-mitigated header or one of these words in the page, and HTTP 999. */
const BOT_STATUS: ReadonlySet<number> = new Set([403, 429, 503]);
const BOT_WORDS = /just a moment|attention required|access denied|unusual traffic|security check|request could not be satisfied|sucuri/i;

/** True when the answer is a bot check (see BOT_STATUS). */
export function botCheck(status: number, headers: Pick<Headers, 'get'>, raw: string): boolean {
  // 999 is LinkedIn's answer to an automated request, without a body.
  return status === 999 || (BOT_STATUS.has(status) && (headers.get('cf-mitigated') !== null || BOT_WORDS.test(raw.slice(0, 200_000))));
}

/** The cause a failed fetch carries ({ code, message } under fetch's "fetch failed"). */
function causeOf(error: unknown): { code?: string; message?: string } {
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (!cause || typeof cause !== 'object') return {};
  const { code, message } = cause as { code?: unknown; message?: unknown };
  return { ...(typeof code === 'string' && code ? { code } : {}), ...(typeof message === 'string' && message ? { message } : {}) };
}

/** B-080: a failed fetch's text with its cause – "getaddrinfo ENOTFOUND todocast.de" instead of the bare "fetch failed". */
export function fetchErrorText(error: unknown): string {
  const top = error instanceof Error ? error.message : String(error ?? '');
  const { code, message } = causeOf(error);
  const inner = message ? (code && !message.includes(code) ? `${message} (${code})` : message) : code ?? '';
  if (!inner) return top;
  return !top || /^fetch failed$/i.test(top.trim()) ? inner : `${top}: ${inner}`;
}

/** A connection the site reset (the other bot-check answer). */
function connectionReset(error: unknown): boolean {
  const code = causeOf(error).code;
  return code === 'ECONNRESET' || code === 'UND_ERR_SOCKET';
}

/** B-080: the page read in my own browser after the direct fetch was turned away (`why`); `direct` is that fetch's answer. */
async function readInBrowser(read: BrowserRead, ctx: ToolContext, url: URL, why: string, direct: ToolOutput, max: number): Promise<ToolOutput> {
  let page: Awaited<ReturnType<BrowserRead>>;
  try {
    page = await read(ctx.agent.id, url.toString(), { maxChars: Math.min(max, 100_000), use: { conversationId: ctx.conversationId, taskId: ctx.taskId } });
  } catch (error) {
    const using = (error as { details?: { takeover?: unknown } } | null)?.details?.takeover === true; // its message is browser/takeover.ts PERSON_USING
    const said = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    const line = using ? `It was a bot check. ${said}` : `It was a bot check; reading it in my own browser failed too: ${said}`;
    return { ...direct, content: [...direct.content, { type: 'text', text: line }], isError: true };
  }
  const more = page.truncated ? '\n… [more text on the page]' : '';
  return {
    content: [{ type: 'text', text: `[untrusted web content from ${url.host}, read in my own browser – ${why}]\n${page.text}${more}` }],
    isError: page.humanCheck, // a human check has no readable page: the fetch did not get real content (no line on what to do – that loops)
  };
}

export function webTools(deps: { fetch?: FetchFn } = {}): ToolDef[] {
  const doFetch: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init));

  const webFetch = defineTool<FetchArgs>({
    name: 'web.fetch',
    description: 'Fetches a web page or API response as plain text, up to about 2 MB. A stored secret goes into a header by its handle.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 8, maxLength: 4000 }, maxChars: { type: 'integer', minimum: 200, maximum: 200_000 },
        headers: { type: 'object', additionalProperties: { type: 'string', maxLength: 4000 }, description: 'A value can hold "secret://<id>", e.g. "Bearer secret://<id>", replaced when sent (then no redirect).' },
      },
      required: ['url'], additionalProperties: false,
    },
    category: 'read',
    describe: (args, ctx) => {
      let host = args.url;
      try { host = new URL(args.url).host; } catch { /* reported in run */ }
      const action = { summary: `Fetch ${host}`, resource: host, reversible: true, external: false };
      const ids = handlesIn(Object.values(checkHeaders(args.headers)));
      if (!ids.length) return action;
      const hostname = hostOfUrl(args.url);
      if (!hostname) throw new WorkforceError('bad_request', 'Not a valid URL.');
      const judged = judgeHandles(ctx, ids, hostname);
      if ('problem' in judged) throw new WorkforceError('forbidden', judged.problem);
      return withHandles(action, judged, `in a header to ${hostname}`);
    },
    async run(args, ctx) {
      let url: URL;
      try { url = new URL(args.url); } catch { return failure('Not a valid URL.'); }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return failure('Only http and https URLs can be fetched.');
      const given = checkHeaders(args.headers);
      const secret = handlesIn(Object.values(given)).length > 0;
      const resolved = secret ? await resolveMasked(ctx, given, url.hostname) : { values: given, mask: (text: string) => text };
      const headers = resolved.values;
      const mask = resolved.mask;
      // A header cannot carry a line break or NUL; fetch's own error would quote the (resolved) value.
      if (secret && Object.values(headers).some((value) => /[\0\r\n]/.test(value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '')))) {
        return failure('A stored secret in the headers holds a line break, which a header cannot carry; nothing was sent.');
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      ctx.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 30_000);
      const max = args.maxChars ?? 40_000;
      let why: string | undefined; // B-080: the direct fetch was turned away as a bot
      let answer: ToolOutput;
      const check = secret ? undefined : redirectCheck(ctx, url.hostname);
      try {
        const init = { signal: controller.signal, redirect: secret || check ? 'manual' as const : 'follow' as const, headers: { 'user-agent': 'Mozilla/5.0 (Autark agent)', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5', ...headers } };
        let response = await doFetch(url.toString(), init);
        let held: string | undefined; // 25.11.2026: a redirect to a site Secure mode has not opened to me
        for (let hop = 0, at = url; check && hop < 10 && response.status >= 300 && response.status < 400; hop++) {
          const location = response.headers.get('location');
          let next: URL;
          try { next = new URL(location ?? '', at); } catch { break; }
          if (!location) break;
          if ((next.protocol !== 'http:' && next.protocol !== 'https:') || !check(next.hostname)) { held = next.toString(); break; }
          await response.body?.cancel().catch(() => undefined);
          at = next;
          response = await doFetch(next.toString(), init);
        }
        const moved = secret && response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
        const type = response.headers.get('content-type') ?? '';
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        let capped = false;
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) { capped = true; chunks.push(value.subarray(0, value.byteLength - (size - MAX_BYTES))); await reader.cancel(); break; }
          chunks.push(value);
        }
        const raw = new TextDecoder().decode(Buffer.concat(chunks));
        const body = mask(/html|xml/i.test(type) || /^\s*</.test(raw) ? htmlToText(mask(raw)) : raw); // before clipping
        const clipped = body.length > max ? `${body.slice(0, max)}\n… [${body.length - max} more chars]` : body;
        const redirect = moved ? `\n[redirect to ${moved.slice(0, 500)} not followed: the request carries a stored secret]`
          : held ? `\n[redirect to ${held.slice(0, 500)} not followed: Secure mode has not opened that site to me yet – I fetch it directly, and the app asks the person first]` : '';
        if (!secret && botCheck(response.status, response.headers, raw)) why = `the direct fetch got HTTP ${response.status}, a bot check`;
        answer = {
          content: [{ type: 'text', text: mask(`[untrusted web content from ${url.host}, HTTP ${response.status}${capped ? ', truncated at 2 MB' : ''}]\n${clipped}${redirect}`) }],
          isError: !response.ok,
        };
      } catch (error) {
        // Redacted before it is shortened: a cut value would no longer be recognised by the output redactor.
        const raw = fetchErrorText(error); // B-080: with its cause
        let message = mask(raw || 'network error');
        try { if (raw) message = ctx.services.secrets.redact(message); } catch { /* no vault (a fake): the output redactor still runs */ }
        message = message.slice(0, 200);
        if (!secret && !controller.signal.aborted && connectionReset(error)) why = "the direct fetch's connection was reset";
        answer = failure(controller.signal.aborted ? 'Fetch timed out or was stopped.' : `Fetch failed: ${message}`);
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', abort);
      }
      const read = ctx.services.browserRead;
      return why && read && !ctx.signal.aborted ? readInBrowser(read, ctx, url, why, answer, max) : answer;
    },
  });

  return [webFetch, webSearchTool({ fetch: doFetch as unknown as SearchFetch })];
}
