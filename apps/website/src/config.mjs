// Owns: the name, the address, the release channel, every download and every outside link.
// Never: page copy or markup; pages read from here.
// Renaming the product or moving the site = edit this file (or set SITE_URL) and rebuild.
import { readFileSync } from 'node:fs';

// Where the finished site lives: origin plus base path, no trailing slash.
// A shared host with a base path builds into the matching dist/ subfolder;
// 'https://openautark.com' builds into dist/ with base '/' (today's own domain). Every canonical URL,
// internal link, sitemap entry, redirect and social card follows it; nothing else needs changing.
// B-084 (08.11.2026, owner): the one public site is openautark.com; the Meta Jarvis address only forwards there.
const SITE_URL = (process.env.SITE_URL || 'https://openautark.com').trim().replace(/\/+$/, '');

export const site = {
  name: 'Autark',
  // Short line next to the name (search results, social cards, app stores).
  descriptor: 'Your own AI company, on your own computer',
  url: SITE_URL,
  lang: 'en',
  locale: 'en_US',
  themeColor: '#0A0A0B',
};

// ── The release switch ──
// false: the public builds still carry the working name; features marked 'next' are built but not released.
// true, set with the rename release: the names below switch in one step, 'next' features count as available,
// and the sentences about the working name and the coming release leave the site. README.md, "Beim Release".
export const RENAMED = true;

// The release channel before OpenAutark, private since 07.11.2026 (after the bridge release 0.3.3), so its releases are gone from the changelog.
const OLD_REPO = 'teydra/proactive-agent-workforce-releases';

const NAMES = RENAMED ? {
  // Since the bridge release 0.3.3 (B-078) the one public home is teydra/OpenAutark. These equal
  // apps/desktop/package.json (productName, artifactName, publish.repo) and apps/android. Android: since 0.3.6 the
  // website offers the Lite APK (no phone use by agents): Play Protect blocks a sideloaded app that asks for
  // Accessibility (Samsung, 08.11.2026). The full autark-android.apk stays in the release for installs that have it.
  repo: 'teydra/OpenAutark',
  app: 'Autark',
  files: { windows: 'autark-windows-x64.exe', macDmg: 'autark-mac-universal.dmg', macZip: 'autark-mac-universal.zip', linux: 'autark-linux-x64.AppImage', android: 'autark-android-lite.apk' },
} : {
  repo: OLD_REPO,
  app: 'Proactive Agent Workforce',
  files: { windows: 'workforce-windows-x64.exe', macDmg: 'workforce-mac-universal.dmg', macZip: 'workforce-mac-universal.zip', linux: 'workforce-linux-x64.AppImage', android: 'autark-android.apk' },
};

// Public release channel. Asset names carry no version, so
// `/releases/latest/download/<file>` always serves the newest build.
const { repo } = NAMES;
export const release = {
  repo,
  renamed: RENAMED,
  repoUrl: `https://github.com/${repo}`,
  releasesUrl: `https://github.com/${repo}/releases`,
  latestUrl: `https://github.com/${repo}/releases/latest`,
  api: `https://api.github.com/repos/${repo}/releases`,
  // The channels the changelog lists (newest channel first); only the public one, since the old repo is private.
  historyApis: [`https://api.github.com/repos/${repo}/releases`],
  asset: (file) => `https://github.com/${repo}/releases/latest/download/${file}`,
  files: NAMES.files,
  // What the installed app is called on the person's PC. The data folder follows the product name;
  // the workspace folder and workforce.db keep their names across the rename (apps/desktop keep list).
  app: {
    name: NAMES.app,
    macBundle: `${NAMES.app}.app`,
    dataFolder: {
      windows: `%APPDATA%\\${NAMES.app}`,
      mac: `~/Library/Application Support/${NAMES.app}`,
      linux: `~/.config/${NAMES.app}`,
    },
    workspace: '~/Workforce',
    // Where Back up and the data folder sit: one Settings page, group Advanced, in 0.2.9; the About page after it.
    settingsHome: RENAMED ? 'About' : 'Advanced',
  },
  // Shown before the live check answers, and to crawlers. Refreshed by the
  // build from the GitHub API when the network is available.
  fallback: {
    windows: { version: '0.3.19', date: '2026-11-24', sizeMb: 145 },
    mac: { version: '0.3.14', date: '2026-11-19', sizeMb: 278 },
    linux: { version: '0.3.19', date: '2026-11-24', sizeMb: 164 },
    // The phone app is a small shell that shows the PC's own interface; its version runs on its own.
    android: { version: '0.3.19', date: '2026-11-24', sizeMb: 12 },
  },
};

// Every platform, in the order the site shows them: PC first, then phone.
// Each gets its own page at /download/<id>/ with one big button and the install steps (build.mjs).
// `file` is the release asset behind the button; the iPhone has none (the web app at /app/, added to the Home Screen).
export const platforms = [
  { id: 'windows', kind: 'pc', os: 'Windows', icon: 'windows', detail: 'Windows 10/11 · x64 installer', file: NAMES.files.windows },
  { id: 'mac', kind: 'pc', os: 'macOS', short: 'Mac', icon: 'apple', detail: 'Universal · Apple silicon + Intel · DMG', file: NAMES.files.macDmg, alt: { label: 'ZIP', file: NAMES.files.macZip } },
  { id: 'linux', kind: 'pc', os: 'Linux', icon: 'linux', detail: 'x64 · AppImage', file: NAMES.files.linux },
  { id: 'android', kind: 'phone', os: 'Android', icon: 'android', detail: 'Android 8 or newer · APK', file: NAMES.files.android },
  { id: 'iphone', kind: 'phone', os: 'iPhone', icon: 'phone', detail: 'Web app · Home Screen · iOS 17 or newer', file: null },
];
export const platformKinds = [{ id: 'pc', label: 'PC' }, { id: 'phone', label: 'Phone' }];

// The site's own stable file addresses: /get/<id> redirects (vercel.json, plus a small page for other
// hosts) to the release channel above, so when the repository changes, links in posts, in the app and in
// search results keep working. The older /download/<id> addresses keep working too: windows, mac, linux
// and android are the platform pages now, checksums still redirects to the file.
export const downloads = [
  ...platforms.filter((p) => p.file).map(({ id, os, detail, file }) => ({ id, os, detail, file, path: `get/${id}` })),
  { id: 'mac-zip', os: 'macOS (ZIP)', detail: 'Universal · Apple silicon + Intel · ZIP', file: NAMES.files.macZip, path: 'get/mac-zip' },
  { id: 'checksums', os: 'Checksums', detail: 'SHA-256 of every file', file: 'SHA256SUMS.txt', path: 'get/checksums' },
];
// Old file addresses that still answer with the file itself (the platform ids became pages).
export const legacyFileLinks = [{ path: 'download/checksums', id: 'checksums' }];

export const maker = {
  company: 'Teydra Lab',
  companyUrl: 'https://teydralab.com/',
  founder: 'Stanislaus Hees',
  founderUrl: 'https://stanislaushees.com/',
  founderProject: 'https://stanislaushees.com/projekte/agent-workforce/',
  location: 'Austria',
  // The family Autark grew up in. Only the About page tells that story; nav, footer and home stay on Autark.
  umbrella: 'Meta Jarvis',
  bookTitle: 'KI ins eigene Produkt',
  bookUrl: 'https://stanislaushees.com/b/1/',
  pressUrl: 'https://stanislaushees.com/presse/',
  award: 'Startup category winner, Beyond Optimization Crowd in Motion Challenge, 16th Austrian Innovation Forum (2026)',
  awardUrl: 'https://stanislaushees.com/notizen/austrian-innovation-forum-2026/',
  imprintUrl: 'https://openautark.com/impressum/', // this site's own imprint (pages/impressum.mjs), 16.11.2026
  privacyUrl: 'https://teydralab.com/privacy-policy',
  contactUrl: 'https://teydralab.com/kontakt',
  feedbackUrl: `https://github.com/${repo}/issues`,
  discordUrl: 'https://discord.gg/2MXxH8c3ee', // permanent invitation to the Teydra Lab Discord (17.11.2026)
  social: [
    { name: 'X', url: 'https://x.com/teydralab' },
    { name: 'LinkedIn', url: 'https://www.linkedin.com/company/teydralab-chatbot/' },
    { name: 'Instagram', url: 'https://www.instagram.com/teydralab/' },
    { name: 'TikTok', url: 'https://www.tiktok.com/@teydralab' },
  ],
};

// Pages, in navigation order. `nav` = shown in the header.
export const pages = [
  { slug: '', title: 'Home' },
  { slug: 'product', title: 'Product', nav: true },
  { slug: 'how-it-works', title: 'How it works', nav: true },
  { slug: 'access', title: 'Access and data', nav: true },
  { slug: 'compare', title: 'Compare' },
  { slug: 'faq', title: 'FAQ', nav: true },
  { slug: 'download', title: 'Download' },
  { slug: 'changelog', title: 'Changelog' },
  { slug: 'about', title: 'About' },
  { slug: 'brand', title: 'Brand' },
];

// Pages that moved. The old address keeps working: a redirect on Vercel and a small page on any other host.
export const movedPages = [{ from: 'safety', to: 'access' }];

// Pages that are built but stay out of the sitemap and search results (robots noindex).
export const unlisted = ['pair', 'app', 'stats'];

// Anonymous counters (25.11.2026): a click on a download button adds 1 to one counter per day and platform in the
// Firestore of the Autark feedback project (rules: apps/desktop/resources/feedback/firestore.rules, privacy: /privacy/).
// Nothing identifies the visitor: no id, no cookie, no address stored. The web API key is public by design (restricted to
// the Firestore API; the rules decide what may be written). It is the one the desktop build ships in
// apps/desktop/resources/feedback/receiver.json, which this build reads too (COUNTS_API_KEY overrides it). Without a usable
// key the site is built without counting – the buttons work the same.
// `authKey` belongs to the private stats page only (COUNTS_AUTH_KEY: a second browser key for Firebase sign-in).
const API_KEY = /^[A-Za-z0-9_-]{30,60}$/;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
function readCounts() {
  let file = {};
  try { file = JSON.parse(readFileSync(new URL('../../desktop/resources/feedback/receiver.json', import.meta.url), 'utf8')); } catch { /* no local receiver file */ }
  const key = String(process.env.COUNTS_API_KEY || file.apiKey || '').trim();
  const project = String(process.env.COUNTS_PROJECT || file.project || 'autark-feedback-7').trim();
  if (!API_KEY.test(key) || !PROJECT_ID.test(project)) return null;
  const authKey = String(process.env.COUNTS_AUTH_KEY || '').trim();
  return { project, key, authKey: API_KEY.test(authKey) ? authKey : '' };
}
export const counts = readCounts();

// Where the iPhone web app lives (pages/app.mjs; its shell is generated from apps/desktop/src/ui/hosted into src/app/):
// origin plus folder, no trailing slash. It needs an origin of its own: browser storage and WebCrypto keys belong to an
// origin, not a path, and the phone's key and token there reach every PC of the person. So never the host the site sits
// on behind Meta Jarvis (its SPA and /telecoding are built and deployed elsewhere) – build.mjs refuses that. Today: the
// Autark Vercel project's own host, in a folder outside the site's base path (the Meta Jarvis rewrite only reaches
// /autark/…); with an own domain: app.<domain>/app. APP_URL builds for another address.
export const appUrl = (process.env.APP_URL || 'https://autark-theta.vercel.app/app').trim().replace(/\/+$/, '');

/** Why `url` cannot carry the iPhone app next to a site at `siteUrl` (undefined: it can). */
export function appOriginProblem(url, siteUrl = site.url) {
  let app;
  try { app = new URL(`${url}/`); } catch { return `APP_URL is no address: ${url}`; }
  if (app.protocol !== 'https:' && app.hostname !== 'localhost' && app.hostname !== '127.0.0.1') return 'The iPhone app needs https.';
  const shared = [new URL(`${siteUrl}/`).host, 'metajarvis.teydralab.com'];
  if (shared.includes(app.host)) return `The iPhone app cannot share ${app.host} with the site or Meta Jarvis: storage and keys belong to the origin.`;
  if (app.pathname === '/') return 'The iPhone app needs a folder of its own (e.g. https://app.example.com/app).';
  const base = new URL(`${siteUrl}/`).pathname;
  if (base !== '/' && app.pathname.startsWith(base)) return `The iPhone app's folder must lie outside the site's base path ${base}.`;
  return undefined;
}
// The meeting server the iPhone app pairs through: the same one every PC uses (apps/desktop shared/model/relay.ts
// DEFAULT_RELAY); AUTARK_RELAY builds the site against another one (a local test server).
export const appRelay = (process.env.AUTARK_RELAY || 'wss://telecoding-relay.onrender.com/autark').trim();
