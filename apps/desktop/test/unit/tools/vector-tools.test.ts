// vector.embed and vector.search as tools: found through tools.find (no core tool), offered in every mode with or without an
// embedding model (20.11.2026: meaning is a ranking inside the one word search – without a model the word hits come with one
// line saying so), short specs; vector.search routes memory places to the knowledge search and added files to services.vectors,
// merges by score and lets the best hits' own texts search on (hops); plain result texts; models-uses knows the use.
// Owns: these assertions only. Never: real models.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup } from './helpers.ts';
import { BASE_CORE } from '../../../src/runtime/tools/core-sets.ts';
import { builtinTools, registerBuiltinTools } from '../../../src/runtime/tools/builtin/index.ts';
import { moreToolsSection } from '../../../src/runtime/tools/builtin/tools-meta.ts';
import { searchByMeaning } from '../../../src/runtime/tools/builtin/vector-search.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { ModeLibrary } from '../../../src/runtime/modes/service.ts';
import { NO_MODEL } from '../../../src/runtime/vectors/meaning.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { KnowledgeHit, KnowledgeQuery } from '../../../src/shared/model/knowledge.ts';
import type { VectorSearchInput } from '../../../src/shared/model/vectors.ts';
import { chosenFor, OFFABLE_USES, servesUse, useValue } from '../../../src/shared/model/models-uses.ts';

const tools = builtinTools();
const find = (name: string) => {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `${name} is registered`);
  return tool;
};
const textOf = (output: ToolOutput) => output.content.map((part) => ('text' in part ? part.text : '')).join('');
const note = (id: string, title: string, body: string, score: number) => ({ item: { id, title, body }, score, why: '' }) as unknown as KnowledgeHit;

function services(over: { chosen?: boolean; notes?: (query: KnowledgeQuery) => KnowledgeHit[]; files?: (input: VectorSearchInput) => Awaited<ReturnType<RuntimeServices['vectors']['search']>> }) {
  const asked: { notes: KnowledgeQuery[]; files: VectorSearchInput[] } = { notes: [], files: [] };
  const s = {
    vectors: {
      available: () => over.chosen === true,
      search: async (input: VectorSearchInput) => { asked.files.push(input); return over.files?.(input) ?? { hits: [], searched: { places: input.in, embeddedFiles: 0 } }; },
    },
    knowledge: { search: async (query: KnowledgeQuery) => { asked.notes.push(query); return over.notes?.(query) ?? []; } },
    paths: { data: 'C:/data', workspace: process.cwd() },
  } as unknown as RuntimeServices;
  return { s, asked };
}

const ctx = (s: RuntimeServices) => ({ services: s, agent: { id: 'ag_a' } }) as unknown as ToolContext;

test('both tools are on demand, in every mode, with a short spec, and work without a chosen model', () => {
  for (const name of ['vector.embed', 'vector.search']) {
    const tool = find(name);
    assert.ok(!(name in BASE_CORE));
    assert.equal(tool.modes, undefined);
    assert.equal(tool.requires, undefined);
    const size = tool.description.length + JSON.stringify(tool.inputSchema).length;
    assert.ok(size < 800, `${name} spec is ${size} characters`);
  }
});

test('without a chosen model both are offered on demand; vector.search answers with the word hits and one line saying so', async () => {
  const h = setup();
  const base = h.services as RuntimeServices;
  base.modes = new ModeLibrary({ resources: path.resolve('resources'), clock: h.clock }) as unknown as RuntimeServices['modes'];
  const { s } = services({ notes: () => [note('company:a.md', 'Invoice rule', 'On the 3rd.', 1)] });
  base.vectors = s.vectors;
  base.knowledge = s.knowledge;
  base.paths = { ...base.paths, data: 'C:/data' };
  const registry = new Registry({ services: () => base });
  base.tools = registry;
  registerBuiltinTools(registry);
  const mode = base.modes.get('general');
  const offered = registry.specsFor(h.tom, mode).map((spec) => spec.name);
  assert.ok(offered.includes('vector.search') && offered.includes('vector.embed'));
  const list = moreToolsSection(registry.specsFor(h.tom, mode), new Set(['tools.call']));
  assert.doesNotMatch(list, /vector\.(embed|search) –/);
  assert.match(list, /other tools .* with tools\.find/);
  const baseCtx = { agent: h.tom, runId: 'run_1', mode: 'general', signal: new AbortController().signal, status: () => {} };
  for (const name of ['vector.search', 'vector.embed']) {
    const found = await registry.call('tools.find', { query: name }, baseCtx, 'find-' + name);
    assert.ok(textOf(found).startsWith(name + ' – '), textOf(found));
    assert.match(textOf(found), /Arguments: .*tools\.call/s);
  }
  const ran = await registry.call('tools.call', { name: 'vector.search', args: { query: 'invoice', in: ['memory'] } }, baseCtx, 'c1');
  assert.equal(ran.isError, undefined, textOf(ran));
  const body = textOf(ran);
  assert.ok(body.startsWith(NO_MODEL), body);
  assert.match(body, /^1 hits\.$/m);
  assert.match(body, /1\.00 memory\/company\/a\.md\n {2}Invoice rule: On the 3rd\./);
});

test('vector.search: memory places go to the knowledge search, files to services.vectors, merged by score; no count of what is stored', async () => {
  const { s, asked } = services({
    chosen: true,
    notes: () => [note('company:a.md', 'Invoice rule', 'the  invoice', 0.612)],
    files: (input) => ({ hits: [{ path: 'C:/work/notes/b.md', chunk: 2, lines: [2, 9], snippet: 'invoice b', score: 1 }], searched: { places: input.in, embeddedFiles: 4 }, note: 'Some of these files changed since vector.embed read them; vector.embed reads them again.' }),
  });
  const body = textOf(await find('vector.search').run({ query: ' invoice ', in: ['memory/company', 'C:/work/notes'], limit: 3 }, ctx(s)));
  assert.deepEqual(asked.notes.map((query) => [query.text, query.folders, query.limit]), [['invoice', ['memory/company'], 3]]);
  assert.equal(asked.files[0].in.length, 1);
  assert.equal(asked.files[0].k, 3);
  assert.match(body, /changed since vector\.embed read them/);
  assert.doesNotMatch(body, /No embedding model/);
  assert.doesNotMatch(body, /embedded files|4 files/, 'no count of what is stored in any context');
  assert.match(body, /^2 hits\.\n1\.00 C:\/work\/notes\/b\.md:2-9\n {2}invoice b\n0\.61 memory\/company\/a\.md\n {2}Invoice rule: the invoice/m);
  assert.match(body, /memory\/ is /);
});

test('hops: the best hits\' own texts search on; a hit found so scores the product along its path and names it', async () => {
  const { s } = services({
    chosen: true,
    notes: (query) => (query.text === 'invoice'
      ? [note('company:a.md', 'Invoice rule', 'Invoices go out on the 3rd.', 1)]
      : [note('company:a.md', 'Invoice rule', 'Invoices go out on the 3rd.', 1), note('company:b.md', 'Third', 'The 3rd is the deadline for the bank.', 0.6), note('company:c.md', 'Far', 'loose', 0.2)]),
  });
  const plain = await searchByMeaning(s, undefined, { query: 'invoice', in: ['memory'] });
  assert.deepEqual(plain.hits.map((hit) => hit.path), ['memory/company/a.md']);
  const hopped = await searchByMeaning(s, undefined, { query: 'invoice', in: ['memory'], hops: 1 });
  assert.deepEqual(hopped.hits.map((hit) => [hit.path, hit.score, hit.via]), [['memory/company/a.md', 1, undefined], ['memory/company/b.md', 0.6, 'memory/company/a.md']]);
});

test('vector.embed reports counts, what was left out, when to call again and what still gets its meaning', async () => {
  const { s } = services({});
  Object.assign(s.vectors, {
    embed: async (paths: string[]) => {
      assert.equal(paths.length, 1);
      return { embedded: 2, reembedded: 1, unchanged: 3, skipped: [{ path: 'x/node_modules', reason: 'dependencies, caches or app data' }], remaining: 5, waiting: 7 };
    },
  });
  const body = textOf(await find('vector.embed').run({ paths: ['C:/work'] }, ctx(s)));
  assert.match(body, /Added 2, read again 1, already added 3/);
  assert.match(body, /x\/node_modules: dependencies/);
  assert.match(body, /5 files not finished: call vector\.embed again/);
  assert.match(body, /7 pieces get their meaning in the background; their words are found already/);
});

test('the use: auto by default, can be off, knows embedding models by name', () => {
  assert.equal(useValue({}, 'embeddings'), 'auto');
  assert.equal(useValue({ embeddings: 'off' }, 'embeddings'), 'off');
  assert.equal(chosenFor({ embeddings: 'ollama:bge-m3' }, 'embeddings'), 'ollama:bge-m3');
  assert.ok(OFFABLE_USES.has('embeddings'));
  const model = (name: string) => ({ model: name, functions: [], strengths: {} });
  assert.ok(servesUse(model('nomic-embed-text'), 'embeddings'));
  assert.ok(servesUse(model('bge-m3:latest'), 'embeddings'));
  assert.ok(servesUse(model('BAAI/bge-m3'), 'embeddings'));
  assert.ok(!servesUse(model('jina-reranker-embed'), 'embeddings'));
  assert.ok(!servesUse(model('gpt-6'), 'embeddings'));
});
