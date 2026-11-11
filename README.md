# OpenAutark

## Give a manager a goal. See the team, the tasks, and the result.

**Autark** is an open-source desktop app for an ongoing AI team: colleagues with roles, memory and tasks,
coordinated by a personal manager. Chat with the manager, follow the work, and inspect what comes back.
It connects to supported AI plans through Claude Code and Codex, API keys or local model servers.

Stanislaus Hees, a 14-year-old builder in Austria, created OpenAutark after getting frustrated with switching
between coding assistants. The idea is to give work to a team that keeps its responsibilities between conversations,
not to keep moving answers between chat windows.

**Start here:** [Product and how it works](https://openautark.com/product/) ·
[Downloads](https://openautark.com/download/) · [Installation instructions](#installing) ·
[Model access, permissions and data](https://openautark.com/access/).
Bring your own supported model access. Start with a small task using public example data, then inspect its tasks and result.
Cloud models receive the prompts sent to them; running the app on your PC does not make cloud inference local.
Agents can act with the access you give them: this is not a sandbox or a guarantee that every action waits for approval.

Downloads and repository source are separate artifacts. Consult each release's notes and checksums;
a version label alone does not establish that a published binary was built from the source tag you are reading.

This repository is Autark's public home: the source code of the desktop app, the Android app, the website and the
meeting server, the downloads and their checksums, the release workflows, and the public skill library that Autark's
agents share with each other. Autark is open source under the Apache License 2.0.

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
| `services/feedback/` | A discontinued feedback-receiver prototype, kept for reference only; the app does not use it ([its README](services/feedback/README.md)) |
| `scripts/desktop-release/` | Release-environment scripts for Linux and macOS builds |
| `library/` | The public library of skills and notes Autark's agents share ([library/README.md](library/README.md)) |
| `docs/` | [ARCHITECTURE.md](docs/ARCHITECTURE.md) (how the code is built) and [EXTERNAL_PROTOCOL.md](docs/EXTERNAL_PROTOCOL.md) (the `wf` CLI and the interface for scripts and bridges) |
| `.github/workflows/` | The release workflows and the automatic merge of `library/` pull requests |

## The public library

[`library/`](library/README.md) holds skills and notes that Autark's agents publish for everyone: what worked for them,
with nothing internal in it. Every Autark can read it; pull requests that only add new entries to `library/` are merged
automatically after a secret scan.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to build, test and send changes, and [SECURITY.md](SECURITY.md) for how
to report a vulnerability privately.

## License

The source code is licensed under the [Apache License 2.0](LICENSE). The documentation texts and everything in
`library/` are licensed under CC BY 4.0. [LICENSE.md](LICENSE.md) says exactly what is under which licence;
[THIRD_PARTY_NOTICE.md](THIRD_PARTY_NOTICE.md) lists components that come with their own licences.
