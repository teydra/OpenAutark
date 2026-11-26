// Owns: the start page, kept short on purpose (Konrad 26.11.2026, task_xbgv3vd6): the promise with ONE download button
// that finds the visitor's own platform, the way it works in three steps, then the shared footer.
// Never: facts of its own, a platform list (that lives on /download/ only), or the long story; the details
// live on /product/, /how-it-works/, /access/, /compare/, /faq/ and /about/.
import { site, maker } from '../config.mjs';
import { page, kword, downloadButton, stOf } from '../layout.mjs';
import { icon } from '../icons.mjs';

const st = stOf('home');

export default function home(rel) {
  return page({
    slug: '',
    rel,
    title: `${site.name} — your own AI company that works on its own`,
    description: `${site.name} is a free app for Windows, macOS and Linux, with an Android app and an iPhone web app, that turns the ChatGPT and Claude plans you already pay for into your own AI company: a manager, specialist agents and a secretary that work proactively on your own computer.`,
    body: (root) => `
<section class="hero" id="top">
  <div class="wrap" style="display:flex;flex-direction:column;flex:1">
    <div class="hero__top" data-reveal>
      <span class="eyebrow">By ${maker.company} · ${maker.location}</span>
      <span class="eyebrow eyebrow--plain"><span class="eyebrow__n" data-rel="windows-version">Version ${rel.windows.version}</span> · Free download</span>
    </div>
    <div class="hero__word">${kword('hero__kword')}</div>
    <div class="hero__body">
      <div>
        <h1 class="hero__title" data-reveal><span class="sr">${site.name}: </span>Your own AI company. <em>It doesn’t wait</em> for a prompt.</h1>
        <p class="lead hero__lead" data-reveal style="--d:1">A manager, specialist agents and a secretary that pick up work, split it up, finish it and report back — on your own computer, with the ChatGPT and Claude plans you already pay for.</p>
      </div>
      <div class="hero__side" data-reveal style="--d:2">
        <div class="btns">
          ${downloadButton(root, { auto: true })}
        </div>
        <p class="hero__other small"><a class="link" href="${root}download/">Other devices${icon('arrow')}</a></p>
        <div class="hero__note"><span>${icon('check')}No account</span><span>${icon('check')}No subscription from us</span><span>${icon('check')}Your data lives on your PC</span></div>
      </div>
    </div>
  </div>
</section>

<section class="section section--paper2" id="how">
  <div class="wrap">
    <div class="head head--split">
      <div><span class="eyebrow" data-reveal>How it works</span>
      <h2 class="h2" data-reveal style="margin-top:22px">Say it once. <em>Your company</em> takes it from there.</h2></div>
      <p class="lead" data-reveal style="--d:1">${site.name} is not another chatbot. It is an organisation: a manager who routes the work, specialists who do it, and you, who are asked only about what really needs you.</p>
    </div>
    <div class="steps">
      <article class="step" data-reveal>
        <div class="step__demo" aria-hidden="true"><div class="split" data-split>
          <div class="split__say">${icon('mic')}<span data-split-text></span></div>
          <div class="split__task"><span class="av">I</span>Research the three closest competitors<em>Ivo</em></div>
          <div class="split__task"><span class="av">L</span>Draft the newsletter for Friday<em>Lena</em></div>
          <div class="split__task"><span class="av av--me">Y</span>Call the printer about the flyers<em>You</em></div>
        </div></div>
        <div class="step__txt"><span class="step__n">01 — Task</span><h3 class="h3">Say it once.</h3><p class="body">Type or dictate into one inbox. Your manager can split a long sentence into separate tasks, each with the right owner: an agent, or you.</p></div>
      </article>
      <article class="step" data-reveal style="--d:1">
        <div class="step__demo" aria-hidden="true"><div class="log" data-log></div></div>
        <div class="step__txt"><span class="step__n">02 — Agents</span><h3 class="h3">Your team does it.</h3><p class="body">Agents delegate among themselves, open your apps, browse, read files and write things down. The steps land in a run journal you can read.</p></div>
      </article>
      <article class="step" data-reveal style="--d:2">
        <div class="step__demo" aria-hidden="true"><div class="askdemo"><div class="card" data-ask>
          <div class="card__top"><span class="tiny muted">First start · About you</span></div>
          <div class="card__title">How far may your team go?</div>
          <div class="card__meta">You can change it later in Settings › Security.</div>
          <div class="card__btns" style="grid-template-columns:1fr 1fr"><span>Trust AI</span><span>Secure</span></div>
          <div class="card__note">${icon('chat')}Trust AI: text steers · Secure: the app asks</div>
        </div></div></div>
        <div class="step__txt"><span class="step__n">03 — You</span><h3 class="h3">You choose how far it goes.${st('security-modes')}</h3><p class="body">On the first start you pick Trust AI, where agents work with your rights and your words steer them, or Secure, where the app asks you before every command. Every message after that steers them too.</p></div>
      </article>
    </div>
    <p data-reveal style="margin-top:36px"><a class="link" href="${root}how-it-works/">How it works in detail${icon('arrow')}</a></p>
  </div>
</section>`,
  });
}
