// Runs the Firestore rules of the feedback project (apps/desktop/resources/feedback/firestore.rules) against the
// Firestore emulator: the feedback mailbox must behave as before and the anonymous counters (dl/, use/) must accept
// exactly "+1 on a field named in the rules, for today and – for use/ – the current UTC hour" and nothing else.
// Needs Java 21+ and the Firebase CLI; run it through `node services/firestore-rules/run.mjs`.
// Prints one PASS/FAIL line per case.
const PORT = process.env.FIRESTORE_EMULATOR_PORT || '18080';
const project = process.env.GCLOUD_PROJECT || 'demo-autark';
const docs = `projects/${project}/databases/(default)/documents`;
const base = `http://127.0.0.1:${PORT}/v1/${docs}`;
const json = { 'content-type': 'application/json' };
const sealed = (n) => Buffer.alloc(n, 7).toString('base64');
const v1 = { integerValue: '1' };
const unsigned = (claims) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: 'x', aud: project, user_id: 'u1', sub: 'u1', ...claims })).toString('base64url')}.`;
const OWNER = 'owner@example.test';
const ownerToken = unsigned({ email: OWNER, email_verified: true });

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const today = dayOf(now);
const yesterday = dayOf(new Date(now.getTime() - 864e5));
const hour = now.getUTCHours();
const HH = pad(hour);
const otherHH = pad((hour + 1) % 24);

// One write: add `by` to each field of the document (what the site and the app send).
const addEach = async (path, byField, headers = {}) => {
  const res = await fetch(`${base}:commit`, {
    method: 'POST', headers: { ...json, ...headers },
    body: JSON.stringify({ writes: [{ transform: { document: `${docs}/${path}`, fieldTransforms: Object.entries(byField).map(([f, by]) => ({ fieldPath: f, increment: { integerValue: String(by) } })) } }] }),
  });
  return res.status;
};
const add = (path, fields, by = 1, headers = {}) => addEach(path, Object.fromEntries(fields.map((f) => [f, by])), headers);
const get = async (path, headers = {}) => (await fetch(`${base}/${path}`, { headers })).status;
// The emulator accepts "Bearer owner" as its admin, which bypasses the rules: used only to read back values.
const value = async (path, field) => {
  const res = await fetch(`${base}/${path}`, { headers: { authorization: 'Bearer owner' } });
  const j = await res.json();
  return Number(j.fields?.[field]?.integerValue ?? 0);
};
const create = async (id, fields) => (await fetch(`${base}/feedback?documentId=${encodeURIComponent(id)}&mask.fieldPaths=v`, { method: 'POST', headers: json, body: JSON.stringify({ fields }) })).status;
const patch = async (path, fields, headers = {}) => (await fetch(`${base}/${path}?${Object.keys(fields).map((f) => `updateMask.fieldPaths=${f}`).join('&')}`, { method: 'PATCH', headers: { ...json, ...headers }, body: JSON.stringify({ fields }) })).status;
const del = async (path) => (await fetch(`${base}/${path}`, { method: 'DELETE' })).status;

const dl = (platform, day = today) => `dl/${day}_${platform}`;
const use = (platform, hh = HH, day = today) => `use/${day}-${platform}-${hh}`;
const as = (claims) => ({ authorization: `Bearer ${unsigned(claims)}` });

// The owner list the rules read (admin/owners); in the live project the service account writes it.
const seed = await fetch(`${base}/admin/owners?updateMask.fieldPaths=emails`, { method: 'PATCH', headers: { ...json, authorization: 'Bearer owner' }, body: JSON.stringify({ fields: { emails: { arrayValue: { values: [{ stringValue: OWNER }] } } } }) });
if (!seed.ok) { console.log(`FAIL could not seed admin/owners: ${seed.status}`); process.exit(1); }

const cases = [
  // ── feedback mailbox: unchanged ──
  ['feedback: v + sealed', () => create('11111111-1111-4111-8111-111111111111', { v: v1, sealed: { bytesValue: sealed(1000) } }), 200],
  ['feedback: with exp 30 d', () => create('22222222-2222-4222-8222-222222222222', { v: v1, sealed: { bytesValue: sealed(1000) }, exp: { timestampValue: new Date(Date.now() + 30 * 864e5).toISOString() } }), 200],
  ['feedback: exp 40 d', () => create('33333333-3333-4333-8333-333333333333', { v: v1, sealed: { bytesValue: sealed(10) }, exp: { timestampValue: new Date(Date.now() + 40 * 864e5).toISOString() } }), 403],
  ['feedback: extra field', () => create('66666666-6666-4666-8666-666666666666', { v: v1, sealed: { bytesValue: sealed(10) }, note: { stringValue: 'x' } }), 403],
  ['feedback: id with a dot', () => create('bad.id', { v: v1, sealed: { bytesValue: sealed(10) } }), 403],
  ['feedback: sealed 1 MB', () => create('88888888-8888-4888-8888-888888888888', { v: v1, sealed: { bytesValue: sealed(1000000) } }), 403],
  ['feedback: public list', () => get('feedback'), 403],
  ['feedback: public get', () => get('feedback/11111111-1111-4111-8111-111111111111'), 403],
  ['feedback: public delete', () => del('feedback/11111111-1111-4111-8111-111111111111'), 403],
  ['feedback: public overwrite', () => patch('feedback/11111111-1111-4111-8111-111111111111', { v: v1, sealed: { bytesValue: sealed(5) } }), 403],
  ['feedback: the owner cannot read either', () => get('feedback', { authorization: `Bearer ${ownerToken}` }), 403],

  // ── download counters ──
  ['dl: first click today creates n = 1', () => add(dl('windows'), ['n']), 200],
  ['dl: n is 1', () => value(dl('windows'), 'n'), 1],
  ['dl: second click adds 1', () => add(dl('windows'), ['n']), 200],
  ['dl: n is 2', () => value(dl('windows'), 'n'), 2],
  ['dl: +2 is refused', () => add(dl('windows'), ['n'], 2), 403],
  ['dl: -1 is refused', () => add(dl('windows'), ['n'], -1), 403],
  ['dl: a new counter may not start at 5', () => add(dl('linux'), ['n'], 5), 403],
  ['dl: another field is refused', () => add(dl('mac'), ['m']), 403],
  ['dl: a second field next to n is refused', () => add(dl('mac'), ['n', 'm']), 403],
  ['dl: yesterday is refused', () => add(dl('windows', yesterday), ['n']), 403],
  ['dl: another platform name is refused', () => add(dl('ios'), ['n']), 403],
  ['dl: android, android-full, mac, mac-zip, linux are accepted', async () => [await add(dl('android'), ['n']), await add(dl('android-full'), ['n']), await add(dl('mac'), ['n']), await add(dl('mac-zip'), ['n']), await add(dl('linux'), ['n'])].join(','), '200,200,200,200,200'],
  ['dl: a path outside the pattern is refused', () => add(`dl/${today}_windows_x`, ['n']), 403],
  ['dl: overwrite with a smaller number is refused', () => patch(dl('windows'), { n: { integerValue: '1' } }), 403],
  ['dl: overwrite with a bigger number is refused', () => patch(dl('windows'), { n: { integerValue: '9' } }), 403],
  ['dl: delete is refused', () => del(dl('windows')), 403],
  ['dl: anonymous get is refused', () => get(dl('windows')), 403],
  ['dl: anonymous list is refused', () => get('dl'), 403],
  ['dl: a signed-in stranger cannot read', () => get(dl('windows'), as({ email: 'someone@example.com', email_verified: true })), 403],
  ['dl: an unverified owner address cannot read', () => get(dl('windows'), as({ email: OWNER, email_verified: false })), 403],
  ['dl: the owner reads one counter', () => get(dl('windows'), { authorization: `Bearer ${ownerToken}` }), 200],
  ['dl: the owner lists the counters', () => get('dl', { authorization: `Bearer ${ownerToken}` }), 200],

  // ── usage counters ──
  ['use: first ping of this hour (n + dev) creates both', () => add(use('windows'), ['n', 'dev']), 200],
  ['use: n = 1, dev = 1', async () => `${await value(use('windows'), 'n')},${await value(use('windows'), 'dev')}`, '1,1'],
  ['use: a later ping adds only n', () => add(use('windows'), ['n']), 200],
  ['use: n = 2, dev = 1', async () => `${await value(use('windows'), 'n')},${await value(use('windows'), 'dev')}`, '2,1'],
  ['use: dev +2 is refused', () => addEach(use('windows'), { n: 1, dev: 2 }), 403],
  ['use: n +2 is refused', () => add(use('windows'), ['n'], 2), 403],
  ['use: dev without n is refused', () => add(use('windows'), ['dev']), 403],
  ['use: -1 is refused', () => add(use('windows'), ['n'], -1), 403],
  ['use: another hour is refused', () => add(use('windows', otherHH), ['n']), 403],
  ['use: yesterday is refused', () => add(use('windows', HH, yesterday), ['n']), 403],
  ['use: unknown platform is refused', () => add(use('bsd'), ['n']), 403],
  ['use: a third field is refused', () => add(use('android'), ['n', 'v']), 403],
  ['use: android, mac, linux, ios are accepted', async () => [await add(use('android'), ['n']), await add(use('mac'), ['n', 'dev']), await add(use('linux'), ['n']), await add(use('ios'), ['n'])].join(','), '200,200,200,200'],
  ['use: overwrite is refused', () => patch(use('windows'), { n: { integerValue: '50' } }), 403],
  ['use: delete is refused', () => del(use('windows')), 403],
  ['use: anonymous get is refused', () => get(use('windows')), 403],
  ['use: anonymous list is refused', () => get('use'), 403],
  ['use: the owner lists the counters', () => get('use', { authorization: `Bearer ${ownerToken}` }), 200],

  // ── the owner list itself ──
  ['admin: the owner cannot read the list', () => get('admin/owners', { authorization: `Bearer ${ownerToken}` }), 403],
  ['admin: the owner cannot change the list', () => patch('admin/owners', { emails: { arrayValue: { values: [{ stringValue: 'x@example.test' }] } } }, { authorization: `Bearer ${ownerToken}` }), 403],
  ['admin: anonymous cannot read the list', () => get('admin/owners'), 403],

  // ── nothing else ──
  ['other collection: write is refused', () => add('other/x', ['n']), 403],
  ['other collection: the owner cannot read', () => get('other', { authorization: `Bearer ${ownerToken}` }), 403],
];

let failed = 0;
for (const [name, run, want] of cases) {
  const got = await run();
  const ok = String(got) === String(want);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${got} (want ${want})`);
}
if (new Date().getUTCHours() !== hour) console.log('NOTE: the UTC hour changed during the run; run it again.');
console.log(failed ? `${failed} FAILED` : `ALL ${cases.length} PASS`);
process.exitCode = failed ? 1 : 0;
