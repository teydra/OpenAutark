// Owner 21.11.2026: the agent operates the feedback system itself – feedback.report sends at once with the screen and
// further images, its covering blocks painted solid black before anything leaves the PC (the host's media.image with
// `cover` as fractions; headless a PNG through computer/png.ts), gated by the person's "messages" switch – and only in Trust AI mode: in Secure mode the tool is in
// no offer and no text the agent reads mentions it, in Trust AI mode the tool and the standard text are both there.
// Owns: these assertions only. Never: contacts the mailbox (a fake), reads real keys or the person's data.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeedbackService } from '../../../src/runtime/feedback/service.ts';
import type { FeedbackPayload } from '../../../src/runtime/feedback/delivery.ts';
import { generateReceiverKeys, openReport } from '../../../src/runtime/feedback/seal.ts';
import { coveredPng, fillBlack } from '../../../src/runtime/tools/builtin/feedback-cover.ts';
import { blockRefusal } from '../../../src/runtime/tools/builtin/feedback-images.ts';
import { needsOf } from '../../../src/runtime/security/tool-gate.ts';
import { FEEDBACK_TOOL, feedbackReport, feedbackTools } from '../../../src/runtime/tools/builtin/feedback.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { agreementsSection } from '../../../src/runtime/security/agreements.ts';
import { decodePng, encodePng, type RawImage } from '../../../src/runtime/computer/png.ts';
import { imageBudget, reportNumber } from '../../../src/shared/model/feedback-delivery.ts';
import { securityDefaults, type SecurityMode, type SecurityTopic } from '../../../src/shared/model/security-settings.ts';
import type { ImageRegion, NormalizedImage } from '../../../src/shared/api/host-bridge.ts';
import type { FileRef } from '../../../src/shared/model/system.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../../../src/runtime/tools/types.ts';
import { API_KEY, PROJECT, fakeMailbox, feedbackEnv, type Env } from '../feedback/fakes.ts';

const RESOURCES = path.resolve(import.meta.dirname, '../../../resources');
const envs: Env[] = [];
const temps: string[] = [];
after(() => { for (const env of envs) env.cleanup(); for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

/** A white RGB image `width` × `height`. */
const white = (width: number, height: number): RawImage => ({ width, height, channels: 3, pixels: new Uint8Array(width * height * 3).fill(255) });
const at = (image: RawImage, x: number, y: number) => [...image.pixels.subarray((y * image.width + x) * image.channels, (y * image.width + x) * image.channels + 3)];

test('blocks are fractions 0..1 of their image; one reaching past it, in pixels, or on an image not sent is refused', () => {
  const ask = (block: { image?: string; x: number; y: number; width: number; height: number }) => ({ screen: true, cover: [{ image: 'screen', ...block }] });
  assert.equal(blockRefusal(ask({ x: 0.5, y: 0.25, width: 0.5, height: 0.75 })), '');
  assert.match(blockRefusal(ask({ x: 0.6, y: 0, width: 0.5, height: 0.1 })), /reaches past its image: x, y, width and height are fractions 0..1/);
  assert.match(blockRefusal(ask({ x: 100, y: 50, width: 200, height: 100 })), /reaches past its image/, 'pixels are no fractions');
  assert.match(blockRefusal(ask({ image: 'C:/x.png', x: 0, y: 0, width: 0.1, height: 0.1 })), /not among the images I send/);
});

test('headless: a PNG is covered black at its own pixels, rounded outwards, and sized to its byte share', () => {
  const image = white(10, 10);
  fillBlack(image, [{ x: 0.25, y: 0.25, w: 0.3, h: 0.3 }]); // pixels 2.5 … 5.5 → 2 … 5
  assert.deepEqual(at(image, 2, 2), [0, 0, 0]);
  assert.deepEqual(at(image, 5, 5), [0, 0, 0]);
  assert.deepEqual(at(image, 6, 6), [255, 255, 255]);
  assert.deepEqual(at(image, 1, 2), [255, 255, 255]);

  const noisy: RawImage = { width: 400, height: 300, channels: 3, pixels: new Uint8Array(randomBytes(400 * 300 * 3)) }; // noise: no compression helps
  const png = encodePng(noisy);
  const whole = coveredPng(png, [{ x: 0, y: 0, w: 0.5, h: 1 }], png.length * 2)!;
  assert.deepEqual([whole.width, whole.height, whole.mime], [400, 300, 'image/png']);
  const back = decodePng(whole.data)!;
  assert.deepEqual(at(back, 0, 0), [0, 0, 0]);
  assert.deepEqual(at(back, 199, 299), [0, 0, 0]);
  assert.deepEqual(at(back, 200, 0), at(noisy, 200, 0), 'outside the block the picture stays');
  const small = coveredPng(png, [{ x: 0, y: 0, w: 0.5, h: 1 }], Math.floor(png.length / 2))!;
  assert.ok(small.data.length <= png.length / 2 && small.width < 400, `${small.width} px, ${small.data.length} bytes`);
  assert.deepEqual(at(decodePng(small.data)!, 0, 0), [0, 0, 0]);
  assert.equal(coveredPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), [], 1000), undefined, 'a JPEG is not read here');
});

interface Stored { ref: FileRef; data: Uint8Array }

/** Runtime services over the feedback fakes: a file store in memory, this company's mode, a screenshot tool and (optionally) the host's image job. */
function setup(options: { mode?: SecurityMode; host?: boolean } = {}) {
  const env = feedbackEnv();
  envs.push(env);
  const team = generateReceiverKeys();
  const box = fakeMailbox();
  const store = new Map<string, Stored>();
  const put = async (data: Uint8Array, name: string, mime = 'application/octet-stream'): Promise<FileRef> => {
    const id = createHash('sha256').update(data).digest('hex');
    const ref: FileRef = { id, name, mime, size: data.length, createdAt: 1 };
    store.set(id, { ref, data });
    return ref;
  };
  const reclaimed: string[] = [];
  const files = {
    put,
    putPath: async (file: string) => put(new Uint8Array(readFileSync(file)), path.basename(file), file.endsWith('.png') ? 'image/png' : 'image/jpeg'),
    get: (id: string) => store.get(id)?.ref,
    read: async (id: string) => store.get(id)!.data,
    reclaim: (ids: Iterable<string>) => { reclaimed.push(...ids); }, reconcileOrphans: () => undefined, remove: async () => true,
  };
  const screen = encodePng(white(160, 100));
  const shotTool = { name: 'computer.screenshot', run: async (): Promise<ToolOutput> => ({ content: [{ type: 'image', mime: 'image/png', dataBase64: Buffer.from(screen).toString('base64') }, { type: 'text', text: 'Screenshot 160×100' }], structured: { width: 160, height: 100 } }) };
  const asked: Array<{ cover?: ImageRegion[]; maxPx?: number; maxBytes?: number }> = [];
  const image = async (input: { fileId: string; maxPx?: number; maxBytes?: number; cover?: ImageRegion[] }): Promise<NormalizedImage> => {
    asked.push({ cover: input.cover, maxPx: input.maxPx, maxBytes: input.maxBytes });
    return { ...coveredPng(store.get(input.fileId)!.data, input.cover ?? [], input.maxBytes ?? 3_000_000)!, mime: 'image/png' };
  };
  let mode: SecurityMode = options.mode ?? 'trust';
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'wf-feedback-tool-'));
  temps.push(workspace);
  const s = {
    ...env.s, files,
    paths: { ...env.s.paths, workspace },
    host: { ...env.s.host, ...(options.host ? { media: { image } } : {}) },
    security: { current: () => ({ mode }) },
    tools: { get: (name: string) => (name === 'computer.screenshot' ? shotTool : undefined) },
  } as unknown as RuntimeServices;
  const service = new FeedbackService({ services: () => s, receiver: { publicKey: team.publicKey, project: PROJECT, apiKey: API_KEY }, fetch: box.fetch, os: 'test' });
  const tool = feedbackReport(() => service);
  const ctx: ToolContext = { agent: { id: 'ag_1', name: 'Mira' } as ToolContext['agent'], runId: 'run_1', conversationId: 'cv_1', mode: 'general', services: s, signal: new AbortController().signal, status: () => undefined };
  const opened = (): FeedbackPayload[] => [...box.docs.values()].map((sealed) => JSON.parse(openReport(team.privateKey, sealed).toString('utf8')));
  return { s, tool, ctx, box, opened, service, asked, reclaimed, workspace, setMode: (next: SecurityMode) => { mode = next; } };
}

const result = (output: ToolOutput) => JSON.parse(output.content[0].type === 'text' ? output.content[0].text : '{}') as Record<string, unknown>;

test('feedback.report sends at once: the covered screen and an image file, each within its share; the answer is the report number', async () => {
  const t = setup({ host: true });
  const photo = path.join(t.workspace, 'photo.png');
  writeFileSync(photo, encodePng(white(3000, 1500)));
  const output = await t.tool.run({ kind: 'bug', text: 'The send button hides behind the dock', screen: true, paths: [photo], cover: [
    { image: 'screen', x: 0, y: 0, width: 0.5, height: 0.5 },
    { image: photo, x: 0, y: 0, width: 0.5, height: 0.5 },
  ] }, t.ctx);
  const answer = result(output);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.images, 2, JSON.stringify(answer));
  const [report] = t.service.list();
  assert.equal(report.status, 'sent');
  assert.equal(answer.number, reportNumber(report.receiptId));
  assert.equal(report.imageFileIds?.length, 2);
  assert.deepEqual(t.asked.map((ask) => ask.cover), [[{ x: 0, y: 0, w: 0.5, h: 0.5 }], [{ x: 0, y: 0, w: 0.5, h: 0.5 }]], 'fractions of each image, as given');
  assert.ok(t.asked.every((ask) => ask.maxBytes === imageBudget(2)));
  const [letter] = t.opened();
  assert.equal(letter.images?.length, 2);
  for (const sent of letter.images!) {
    const pixels = decodePng(Buffer.from(sent.base64, 'base64'))!;
    assert.ok(Buffer.from(sent.base64, 'base64').length <= imageBudget(2));
    assert.deepEqual(at(pixels, 0, 0), [0, 0, 0], 'covered');
    assert.deepEqual(at(pixels, pixels.width - 1, pixels.height - 1), [255, 255, 255], 'the rest stays');
  }
  assert.equal(t.reclaimed.length, 2, 'the originals of the screen and the path are queued for clean-up');
});

test('headless: a PNG is covered here; an image that cannot be covered is not sent and the answer says why', async () => {
  const t = setup();
  const jpeg = path.join(t.workspace, 'photo.jpg');
  writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 10, 0, 10, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]));
  const output = await t.tool.run({ kind: 'idea', text: 'Show the dock on top', screen: true, paths: [jpeg], cover: [
    { image: 'screen', x: 0, y: 0, width: 1, height: 0.1 }, { image: jpeg, x: 0, y: 0, width: 0.5, height: 0.5 },
  ] }, t.ctx);
  const answer = result(output);
  assert.equal(answer.ok, true);
  assert.equal(answer.images, 1, JSON.stringify(answer));
  assert.match(String((answer.notSent as string[])[0]), /photo\.jpg" is not sent: its blocks cannot be painted here/);
  const [letter] = t.opened();
  assert.equal(letter.images?.length, 1);
  const screen = decodePng(Buffer.from(letter.images![0].base64, 'base64'))!;
  assert.deepEqual(at(screen, 159, 9), [0, 0, 0]);
  assert.deepEqual(at(screen, 0, 10), [255, 255, 255]);
});

test('a block naming no sent image or reaching past its image, or too many images, refuses before anything is taken or sent', async () => {
  const t = setup({ host: true });
  const stray = await t.tool.run({ kind: 'bug', text: 'Something is off', screen: true, cover: [{ image: 'C:/other.png', x: 0, y: 0, width: 1, height: 1 }] }, t.ctx);
  assert.equal(stray.isError, true);
  assert.match(stray.content[0].type === 'text' ? stray.content[0].text : '', /not among the images I send/);
  const past = await t.tool.run({ kind: 'bug', text: 'Something is off', screen: true, cover: [{ image: 'screen', x: 0.8, y: 0, width: 0.3, height: 0.1 }] }, t.ctx);
  assert.match(past.content[0].type === 'text' ? past.content[0].text : '', /reaches past its image/);
  const many = await t.tool.run({ kind: 'bug', text: 'Something is off', screen: true, paths: ['1', '2', '3', '4', '5', '6'] }, t.ctx);
  assert.match(many.content[0].type === 'text' ? many.content[0].text : '', /at most 6 images; I send 7/);
  assert.equal(t.asked.length, 0);
  assert.equal(t.box.docs.size, 0);
});

test('Secure mode: the tool is in no offer and refuses a call that still arrives; Trust AI mode offers it', async () => {
  const t = setup({ mode: 'secure' });
  const registry = new Registry({ services: () => t.s });
  for (const tool of feedbackTools) registry.register(tool);
  registry.register({ name: 'chat.read', description: 'x', inputSchema: { type: 'object' }, category: 'read', run: async () => ({ content: [] }) } as ToolDef);
  const agent = { id: 'ag_1', name: 'Mira', mode: 'general' } as never;
  const mode = { key: 'general', name: 'General', description: '', skills: [], category: 'general', instructions: '' } as never;
  assert.deepEqual(registry.specsFor(agent, mode).map((spec) => spec.name), ['chat.read']);
  const refused = await t.tool.run({ kind: 'bug', text: 'Something is off' }, t.ctx);
  assert.equal(refused.isError, true);
  assert.equal(t.box.docs.size, 0);
  t.setMode('trust');
  assert.deepEqual(registry.specsFor(agent, mode).map((spec) => spec.name), ['chat.read', FEEDBACK_TOOL]);
  const unreadable = new Registry({ services: () => ({ security: { current: () => { throw new Error('no settings'); } } }) as never });
  for (const tool of feedbackTools) unreadable.register(tool);
  assert.deepEqual(unreadable.specsFor(agent, mode), [], 'a mode that cannot be read counts as Secure');
});

test('texts: the Trust AI standard text tells me feedback reaches the maker with personal data; no Secure text and no mode or skill names it', () => {
  const shipped = (mode: SecurityMode, topic: SecurityTopic) => { try { return readFileSync(path.join(RESOURCES, 'security', mode, `${topic}.md`), 'utf8').replaceAll('{{name}}', 'Ada'); } catch { return ''; } };
  const section = (mode: SecurityMode) => agreementsSection({ security: securityDefaults(mode), name: 'Ada', folder: (m) => `security/${m}`, text: shipped });
  const trust = section('trust');
  assert.match(trust, /feedback\.report; it reaches the developer with everything in it, so I leave out what is private\./);
  assert.doesNotMatch(section('secure'), /feedback|maker/i);
  assert.doesNotMatch(feedbackTools[0].description, /\b(may|allowed|only if|ask before)\b/i);
  assert.match(feedbackTools[0].description, /It reaches the developer with everything in it, personal data included/);
  const mentions: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.md$/.test(name) && readFileSync(file, 'utf8').includes('feedback.report')) mentions.push(path.relative(RESOURCES, file).replaceAll('\\', '/'));
    }
  };
  walk(RESOURCES);
  assert.deepEqual(mentions, ['security/trust/setup.md'], 'only the Trust AI text names the tool');
});

test('the same text within 24 h is counted, not sent again; at most 5 new reports a day; redacted, with the run id', async () => {
  const t = setup({ host: true });
  const file = (text: string, screen = false) => t.tool.run({ kind: 'bug', text, ...(screen ? { screen } : {}) }, t.ctx);
  const first = result(await file('Key sk-proj-AbCdEfGhIjKlMnOpQrStUv123 shows in the log'));
  assert.equal(first.ok, true);
  const [stored] = t.service.list();
  assert.equal(stored.author, 'ag_1');
  assert.equal(stored.context.runId, 'run_1');
  assert.equal(stored.text.includes('sk-proj-AbCd'), false);
  const again = result(await file('  KEY sk-proj-AbCdEfGhIjKlMnOpQrStUv123 shows IN the log ', true));
  assert.match(String(again.note), /Already reported/);
  assert.equal(again.number, first.number);
  assert.equal(t.box.docs.size, 1, 'one letter');
  assert.equal(t.reclaimed.length, 2, 'the repeat\'s screen and its covered copy go to clean-up');
  for (let index = 2; index <= 5; index += 1) assert.equal(result(await file(`Distinct problem number ${index}`)).ok, true);
  const sixth = await file('A sixth distinct problem');
  assert.equal(sixth.isError, true);
  assert.match(sixth.content[0].type === 'text' ? sixth.content[0].text : '', /already filed 5 feedback reports/);
});

test('the person\'s "messages" switch gates it, as it gates the RPC path for the same report', () => {
  const tool = feedbackTools[0];
  assert.equal(tool.category, 'communicate');
  const action = tool.describe!({ kind: 'bug', text: 'Something is off' }, {} as ToolContext);
  assert.deepEqual(needsOf(tool, { kind: 'bug', text: 'Something is off' }, action, { agentId: 'ag_1' }), [{ capability: 'message' }]);
  assert.deepEqual(needsOf(tool, { kind: 'bug', text: 'x', paths: ['C:/shots/a.png'] }, action, { agentId: 'ag_1' }).map((need) => need.capability), ['message', 'read'], 'and a path is read');
});
