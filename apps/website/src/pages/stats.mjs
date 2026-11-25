import { page, esc } from '../layout.mjs';
import { counts } from '../config.mjs';
// /stats/ – the team's private view of the anonymous counters (download clicks per platform and day, use of the app per
// hour). Not linked anywhere, not in the sitemap, noindex. Nothing is shown without a Google sign-in whose verified
// address the Firestore rules accept; the page itself holds no data. assets/stats.js loads Firebase sign-in from Google
// only after the visitor presses the button (or was signed in here before), so a stranger who opens the address loads
// nothing from Google. Never: counts a visit, sets a cookie, reads anything without the rules' consent.
export default function stats(rel) {
  const cfg = counts?.authKey ? { project: counts.project, key: counts.key, authKey: counts.authKey } : null;
  return page({ slug: 'stats', rel, title: 'Counts', description: 'Private page of the Autark team.', noindex: true, body: (root) => `
<section class="section stats">
  <div class="wrap">
    <h1 class="stats__h">Counts</h1>
    <p class="muted stats__lead">Anonymous download clicks and use of Autark. Private: sign in with a Google account of the team.</p>
    <div id="stats" ${cfg ? `data-project="${esc(cfg.project)}" data-key="${esc(cfg.key)}" data-auth-key="${esc(cfg.authKey)}"` : ''}>
      <noscript><p>This page needs JavaScript.</p></noscript>
      ${cfg ? `<p><button type="button" class="btn btn--ink" id="stats-signin">Sign in with Google</button></p>` : '<p class="muted">Not configured in this build.</p>'}
      <p id="stats-msg" class="stats__msg" role="status"></p>
      <div id="stats-view" hidden>
        <div class="stats__bar">
          <div class="stats__range" role="group" aria-label="Range">
            <button type="button" data-days="14">14 days</button><button type="button" data-days="30" aria-pressed="true">30 days</button><button type="button" data-days="90">90 days</button><button type="button" data-days="365">1 year</button>
          </div>
          <button type="button" class="stats__out" id="stats-out">Sign out</button>
        </div>
        <div class="stats__cards" id="stats-cards"></div>
        <h2 class="stats__h2">Downloads per day</h2>
        <p class="muted small">Clicks on a download button of this website, per UTC day.</p>
        <div class="stats__chart" id="chart-dl"></div>
        <h2 class="stats__h2">Active devices per day</h2>
        <p class="muted small">Devices that sent their first usage signal of the UTC day, per platform.</p>
        <div class="stats__chart" id="chart-dev"></div>
        <h2 class="stats__h2">When Autark is used</h2>
        <p class="muted small">Average number of devices in use per hour of the day, Vienna time (one signal per device and hour).</p>
        <div class="stats__chart" id="chart-hour"></div>
      </div>
    </div>
  </div>
</section>
<script type="module" src="${root}assets/stats.js"></script>
` });
}
