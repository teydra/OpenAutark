// Owns: fast checks of the site's sources: base path from SITE_URL, platform order, file links on OpenAutark, the
// per-platform pages, a home page without status chips or umbrella links, the iPhone web app (/app/) – and one offline
// build (OFFLINE=1 into dist/) for the app's files and its hosting headers.
// Never: network or a browser (scripts/qa.mjs does the browser pass). Run: node --test apps/website/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { site, release, platforms, platformKinds, downloads, legacyFileLinks, maker, appUrl, appOriginProblem } = await import('../src/config.mjs');
const { BASE } = await import('../src/layout.mjs');
const APP_BASE = new URL(`${appUrl}/`).pathname;
const { platformPages } = await import('../src/platform.mjs');
const home = (await import('../src/pages/home.mjs')).default;
const download = (await import('../src/pages/download.mjs')).default;

const rel = { ...structuredClone(release.fallback), history: [] };
test('About keeps historical names without old Meta Jarvis links', async () => {
  const about = (await import('../src/pages/about.mjs')).default;
  const html = about(rel);
  assert.ok(html.includes('Meta Jarvis'));
  assert.ok(!html.includes('metajarvis.teydralab.com'));
  assert.ok(!html.includes('href="undefined"'));
  assert.equal(maker.umbrellaUrl, undefined);
  assert.equal(maker.telecodingUrl, undefined);
});
const ldOf = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

test('base path follows SITE_URL: / by default (openautark.com, B-084), a sub path for a shared host', () => {
  if (!process.env.SITE_URL) assert.equal(BASE, '/');
  const probe = `import('${pathToFileURL(join(root, 'src/layout.mjs')).href}').then((m) => process.stdout.write(m.BASE + ' ' + m.abs('download')))`;
  const run = (url) => execFileSync(process.execPath, ['--input-type=module', '-e', probe], { env: { ...process.env, SITE_URL: url } }).toString();
  assert.equal(run('https://autark.example.com/'), '/ https://autark.example.com/download/');
  assert.equal(run('https://host.example/sub/autark'), '/sub/autark/ https://host.example/sub/autark/download/');
});

test('platforms: PC first (Windows, macOS, Linux), then phone (Android, iPhone)', () => {
  assert.deepEqual(platforms.map((p) => p.id), ['windows', 'mac', 'linux', 'android', 'iphone']);
  assert.deepEqual(platformKinds.map((k) => k.id), ['pc', 'phone']);
  assert.equal(platforms.find((p) => p.id === 'iphone').file, null);
});

test('file links live on OpenAutark under /get/, the old checksums link keeps answering', () => {
  assert.equal(release.repo, 'teydra/OpenAutark');
  const byId = Object.fromEntries(downloads.map((d) => [d.id, d]));
  for (const id of ['windows', 'mac', 'mac-zip', 'linux', 'android', 'checksums']) assert.equal(byId[id].path, `get/${id}`);
  assert.equal(release.asset(byId.android.file), 'https://github.com/teydra/OpenAutark/releases/latest/download/autark-android-lite.apk');
  assert.deepEqual(legacyFileLinks, [{ path: 'download/checksums', id: 'checksums' }]);
  assert.deepEqual(release.historyApis, ['https://api.github.com/repos/teydra/OpenAutark/releases'], 'the changelog reads only the public repo; the old one is private');
});

test('one page per platform with a canonical address, one h1, a big button and valid structured data', () => {
  const pages = platformPages(rel);
  assert.equal(pages.length, 5);
  for (const { slug, html } of pages) {
    const p = platforms.find((x) => `download/${x.id}` === slug);
    assert.ok(html.includes(`<link rel="canonical" href="${site.url}/${slug}/">`), slug);
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, slug);
    if (p.file) assert.ok(html.includes(`href="${site.url}/get/${p.id}" data-dl="${p.id}"`), `${slug} button is the site's own /get/${p.id} address (a worker answers it with the newest file; no file name in the page)`);
    else assert.ok(!html.includes('.apk"') && html.includes('href="#steps"'), 'iPhone has no file, only the way to set it up');
    const graph = ldOf(html).flatMap((g) => g['@graph']);
    assert.ok(graph.some((n) => n['@type'] === 'HowTo' && n.step.length >= 2), `${slug} HowTo`);
    assert.ok(graph.some((n) => n['@type'] === 'WebPage' && n.breadcrumb.itemListElement.length === 3), `${slug} breadcrumb`);
  }
});

// 26.11.2026 (Konrad, task_xbgv3vd6, owner's go 11:17): the start page is short – the promise with one download button that
// finds the visitor's platform, the three steps, the footer. Choosing a platform happens on /download/ only.
test('home: hero with one auto download button, three steps, footer – no platform list, no status chips, no umbrella links', () => {
  const html = home(rel);
  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
  assert.equal((main.match(/<section[\s>]/g) || []).length, 2, 'hero and the steps; the footer is the third block');
  assert.ok(main.indexOf('id="top"') < main.indexOf('id="how"'));
  assert.equal((main.match(/data-dl-auto/g) || []).length, 1, 'exactly one download button');
  assert.match(main, new RegExp(`<a class="link" href="${BASE}download/">Other devices`), 'a small link to every device');
  for (const p of platforms.filter((x) => x.id !== 'windows')) assert.ok(!html.includes(`download/${p.id}/`), `no ${p.id} link on the home page (header, main or footer)`);
  assert.ok(!html.includes('data-plat=') && !html.includes('class="plats'), 'no platform tiles');
  assert.ok(!ldOf(html).flatMap((g) => g['@graph']).some((n) => n['@type'] === 'FAQPage'), 'the FAQ structured data lives on /faq/');
  assert.ok(!html.includes('pill--available') && !html.includes('id="status"') && !html.includes('· working'));
  assert.ok(!html.includes(`href="${maker.umbrellaUrl}"`) && !html.includes(`href="${maker.telecodingUrl}"`) && !html.includes(maker.umbrella));
});

test('/pair/ stays out of search, keeps the typed ID and offers the Android app with the Android page as fallback', async () => {
  const html = (await import('../src/pages/pair.mjs')).default(rel);
  assert.ok(html.includes('noindex') && html.includes('data-pair-id') && html.includes('data-pair-copy'));
  assert.ok(html.includes('data-package="com.teydralab.autark.android"') && html.includes(`data-fallback="${site.url}/download/android/"`));
});

test('iPhone page: the web app at /app/, Add to Home Screen, Remote ID and code, iOS 17, and the honest phone-use note', () => {
  const html = platformPages(rel).find((p) => p.slug === 'download/iphone').html;
  assert.ok(html.includes(`href="${appUrl}/"`) && html.includes('Add to Home Screen') && html.includes('Remote ID') && html.includes('iOS 17'));
  assert.ok(!html.includes(`href="${site.url}/app/"`), 'never the site\'s own origin');
  assert.ok(html.includes('cannot use other iPhone apps'));
  assert.ok(!html.includes('sets the web app up') && !html.includes('Tailscale'), 'no PC-served web app any more');
});

// Chat sweep 16.11.2026 (owner 11.11.: "Kann man es nicht wie Android einfach runterladen installieren?"): the download
// table and the FAQ say the real iPhone way – the site's web app on the Home Screen, no App Store, no Apple account.
test('download page and FAQ: the iPhone is the web app from the site, no manager set-up, no Wi-Fi or Tailscale', async () => {
  const html = download(rel);
  assert.ok(html.includes('Add to Home Screen') && html.includes('No App Store, no Apple account'), 'the short iPhone line');
  assert.ok(!/manager on the PC to set it up/.test(html) && !html.includes('web app your PC serves'));
  const { faq } = await import('../src/data/faq.mjs');
  const phone = faq.find((entry) => entry.q === 'Can I use it from my phone?').a;
  assert.ok(phone.includes('web app from this site') && phone.includes('Home Screen') && phone.includes('meeting server') && phone.includes('no App Store'));
  assert.ok(!/manager sets that up|Wi-Fi or Tailscale/.test(phone), phone);
});

test('the iPhone app: its own noindex document for the Home Screen, the manifest scoped to it, #app and the shell with SRI', async () => {
  const mod = await import('../src/pages/app.mjs');
  const html = mod.default(rel);
  assert.ok(html.includes('noindex') && html.includes('apple-mobile-web-app-capable') && html.includes('<div id="app"></div>'));
  assert.ok(html.includes(`<link rel="manifest" href="${APP_BASE}app.webmanifest">`));
  assert.match(html, new RegExp(`<script type="module" src="${APP_BASE}shell\\.js"( integrity="sha384-[A-Za-z0-9+/=]+")?></script>`));
  assert.ok(!/<script(?![^>]*src=)/.test(html), 'no inline script (the CSP allows none)');
  const manifest = JSON.parse(mod.extra()['app.webmanifest']);
  assert.equal(manifest.scope, APP_BASE);
  assert.equal(manifest.start_url, APP_BASE);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, manifest.background_color, 'one colour for the splash and the bar');
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  assert.ok(!/(^|\})\s*(html|body|:root)[^{]*\{[^}]*(background|color:|font)/.test(style), 'the shell colours only .hs: the PC UI\'s theme owns the page');
  assert.ok(/\.hs\{[^}]*overflow-y:auto/.test(style) && /\.hs-card\{[^}]*margin:auto/.test(style), 'a short screen scrolls the card instead of clipping it');
});

test('the iPhone app has an origin of its own: never the site\'s host or Meta Jarvis, outside the base path', () => {
  assert.equal(appOriginProblem(appUrl), undefined);
  assert.notEqual(new URL(appUrl).host, new URL(site.url).host);
  assert.match(appOriginProblem('https://metajarvis.teydralab.com/app', 'https://autark.example.com'), /cannot share/);
  assert.match(appOriginProblem(`${new URL(site.url).origin}/app`), /cannot share/);
  assert.match(appOriginProblem('https://app.example.com'), /folder of its own/);
  assert.match(appOriginProblem('https://other.example/autark/app', 'https://other2.example/autark'), /outside the site's base path/);
  assert.match(appOriginProblem('http://app.example.com/app'), /https/);
  const failed = (() => { try { execFileSync(process.execPath, [join(root, 'build.mjs')], { cwd: root, env: { ...process.env, OFFLINE: '1', APP_URL: 'https://metajarvis.teydralab.com/autark/app' }, stdio: 'pipe' }); return ''; } catch (error) { return String(error.stderr); } })();
  assert.match(failed, /cannot share/, 'the build refuses the shared origin');
});

test('/pair/ on an iPhone points to the Home Screen app (Safari keeps separate storage)', async () => {
  const html = (await import('../src/pages/pair.mjs')).default(rel);
  assert.ok(html.includes('data-pair-ios') && html.includes('open Autark from your Home Screen'.replace('Autark', site.name)) && html.includes(`href="${appUrl}/"`));
});

test('the PC version comes from GitHub\'s releases/latest, not a newer phone-only tag at the top of the list', () => {
  // A mocked fetch drives the real build: the list starts with android-v0.3.7 (binary only), releases/latest is v0.3.4.
  const asset = (name, size) => ({ name, size, browser_download_url: `https://example.invalid/${name}` });
  const android = { tag_name: 'android-v0.3.7', name: 'Android 0.3.7', published_at: '2026-11-08T18:00:00Z', html_url: 'https://example.invalid/android-v0.3.7', body: '', assets: [asset(release.files.android, 5e6)] };
  const desktop = { tag_name: 'v0.3.4', name: '0.3.4', published_at: '2026-11-08T10:00:00Z', html_url: 'https://example.invalid/v0.3.4', body: '', assets: [asset(release.files.windows, 140e6), asset(release.files.android, 4e6)] };
  const answers = {
    [`${release.api}?per_page=30`]: [android, desktop],
    [`${release.api}/latest`]: desktop,
    [release.asset('latest-android-lite.json')]: { versionName: '0.3.7' },
  };
  const mock = `const answers = ${JSON.stringify(answers)}; globalThis.fetch = async (url) => (String(url) in answers ? new Response(JSON.stringify(answers[String(url)])) : new Response('', { status: 404 }));`;
  const env = { ...process.env, ALLOW_NO_SHA256: '1' }; delete env.OFFLINE; // this mock serves no SHA256SUMS.txt
  execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(mock)}`, join(root, 'build.mjs')], { cwd: root, env, stdio: 'pipe' });
  const siteDir = join(root, 'dist', ...BASE.split('/').filter(Boolean));
  const facts = JSON.parse(readFileSync(join(siteDir, 'facts.json'), 'utf8'));
  assert.equal(facts.platforms.windows.version, '0.3.4');
  assert.equal(facts.platforms.windows.sizeMb, 140);
  assert.equal(facts.platforms.android.version, '0.3.7', 'the phone app keeps its own version from latest-android-lite.json');
  assert.ok(readFileSync(join(siteDir, 'llms-full.txt'), 'utf8').includes('- android-v0.3.7 (2026-11-08)'), 'the changelog still lists the Android tag');
});

test('the build ships the app with its shell, worker and icons; the app path allows camera and microphone, the rest of the site does not', () => {
  execFileSync(process.execPath, [join(root, 'build.mjs')], { cwd: root, env: { ...process.env, OFFLINE: '1' }, stdio: 'pipe' });
  // B-084: at base '/' the app is built apart (dist-app/, the Vercel project `autark`), the site's /app/ only forwards.
  const apart = BASE === '/';
  const dir = join(root, apart ? 'dist-app' : 'dist', ...APP_BASE.split('/').filter(Boolean));
  for (const file of ['index.html', 'shell.js', 'sw.js', 'app.webmanifest', 'app-icon.png', 'app-icon-512.png']) assert.ok(existsSync(join(dir, file)), file);
  assert.match(readFileSync(join(dir, 'shell.js'), 'utf8'), /^\/\/ autark-hosted-src: [0-9a-f]{32}/, 'the generated shell from apps/desktop');
  const old = join(root, 'dist', ...BASE.split('/').filter(Boolean), 'app');
  assert.ok(!existsSync(join(old, 'shell.js')) && readFileSync(join(old, 'index.html'), 'utf8').includes(`url=${appUrl}/`), 'the site\'s old /app/ only forwards');
  const vercel = JSON.parse(readFileSync(join(root, 'dist', 'vercel.json'), 'utf8'));
  if (apart) {
    const own = JSON.parse(readFileSync(join(root, 'dist-app', 'vercel.json'), 'utf8'));
    for (const path of ['/autark', '/autark/', '/autark/faq/']) {
      const route = own.routes.find((r) => r.src && new RegExp(`^${r.src}$`).test(path));
      assert.equal(route?.status, 410, path);
      assert.ok(!route.headers?.Location);
    }
    assert.ok(own.routes.some((h) => h.src === `${APP_BASE}(.*)` && h.headers['Permissions-Policy'] === 'camera=(self), microphone=(self), geolocation=()'), 'the app keeps its headers where it is served');
  }
  const app = vercel.headers.find((h) => h.source === `${APP_BASE}(.*)`);
  const policy = (h) => h.headers.find((x) => x.key === 'Permissions-Policy')?.value;
  assert.equal(policy(app), 'camera=(self), microphone=(self), geolocation=()');
  const csp = app.headers.find((x) => x.key === 'Content-Security-Policy').value;
  assert.ok(csp.includes("script-src 'self'") && csp.includes("connect-src 'self' wss:") && csp.includes("base-uri 'none'"));
  const rest = vercel.headers.find((h) => policy(h) === 'camera=(), microphone=(), geolocation=()');
  assert.ok(rest && new RegExp(`^${rest.source}$`).test(`${BASE}download/`) && !new RegExp(`^${rest.source}$`).test(`${APP_BASE}shell.js`));
  assert.ok(vercel.headers.some((h) => h.source.startsWith(`${APP_BASE}(`) && h.headers.some((x) => x.key === 'Cache-Control' && x.value === 'no-cache')));
  assert.ok(!readFileSync(join(root, 'dist', ...BASE.split('/').filter(Boolean), 'sitemap.xml'), 'utf8').includes('/app/'));
});

test('download overview lists every platform page', () => {
  const html = download(rel);
  for (const p of platforms) assert.ok(html.includes(`download/${p.id}/`), p.id);
  assert.ok(!html.includes('pill--available'));
});

// 18.11.2026 (a mail gateway marked mails with a link to the site as suspicious – a direct link to an installer): no address
// 24.11.2026 (owner): the platform pages' big button downloads in one click. It points at /get/<id>, an address without a file name;
// the Cloudflare worker (worker/worker.mjs) answers it with a redirect to the newest release file. The pages still name no file,
// and mails and posts keep linking to the platform page, not to /get/.
const FILE_LINK = /(?:https?:)?\/\/[^"'\s<>)]*\.(?:exe|apk|dmg|AppImage|zip|msi)|releases\/(?:latest\/)?download\/(?!SHA256SUMS\.txt)[^"'\s<>)]*/i;
test('no page links to an installer file; the buttons lead to a page here or to the release page', async () => {
  const pages = [home(rel), await download(rel), ...platformPages(rel).map((p) => p.html)];
  for (const [i, html] of pages.entries()) assert.doesNotMatch(html, FILE_LINK, `page ${i}`);
  assert.ok(home(rel).includes(`href="/download/windows/" data-dl="windows"`) || home(rel).includes('/download/windows/" data-dl="windows"'), 'the home button opens the Windows page');
  for (const d of downloads) {
    const target = d.id === 'checksums' ? release.asset(d.file) : `${site.url}/download/${d.id === 'mac-zip' ? 'mac' : d.id}/`;
    assert.doesNotMatch(target, /\.(?:exe|apk|dmg|AppImage|zip|msi)$/i, d.id);
  }
});

test('Android page: big button is Lite, small link to the full version; no page tells anyone to switch Play Protect off; Windows is described as signed', async () => {
  const pages = platformPages(rel);
  const android = pages.find((p) => p.slug === 'download/android').html;
  assert.ok(android.includes(`href="${site.url}/get/android"`) && android.includes(`href="${site.url}/get/android-full"`));
  assert.ok(android.includes('Full version with phone control'));
  assert.ok(!/Play Protect/i.test(pages.map((p) => p.html).join('')), 'Lite installs with Play Protect on (25.11.2026): no page warns about it');
  const win = pages.find((p) => p.slug === 'download/windows').html;
  assert.ok(/code-signed \(publisher: Open Source Developer Meral Anna Hees\)/.test(win));
  const all = pages.map((p) => p.html).join('') + home(rel) + download(rel);
  assert.ok(!/not code-signed|no Windows certificate|build is not signed|builds are not signed/i.test(all));
  const worker = readFileSync(join(root, 'worker/worker.mjs'), 'utf8');
  assert.ok(worker.includes("'android-lite': 'autark-android-lite.apk'") && worker.includes("android: 'autark-android-lite.apk'") && worker.includes("'android-full': 'autark-android.apk'"));
});

test('the typed-in release values (shown before the live check, and to crawlers) are the version of this repository, and the big button shows them', async () => {
  const app = JSON.parse(readFileSync(join(root, '../desktop/package.json'), 'utf8')).version;
  assert.equal(release.fallback.windows.version, app, 'config.mjs fallback.windows is not the version of apps/desktop: update the fallback with the release (sizes from the release assets)');
  assert.equal(release.fallback.linux.version, app);
  const gradle = readFileSync(join(root, '../android/app/build.gradle'), 'utf8').match(/versionName\s*=\s*'([^']+)'/)?.[1];
  assert.equal(release.fallback.android.version, gradle);
  const html = await home(rel);
  assert.ok(html.includes(`v${app} · ${release.fallback.windows.sizeMb} MB`), 'the big button names the current version and size');
  assert.ok(!html.includes('0.3.19'));
});

test('no text names "My day" or the old Work section, and Secure is described only as asking before every command (Stanislaus and Konrad 26.11.2026)', async () => {
  const { readdirSync } = await import('node:fs');
  const files = [join(root, 'build.mjs')];
  for (const d of ['src', 'src/data', 'src/pages']) for (const f of readdirSync(join(root, d))) if (f.endsWith('.mjs')) files.push(join(root, d, f));
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    assert.ok(!/My day|my-day/i.test(t), `${f}: My day is gone from the app`);
    assert.ok(!/own folders|outside its|files elsewhere|files outside/i.test(t), `${f}: Secure asks before every command; the folder claim is not proven for every engine`);
    assert.ok(!/counts as harmless|without a question/i.test(t), `${f}: in Secure every command asks, also read-only ones (Konrad's measurement 25.11.2026)`);
    assert.ok(!/\(Work\)|tasks into Work|01 — Work|Work: one inbox/.test(t), `${f}: the Work section is gone from the app`);
  }
});

test('Mac page: the version reads "<version> (macOS preview)" with the not-notarized line below it; the label follows the version from the release, other platforms have none (Felix and Juri 26.11.2026)', async () => {
  for (const version of [rel.mac.version, '0.3.21']) {
    const macFile = platforms.find((p) => p.id === 'mac').file;
    const r = { ...rel, mac: { ...rel.mac, version }, sums: { ...rel.sums, [macFile]: 'a'.repeat(64) } }; // the overview table lists only files with a published SHA-256
    const pages = Object.fromEntries(platformPages(r).map((p) => [p.slug, p.html]));
    assert.ok(pages['download/mac'].includes(`<dd>${version} (macOS preview)</dd>`), `Mac version row for ${version}`);
    assert.match(pages['download/mac'], /<\/dl>\s*<p[^>]*><strong>Not notarized: on the first start, open System Settings › Privacy &amp; Security › Open Anyway\.<\/strong><\/p>/);
    const dl = await download(r);
    assert.ok(dl.includes(`<td>${version} (macOS preview)</td>`), 'download overview table');
  }
  for (const id of ['windows', 'linux', 'android']) {
    const html = platformPages(rel).find((p) => p.slug === `download/${id}`).html;
    assert.ok(!html.includes('macOS preview') && !html.includes('Not notarized'), id);
  }
});

test('a build with network that cannot read SHA256SUMS.txt stops instead of shipping pages without SHA-256 (18.11. and 26.11.2026)', () => {
  const mock = "globalThis.fetch = async () => new Response('', { status: 404 });";
  const env = { ...process.env }; delete env.OFFLINE; delete env.ALLOW_NO_SHA256;
  let err = null;
  try { execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(mock)}`, join(root, 'build.mjs')], { cwd: root, env, stdio: 'pipe' }); } catch (e) { err = e; }
  assert.ok(err, 'the build must fail');
  assert.match(String(err.stderr), /SHA256SUMS\.txt[^]*could not be read/);
});
