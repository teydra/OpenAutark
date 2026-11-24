// Owns: the security topic files (runtime/security/topics.ts): defaults with the person's name, the person's save (a
// text equal to the default removes the file), the change log, an edit on disk taken over in Trust AI mode and put back
// in Secure mode (kept as <topic>.rejected.md), a linked PC's copy accepted before it lands, a file that is no text moved
// aside. Never: the prompt section (agreements.test.ts) or the RPC (security-mode.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SecurityTopics, fillName, topicOfRel } from '../../../src/runtime/security/topics.ts';
import { readSecurityChanges, type LogKv } from '../../../src/runtime/settings/security-log.ts';
import { CRITICAL_TOPICS, MAX_TOPIC_TEXT, SECURE_EXTRA_TOPICS, TRUST_TOPICS, securityDefaults, type SecurityMode } from '../../../src/shared/model/security-settings.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import { clock, tempDir } from '../store/helpers.ts';

const RESOURCES = path.resolve(import.meta.dirname, '../../../resources');
const silent = { debug() {}, info() {}, warn() {}, error() {} } as never;
const PERSON = { kind: 'person', name: 'Ada' } as const;

function rig(mode: SecurityMode = 'trust') {
  const temp = tempDir('wf-topics-');
  const store = new Map<string, unknown>();
  const kv: LogKv = { get: <T>(ns: string, key: string) => store.get(`${ns}/${key}`) as T | undefined, set: (ns, key, value) => { store.set(`${ns}/${key}`, value); } };
  const state = { settings: { profile: { name: 'Ada' }, security: securityDefaults(mode) } as unknown as Settings };
  const time = clock();
  const make = () => new SecurityTopics({ dataDir: temp.dir, resourcesDir: RESOURCES, settings: { get: () => state.settings }, kv, clock: time, log: silent });
  const file = (m: SecurityMode, topic: string) => path.join(temp.dir, 'security', m, `${topic}.md`);
  const write = (m: SecurityMode, topic: string, text: string) => { mkdirSync(path.dirname(file(m, topic)), { recursive: true }); writeFileSync(file(m, topic), text); };
  return { temp, kv, state, time, make, file, write, done: () => temp.cleanup() };
}

test('a topic without a file reads its default with the person\'s name; a topic without a default is empty', () => {
  const h = rig();
  try {
    const topics = h.make();
    const money = topics.list('trust').find((entry) => entry.topic === 'money')!;
    assert.equal(money.isDefault, true);
    assert.match(money.text, /^Money spent is gone\. I spend when Ada asked/);
    assert.ok(!money.text.includes('{{name}}'));
    assert.equal(topics.text('trust', 'team'), '', 'no default for team in Trust AI mode');
    assert.equal(topics.list('secure').length, 14, 'every topic of a mode');
    assert.equal(fillName('Ask {{name}}.', '  '), 'Ask the person.');
    assert.deepEqual(topicOfRel('security/secure/money.md'), { mode: 'secure', topic: 'money' });
    assert.equal(topicOfRel('security/secure/money.rejected.md'), undefined);
    assert.equal(topicOfRel('security/other/money.md'), undefined);
    assert.equal(topicOfRel('security/trust/nonsense.md'), undefined);
  } finally { h.done(); }
});

test('the shipped Trust texts act with a line of report; an irreversible guess is prepared; Secure sends a doubt to the person', () => {
  const h = rig();
  try {
    const topics = h.make();
    const trust = topics.list('trust').filter((entry) => entry.text);
    assert.deepEqual(trust.map((entry) => entry.topic).sort(), ['accounts', 'captcha', 'computer', 'general', 'message', 'money', 'phone', 'publish', 'setup', 'write']);
    for (const { topic, text } of trust) {
      assert.doesNotMatch(text, /\bI ask\b|ask about first|as a draft first|I bring .* first|I show it before|or ask\b/, `${topic}: acting, preparing or a line of report, no asking first`);
      assert.ok(!text.includes('{{name}}'), topic);
    }
    const general = topics.text('trust', 'general');
    assert.match(general, /^I decide and act – that is why Ada chose this mode\./);
    assert.match(general, /can't be undone and rests only on a guess I prepare to the last click/, 'an irreversible guess still stops at the last click');
    assert.match(topics.text('trust', 'money'), /I prepare to the last click and leave to them with the amount and the link\.$/);
    assert.match(topics.text('trust', 'publish'), /goes to Ada as a finished piece before it goes out/, 'a first of a kind goes to the person finished');
    assert.match(topics.text('trust', 'message'), /needs their own word; without it I leave that point open and send the rest/);
    assert.match(topics.text('trust', 'write'), /keep a copy if it may be important\.$/);
    assert.match(topics.text('secure', 'general'), /In this mode a doubt about a step beyond my own work goes to Ada\.$/);
  } finally { h.done(); }
});

// Owner 24.11.2026 (task_nkrfq0dt): the bot-check text reads word for word as he wrote it, in both modes; every topic a
// mode shows has its default, short (at most three sentences), and the hard limits stay in it.
test('the shipped texts: the bot check word for word, every shown topic present and short, the hard limits kept', () => {
  const h = rig();
  try {
    const topics = h.make();
    const BOT = 'I don\'t solve checks like "I\'m not a robot"';
    assert.equal(topics.text('trust', 'captcha'), BOT);
    assert.equal(topics.text('secure', 'captcha'), BOT);
    for (const mode of ['trust', 'secure'] as const) {
      const shown = mode === 'trust' ? TRUST_TOPICS : [...SECURE_EXTRA_TOPICS, ...CRITICAL_TOPICS.secure];
      for (const topic of shown) {
        const text = topics.text(mode, topic);
        assert.ok(text.length > 0, `${mode}/${topic} has a default`);
        assert.ok(!text.includes('{{name}}'), `${mode}/${topic}`);
        const sentences = text.split(/\n\s*\n/).flatMap((part) => part.split(/(?<=[.!?])\s+(?=[A-Z{])/)).filter((s) => s.trim());
        assert.ok(sentences.length <= 3, `${mode}/${topic}: ${sentences.length} sentences`);
      }
    }
    assert.match(topics.text('trust', 'money'), /full price, including anything that repeats/, 'money: the full price, repeats included');
    assert.match(topics.text('trust', 'message'), /a date, a price, a promise – needs their own word/, 'messages: no new commitment without the person');
    assert.match(topics.text('trust', 'accounts'), /Passwords and codes stay out of chats, files and logs\./, 'accounts: no values in texts');
    assert.match(topics.text('secure', 'accounts'), /Passwords and codes stay out of chats, files and logs\./);
    assert.match(topics.text('secure', 'money'), /^Spending money is closed in this company/);
  } finally { h.done(); }
});

test('the person\'s save writes the file and is logged; the default text again (or null) removes it', () => {
  const h = rig();
  try {
    const topics = h.make();
    const saved = topics.save('trust', 'money', '  Up to 50 EUR I buy what the job needs.\r\n', PERSON);
    assert.deepEqual(saved, { topic: 'money', text: 'Up to 50 EUR I buy what the job needs.', isDefault: false });
    assert.equal(readFileSync(h.file('trust', 'money'), 'utf8'), 'Up to 50 EUR I buy what the job needs.\n');
    const [entry] = readSecurityChanges(h.kv);
    assert.equal(entry?.field, 'security/trust/money.md');
    assert.deepEqual(entry?.by, PERSON);
    assert.match(entry!.from, /^\(default\) Money spent is gone/);
    const back = topics.save('trust', 'money', topics.defaultText('trust', 'money'), PERSON);
    assert.equal(back.isDefault, true, 'the default text again: no file of its own');
    assert.equal(existsSync(h.file('trust', 'money')), false);
    topics.save('trust', 'captcha', '', PERSON);
    assert.equal(topics.text('trust', 'captcha'), '', 'an empty text is a choice too: nothing for this topic');
    topics.save('trust', 'captcha', null, PERSON);
    assert.match(topics.text('trust', 'captcha'), /I'm not a robot/);
    const count = readSecurityChanges(h.kv).length;
    topics.save('trust', 'captcha', null, PERSON);
    assert.equal(readSecurityChanges(h.kv).length, count, 'a save that changes nothing writes nothing');
    assert.throws(() => topics.save('trust', 'general', 'x'.repeat(MAX_TOPIC_TEXT + 1), PERSON), /at most/);
    assert.throws(() => topics.save('trust', 'general', 'bell \u0007', PERSON), /plain text/);
  } finally { h.done(); }
});

test('Trust AI mode: an edit on disk is taken over and logged as an edit of the file', () => {
  const h = rig('trust');
  try {
    const topics = h.make();
    h.write('trust', 'publish', 'I post what Ada drafted, nothing else.\n');
    topics.reconcile();
    assert.equal(topics.text('trust', 'publish'), 'I post what Ada drafted, nothing else.');
    const [entry] = readSecurityChanges(h.kv);
    assert.equal(entry?.field, 'security/trust/publish.md');
    assert.equal(entry?.by.kind, 'other');
    assert.match(entry!.by.name, /edit of the file/);
    topics.reconcile();
    assert.equal(readSecurityChanges(h.kv).length, 1, 'looked at again: nothing new');
  } finally { h.done(); }
});

test('FX1 H4: in Trust AI mode an edit of a Secure text is put back (it would rule after a switch); isAccepted says what the app holds', () => {
  const h = rig('trust');
  try {
    const topics = h.make();
    h.write('secure', 'money', 'Spend what you like.\n');
    assert.equal(topics.isAccepted('security/secure/money.md', 'Spend what you like.'), false, 'not looked at yet: not the app\'s');
    topics.reconcile();
    assert.equal(existsSync(h.file('secure', 'money')), false, 'the new file goes again');
    assert.equal(readFileSync(path.join(h.temp.dir, 'security', 'secure', 'money.rejected.md'), 'utf8').trim(), 'Spend what you like.');
    assert.equal(topics.text('secure', 'money'), topics.defaultText('secure', 'money'));
    assert.equal(topics.isAccepted('security/secure/money.md', null), true);
    h.write('trust', 'publish', 'I post drafts only.\n');
    topics.reconcile();
    assert.equal(topics.isAccepted('security/trust/publish.md', 'I post drafts only.\r\n'), true, 'a Trust text taken over is the app\'s');
    assert.equal(topics.isAccepted('security/trust/publish.md', 'Something else'), false);
    assert.equal(topics.isAccepted('security/trust/publish.rejected.md', 'I post drafts only.'), false, 'no topic file');
  } finally { h.done(); }
});

test('Secure mode: an edit on disk is put back and kept as <topic>.rejected.md; a removed file comes back; a new file goes', () => {
  const h = rig('secure');
  try {
    const topics = h.make();
    topics.save('secure', 'money', 'Nothing is bought here.', PERSON);
    h.write('secure', 'money', 'Buy whatever helps.\n');
    rmSync(h.file('secure', 'general'), { force: true });
    h.write('secure', 'commands', 'Every command is fine.\n'); // a file the app never had
    topics.reconcile();
    assert.equal(readFileSync(h.file('secure', 'money'), 'utf8'), 'Nothing is bought here.\n');
    assert.equal(readFileSync(path.join(path.dirname(h.file('secure', 'money')), 'money.rejected.md'), 'utf8'), 'Buy whatever helps.\n');
    assert.equal(existsSync(h.file('secure', 'commands')), false, 'the new file is removed again');
    assert.equal(topics.text('secure', 'commands'), '');
    rmSync(h.file('secure', 'money'));
    topics.reconcile();
    assert.equal(topics.text('secure', 'money'), 'Nothing is bought here.', 'a deleted text is written again');
    h.write('trust', 'money', 'Trust texts are closed in Secure mode too.\n');
    topics.reconcile();
    assert.equal(existsSync(h.file('trust', 'money')), false, 'both folders are the person\'s in Secure mode');
    assert.equal(readSecurityChanges(h.kv).filter((entry) => entry.by.kind === 'other').length, 0, 'nothing was taken over');
  } finally { h.done(); }
});

test('Secure mode: a linked PC\'s copy is accepted before it lands, so it stays; the first look takes what is there', () => {
  const h = rig('secure');
  try {
    h.write('secure', 'general', 'Written before this version.\n');
    const topics = h.make();
    assert.equal(topics.text('secure', 'general'), 'Written before this version.', 'the first look records, puts nothing back');
    topics.acceptSynced('security/secure/general.md', 'Changed on my other PC.\r\n');
    h.write('secure', 'general', 'Changed on my other PC.\n');
    topics.reconcile();
    assert.equal(topics.text('secure', 'general'), 'Changed on my other PC.');
    assert.equal(readSecurityChanges(h.kv)[0]?.by.name, 'A linked PC');
    topics.acceptSynced('security/secure/general.md', null);
    rmSync(h.file('secure', 'general'));
    topics.reconcile();
    assert.equal(existsSync(h.file('secure', 'general')), false, 'a removal there stays a removal');
    topics.acceptSynced('agents/x/SYSTEM.md', 'ignored');
  } finally { h.done(); }
});

test('a file that is no text is moved aside in either mode and the accepted text stands', () => {
  const h = rig('trust');
  try {
    const topics = h.make();
    h.write('trust', 'phone', 'bad\u0000bytes');
    topics.reconcile();
    assert.equal(existsSync(path.join(path.dirname(h.file('trust', 'phone')), 'phone.rejected.md')), true);
    assert.equal(existsSync(h.file('trust', 'phone')), false);
    assert.match(topics.text('trust', 'phone'), /Ada's phone is personal/);
  } finally { h.done(); }
});
