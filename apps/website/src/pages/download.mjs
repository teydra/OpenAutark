// Owns: the download overview at /download/ (PC first, then phone) and, through `subpages`, the
// per-platform pages at /download/<id>/ (src/platform.mjs).
// Never: install wording (data/install.mjs) or file names (config.mjs).
import { site, release, downloads, platforms, maker, counts } from '../config.mjs';
import { page, pageHero, esc, downloadButton, platformRows } from '../layout.mjs';
import { icon } from '../icons.mjs';
import { platformPages } from '../platform.mjs';

export const subpages = platformPages;

export default function downloadPage(rel) {
  const W = rel.windows;
  const { files, app } = release;
  const stable = downloads.map((d) => ({ ...d, url: `${site.url}/${d.path}` }));
  const short = {
    windows: 'Code-signed. SmartScreen may still ask once: <em>More info</em> → <em>Run anyway</em>. No admin rights needed.',
    mac: 'macOS refuses once: <em>System Settings → Privacy &amp; Security → Open Anyway</em>.',
    linux: '<code>chmod +x</code> and run. Needs FUSE 2 and a system keyring.',
    android: 'Allow installs from your browser once, then type your PC’s Remote ID.',
    iphone: 'Open the web app in Safari, <em>Share</em> → <em>Add to Home Screen</em>, type your PC’s Remote ID. No App Store, no Apple account.',
  };

  return page({
    slug: 'download',
    rel,
    title: `Download ${site.name}`,
    description: `Download ${site.name} ${W.version} for Windows, macOS or Linux, and the Android app, free and without an account; on iPhone it is a web app on the Home Screen, no App Store needed. One page per platform with the install steps, plus requirements, checksums and permanent links.`,
    ld: [{
      '@type': 'ItemList', name: `${site.name} downloads`, numberOfItems: platforms.length,
      itemListElement: platforms.map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: `${site.name} for ${p.os}`, url: `${site.url}/download/${p.id}/` })),
    }],
    body: (root) => `
${pageHero({
  root, crumb: 'Download',
  title: `Get <em>${site.name}.</em>`,
  lead: `Free for Windows, macOS and Linux, with an Android app and an iPhone web app. No account, no subscription from us. Agents get full access to the PC you install it on, so please read <a href="${root}access/">what that means</a>.`,
  actions: `${downloadButton(root, { auto: true })}<a class="btn btn--ghost btn--lg" href="#platforms">Every device${icon('arrowDown', 'ic--move')}</a>`,
})}
<section class="section section--tight" id="platforms">
  <div class="wrap">
    ${platformRows(root)}
    <p class="small muted" style="margin-top:22px">Every link here always points to the newest public release. <a href="${release.releasesUrl}" rel="noopener">All releases on GitHub</a> · <a href="${root}changelog/">Changelog</a>${counts ? ` · A click on a download button is counted anonymously, as a number only: <a href="${root}privacy/#counts">what and why</a>` : ''}</p>
  </div>
</section>

<section class="section section--line" id="install">
  <div class="wrap layout-doc">
    <nav class="toc" aria-label="On this page"><b>On this page</b><a href="#needs">What you need</a><a href="#steps">Install</a><a href="#first">First start</a><a href="#verify">Check the file</a><a href="#updates">Updates</a><a href="#links">Permanent links</a><a href="#remove">Uninstall</a></nav>
    <div class="prose">
      <h2 id="needs">What you need</h2>
      <ul>
        <li><strong>A computer with Windows 10 or 11 (x64), macOS (Apple silicon or Intel), or Linux x64.</strong> ${site.name} is built and tested against an ordinary 8 GB RAM laptop; the heavy AI work happens at your AI provider unless you choose a local model. Your phone joins a company that runs on a PC.</li>
        <li><strong>At least one AI.</strong> A ChatGPT plan (used through OpenAI Codex), a paid Claude plan (used through Claude Code), an API key, or a local model server (Ollama, LM Studio, llama.cpp, vLLM). Claude Free cannot run agents.</li>
        <li><strong>An internet connection</strong> for your AI provider, for updates and for the local search model, which is downloaded the first time it is needed (about 135 MB).</li>
      </ul>

      <h2 id="steps">Install</h2>
      <p>The Windows installer is code-signed; the Mac app is not notarized. Each system may still ask once. Each platform page shows exactly what you will see.</p>
      <table>
        <tbody>${platforms.map((p) => `<tr><td><a href="${root}download/${p.id}/">${p.os}</a></td><td>${short[p.id]}</td></tr>`).join('')}</tbody>
      </table>

      <h2 id="first">The first start</h2>
      <ol>
        <li><strong>Connect one AI.</strong> Sign in through the official tool of your provider; the app can install Codex or Claude Code for you and tests them with a real answer. Each added account lives in its own folder.</li>
        <li><strong>Type your name and company,</strong> and press Start.</li>
        <li><strong>Answer the first question.</strong> Your manager asks how far it may go on this PC.</li>
      </ol>
      <div class="callout">${icon('bolt')}<div><strong>Agents have full access from the first moment.</strong> The question is how you tell them what you want. It closes nothing technically. <a href="${root}access/">What that means</a></div></div>

      <h2 id="verify">Check the file</h2>
${rel.sums && Object.keys(rel.sums).length ? `      <table>
        <thead><tr><th>File</th><th>Version</th><th>SHA-256</th></tr></thead>
        <tbody>${platforms.filter((p) => p.file && rel.sums[p.file]).map((p) => `<tr><td>${p.os}<br><span class="small muted"><code>${esc(p.file)}</code></span></td><td>${esc(rel[p.id]?.version || 'latest')}</td><td><code class="plat-hash">${esc(rel.sums[p.file])}</code></td></tr>`).join('')}</tbody>
      </table>
` : ''}      <p>Every release publishes <a href="${release.asset('SHA256SUMS.txt')}" rel="nofollow">SHA256SUMS.txt</a> with the SHA-256 hash of each file. In PowerShell, in your Downloads folder:</p>
      <p><code>Get-FileHash .\\${files.windows} -Algorithm SHA256</code> <button class="btn btn--sm btn--ghost" type="button" data-copy="Get-FileHash .\\${files.windows} -Algorithm SHA256" style="margin-left:8px;vertical-align:middle">Copy</button></p>
      <p>The hash must match the line for <code>${files.windows}</code> in SHA256SUMS.txt. On macOS use <code>shasum -a 256 &lt;file&gt;</code>, on Linux or Android <code>sha256sum &lt;file&gt;</code>. A match shows the file arrived as published. It does not replace a signature.</p>

      <h2 id="updates">Updates</h2>
      <p>${site.name} checks GitHub Releases every minute while the window is open and every 15 minutes from the tray. A small icon appears only when an update exists. On Windows and Linux one click downloads it, verifies it against the SHA-512 in the update manifest, installs it, and the app opens again by itself. Your agents, chats and settings stay where they are.</p>
      <p>On macOS the app replaces itself where macOS allows it, and otherwise the icon leads to the download. That path is new and has not run on a real Mac yet. The Android app shows a line at the top when a new APK exists; <em>Update</em> downloads it in the app with its progress, and Android installs it after you confirm. Most changes need none, because the interface comes from your PC.</p>

      <h2 id="links">Permanent links</h2>
      <p>Use these addresses to link to ${site.name} from anywhere: in posts, docs or from the app itself. Each one opens the page for that platform here, even if the release channel moves; the file itself is on <a href="${release.releasesUrl}" rel="noopener">GitHub Releases</a>. The older <code>${site.url}/download/windows</code>, <code>/mac</code> and <code>/linux</code> addresses keep working and open the platform pages.</p>
      <table>
        <thead><tr><th>File</th><th>Permanent link</th></tr></thead>
        <tbody>${stable.map((d) => `<tr><td>${d.os}<br><span class="small muted">${esc(d.detail)}</span></td><td><code>${d.url}</code> <button class="btn btn--sm btn--ghost" type="button" data-copy="${d.url}" style="margin-left:6px">Copy</button></td></tr>`).join('')}</tbody>
      </table>

      <h2 id="remove">Uninstall</h2>
      <p>On Windows open <em>Settings → Apps → Installed apps</em>, find <em>${app.name}</em> and choose <em>Uninstall</em>. On macOS drag the app to the Trash. On Linux delete the AppImage. On Android uninstall the app like any other. Your data stays until you delete the folders yourself: <a href="${root}access/#data">where they are</a>. If you want to keep your company on another PC, use <em>Back up</em> in Settings › ${app.settingsHome} first.</p>
      <p>Something wrong? <a href="${maker.feedbackUrl}" rel="noopener">Report a problem on GitHub</a>.</p>
    </div>
  </div>
</section>`,
  });
}
