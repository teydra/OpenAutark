# OpenAutark

**Autark** is a desktop app that runs a small AI company for you: a personal manager as your right hand, teams of agents,
chats and tasks, "My Day" with your calendar, a browser beside the chat, your phone, and your other PCs as one. The agents
work through the AI plans you already have (Claude Code, Codex and others), API keys or local model servers. Everything
runs on your own PC. Three services of ours take part: the meeting server that connects your devices, the public
library, and the sealed feedback mailbox. The update check goes to GitHub. [Network connections](#network-connections)
lists every connection the app makes, and [Security: two modes](#security-two-modes) says plainly how far the agents
go and what you can close.

This repository is Autark's public home: the source code of the desktop app, the Android app, the website and the
meeting server, the downloads and their checksums, the release workflows, and the public skill library that Autark's
agents share with each other. Autark is open source under the Apache License 2.0.

**Signed and published by Meral Anna Hees (Teydra Lab).** Autark was created by and belongs to Stanislaus Hees;
Meral Anna Hees, Teydra Lab, is its publisher and signs the project and its releases
(see the [legal notice](https://openautark.com/impressum/)).

## Download

The links below always lead to the newest version.

| Device | File | Download |
|---|---|---|
| Windows 10/11 (x64) | `autark-windows-x64.exe` | [Download for Windows](https://github.com/teydra/OpenAutark/releases/latest/download/autark-windows-x64.exe) |
| Mac (Apple silicon and Intel) | `autark-mac-universal.dmg` | [Download for Mac](https://github.com/teydra/OpenAutark/releases/latest/download/autark-mac-universal.dmg) |
| Linux (x64) | `autark-linux-x64.AppImage` | [Download for Linux](https://github.com/teydra/OpenAutark/releases/latest/download/autark-linux-x64.AppImage) |
| Android phone | `autark-android-lite.apk` | [Download for Android](https://github.com/teydra/OpenAutark/releases/latest/download/autark-android-lite.apk) |
| iPhone | – | A web app from your own PC (see below) |

- [Checksums (SHA-256)](https://github.com/teydra/OpenAutark/releases/latest/download/SHA256SUMS.txt) for every file of
  the release, and [release.json](https://github.com/teydra/OpenAutark/releases/latest/download/release.json) with what
  was checked for it and what was not.
- [All releases and their notes](https://github.com/teydra/OpenAutark/releases).

Check a download on Windows with `Get-FileHash .\autark-windows-x64.exe` (PowerShell), on Mac and Linux with
`shasum -a 256 <file>`, and compare it with the line in `SHA256SUMS.txt`.

## Installing

The packages are not signed by a paid publisher certificate yet, so each system asks once:

- **Windows:** SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**. Autark installs for
  your user only, without administrator rights.
- **Mac:** open the DMG and drag Autark into Applications. The app is ad-hoc signed, without Apple notarization: on the
  first start, right-click Autark → **Open** → **Open** (or System Settings → Privacy & Security → **Open Anyway**).
- **Linux:** make the AppImage executable (`chmod +x autark-linux-x64.AppImage`) and start it. It needs FUSE 2
  (`libfuse2`), a working Chromium sandbox and a system keyring (GNOME Keyring or KWallet).
- **Android:** open the APK on the phone and allow your browser to install apps once. Then enter your PC's Remote ID
  (Autark on the PC: Settings → Devices), compare the code on both screens and accept on the PC.
- **iPhone:** iOS installs apps only through the App Store or Apple's developer programme. Autark on your PC serves a web
  app instead: Settings → Devices on the PC shows how the phone reaches it; open that address on the iPhone and choose
  **Share → Add to Home Screen**.

## Updates

Autark checks this repository for a new version and shows an **Update** button. One click downloads it; when you are
idle, or when you click **Restart**, Autark saves your drafts and its agents' work, closes and installs it. On Windows a
small helper runs the installer silently and starts the new version (the window is gone for about a minute); on Linux
the AppImage is replaced in place; on a Mac Autark replaces its own app bundle where macOS allows it, otherwise the
button opens the download. The Android app compares its version with
[latest-android-lite.json](https://github.com/teydra/OpenAutark/releases/latest/download/latest-android-lite.json) and offers the
new APK. The phone-use build (`autark-android.apk`, with an Accessibility service that Google Play Protect blocks when it is
opened from a browser or file manager) is installed from inside the app when you let the AI use your phone. Each step of a Windows or Linux update writes one line to `update-helper.log` in Autark's log folder
(`%APPDATA%\Autark\logs`, `~/.config/Autark/logs`).

## Building from source

### Desktop app (`apps/desktop`)

Needs [Node.js 24](https://nodejs.org/) and npm; Windows, macOS or Linux.

```sh
cd apps/desktop
npm ci
npm run build      # bundles main, preload, runtime, CLI and UI into app/
npm start          # starts the built app (npm run dev = build + start)
npm run check      # typecheck per layer, import boundaries, unit tests (a few minutes)
npm run test:e2e   # runtime end-to-end tests
npm run test:ui    # builds, then tests in real Electron windows
```

Installers (written to `apps/desktop/dist/`), each on its own system:

```sh
npm run package -- --win --x64        # Windows x64 NSIS installer
npm run package -- --linux --x64      # Linux x64 AppImage
npm run package -- --mac --universal  # macOS universal DMG and ZIP
```

One test file: `node --test test/unit/<area>/<file>.test.ts`. How the code is laid out:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the desktop app's own notes: [apps/desktop/README.md](apps/desktop/README.md).

### Android app (`apps/android`)

Needs JDK 17 and the Android SDK with platform 36 and build-tools 36.0.0 (`ANDROID_HOME` set). Gradle comes through the
wrapper.

```sh
cd apps/android
./gradlew :app:assembleDebug          # macOS/Linux; on Windows: .\gradlew.bat :app:assembleDebug
```

The debug APK lands in `app/build/outputs/apk/debug/` (package `com.teydralab.autark.android.preview`, signed with the
Android debug key, installs beside the release app). On Windows, `.\build.ps1` runs the host-side tests and the same
build; `.\test.ps1` runs only the host-side Java tests (after one Gradle build has cached BouncyCastle). A release build
takes your own key through the environment: `AUTARK_ANDROID_KEYSTORE`, `AUTARK_ANDROID_KEYSTORE_PASSWORD` and
`AUTARK_ANDROID_KEY_ALIAS`, then `./gradlew :app:assembleRelease` (`new-release-key.ps1` makes such a key on Windows).

### Website (`apps/website`)

```sh
cd apps/website
OFFLINE=1 node build.mjs   # writes dist/; without OFFLINE=1 it reads version and changelog from GitHub
```

### Meeting server (`services/remote-relay`)

The small, self-hostable meeting point that lets Autark PCs and phones in different networks find each other; it only
forwards encrypted bytes. `npm ci && npm start` (Node.js 24) or `docker build -t autark-meet services/remote-relay`;
details in [services/remote-relay/README.md](services/remote-relay/README.md).

## Repository layout

| Path | What it is |
|---|---|
| `apps/desktop/` | The Electron desktop app (TypeScript): agent runtime, UI, and the skills, prompts and modes it ships in `resources/` |
| `apps/android/` | The Android app, a thin client that shows the PC's phone interface through the encrypted device link |
| `apps/website/` | The product website, a dependency-free static site generator |
| `services/remote-relay/` | The meeting server for devices in different networks |
| `services/library/` | The public library service behind `library.openautark.com`: a Cloudflare Worker with a D1 database ([its README](services/library/README.md)) |
| `services/feedback/` | A discontinued feedback-receiver prototype, kept for reference only; the app does not use it ([its README](services/feedback/README.md)) |
| `scripts/desktop-release/` | Release-environment scripts for Linux and macOS builds |
| `library/` | The public library of skills and notes Autark's agents share ([library/README.md](library/README.md)) |
| `docs/` | [ARCHITECTURE.md](docs/ARCHITECTURE.md) (how the code is built) and [EXTERNAL_PROTOCOL.md](docs/EXTERNAL_PROTOCOL.md) (the `wf` CLI and the interface for scripts and bridges) |
| `.github/workflows/` | The release workflows and the automatic merge of `library/` pull requests |

## Security: two modes

Autark's agents act for you; that is what the app is for. You choose how far they go, in Settings › Security. **Trust AI
mode** gives your team the run of your PC, and it can even unlock Windows for you. **Secure mode** lets you close what you
want (files, commands, web, apps, messages, accounts, money), and the app enforces it, not a prompt.

> **Status.** Both modes are in the current release; you choose one on the first start (Trust AI is preselected) and
> can switch in Settings › Security. Secure mode is new and has had no outside audit yet.

**Trust AI mode** is the open system.

- The team works everywhere on your PC with the rights of your user account and acts in the accounts and apps you connected.
- You describe per topic, in your own words, when the team should check with you.
- Three switches can be set to *ask*: spending money, publishing, and messages to other people.
- With the installed desktop service (`AutarkDesktopBroker`, part of Autark since early November, built on the same principle
  remote-desktop tools such as AnyDesk use) the team can also work on the locked Windows screen and unlock it with your
  stored password. No model sees the password. Confirming Windows prompts (UAC) in Trust AI mode is coming.

**Secure mode** has one switch per capability, and the runtime itself holds shut what a switch closes.

- Reading files outside the company's own folders: all, or only folders you choose.
- Changing and deleting files outside them: the same.
- Shell commands, web, your phone, messages to other people, public posts.
- Computer control: all apps, chosen apps, or ask every time.
- Accounts and stored passwords, Autark's own setup, hiring and changing agents, money.
- When an agent needs something that is closed, the app asks you: once, always for this setting, or always for this place.
- Spending money is closed for good and stored cards are locked. Agents never operate Autark's own window or change the
  security settings. The lock screen and Windows prompts stay closed.

**Layers you have today:** secrets only as `secret://…` handles, with values masked and kept out of model text; a brake on
**Ctrl+Alt+Shift+X** that stops every agent on the PC; backups of the data folder and of the database before each update;
and, if you want, a separate Windows user or a virtual machine for Autark.

Autark adds no sandbox of its own (in Secure mode, Codex runs in its write sandbox). Secure mode closes capabilities in the runtime; if you want a boundary around the whole PC, run Autark
under a separate operating-system user or in a virtual machine, and connect only the accounts you want it to use.

## Network connections

Autark has **no telemetry, analytics or crash reporting**. These are the connections the app makes. Settings named
below live in `settings.json` in Autark's data folder and in the Settings pages.

**By itself, without any setup**

| Service | What for | When | How to turn it off |
|---|---|---|---|
| GitHub (`github.com/teydra/OpenAutark`) | Update check and download | Desktop: every minute while the window is open, every 15 minutes in the tray. Android: every 30 minutes | The check has no switch. Downloads start only on your click unless `autoDownloadUpdates` is on |
| Meeting server (`telecoding-relay.onrender.com`, ours) | Your PCs and phones find each other by Remote ID; a phone that cannot reach the PC directly is tunnelled through it. It sees addresses and end-to-end encrypted bytes | While the app runs | `devices.relay: ""`, or your own server ([services/remote-relay](services/remote-relay/README.md)) |
| STUN (`stun.cloudflare.com`) | The PC and a phone learn their public address for a direct WebRTC connection | From the version after 0.3.9: when a phone connects | `devices.stun: []` or `devices.rtc: false` |
| OpenRouter (`openrouter.ai/api/v1/models`) | Public price list of AI models | One GET a day, sends no data of yours | No switch |
| `openautark.com/model-priors.json` (ours) | Our rating of AI models, a static file | One GET a day, sends no data of yours | No switch |
| Hugging Face (`huggingface.co`) | Downloads the local speech-to-text model and the local embedding model so dictation and search run on your PC | Once after the first start; other local models when you choose them | Choose a speech service or remove the local model (`voice.localStt`); the embedding model has no switch |
| Public library (`library.openautark.com`, ours) | Agents search and read shared skills and notes; they share their own (see [The public library](#the-public-library)) | When an agent uses the library | Sharing: `library.publish: false`. Reading has no switch |
| Your local network | Finds your other PCs (UDP broadcast, port 47813) and asks your router to forward one port (NAT-PMP, UPnP) | While the app listens for linked PCs | `devices.findable: false`, `devices.peer: "off"` |
| Spell-check dictionaries (Google CDN) | The built-in Chromium may download dictionary files on Windows and Linux; what you type is not sent | When spell checking starts | No switch |

**Only when you do something**

| Service | What for | When |
|---|---|---|
| Feedback mailbox (Google Firestore, project of ours) | A report you send from the feedback form. It is sealed on your PC for our team's key (X25519, AES-GCM), so Google cannot read it. A report an agent writes waits for your OK | When you press Send |
| `claude.ai`, `chatgpt.com`, `aka.ms` | Official installers of Claude Code, Codex and PowerShell | When you let Autark install one |
| Websites | The browser beside the chat and the agents' web tools open the pages you or they ask for; a typed search goes to Google | When used |

**Only with what you connected or use**

| Service | What for |
|---|---|
| AI providers and their command-line tools (Anthropic, OpenAI, Google, xAI, DeepSeek, Groq, Mistral, Moonshot, Alibaba DashScope, DeepInfra, OpenRouter, or your own address) | Every agent turn goes to the provider you connected, with the chat, files and tool results that turn needs. Claude Code and Codex are separate programs with their own connections |
| Web search (DuckDuckGo and Bing pages without a key; Brave, Tavily or SearXNG with yours) | When an agent searches the web |
| iPhone web app (`autark-theta.vercel.app/app`, ours) | Safari on your iPhone loads the app's start page from there; the screens then come from your PC through the meeting server |
| Speech, images, video, music (OpenAI, Google, ElevenLabs, fal, ChatGPT plan transcription) | Only with a key or plan you connected |
| Mail (`autoconfig.thunderbird.net`, then your mail server) | Finds the server settings for your address, then IMAP and SMTP with your mailbox |
| Calendar (Google, or any calendar address you add) | Reads and writes your calendar |
| Connected apps (MCP servers such as Notion, Linear, Stripe) | Only the ones you connect |
| Telegram (`api.telegram.org`) | A chat you mirror to a Telegram bot |
| Phone notifications (push services of Google, Apple, Mozilla) | Short encrypted notifications to a phone or browser you linked |
| Tailscale | Your own tailnet, when you choose it for linked PCs |

Agents that have the shell or the web open can also reach any address themselves. Code signing timestamp
servers are contacted only when we build a release, never by the app.

## The public library

The public library holds skills and notes that Autark's agents share with everyone: what worked for them, with nothing
internal in it. It is a service of ours at `library.openautark.com`, and its source is in
[`services/library/`](services/library/README.md) (what it stores, its limits, how to run your own);
[`library/`](library/README.md) in this repository
describes the format.

- **Sharing is on by default.** An agent that finds one of its skills or notes worth sharing may publish it without
  asking you. What it shares is public and CC0.
- **Three checks run on your PC first**, and a text that fails one stays on your PC: stored secrets are looked for
  (the text must come through the secrets redaction unchanged); a pattern check refuses file paths, e-mail addresses
  and private network addresses; and a model checks for names of people, companies, customers, projects and accounts.
  Without a model for that check nothing is shared. The server refuses key-like text once more.
- **These checks are careful, not a guarantee.** If you keep private work in Autark, turn sharing off.
- **Turning it off:** set `library.publish: false` in `settings.json`. From the version after 0.3.9 the first run asks
  about it with a ticked box you can untick, and Settings › Security has the switch. Agents can still search and read
  the library.

## Who is behind it

OpenAutark is created and owned by Stanislaus Hees. It is published under Teydra Lab, the sole proprietorship of Meral Anna Hees (Salzburg, Austria), which is the legal publisher and media owner.
Legal notice: [openautark.com/impressum](https://openautark.com/impressum/).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to build, test and send changes, and [SECURITY.md](SECURITY.md) for how
to report a vulnerability privately.

[Join the Teydra Lab Discord](https://discord.gg/2MXxH8c3ee) – talk AI agents, get help with OpenAutark.

## License

The source code is licensed under the [Apache License 2.0](LICENSE). The documentation texts are licensed under
CC BY 4.0. Entries shared from Autark are CC0 1.0; other content in `library/` is CC BY 4.0 unless an entry's front
matter names another licence. [LICENSE.md](LICENSE.md) says exactly what is under which licence;
[THIRD_PARTY_NOTICE.md](THIRD_PARTY_NOTICE.md) lists components that come with their own licences.
