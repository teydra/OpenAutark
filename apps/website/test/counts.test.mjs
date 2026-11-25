// Owns: checks of the anonymous download count (25.11.2026): what the site sends, that it holds nothing that identifies a
// visitor, that the platforms match the Firestore rules, that the key stays out of the repository, and that the private
// stats page is neither listed nor open. Never: network, a browser or a build into dist/ (site.test.mjs builds there).
// Run: node --test apps/website/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import privacy from '../src/pages/privacy.mjs';
import { release } from '../src/config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const siteJs = readFileSync(join(root, 'src/assets/site.js'), 'utf8');
const rules = readFileSync(join(root, '../desktop/resources/feedback/firestore.rules'), 'utf8');
const rel = { ...structuredClone(release.fallback), history: [] };

// The pages as they come out for a given environment (config.mjs reads its key once, at import).
function render(env) {
  const code = `const rel = ${JSON.stringify(rel)};
    const home = (await import(${JSON.stringify(pathToFileURL(join(root, 'src/pages/home.mjs')).href)})).default(rel);
    const stats = (await import(${JSON.stringify(pathToFileURL(join(root, 'src/pages/stats.mjs')).href)})).default(rel);
    const plats = Object.fromEntries((await import(${JSON.stringify(pathToFileURL(join(root, 'src/platform.mjs')).href)})).platformPages(rel).map((p) => [p.slug, p.html]));
    process.stdout.write(JSON.stringify({ home, stats, plats }));`;
  const clean = { ...process.env }; for (const k of ['COUNTS_API_KEY', 'COUNTS_AUTH_KEY', 'COUNTS_PROJECT']) delete clean[k];
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...clean, ...env }, cwd: root, maxBuffer: 1 << 26 }).toString());
}
const KEY = `AIza${'a'.repeat(35)}`;
const AUTH_KEY = `AIza${'b'.repeat(35)}`;

test('the site sends the count only with a key, and never the stats key', () => {
  const on = render({ COUNTS_API_KEY: KEY, COUNTS_AUTH_KEY: AUTH_KEY });
  assert.ok(on.home.includes(`window.__COUNT={"p":"autark-feedback-7","k":"${KEY}"}`));
  assert.ok(!on.home.includes(AUTH_KEY), 'the sign-in key is for the stats page only');
  assert.ok(on.stats.includes(`data-auth-key="${AUTH_KEY}"`));
});

test('without a usable key nothing is counted, and without the sign-in key the stats page is closed', () => {
  const off = render({ COUNTS_API_KEY: '‹secret:google-api-key›' });
  assert.ok(!off.home.includes('__COUNT'));
  assert.ok(off.stats.includes('Not configured in this build.'));
  const noAuth = render({ COUNTS_API_KEY: KEY });
  assert.ok(noAuth.home.includes('__COUNT') && noAuth.stats.includes('Not configured in this build.'));
});

test('the footer links to our own privacy page, and every page with a counted download says it is counted', () => {
  const on = render({ COUNTS_API_KEY: KEY });
  assert.match(on.home, /<nav aria-label="Legal">[^]*?<a href="\/privacy\/">Privacy<\/a>/);
  assert.ok(!/<nav aria-label="Legal">[^]*?teydralab\.com\/privacy-policy[^]*?<\/nav>/.test(on.home), 'the footer no longer points at the company policy');
  for (const id of ['windows', 'mac', 'linux', 'android']) assert.match(on.plats[`download/${id}`], /counted anonymously[^]*?href="\/privacy\/#counts"/, id);
  assert.ok(!on.plats['download/iphone'].includes('counted anonymously'), 'the iPhone page has no download button to count');
  const off = render({ COUNTS_API_KEY: '‹secret:google-api-key›' });
  assert.ok(!off.plats['download/mac'].includes('counted anonymously'), 'no key, no counting, no notice');
});

test('the stats page is noindex, outside the sitemap, and loads Google only on demand', () => {
  const { stats } = render({ COUNTS_API_KEY: KEY, COUNTS_AUTH_KEY: AUTH_KEY });
  assert.match(stats, /<meta name="robots" content="noindex/);
  assert.match(readFileSync(join(root, 'src/config.mjs'), 'utf8'), /export const unlisted = \[[^\]]*'stats'/);
  assert.ok(!stats.includes('gstatic.com'), 'the page itself loads nothing from Google');
  const js = readFileSync(join(root, 'src/assets/stats.js'), 'utf8');
  assert.ok(js.includes('gstatic.com/firebasejs/') && js.includes("import(`${FB}/firebase-auth.js`)"));
  assert.ok(!/^import /m.test(js), 'no static import: Google code is fetched inside the click handler');
});

test('the download count carries a counter name and +1, nothing that identifies a visitor, and never delays the link', () => {
  const block = siteJs.slice(siteJs.indexOf('const COUNT = window.__COUNT;'), siteJs.indexOf('/pair/: show the Remote ID')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(block.includes("fieldPath: 'n', increment: { integerValue: '1' }"));
  assert.ok(block.includes('keepalive: true') && block.includes("credentials: 'omit'") && block.includes("referrerPolicy: 'no-referrer'"));
  assert.ok(!/preventDefault|location\.assign|await /.test(block), 'the click is only observed');
  for (const word of ['cookie', 'localStorage', 'sessionStorage', 'userAgent', 'navigator', 'referrer:', 'screen']) assert.ok(!block.includes(word), word);
  assert.ok(block.includes('new Date().toISOString().slice(0, 10)'));
});

test('the platforms the site counts are exactly the ones the Firestore rules accept', () => {
  const inSite = /\\\/get\\\/\(([^)]+)\)/.exec(siteJs)?.[1].split('|').sort();
  const inRules = /today\(\) \+ '_\(([^)]+)\)'/.exec(rules)?.[1].split('|').sort();
  assert.ok(inSite?.length > 3);
  assert.deepEqual(inSite, inRules);
});

test('the privacy notice says what is counted, what is not, why, and how to avoid it', () => {
  const html = privacy(rel);
  for (const term of ['id="counts"', 'Download clicks', 'at most one signal per hour', 'No device or installation ID', 'we store no IP address', 'Article 6(1)(f) GDPR', 'Turning it off', 'europe-west3']) assert.ok(html.includes(term), term);
  assert.ok(html.includes('stores nothing on your device'));
});

test('the rules file keeps the feedback mailbox and limits the counters to +1 for today', () => {
  for (const term of ["match /feedback/{id}", "request.resource.data.keys().hasOnly(['v', 'sealed', 'exp'])", "request.resource.data.n == before('n') + 1", "pad(request.time.hours())", 'allow read: if owner();']) assert.ok(rules.includes(term), term);
  assert.ok(!/allow (read|write|create|update)[^:]*: if true/.test(rules));
});
