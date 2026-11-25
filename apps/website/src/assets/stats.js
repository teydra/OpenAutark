/* Owns: the private /stats/ page – Google sign-in (Firebase Auth from gstatic, loaded only after the button or an earlier
   sign-in here), reading the anonymous counters with the signed-in token, and three small SVG charts.
   Never: runs without the page's #stats element, counts anything, or reads without the Firestore rules' consent. */
const root = document.getElementById('stats');
if (root?.dataset.project) {
  const { project, key, authKey } = root.dataset;
  const FB = 'https://www.gstatic.com/firebasejs/13.4.0';
  const $ = (s) => document.querySelector(s);
  const msg = (t) => { $('#stats-msg').textContent = t || ''; };
  const MARK = 'autark-stats-signed-in';
  const PLATFORMS = { windows: 'Windows', mac: 'macOS', linux: 'Linux', android: 'Android', ios: 'iPhone' };
  const COLORS = { windows: '#2f6fed', mac: '#7a5af8', linux: '#e2a400', android: '#17a169', ios: '#e5484d' };
  const DL_GROUP = { windows: 'windows', mac: 'mac', 'mac-zip': 'mac', linux: 'linux', android: 'android', 'android-full': 'android' };
  const DOCS = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
  let auth; let days = 30;
  let dl = []; let use = [];

  const pad = (n) => String(n).padStart(2, '0');
  const dayOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
  const viennaHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Vienna', hour: '2-digit', hourCycle: 'h23' });
  const label = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const svgNs = 'http://www.w3.org/2000/svg';
  const h = (name, attrs = {}, text) => { const e = document.createElementNS(svgNs, name); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };

  // ── data: every document of a collection from `since` on, read with the signed-in token ──
  async function read(coll, since) {
    const token = await auth.currentUser.getIdToken();
    const out = [];
    let after = `projects/${project}/databases/(default)/documents/${coll}/${since}`;
    let op = 'GREATER_THAN_OR_EQUAL';
    for (;;) {
      const res = await fetch(`${DOCS}:runQuery?key=${key}`, {
        method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ structuredQuery: { from: [{ collectionId: coll }], where: { fieldFilter: { field: { fieldPath: '__name__' }, op, value: { referenceValue: after } } }, orderBy: [{ field: { fieldPath: '__name__' } }], limit: 2000 } }),
      });
      if (res.status === 403) throw new Error('This Google account may not read the counts.');
      if (!res.ok) throw new Error(`Google answered ${res.status}.`);
      const rows = (await res.json()).filter((r) => r.document);
      for (const r of rows) out.push({ id: r.document.name.split('/').pop(), n: Number(r.document.fields?.n?.integerValue ?? 0), dev: Number(r.document.fields?.dev?.integerValue ?? 0) });
      if (rows.length < 2000) return out;
      after = rows[rows.length - 1].document.name; op = 'GREATER_THAN';
    }
  }

  async function load() {
    msg('Loading …');
    const since = dayOf(addDays(new Date(), -365));
    try {
      [dl, use] = await Promise.all([read('dl', since), read('use', since)]);
      dl = dl.map((r) => { const m = /^(\d{4}-\d{2}-\d{2})_([a-z-]+)$/.exec(r.id); return m && DL_GROUP[m[2]] ? { day: m[1], p: DL_GROUP[m[2]], n: r.n } : null; }).filter(Boolean);
      use = use.map((r) => { const m = /^(\d{4}-\d{2}-\d{2})-([a-z]+)-(\d{2})$/.exec(r.id); return m ? { day: m[1], p: m[2], hour: Number(m[3]), n: r.n, dev: r.dev } : null; }).filter(Boolean);
      msg('');
      $('#stats-signin')?.parentElement.setAttribute('hidden', '');
      $('#stats-view').hidden = false;
      render();
    } catch (e) { msg(e.message || 'Could not load the counts.'); }
  }

  // ── charts ──
  const W = 640; const H = 220; const M = { l: 34, r: 8, t: 10, b: 24 };
  const niceMax = (v) => { if (v <= 4) return 4; const p = 10 ** Math.floor(Math.log10(v)); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
  // cols: [{ name, parts: {platform: value} }]; kind 'bars' stacks, 'lines' draws one line per platform.
  function chart(el, cols, kind, unit) {
    el.replaceChildren();
    const plats = Object.keys(PLATFORMS).filter((p) => cols.some((c) => c.parts[p]));
    if (!cols.length || !plats.length) { el.append(Object.assign(document.createElement('p'), { className: 'muted small', textContent: 'No counts in this range yet.' })); return; }
    const tot = (c) => plats.reduce((s, p) => s + (c.parts[p] || 0), 0);
    const max = niceMax(Math.max(...cols.map((c) => (kind === 'bars' ? tot(c) : Math.max(...plats.map((p) => c.parts[p] || 0))))));
    const iw = W - M.l - M.r; const ih = H - M.t - M.b; const step = iw / cols.length;
    const y = (v) => M.t + ih - (v / max) * ih;
    const svg = h('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', class: 'stats__svg' });
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i; svg.append(h('line', { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: 'stats__grid' }), h('text', { x: M.l - 5, y: y(v) + 4, class: 'stats__tick', 'text-anchor': 'end' }, String(Math.round(v * 10) / 10)));
    }
    const every = Math.ceil(cols.length / 8);
    cols.forEach((c, i) => { if (i % every === 0) svg.append(h('text', { x: M.l + step * (i + 0.5), y: H - 6, class: 'stats__tick', 'text-anchor': 'middle' }, c.name)); });
    if (kind === 'bars') {
      cols.forEach((c, i) => { let base = 0; for (const p of plats) { const v = c.parts[p] || 0; if (!v) continue; svg.append(h('rect', { x: M.l + step * i + step * 0.12, width: Math.max(1, step * 0.76), y: y(base + v), height: y(base) - y(base + v), fill: COLORS[p] })); base += v; } });
    } else {
      for (const p of plats) {
        const pts = cols.map((c, i) => [M.l + step * (i + 0.5), y(c.parts[p] || 0)]);
        svg.append(h('polyline', { points: pts.map((q) => q.join(',')).join(' '), fill: 'none', stroke: COLORS[p], 'stroke-width': 2, 'stroke-linejoin': 'round' }));
        if (cols.length <= 45) for (const q of pts) svg.append(h('circle', { cx: q[0], cy: q[1], r: 2.5, fill: COLORS[p] }));
      }
    }
    const cursor = h('line', { y1: M.t, y2: M.t + ih, class: 'stats__cursor', visibility: 'hidden' });
    svg.append(cursor);
    const read = document.createElement('p'); read.className = 'stats__read'; read.textContent = 'Tap or move over the chart for the numbers.';
    const show = (ev) => {
      const r = svg.getBoundingClientRect(); const x = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.min(cols.length - 1, Math.max(0, Math.floor((x - M.l) / step)));
      cursor.setAttribute('x1', M.l + step * (i + 0.5)); cursor.setAttribute('x2', M.l + step * (i + 0.5)); cursor.setAttribute('visibility', 'visible');
      const c = cols[i];
      read.textContent = `${c.title || c.name}: ${plats.filter((p) => c.parts[p]).map((p) => `${PLATFORMS[p]} ${Math.round(c.parts[p] * 10) / 10}`).join(' · ') || '0'}${unit ? ` ${unit}` : ''}`;
    };
    svg.addEventListener('pointermove', show); svg.addEventListener('pointerdown', show);
    const legend = document.createElement('p'); legend.className = 'stats__legend';
    for (const p of plats) { const s = document.createElement('span'); s.innerHTML = `<i style="background:${COLORS[p]}"></i>${PLATFORMS[p]}`; legend.append(s); }
    el.append(svg, read, legend);
  }

  function render() {
    const end = new Date(); const dayList = []; for (let i = days - 1; i >= 0; i--) dayList.push(dayOf(addDays(end, -i)));
    const from = dayList[0];
    const dlIn = dl.filter((r) => r.day >= from); const useIn = use.filter((r) => r.day >= from);
    const byDay = (rows, field) => dayList.map((d) => { const parts = {}; for (const r of rows) if (r.day === d) parts[r.p] = (parts[r.p] || 0) + r[field]; return { name: label(d), title: label(d), parts }; });
    chart($('#chart-dl'), byDay(dlIn, 'n'), 'bars', 'downloads');
    chart($('#chart-dev'), byDay(useIn, 'dev'), 'lines', 'devices');
    // hour of the day in Vienna time: each UTC hour of each day is mapped on its own, so summer and winter time are right
    const hours = Array.from({ length: 24 }, (_, i) => ({ name: pad(i), title: `${pad(i)}:00–${pad(i)}:59`, parts: {} }));
    const seen = new Set(useIn.map((r) => r.day));
    for (const r of useIn) { const hv = Number(viennaHour.format(new Date(`${r.day}T${pad(r.hour)}:00:00Z`))); hours[hv].parts[r.p] = (hours[hv].parts[r.p] || 0) + r.n; }
    const nDays = Math.max(1, seen.size);
    for (const c of hours) for (const p of Object.keys(c.parts)) c.parts[p] /= nDays;
    chart($('#chart-hour'), hours, 'bars', 'devices on average');
    // cards
    const sum = (rows, f) => rows.reduce((s, r) => s + r[f], 0);
    const today = dayOf(end); const yesterday = dayOf(addDays(end, -1));
    const peak = hours.reduce((b, c) => (Object.values(c.parts).reduce((s, v) => s + v, 0) > Object.values(b.parts).reduce((s, v) => s + v, 0) ? c : b), hours[0]);
    const cards = [
      [`Downloads, ${days} days`, sum(dlIn, 'n')], ['Downloads today (UTC)', sum(dl.filter((r) => r.day === today), 'n')],
      ['Active devices yesterday', sum(use.filter((r) => r.day === yesterday), 'dev')], ['Active devices today (UTC)', sum(use.filter((r) => r.day === today), 'dev')],
      ['Busiest hour (Vienna)', Object.keys(peak.parts).length ? `${peak.name}:00` : '–'],
    ];
    $('#stats-cards').replaceChildren(...cards.map(([t, v]) => { const d = document.createElement('div'); d.className = 'stats__card'; d.innerHTML = '<b></b><span></span>'; d.firstChild.textContent = v; d.lastChild.textContent = t; return d; }));
  }

  // ── sign-in ──
  // Google's script is fetched only when asked for. Browsers allow the sign-in popup only straight after a tap, so the
  // first tap loads the sign-in code and the second one opens Google.
  let A;
  async function sdk() {
    if (A) return;
    const [{ initializeApp }, a] = await Promise.all([import(`${FB}/firebase-app.js`), import(`${FB}/firebase-auth.js`)]);
    A = a; auth = A.getAuth(initializeApp({ apiKey: authKey, authDomain: `${project}.firebaseapp.com`, projectId: project }));
    $('#stats-out').onclick = async () => { await A.signOut(auth); localStorage.removeItem(MARK); location.reload(); };
  }
  async function signedIn() {
    await auth.authStateReady();
    if (!auth.currentUser) return false;
    localStorage.setItem(MARK, '1');
    await load();
    return true;
  }
  const button = $('#stats-signin');
  button.addEventListener('click', async () => {
    try {
      if (!A) { msg('Loading sign-in …'); await sdk(); if (await signedIn()) return; msg(''); button.textContent = 'Continue with Google'; return; }
      msg('Opening Google …');
      await A.signInWithPopup(auth, new A.GoogleAuthProvider());
      await signedIn();
    } catch (e) { msg(e?.code === 'auth/popup-closed-by-user' ? '' : `Sign-in failed: ${e?.code || e?.message || e}`); }
  });  document.querySelectorAll('.stats__range button').forEach((b) => b.addEventListener('click', () => {
    days = Number(b.dataset.days); document.querySelectorAll('.stats__range button').forEach((o) => o.setAttribute('aria-pressed', String(o === b))); if (auth?.currentUser) render();
  }));
  if (localStorage.getItem(MARK)) button.click();
}
