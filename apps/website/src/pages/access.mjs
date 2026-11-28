// Owns: /access/ (access and data): what agents can do on the PC, secrets by ID, where data and backups live,
// and the unsigned-build steps.
// Never: capability facts (data/features.mjs) or install steps (data/install.mjs).
import { site, release, maker } from '../config.mjs';
import { page, pageHero, statusPill, downloadButton, abs, legend, stOf } from '../layout.mjs';
import { icon } from '../icons.mjs';
import { installSteps } from '../data/install.mjs';

const st = stOf('access');

// [id, label in the table of contents, heading in the text]
const sections = [
  ['short', 'In short', 'In short'],
  ['access', 'Two modes', 'Two modes: Trust AI and Secure'],
  ['first-question', 'The first questions', 'The first questions'],
  ['steering', 'What steers them', 'What steers them'],
  ['secrets', 'Secrets', 'Secrets are referred to by ID'],
  ['accounts', 'AI sign-ins', 'Your AI sign-ins'],
  ['data', 'Where your data lives', 'Where your data lives'],
  ['leaves', 'What leaves your PC', 'What leaves your PC'],
  ['backups', 'Backups', 'Backups and export'],
  ['stop', 'Stopping work', 'Stopping work'],
  ['journal', 'What is written down', 'What is written down'],
  ['others', 'Who else can reach it', 'Who else can reach it'],
  ['unsigned', 'Signing', 'How the builds are signed, and what you will see'],
  ['updates', 'Updates', 'Updates'],
  ['limits', 'Not proven yet', 'What is not proven yet'],
  ['report', 'Report a problem', 'Reporting a problem'],
];
const h2 = (id) => `<h2 id="${id}">${sections.find((s) => s[0] === id)[2]}</h2>`;

// Rules inside .prose: keep the .rule heading size (the prose h3 rule would override it).
const ruleH = 'style="margin-top:0;font-size:17.5px;line-height:1.3"';
const short = [
  ['bolt', 'You choose one of two modes', 'Trust AI, preselected: agents may do everything your user account can. Secure: the app asks you before commands and before anything outside its own folders, and spending stays closed. You can switch later in Settings › Security.'],
  ['chat', 'In Trust AI mode, text steers', 'Agents follow the agreements you can read and change, their rules and skills, and what you say. That is guidance, not a technical barrier. Three switches can make the app ask first: spending, messages and publishing.'],
  ['key', 'Secret values stay out of prompts', 'Agents refer to a secret by its ID and the app fills the value in at the last moment. That protects against leaks, not against an agent set on getting a value.'],
  ['pc', 'Your data lives on your PC', `No ${site.name} server holds your data, and there is no account with us. Prompts go to the AI providers you connect.`],
  ['hash', 'Windows is signed, macOS is not notarized', 'The Windows installer is code-signed, though SmartScreen may warn once. macOS warns you, and you confirm by hand. The steps are below.'],
];

export default function (rel) {
  const url = abs('access');
  const { app, files } = release;

  return page({
    slug: 'access',
    rel,
    title: 'Access and data',
    description: `What ${site.name} really does on your PC: two modes, Trust AI with full access and Secure where the app asks first, secrets are used by ID, data and backups stay on your disk, and how the builds are signed, with the Windows and Mac steps you will see.`,
    ld: [{
      '@type': 'TechArticle',
      '@id': `${url}#article`,
      headline: `Access and data in ${site.name}`,
      description: 'Trust AI and Secure mode, the first questions, secrets by ID, where data lives, what leaves the PC, backups, signing and install steps, and what is not proven yet.',
      inLanguage: site.lang,
      about: { '@id': `${site.url}/#software` },
      author: { '@id': 'https://teydralab.com/#organization' },
      publisher: { '@id': 'https://teydralab.com/#organization' },
      isPartOf: { '@id': `${url}#webpage` },
    }],
    body: (root) => `
${pageHero({
  root,
  crumb: 'Access and data',
  title: 'It can do <em>a lot.</em> You choose how much.',
  lead: `${site.name}’s agents work with your rights. In Trust AI mode text steers them; in Secure mode the app asks you before commands and before anything outside its own folders. This page says plainly what the app does and does not do on your PC, where your data lives, what you will see when you install it, and what is not proven yet.`,
})}

<section class="section section--tight">
  <div class="wrap layout-doc">
    <nav class="toc" aria-label="On this page"><b>On this page</b>${sections.map(([id, label]) => `<a href="#${id}">${label}</a>`).join('')}</nav>

    <div style="min-width:0">
      ${legend(rel)}

      <div class="prose">
        ${h2('short')}
        <div class="rules">
          ${short.map(([ic, h, p]) => `<div class="rule">${icon(ic)}<div><h3 ${ruleH}>${h}</h3><p>${p}</p></div></div>`).join('\n          ')}
        </div>

        ${h2('access')}
        <p>On the first start you choose a mode${st('security-modes')}. Trust AI is preselected, and a company set up before the modes existed runs in Trust AI. You can change the mode later in Settings › Security, after confirming twice. Each PC keeps its own mode, and an agent works under the rules of the PC its step runs on.</p>

        <h3>Trust AI mode</h3>
        <p>Agents run as you. Claude Code runs with permissions bypassed; Codex runs with full access, and the app accepts its approval requests at once. So an agent can:</p>
        <ul>
          <li>read, change and delete any file your user account can, private ones included;</li>
          <li>run any command and install programs;</li>
          <li>use a browser, and on Windows or Linux with X11 your mouse and keyboard;</li>
          <li>on Windows, with ${site.name}’s desktop service, unlock the screen and answer Windows prompts with a password from the catalog;</li>
          <li>use every secret in the catalog on any site, including a saved card, so it can spend money;</li>
          <li>send mail and messages through what you connected, and publish;</li>
          <li>do the same on a PC you linked.</li>
        </ul>
        <p>What you write in Settings › Security, one text per topic, tells the team when to check with you. Three switches can be set to Ask: spending money, messages to other people and publishing. Then the app asks you before its own tools take such a step, for example a stored card, a message through a connected app or a post. They do not catch a step an agent clicks through on a website. There is no guardian model and no money limit.</p>

        <h3>Secure mode</h3>
        <p>Agents work freely in the company’s own folders: the workspace, each agent’s own folder, memory and the temp folders. Everything else goes through a gate in the app, for ${site.name}’s own tools and for the engines’ own tools alike: Claude Code runs in its default permission mode and Codex in its write sandbox, and both hand their permission requests to that gate. As set up for a new Secure company, the app asks you before an agent:</p>
        <ul>
          <li>reads or changes files outside those folders (folders you add are open from then on);</li>
          <li>runs a command;</li>
          <li>operates an app on this PC, or your phone;</li>
          <li>writes to people outside the company or publishes;</li>
          <li>signs in or uses a stored password;</li>
          <li>changes ${site.name}’s own setup.</li>
        </ul>
        <p>You answer once, always for this setting, always for this place, or decline. The request also lands in My day and on your phone. A declined step does not run: the agent reads “BLOCKED – not executed”, and the chat shows a short “Blocked: …” line.</p>
        <p>Closed whatever a switch says: spending money (the app refuses stored cards and its spending tools), ${site.name}’s own window, its security settings, and the Windows lock screen and Windows prompts. Linking another PC is left to you in Settings › Devices.</p>
        <p><strong>What Secure mode does not cover:</strong></p>
        <ul>
          <li><strong>The web is open by default.</strong> Agents browse and search without asking, also on sites where their browser is already signed in. A purchase or a post clicked through such a site is not stopped by code. You can set the web to Ask.</li>
          <li><strong>An allowed command is not checked for what it does.</strong> The app decides whether a command may run, not which files it touches. “Always” for commands opens every command.</li>
          <li><strong>Codex reads through commands.</strong> Commands Codex counts as harmless, such as listing a folder or printing a file, run without a question, and its sandbox limits writing, not reading.</li>
          <li><strong>Hiring and changing agents</strong> is open by default.</li>
          <li><strong>Programs outside the app</strong>, such as a script an agent started earlier, are not checked (see <a href="#others">who else can reach it</a>).</li>
        </ul>
        <div class="callout">${icon('bolt')}<p><strong>Full access has real consequences.</strong> In our own live test runs, agents given a vague request reached real repositories, backups, SSH keys and <code>.env</code> files within minutes, and one changed the permissions of a file it had found. So we run those tests under a throwaway profile, with a watcher that exists only on our test bench. Secure mode is new and has no outside audit. If this PC holds something you cannot afford to have touched, give ${site.name} its own Windows user or a virtual machine, in either mode.</p></div>

        ${h2('first-question')}
        <p>The first run is short${st('first-question')}: a short tour, connect one AI, type your name and company, choose the mode, press Start. Then the app posts a start line in your manager’s chat, in your name and marked as the app’s, and the manager’s first message below it. That message asks a few questions: which language to use, how independently to work, whether to set up this PC itself, what to call the team and how to build it. Answer what matters to you; the rest it decides.</p>
        <p><strong>Your answers change no setting.</strong> They tell the team what you want, and the manager keeps them as agreements; a model follows them because you said so. In Trust AI mode that is all that holds it back. You can read and replace this text: an own <code>prompts/onboarding.md</code> in the data folder takes its place.</p>

        ${h2('steering')}
        <p>Agents act on what they read, so that is where the care goes, in both modes. All of it is plain text you can open and change.</p>
        <ul>
          <li><strong>The rules every agent gets</strong> (<code>rules.md</code>), for example: before something you cannot undo, such as deleting, paying or sending to outsiders, check target, amount and recipient once.</li>
          <li><strong>Each agent’s instructions</strong> (<code>SYSTEM.md</code>), which you or the manager can edit.</li>
          <li><strong>Skills.</strong> The ones that matter most have their description in every prompt, so a model reads them before that kind of work.</li>
          <li><strong>Spending is a skill too</strong>${st('money-skill')}. It gives reference points to think with: roughly under 20 euros, buy when it is recognisably sensible; above that, it helps when the one above you was clear what is bought and why; for hundreds of euros, have a stronger model think it over once more. You can rewrite it. <strong>In Trust AI mode it is guidance: no code stops a purchase</strong> unless you set spending to Ask. In Secure mode spending is closed.</li>
          <li><strong>Your own words.</strong> A message at any time steers running work, and one marked important reaches it at once.</li>
        </ul>
        <p>Text can be wrong, and so can a model. A web page, a mail or a file can also contain instructions aimed at your agent. The app marks such content as untrusted when it hands it over, and that is a hint to the model, not a filter. Treat what an agent reads from outside as something that can influence it.</p>

        ${h2('secrets')}
        <p>Passwords and keys live in a catalog${st('vault')}, encrypted with your operating system’s protection: the Windows user key, the macOS keychain, the Linux keyring. If that protection is not available, the app stores nothing rather than falling back to plain text.</p>
        <ul>
          <li><strong>By ID.</strong> Agents see each secret’s name, description and ID, such as <code>secret://github</code>. The catalog’s text lies open in <code>secrets/</code> in the data folder, without a single value.</li>
          <li><strong>Values stay out of prompts.</strong> The value is filled in at the last moment: into a browser field, a command’s environment, a request header or a connector.</li>
          <li><strong>A field for it.</strong> The + in the message box has a Secret entry, so you hand over a key without typing it into a chat. Text you type into a normal message does reach the model.</li>
          <li><strong>Masking.</strong> Before a tool runs, a known value in its arguments is replaced by its ID, so it does not land in a note or file. In output, known values are masked, also as base64, URL-encoded or hex. Values under 8 characters are too short for this.</li>
          <li><strong>No site binding.</strong> Every secret works everywhere for every agent. That is deliberate. In Secure mode the app asks you before an agent uses a stored password, and refuses card data.</li>
        </ul>
        <p><strong>What this does not do:</strong> a command that receives a value can do anything with it, and masking only knows those encodings. It keeps values out of prompts and logs; it is not a barrier against an agent set on getting one. And it covers only the catalog. A password in a text file, a <code>.env</code> file or a browser export on your disk is as open to agents as any other file. Password import${st('import-pw')} reads such an export once and leaves the file where it is. Please delete it.</p>

        ${h2('accounts')}
        <p>You sign in to ChatGPT and Claude through the providers’ official tools, Codex and Claude Code${st('plans')}, each added account in its own folder under <code>accounts/</code>. ${site.name} does not read, copy or forward the tokens those tools keep, and there is nothing to sign in to on our side. An agent in Trust AI mode could still open those folders like any other, so this describes what the app does, not what an agent can reach. In Secure mode they are outside the folders agents read freely.</p>

        ${h2('data')}
        <dl class="kv">
          <dt>Data folder</dt><dd>Windows <code>${app.dataFolder.windows}</code>, macOS <code>${app.dataFolder.mac}</code>, Linux <code>${app.dataFolder.linux}</code>. Settings › ${app.settingsHome} opens it, and its <code>README.md</code> lists every entry and what editing it does.</dd>
          <dt>Database</dt><dd><code>workforce.db</code>: chats, tasks, runs and accounts, with secret values encrypted. Stored files are in <code>blobs/</code>.</dd>
          <dt>Plain files</dt><dd><code>settings.json</code>, <code>agents/</code>, <code>memory/</code>, <code>secrets/</code> (no values), <code>connectors/</code>, <code>prompts/</code>, <code>theme.css</code>, and a readable copy of your chats in <code>chats/</code>. What you and your agents change here, the app takes over.</dd>
          <dt>Workspace</dt><dd><code>${app.workspace}</code>: projects, downloads and shared skills.</dd>
          <dt>Uninstalling</dt><dd>Removes the app, not this data. Delete the folders yourself if you want it gone.</dd>
        </dl>
        ${release.renamed ? '' : `<p>The data folder still carries the working name. The rename release is built to move it once, in place, so there is no second app and no second folder ${statusPill('next')}. That move has been tested in code, not yet through a real update.</p>`}

        ${h2('leaves')}
        <p>No ${site.name} server holds your data, and the app has no analytics or usage reporting. Our meeting server only connects your devices and passes end-to-end encrypted traffic. Things do leave your PC, though, and these are the places:</p>
        <dl class="kv">
          <dt>Your AI provider</dt><dd>Everything an agent works with: your messages, its instructions, what it read, including private files if it opened them. That provider’s terms apply. With a local model it stays on your hardware.</dd>
          <dt>Model downloads</dt><dd>The small local search model (118 MB plus a 17 MB tokenizer, from huggingface.co) is fetched without asking the first time it is needed. Speech models come from huggingface.co or github.com when you pick them.</dd>
          <dt>Embeddings</dt><dd>If you choose an API provider for embeddings, pieces of text go there. Known secret values are replaced first.</dd>
          <dt>Web search</dt><dd>Codex and Claude Code use their own search. Otherwise search goes to DuckDuckGo or Bing, or to Brave, Tavily, Keenable or your SearXNG if you store a key for one. Keenable logs queries with or without a key (<a href="https://docs.keenable.ai/data-privacy" rel="noopener">its data and privacy page</a>).</dd>
          <dt>Other services</dt><dd>What agents open or connect sees the request, as if you did it: websites, connected apps, your mail server, Google Calendar, Telegram. When a mailbox is added, its domain may be looked up in Mozilla’s public mail directory and at the domain itself.</dd>
          <dt>Updates</dt><dd>The app asks GitHub for new versions. If you have it install Codex or Claude Code, it runs that provider’s official installer.</dd>
          <dt>Phone notifications</dt><dd>Small encrypted notifications through your phone browser’s push service, if you use them.</dd>
          <dt>Feedback</dt><dd>Reports, also those agents write, are saved on your PC. Nothing goes out unless you press send, and then it is encrypted on your PC so that only the Teydra team can read it. The app says whether this version can send at all.</dd>
        </dl>
        <p>For ${maker.company} as a company, see the <a href="${maker.privacyUrl}" rel="noopener">privacy policy</a> and the <a href="${maker.imprintUrl}" rel="noopener">imprint</a>.</p>

        ${h2('backups')}
        <ul>
          <li><strong>Back up</strong> in Settings › ${app.settingsHome} copies the data folder${st('backup')}, into <code>backups/</code>, or a folder you choose${st('settings-pages')}. It leaves out provider logins. Secret values stay in it encrypted with this PC’s key, so they open only here. Agents’ browser profiles with their logged-in sites and the scripts in <code>connectors/</code> are copied as they are, so treat a backup as private. It only runs when you or an agent start it, and the default place is on the same disk, so copy it elsewhere.</li>
          <li><strong>Restore</strong> happens at the next start and keeps what it replaced in <code>before-restore-&lt;time&gt;/</code>. On another PC you sign in again and enter your secrets again.</li>
          <li><strong>Before an update</strong> the app copies the database by itself to <code>backups/pre-upgrade/</code>. If starts keep failing, a repair screen opens${st('repair')}.</li>
          <li><strong>Export</strong> in a chat’s menu writes it with its messages and files into <code>exports/</code>${st('export')}. All chats at once, into a folder you choose, is in Settings › About${st('settings-pages')}. <code>chats/</code> in the data folder holds a readable copy anyway.</li>
          <li><strong>Memory</strong> is plain Markdown${st('memory-files')}, so it copies and versions like any folder. An agent’s forget or deleting the file removes a memory; older copies in backups keep what they held.</li>
        </ul>
        <p>None of this undoes what an agent did outside the data folder. A deleted project or a sent mail does not come back through a restore.</p>

        ${h2('stop')}
        <p><strong>Stop all agent work</strong>${st('stop')} is in the tray, in the list behind the chat header’s live line and in the command palette. While agents work, <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>X</kbd> does the same.</p>
        <ul>
          <li>Every running turn on this PC is cut and no new one starts; tasks pause. It holds across a restart until you choose Resume.</li>
          <li>Work running on another linked PC goes on. Stop it there.</li>
          <li>A script an agent left running on its own, such as a WhatsApp bridge, can keep running. End it yourself.</li>
          <li>It is a brake, not an undo. What is done stays done.</li>
        </ul>
        <p>There is no Stop button in the chat itself: a message redirects an agent. Closing the window does not stop anything, because agents keep running in the tray. With “Start with Windows” or “Start at login” on in Settings, which is off by default, the app also comes back at sign-in and after a crash, and on Windows for the next due work after you quit.</p>

        ${h2('journal')}
        <p>Tool calls and their outcome are written to a run journal${st('journal')}. Under an agent’s message you can open its steps, and its page in Team lists its runs. After a crash, a call that may have had an effect is reported to the agent as unknown to check, rather than simply repeated. This helps you read afterwards what happened. It prevents nothing.</p>

        ${h2('others')}
        <ul>
          <li><strong>Programs on this PC.</strong> The running app answers on a local port, with a token in <code>runtime.json</code>. Any program running under your user can read that file and control the app. This is how scripts and bridges work.</li>
          <li><strong>Your phone</strong>${st('phone')}: an Android phone joins by your PC’s Remote ID; both screens show the same code and you accept on the PC. It then belongs to your whole company and sees what you see. Access lasts exactly as long as the phone is listed in Settings › Devices; Remove ends it. An iPhone uses the web app your PC serves over your network or tailnet.</li>
          <li><strong>Colleagues</strong>${st('people')} join by your invite link and connect to your PC. They see the chats and tasks they belong to.</li>
          <li><strong>Other PCs</strong>${st('remote')}: another PC can ask to connect, and you accept each one after comparing a code. A linked PC’s agent can then run tools here like one of your own. Our meeting server helps your devices find each other by Remote ID; what passes through it is end-to-end encrypted, and you can set your own or none.</li>
        </ul>

        ${h2('unsigned')}
        <p>The Windows installer is code-signed (publisher: Open Source Developer Meral Anna Hees). Because the certificate is new, SmartScreen can still warn once; Smart App Control usually lets signed files through but promises nothing. The Mac app has no Apple Developer ID: it is signed ad hoc and not notarized, so macOS warns you. What follows is what you will see. All steps are also on the <a href="${root}download/">download page</a>.</p>
        <h3>Windows</h3>
        ${installSteps.windows()}
        <h3>macOS</h3>
        ${installSteps.mac()}
        <h3>Linux</h3>
        ${installSteps.linux()}
        <h3>Checking a file</h3>
        <p>Every release lists SHA-256 hashes in <a href="${release.asset('SHA256SUMS.txt')}" rel="nofollow">SHA256SUMS.txt</a>. On Windows: <code>Get-FileHash .\\${files.windows}</code> in PowerShell. On macOS or Linux: <code>shasum -a 256 &lt;file&gt;</code>. A match shows the file arrived as published. It does not replace a signature, because the list comes from the same release as the file; the Windows installer also carries its own signature.</p>

        ${h2('updates')}
        <p>While the window is open the app asks GitHub Releases every minute, and every 15 minutes from the tray${st('updates')}. A small icon appears only when an update exists. On Windows and Linux one click downloads it, checks it against the SHA-512 in the release manifest, installs it and restarts.</p>
        <p>${release.renamed ? 'On macOS the app replaces itself where macOS allows it. That path is new; if macOS refuses, the app keeps working and the icon leads to the download.' : `On macOS the icon leads to the download: you replace the app by hand, and your data stays. A Mac update that replaces itself is built ${statusPill('next')}, starts with the release after the rename, and has never run on a real Mac. If macOS refuses it, the manual way stays.`}</p>

        ${h2('limits')}
        <p>${site.name} is young. This is what we have not proven.</p>
        <ul>
          <li><strong>Releases.</strong> Version 0.3.2 passed packaged start-up checks on Windows, Linux, Apple silicon and Intel. The update from 0.3.1 was not run on a PC before release; linked PCs need the same version to share settings and plan logins. A fresh Windows install, the update on macOS and Linux, and the AppImage on an ordinary Linux PC were not established.</li>
          <li><strong>Trust AI mode</strong> rests on text: your answers, agreements and rules. A model can read them differently or overlook them.</li>
          <li><strong>Secure mode</strong>${st('security-modes')} is new. Its gate is covered by automated tests but has no outside audit; a step the gate does not see is not stopped.</li>
          <li><strong>Doing things on its own.</strong> Agents wake up and carry on, but how much they do on a vague request still varies by model and by run. In our own rounds they sometimes asked instead of finding out. The decision model behind the subconscious has also answered without having searched.</li>
          <li><strong>Browser per chat</strong>${st('browser-spaces')}: tested in real windows with a scripted test engine, not with a real model, and not on macOS.</li>
          <li><strong>Providers through a file</strong>${st('providers-file')}: tested with fakes, not against a real provider. API keys and local models have no recorded live run; Gemini CLI, Copilot CLI and Kimi Code have never been seen live.</li>
          <li><strong>Devices and accounts.</strong> Google Calendar has not been tested against a real Google account, email not against a real mailbox, voice not with a real microphone or phone, phone access and linked PCs not on physical devices.</li>
          <li><strong>macOS.</strong> Agents cannot control the computer there; they get screenshots. The install steps above are written from what macOS shows for apps that are not notarized, and have not been re-checked on every version.</li>
          ${release.renamed ? '' : `<li><strong>The rename</strong> ${statusPill('next')}: moving the data folder and replacing the old app is tested in code, and has not yet run through a real update.</li>`}
          <li><strong>Source code.</strong> It is public under Apache-2.0 on <a href="${release.repoUrl}" rel="noopener">GitHub</a>, so you can audit it yourself; nobody outside Teydra Lab has audited it yet.</li>
        </ul>

        ${h2('report')}
        <p>For a bug that puts no one at risk, <a href="${maker.feedbackUrl}" rel="noopener">open an issue on GitHub</a>. For anything sensitive, such as a secret that leaks or a problem with updates, please do not post it publicly. <a href="${maker.contactUrl}" rel="noopener">Contact ${maker.company} directly</a> and give us time to fix it.</p>
      </div>

      <div class="btns" style="margin-top:56px">
        ${downloadButton(root)}
        <a class="btn btn--ghost btn--lg" href="${root}how-it-works/">How it works${icon('arrow', 'ic--move')}</a>
      </div>
    </div>
  </div>
</section>`,
  });
}
