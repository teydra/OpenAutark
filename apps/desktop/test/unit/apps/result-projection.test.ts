// Synthetic MCP wire → Apps → Registry → model-facing output, SQLite journal and projection.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readdirSync } from 'node:fs';
import { Apps } from '../../../src/runtime/apps/service.ts';
import { appsKv } from '../../../src/runtime/apps/index.ts';
import { connectMcp } from '../../../src/runtime/apps/client/index.ts';
import { parseResultProjections } from '../../../src/runtime/apps/result-projection.ts';
import { appToolNames } from '../../../src/runtime/apps/tools.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { ctxFor, setup } from '../tools/helpers.ts';
import { appsFixture } from './service-fakes.ts';

const RAW = 'SYNTH_RAW_62JA', PERSON = 'SYNTH_PERSON_76MF', COMPANY = 'SYNTH_COMPANY_95LK', ERROR = 'SYNTH_ERROR_21GH';
const policy = { search: { rowsField: 'matches', fields: ['company', 'active'] } };
const tool = { name: 'search', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } };
const leak = new RegExp([RAW, PERSON, COMPANY, ERROR].join('|'));

function response(n = 1) {
  return {
    content: [
      { type: 'text', text: RAW.repeat(2600) },
      { type: 'image', mimeType: 'image/png', data: Buffer.from(PERSON).toString('base64') },
      { type: 'resource_link', uri: 'https://example.invalid/' + RAW },
    ],
    structuredContent: { ignored: RAW, matches: Array.from({ length: n }, () => ({ company: COMPANY, active: true, person: PERSON, details: { other: RAW } })) },
  };
}

async function fixture(t: TestContext) {
  const h = setup(), f = appsFixture();
  const registry = new Registry({ services: () => h.services });
  const log: unknown[] = [], blobs: string[] = [];
  h.services.files = { put: (bytes: Uint8Array) => { blobs.push(Buffer.from(bytes).toString('utf8')); throw new Error('Unexpected blob write'); } } as unknown as typeof h.services.files;
  h.services.log = { warn: (...args: unknown[]) => log.push(args), info: (...args: unknown[]) => log.push(args) } as unknown as typeof h.services.log;
  const journal = new Journal({ db: h.db, bus: h.bus, clock: h.clock, keepOutput: async (body) => { blobs.push(body); return undefined; } });
  h.services.runs = journal;
  const { services: _services, ...ctx } = ctxFor(h);
  journal.start({ id: ctx.runId, agentId: ctx.agent.id, conversationId: h.chat.id, trigger: 'manual' });
  const kv = appsKv(h);
  let next: () => unknown | Promise<unknown> = () => ({ result: response() });
  let providerCalls = 0;
  let listFails: (() => Response) | undefined;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const msg = JSON.parse(String(init?.body)) as { id?: string; method: string };
    if (msg.id === undefined) return new Response(null, { status: 202 });
    if (msg.method === 'tools/list' && listFails) return listFails();
    const answer = msg.method === 'initialize' ? { result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'Synthetic', version: '1' } } }
      : msg.method === 'tools/list' ? { result: { tools: [tool, { ...tool, name: 'other' }, { ...tool, name: 'Search' }] } }
      : (++providerCalls, await next());
    return Response.json({ jsonrpc: '2.0', id: msg.id, ...(answer as object) });
  };
  const apps = new Apps({ ...f.deps, kv, services: { ...f.deps.services, tools: registry, settings: h.settings, log: h.services.log },
    connect: (target, opts) => connectMcp(target, { ...opts, fetch }) });
  const write = (resultProjection: unknown = policy) => {
    f.data.write('mcp.json', { mcpServers: { example: { url: 'https://example.invalid/mcp', resultProjection } } });
    f.changedFile();
  };
  t.after(async () => { await apps.stop(); rmSync(f.data.dir, { recursive: true, force: true }); h.db.close(); });
  write();
  apps.start();
  await apps.idle();
  const call = (id: string, name = 'search') => registry.call('app.example.' + name, {}, ctx, id);
  const callAs = (full: string) => registry.call(full, {}, ctx, 'exact');
  const noLeaks = (outputs: unknown[]) => {
    const rows = journal.items(ctx.runId);
    assert.ok(rows.some((item) => item.kind === 'tool_result'));
    assert.doesNotMatch(JSON.stringify([outputs, rows, log]), leak);
    assert.deepEqual(blobs, []);
    assert.deepEqual(readdirSync(f.data.dir), ['connectors']);
  };
  return { h, apps, kv, log, call, callAs, noLeaks, failList: (make: () => Response) => { listFails = make; }, write, calls: () => providerCalls,
    answer: (answer: typeof next) => { next = answer; }, enable: () => h.settings.update({ apps: { resultProjection: true } }) };
}

test('large and zero-hit results store only approved scalars and no markers reach downstream sinks', async (t) => {
  const f = await fixture(t);
  assert.equal(f.h.settings.get().apps?.resultProjection, false);
  f.enable();
  f.answer(() => ({ result: response(1800) }));
  const modelInput = await f.call('large');
  const out = modelInput.structured as { status: string; count: number; reference: string };
  assert.match(out.reference, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(out, { status: 'ok', count: 1800, reference: out.reference });
  assert.deepEqual(modelInput.content, [{ type: 'text', text: JSON.stringify(out) }]);
  assert.deepEqual(f.kv.get('projection:' + out.reference), Array.from({ length: 1800 }, () => ({ company: COMPANY, active: true })));
  f.answer(() => ({ result: response(0) }));
  const zero = (await f.call('zero')).structured as typeof out;
  assert.equal(zero.count, 0);
  assert.notEqual(zero.reference, out.reference);
  assert.deepEqual(f.kv.get('projection:' + zero.reference), []);
  f.noLeaks([modelInput, zero]);
  assert.doesNotMatch(JSON.stringify(f.h.db.all('SELECT value FROM kv WHERE key NOT LIKE ?', ['projection:%'])), leak);
});

test('transport, protocol, provider, projection and storage errors do not echo or persist payloads', async (t) => {
  const f = await fixture(t);
  f.enable();
  const results = [];
  for (const [index, answer] of [
    () => { throw new Error(ERROR); },
    () => ({ error: { code: -32000, message: ERROR, data: response() } }),
    () => ({ result: { ...response(), isError: true } }),
    () => ({ result: { content: [{ type: 'text', text: RAW }], structuredContent: { matches: [{ company: COMPANY }, { company: { nested: PERSON } }] } } }),
    () => ({ result: { ...response(), structuredContent: { matches: [{ person: PERSON }] } } }),
    () => ({ result: response(10_001) }),
    // no rowsField, no structuredContent (text only), a non-array rowsField, a non-object body: nothing falls back to content
    () => ({ result: { content: [{ type: 'text', text: RAW }], structuredContent: { ignored: RAW, other: [{ company: COMPANY }] } } }),
    () => ({ result: { content: [{ type: 'text', text: JSON.stringify({ matches: [{ company: COMPANY }] }) + RAW }] } }),
    () => ({ result: { content: [], structuredContent: { matches: { company: COMPANY } } } }),
    () => ({ result: { content: [{ type: 'text', text: RAW }], structuredContent: [{ company: COMPANY }] } }),
    () => ({ result: { content: [], structuredContent: { matches: [{ company: COMPANY }, PERSON] } } }),
  ].entries()) {
    f.answer(answer);
    const result = await f.call('err-' + index);
    assert.equal(result.isError, true);
    assert.deepEqual(result.structured, { status: 'error' });
    results.push(result);
  }
  f.answer(() => ({ result: response() }));
  const set = f.kv.set;
  f.kv.set = (key, value) => { if (key.startsWith('projection:')) throw new Error(ERROR + JSON.stringify(value)); set(key, value); };
  const storeError = await f.call('store');
  assert.deepEqual(storeError.structured, { status: 'error' });
  const calls = f.calls();
  const undeclared = await f.call('undeclared', 'other');
  assert.deepEqual(undeclared.structured, { status: 'blocked' });
  f.write({ search: { rowsField: 'matches', fields: ['company', 'company'] } });
  await f.apps.idle();
  const invalid = await f.call('invalid');
  assert.deepEqual(invalid.structured, { status: 'blocked' });
  assert.equal(f.calls(), calls, 'refusals never reach provider');
  assert.deepEqual(f.kv.keys('projection:'), []);
  f.noLeaks([results, storeError, undeclared, invalid]);
});

test('legacy output is unchanged with the setting off and cannot be replayed after opt-in', async (t) => {
  const f = await fixture(t);
  f.answer(() => ({ result: { content: [{ type: 'text', text: RAW }] } }));
  const legacy = await f.call('same');
  assert.match(JSON.stringify(legacy), /SYNTH_RAW/);
  f.enable();
  const replay = await f.call('same');
  assert.equal(replay.isError, true);
  assert.doesNotMatch(JSON.stringify(replay), leak);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.kv.keys('projection:'), []);
});

test('a reply cannot fall back to legacy output if the company opts in while awaiting the provider', async (t) => {
  const f = await fixture(t);
  const reached = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<unknown>();
  f.answer(() => { reached.resolve(); return complete.promise; });
  const pending = f.call('in-flight');
  await reached.promise;
  f.enable();
  complete.resolve({ result: response() });
  const output = await pending;
  assert.deepEqual(output.structured, { status: 'error' });
  assert.deepEqual(f.kv.keys('projection:'), []);
  f.noLeaks([output]);
});

test('policy rejects wildcard, duplicate, inherited or prototype-mutating structural keys', () => {
  for (const fields of [['*'], ['company', 'company'], ['__proto__'], ['constructor']]) {
    assert.equal(parseResultProjections({ search: { rowsField: 'matches', fields } }), null);
  }
  assert.equal(parseResultProjections({ search: Object.create(policy.search) }), null);
  assert.equal(parseResultProjections({ search: { ...policy.search, extra: true } }), null);
});

test('a protected call cannot persist under a replaced connector policy', async (t) => {
  const f = await fixture(t);
  f.enable();
  const reached = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<unknown>();
  f.answer(() => { reached.resolve(); return complete.promise; });
  const pending = f.call('replaced');
  await reached.promise;
  f.write({ search: { rowsField: 'matches', fields: ['active'] } });
  complete.resolve({ result: response() });
  const output = await pending;
  assert.deepEqual(output.structured, { status: 'error' });
  assert.deepEqual(f.kv.keys('projection:'), []);
  f.noLeaks([output]);
});

test('a policy applies to the exact MCP name, not to a tool that only shares its registered name', async (t) => {
  const f = await fixture(t);
  f.enable();
  const names = appToolNames('example', ['search', 'Search']);
  assert.notEqual(names.get('Search'), names.get('search'));
  const calls = f.calls();
  const sibling = await f.callAs(names.get('Search')!);
  assert.deepEqual(sibling.structured, { status: 'blocked' });
  assert.equal(f.calls(), calls, 'a tool without its own policy never reaches the provider');
  f.noLeaks([sibling]);
});

test('a protected connector that fails to connect shows no provider text in its status or the log', async (t) => {
  const f = await fixture(t);
  f.enable();
  for (const make of [
    () => new Response(ERROR + RAW, { status: 500, headers: { 'content-type': 'text/plain' } }),
    () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: ERROR, data: response() } }),
  ]) {
    f.failList(make);
    const app = await f.apps.reconnect('example');
    assert.equal(app.status, 'error');
    assert.doesNotMatch(JSON.stringify([app, f.apps.list()]), leak);
  }
  assert.doesNotMatch(JSON.stringify(f.log), leak);
});

test('a provider that answers with one JSON text block is projected like structuredContent; nothing else of it is kept', async (t) => {
  const f = await fixture(t);
  f.enable();
  const body = { ignored: RAW, matches: [{ company: COMPANY, active: false, person: PERSON, details: { other: RAW } }] };
  f.answer(() => ({ result: { content: [{ type: 'text', text: JSON.stringify(body) }] } }));
  const ok = (await f.call('text-only')).structured as { status: string; count: number; reference: string };
  assert.deepEqual({ status: ok.status, count: ok.count }, { status: 'ok', count: 1 });
  assert.deepEqual(f.kv.get('projection:' + ok.reference), [{ company: COMPANY, active: false }]);
  // a present but invalid structuredContent never falls back to the text, nor does a second block or a broken JSON
  const bad = [
    { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: { matches: [{ person: PERSON }] } },
    { content: [{ type: 'text', text: JSON.stringify(body) }, { type: 'text', text: RAW }] },
    { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from(JSON.stringify(body)).toString('base64') }] },
    { content: [{ type: 'text', text: JSON.stringify(body).slice(0, -2) }] },
    { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true },
  ];
  const results = [];
  for (const [index, result] of bad.entries()) {
    f.answer(() => ({ result }));
    const out = await f.call('text-bad-' + index);
    assert.deepEqual(out.structured, { status: 'error' }, 'case ' + index);
    results.push(out);
  }
  assert.equal(f.kv.keys('projection:').length, 1);
  f.noLeaks([ok, results]);
});