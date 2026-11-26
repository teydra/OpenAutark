# Architecture – Workforce agent OS

> The map of the code as it is now – for every human and agent that works on it: layers, modules, data, flows and the
> rules each part owns. The product is Autark; the code still says `workforce`. Build history: BUILD_LOG (internal).

## 1. The product in one paragraph

Windows desktop broker installation: `resources/broker/install.ps1` stages the shipped image into `%ProgramFiles%/AutarkDesktopBroker/<SHA256>/AutarkDesktopBroker.exe`, verifies owners, write ACLs and reparse-free ancestors before switching LocalSystem service configuration with elevation. Existing pipe SID and key are preserved; rollback targets must pass the same image/path checks. The new NSIS setup embeds `preflight.ps1` and refuses legacy/unknown service paths before replacing app files. Silent protected app updates do not update/restart the privileged broker: interactive app startup invokes reconciliation (not key-existence detection), which requests UAC for migration, changed bits or repair. Uninstall removes the service with elevation and retains protected versions/data; silent uninstall with a service aborts. These are source contracts, not yet installed/live-verified behavior.


Android APK update channels: `UpdateCheck` reads `R.bool.lite_updates` (false in main, true in the playLite resource overlay). `UpdateRelease` selects `latest-android.json` for full builds and `latest-android-lite.json` for Lite; Lite updates require `channel: lite` plus the Lite APK filename. Google Play installs still update through Play only. Signed build records are emitted by `apps/android/build.ps1`; real-device installation is a separate check.

One person runs an AI company on their PC: a manager, teams of specialist agents (video, web, research, social,
finance …) and a private secretary, across company, personal brand and private life. The person talks to agents
in **chats** (a chat is a place, not an agent), gives **tasks** (quests – goals with an end – holding to-dos; whoever
owns one works on it until it is done or it waits on something real), and looks at one **Tasks** page: their own
to-dos, the quests, what the agents and colleagues work on, and their calendar. Agents are trusted like senior employees: they act on the whole PC without
asking, hire and archive colleagues (themselves included), split work into parallel parts (Ultra), use any model
(Codex, Claude Code, ACP plan CLIs, API keys, local servers) and work on linked PCs and Android phones. The
system behind it is deliberately small: **a SQLite store plus a few plain files and skills**. Anything without a
screen of its own (connectors, look, settings, devices) the AI changes by editing those files – the person just
tells the AI.

## 2. Process model

```
┌──────────── Electron main (src/main) ─────────────────────┐
│ window · tray · updates · launcher · protocols · IPC      │
│ the person's browser (native tabs + side driver)          │
│ media analyzer window · capture · Host services           │
└──────┬───────────────────────────────┬────────────────────┘
       │ utilityProcess + MessagePort   │ MessagePort (handed over by the preload)
┌──────▼───────────────────┐    ┌──────▼──────────────────┐
│ Runtime (src/runtime)    │◄──►│ UI renderer (src/ui)    │
│ pure Node, no electron   │RPC │ Preact + signals        │
│ SQLite · agents · tools  │    └─────────────────────────┘
│ engines · MCP hub        │◄── WebSocket /ws ─────── PWA on phone/browser (same src/ui), wf CLI
│ HTTP :47811              │◄── POST /rpc + bearer ── scripts and agents (token in runtime.json)
│ peer listener :47812     │◄── pinned-key channel ── linked PCs (same runtime) · meeting server
└──────┬───────────────────┘◄── MCP over HTTP ─────── Codex / Claude Code / ACP CLI processes
       │ child processes as leases: codex app-server per account, claude -p per turn, ACP CLIs,
       │ PowerShell UIA helper, adb, stdio MCP servers, Playwright browsers of agents
```

* **Runtime** (`src/runtime`) owns all state and behaviour and never imports `electron`. The few things only the
  host can do (OS keychain encrypt/decrypt, screenshots, notifications, power events, the person's browser,
  the media analyzer, restart) it asks through `Host` (`runtime/host.ts`; `host-electron.ts` over the host bridge,
  `host-node.ts` headless). Entry points: `entry-electron.ts` (the utility process, bundled to `app/runtime.mjs`)
  and `cli.ts` (headless, `app/runtime-cli.mjs --data <dir>`, used on worker PCs and in tests). The composition
  root is `runtime/main.ts`: `compose/services.ts` builds every service, `compose/network.ts` everything that
  serves clients, `compose/lifecycle.ts` holds the restore-before-open and the ordered stop steps.
* **Repair runtime**: `repair/boot.ts` asks the start guard (`<data>/boot.json`); after repeated start crashes or
  a failed upgrade the utility process runs `repair/server.ts` instead, and the UI shows `ui/repair/RepairScreen.tsx`
  (Retry, put back the pre-update copy, diagnostics export).
* **Main** (`src/main`) is thin: `index.ts` (pre-ready: single instance, schemes), `desktop.ts` (composition),
  `runtime-host.ts` (fork, launch-token handshake, restart with backoff), `runtime-link.ts`/`renderer-link.ts`,
  `window.ts` (hardened window, hidden title bar), `window-recovery.ts` (a renderer crash reloads; more than two
  in a minute show "Try again"), `tray.ts` (Open, Quit, "Stop all agent work"), `work-stop.ts` (global shortcut),
  `companies.ts` (several companies per installation, §3; leaving or deleting one: `company-remove.ts`),
  `host-services.ts` (notifications with their sound, §4.2),
  `updates/*` (electron-updater state machine; on macOS, where Squirrel.Mac refuses an ad-hoc signed app, an own
  self-update `updates/mac-self-update.ts`), `keyring-name.ts` (a data folder moved from the old name keeps that name
  for the OS keyring in `<data>/keyring-name` until `ready`; the folder itself is moved by an older release – data still
  in the old folder gets the 0.3.14 advice, §3 Database), `launcher*.ts` ("Start with Windows" = keep agents running:
  one per-user Task Scheduler task, `run-state.json`, `next-due.json`), `protocols/*` (`app://`, `wf-sandbox://`,
  `wf-file://`), `session-guards.ts` (microphone only for our page while armed), `workspace-*.ts` and `side-driver/`
  (§10), `media-analyzer*.ts` and `media-preview*.ts` (keyframes, audio decode, image prep, video previews – two
  instances of the one hidden-window runner `hidden-jobs.ts`, each with its own session and queue), `title-bar.ts`
  (§11). Closing the window always keeps the agents running in the tray; the tray's Quit quits (Quests-Runde 20.11.2026:
  no `closeToTray` setting).
* **Preload** (`src/preload`) exposes `window.workforce` (`shared/api/desktop.ts`) over IPC; `main-world.ts` guards
  the runtime port. `ipc.ts` accepts only our window's main frame; `ipc-args.ts` checks every argument.
* **UI** (`src/ui`) is one Preact app for the desktop window *and* the PWA served by the runtime. It only talks
  RPC (`ui/lib/rpc.ts`: MessagePort on desktop, WebSocket elsewhere). Layouts: desktop columns and the phone stack.
* **Shared** (`src/shared`): pure types, the RPC contract (`shared/api`), models (`shared/model`), the generative-UI
  block catalog (`shared/blocks`), text and voice helpers. No Node, DOM or Electron imports.
* **Who calls** (`shared/api/protocol.ts` `ClientScope`, decided by the transport, never by the client): `owner`
  (desktop window, local CLI, bearer token from `runtime.json`), `device` (a paired phone/browser of the owner),
  `person` (a device of an employee or a co-CEO – the scope carries the person's `role`, §8), `peer` (a linked PC
  runtime), `agent` (an MCP lease of a running turn),
  `external` (an external agent docked into one chat). `rpc/server.ts` dispatches, `rpc/scopes.ts` filters pushed
  events, the handler table (`rpc/handlers/*`) decides which scope may call what.
* **HTTP server** (`runtime/http/server.ts`, port 47811 or the next free one): static UI and service worker for the
  PWA, `/ws` RPC, `POST /rpc` (tokenless pairing/join exchange, or a bearer token for programs), `GET /events`
  (Server-Sent Events, `docs/EXTERNAL_PROTOCOL.md`), `/mcp` (the MCP hub, loopback only), `/files/<sha256>`,
  `/sandbox/app` (mini-tools for the PWA), `GET /ui-hashes.json` (the sha256 of every UI file, for the iPhone web app's
  check, §8; `shared/model/ui-hashes.ts`). `http/peer-server.ts` is the separate peer listener (47812) other PCs
  dial, and the Android app at `/peer/phone` (§8); it is open only while a PC or an Android phone is linked. It holds at
  most 4 unfinished handshakes per address (503 beyond, `MAX_HANDSHAKES_PER_ADDRESS`) and waits 2 s for a refused
  socket's close (`PEER_CLOSE_WAIT_MS`). Host allowlist, Origin check and the bind gate are in `http/security.ts`.

## 3. Data: a SQLite store plus a few files

**The system is a few files plus skills.** Everything a person or an AI is meant to change lives as a plain file
in the data folder; the database holds what the app writes (chats, tasks, runs, knowledge). There is no data-folder
guard: agents read and write these files like any other.

`<data>` = Electron userData (headless: `--data`, tests: `WORKFORCE_TEST_DATA`). Layout: `runtime/root/layout.ts`;
paths: `runtime/system/paths.ts`.

**Companies** (`main/companies.ts`, `runtime/root/companies.ts`, `shared/model/companies.ts`): a company is one data
folder. The first is `<appData>/Autark`, every other one `<appData>/Autark Companies/<id>` (id `[a-z0-9][a-z0-9-]{0,39}`,
new ones `company-2`, `company-3` …; the folders are the list). `main/index.ts` reads `--company=<id>` and sets userData
before the single-instance lock, so each company is its own process with its own lock, runtime, database,
`settings.json`, tray, window, Remote ID and "Keep agents running" launcher (task, LaunchAgent or unit named with its id);
the workspace of every company but the first is `<data>/workspace`, and `AUTARK_DATA=<data>` points its agents' `wf`
at its own runtime. `logins` is a reserved name: `<appData>/Autark Companies/logins` is the PC's one folder of plan
logins that all its companies share (§6). Every `CompanyEntry` carries its `folder` (`first` or the id, shared
`folderOf`), so two companies of the same name are told apart. The profile menu (`ui/shell/ProfileMenu.tsx`, desktop)
lists the companies (the label from the profile's company or name, the folder under a name another company shares),
"New company" and "Import a company"; `companies.open` (host op `company.open`) starts the target
detached or shows it if it runs, and the asking window hides to its tray while its agents keep working; a new company's
first window runs the normal first run. **Leave, delete, export, import** (16.11.2026; Settings › General › Companies,
`ui/settings/CompaniesGroup.tsx`, desktop window only, facts from `companies.list {facts: true}`): `companies.remove
{id|null}` → host op `company.remove` → `main/company-remove.ts` writes the mark `company-removed.json` first (from then
the company is never listed, opened, woken or started; `--company=` of a removed or missing folder quits), a running
company quits on a loopback request, and the sweep – after its runtime ended – takes its start at sign-in off and moves
the folder to the recycle bin (never a hard delete; the first company's entries go via `<Autark Companies>/first –
removed <time>`, and a plain start then opens the next company); the only company is refused, `~/Workforce` and
`logins` are never touched. Leave asks once (an employee company or one with linked PCs), Delete twice with the name
typed. `companies.export {id?, dir}` writes '<name> <time>' with a backup plus `secrets.csv`; `companies.import {path}`
stages that backup's restore into the next free company folder (`portability/company.ts`). Every company runs the
updater (16.11.2026, `main/desktop.ts`, `companyArgs`); one install runs at a time per PC (`updates/install-helper.ts`:
the lock folder `%TEMP%\autark-install.lock`; a company that asks while it is held installs nothing, waits and restarts
with `--updated --company=<id>`; on macOS the swap script restarts the company with `open -n … --args`); after an update
it starts every other company whose run-state was running, the first included (`wakeCompanies`). A linked own PC's
newer version (`device.upserted` caps `version`) triggers one throttled update check (`updates-wiring.ts`
`siblingUpdates`); a version whose install did not land is not downloaded again by itself and its notice stays until
dismissed (About shows it). The tray's "Stop all agent work" and the global
shortcut stop every company on this PC (`work.stop` over loopback `/rpc` with each one's token from its `runtime.json`;
a company whose shortcut registration failed retries while its agents work); the window's own stop and Resume act on
its own company. The uninstaller removes the other companies' launcher tasks too (`assets/installer.nsh`).

| Entry | What it is | Owner (code) |
|---|---|---|
| `README.md` | Generated map: every entry, what editing it does, how to call the running app | `root/readme.ts` |
| `settings.json` | **The only settings store**, written whole: JSON with comments (profile, preferences, notifications, voice, routing = "Models", onboarding, feedback, pwa, devices, day, calendar). Every key is present with its current value and a comment line above it naming its purpose, options or range and default; `null` means the default | `settings/schema.ts` (the one table), `read.ts`, `service.ts`, `validate.ts`, `defaults.ts` |
| `settings.schema.json` | JSON Schema (draft-07) of the same table for editors and scripts: enums, ranges, patterns, defaults, descriptions; written by the app once per start – never edit | `settings/schema.ts` (`schemaText()`), `settings/service.ts` |
| `theme.css` | The app's look: CSS applied live on top of the shipped styles (tokens such as `--surface`, `--text`; dark mode `:root[data-theme=dark]`). Delete it to go back | `root/theme.ts` |
| `agents/<id>/` | `SYSTEM.md` (the agent's instructions – authoritative), `HUMAN.md` (the person's own lines near the end of its prompt; only "for every agent" from `settings.json` follows, §5), `skills/<name>/SKILL.md` (its Main Skills), `agent.json`, `avatar.png/jpg` copy; `agents/README.md` says who is who | `agent-core/*` |
| `memory/` | **The memory tree** (§5.2): one Markdown file per entry in folders by who it is for – `company/`, `branches/<space>/`, `agents/<id>/`, `references/<person>/`, `chats/<chat>/` and any topic subfolder (`_folder.md` describes a folder). The files are the truth; anyone may edit them; writing or changing one makes it findable with `knowledge.find` (by words; where a person chose an embedding model, meaning re-ranks them, §5.3) | `knowledge/memory-*.ts`, `tools/builtin/memory.ts` |
| `prompts/` | Own versions of the shipped prompts (`identity`, `rules`, `skills`, `compaction`, `onboarding`, `agent-default`, `subconscious`) – a file here replaces the shipped one | `context/templates.ts` |
| `modes/` | Own modes (`<key>.md`), replacing a shipped mode of the same key | `modes/service.ts` |
| `secrets/` | The secrets catalog: one `<route>.md` per route listing entries (id, name, kind, tags, description) – never a value | `secrets/files.ts` |
| `connectors/` | `mcp.json` (MCP servers, the usual `mcpServers` map), `mail.json` (mailboxes), `status.json` (written by the app) | `apps/connectors.ts`, `apps/service.ts` |
| `chats/` | A readable mirror of the chats (`chat.json`, `messages/<yyyy>-<mm>.jsonl`); the database stays the original | `chat-files/mirror.ts` |
| `side-tabs.json` | The browser tabs per space: `global` (the person's pane), `chat:<id>` (a chat's area), `agent:<id>` (an agent's own area, kept by that agent); the window follows an edit within a second (§10) | `root/side-tabs.ts`, `main/workspace-tabs.ts` |

App-managed (never reported by the watcher): `workforce.db` (+ WAL), `blobs/ab/cd/<sha256>` (content-addressed
files, `files/store.ts`; the layout, the HTTP Range rule and the content types are one rule for runtime and main in
`shared/files/serving.ts` and `shared/files/mime.ts`, Quests-Runde 20.11.2026), `accounts/<provider>/<id>/` (isolated CLI homes headless and in tests; the desktop app
keeps them in the PC's shared `<Autark Companies>/logins/<provider>/<folder>`, §6), `browser-profiles/<agentId>/`, `logs/`,
`tmp/`, `backups/`, `exports/`, `engine-cwd/` (empty folder CLI engines start in), `engine-prompts/`,
`models/speech/` (local speech models and, on the same download rail, the local embedding model `embedding-minilm-l12-int8`, fetched on first need, §5.3), `engine-transcripts/` (rebuilt Claude Code sessions, §5.5), `runtime.json` ({port, token} while the app runs), `boot.json`,
`run-state.json`, `next-due.json`, `window-state.json`, `bin/` (the agents' `wf` shim, below). The workspace for projects
and artifacts is `<home>/Workforce` (`downloads/`, `inbox/`, shared skills in `skills/<name>/SKILL.md`); another
company's is `<data>/workspace`.

**One watcher** (`root/watcher.ts`) watches `<data>` by OS events (no polling). Each entry has one owner that
registers with it; the app's own writes are recognised (`root/marks.ts`) and not reported back. Text files the app
writes and others may edit at the same time go through `root/text-doc.ts` (atomic writes; an unusable edit is kept
as `<name>.rejected.md` with a quiet notice, `root/notice.ts`).

**settings.json rules** (`settings/schema.ts`, `read.ts`, `service.ts`): one table (`schema.ts`) lists every section and
key – purpose, options or range, pattern, default – and everything else is built from it: the file text
(`settingsText()`, a header, `"$schema": "./settings.schema.json"`, one comment line per section and key such as
`// Colour scheme of the window. Options: system | light | dark. Default: system`), `settings.schema.json`
(`schemaText()`), the defaults (`defaults.ts`), the checks (`validate.ts`) and the reader (`parseText()`/`stripJsonc()`:
`//` and `/* */` comments outside strings and trailing commas are accepted, no dependency). Reading (`read.ts`): defaults
⊕ file; each section is validated on its own; an invalid section keeps its last good value and shows a quiet notice;
`null` or a missing key means the default (in a `settings.update` too since 16.11.: `validate.ts` `deepMerge` puts a
key's default in place of `null`); `"$schema"` is skipped; unknown keys are dropped. Writing: the app writes
the **whole** file after every update and after every read whose text differs from the whole current text – that keeps
the comments current, turns an old file of differences into the whole file once (every value the person set stays) and
leaves an invalid value as written with a `// Not applied (<reason>) …` line above it. Never overwritten: a file that
is not JSON at all (copied to
`settings.rejected.json` before the app writes again), and a file whose sections only fail together. A deleted file is
written again from the current values (write `{}` to reset). A valid edit applies within a second. Consequences:
a default changed in a later version does not reach existing installs for keys already in the file; a script reading
the file must strip the comments (`parseText(text).data`, never plain `JSON.parse`); editors need `allowComments`
(the schema sets it; a strict ajv needs `strict: false`). There is no spending, monthly or budget key anywhere (a test
asserts it). The skill `app-settings` is one short paragraph (open the file, every key has its options above it, change
the value, save) plus pointers to what is not in the file. The old `settings` table is no longer read (its move into
the file ran up to 0.3.3; Quests-Runde 20.11.2026). Without a data folder (tests) settings live in memory.

**theme.css**: `root/theme.ts` emits `theme.updated` {css} on every change; `ui/main.tsx` puts it into
`<style id="wf-theme-css">` as the last stylesheet and reloads it on reconnect; phones get it too (`theme.get`
for every scope). The skill `app-look` explains it.

**Controlling the running app from outside** – everything the window can do, a program or an agent can do:
`wf call <method> [json]` (the `wf` terminal client, `runtime/wf-cli`, bundled to `app/wf.mjs`; it finds the app
through the data folder), or plain HTTP `POST http://127.0.0.1:<port>/rpc` with `Authorization: Bearer <token>` and
`{"id":1,"method":"…","params":{…}}`, port and token from `<data>/runtime.json`. Agents have `wf` on their PATH:
`engines/wf-shim.ts` writes `<data>/bin/wf` (sh, for Git Bash, macOS and Linux) and on Windows `wf.cmd`, which run
`app/wf.mjs` with the app binary as Node (`ELECTRON_RUN_AS_NODE=1` set only inside the shim; paths on the shim's own
drive are relative, so a non-ASCII user name never appears in them); written LF and only when changed. `agentEnv` puts
`<data>/bin` first on PATH and sets `AUTARK_DATA=<data>` for the CLI engines (`engines/registry.ts`) and for
`shell.exec`/`secrets.run` (`tools/builtin/command.ts`); `wf` looks at `AUTARK_DATA` first (`wf-cli/discover.ts`), so it
reaches its own company. In PowerShell JSON arguments lose their inner quotes; the stdin form
`'<json>' | wf call <method> -` works, and the skills show both forms. The README and the `app-settings` skill also
document the HTTP route.

**SQLite** (`runtime/db`): one database with WAL and a prepared-statement cache. Main tables: conversations,
members, messages (+FTS), tasks (+FTS; quests and to-dos, the person's included, are tasks, §4.3), runs and run_items
(the journal), wakes, schedules, knowledge (+FTS; only the older versions of memory files – the memory itself is the
files of §5.2), vector_files and
vector_chunks (the vectors, §5.3), context_items (the transcript's items, §5.5), accounts, models, devices, tokens,
people, media (+FTS), files, bridges, split_groups and splits, calendar_events and calendar_sources, spend, kv.
A message's `meta` carries the values every device renders (B-075): `live` while a run's row streams, `ms` and `lines`
on its finished answer (§4.2), `call` on a call's own row and on each line said in it (§9).
Migrations (Quests-Runde 20.11.2026, `db/migrate.ts`): the list starts at the **baseline** `091-baseline.ts` – the
schema the old chain 001–091 left (the old chain against the baseline gave the same `sqlite_master` and rows at 91, 100
and 109; its fingerprint is pinned in `test/unit/db/baseline.test.ts`) in one step for a new database –, then `092…110`,
only ever appended. Data below `OLDEST_SCHEMA` (103, Autark 0.3.9) is refused before anything is copied or changed
(`db/upgrade.ts`; the repair screen shows `olderData`: "Install Autark 0.3.14 first … then this version opens it", with
the release link `OLD_CHAIN_URL`) – the one-time conversions of 13.11. and the login move of 16.11. live in that bridge
release, not here; a first start in "Autark" while the old name's folder still holds the data gets the same advice
(`olderFolder`). Kept notes: `103` the use count `uses` on `secrets` and `secret_groups` (§7.4); B-092: `107`
`runs.cache_write_tokens`, `108` the Claude session's kept running total `engine_sessions.cost_total`/`cost_ref`, `109`
`engine_sessions.folded_at` and `compacted_at` (the fold, §5.1; carried over only when the same session ref is saved
again at the same generation) and `context_items.tokens` ×3/2 (rows counted before at 3 characters per token); `110`
the quests (§4.3: `tasks` rebuilt with `kind`, `at`, `minutes`; a task with pieces became a quest and its pieces, flattened,
its to-dos; `due_at` became `at` only on the person's work – an agent's or team row's old date is dropped –; the
calendar's to-do blocks became their tasks' `at`/`minutes`; routine and timer schedules became reminders, messages or a
to-do's `at`; `day_briefings` and `task_estimates` dropped; kv `quests/converted` marks a profile it converted).
Before migrating older data one pre-update copy is made (`VACUUM INTO`). Repositories live next to their service
(`tasks/repo.ts`, `chat/*-repo.ts`, …) or in `runtime/store`.

**Backup and restore** (`portability/backup.ts`, `restore.ts`): a backup is a copy of the data folder – the
database by `VACUUM INTO`, `settings.json`, `theme.css`, the data entries (not logins, logs, tmp, the chat mirror,
`bin/`, a company's `workspace/` or older backups), the workspace skills and the agents' own skills of the workspace
(`<workspace>/agents/<slug>/skills` → `workspace-agent-skills/<slug>/`); never `runtime.json` (live port and owner
token) or a removal mark. Restore is staged and put back at the next start; the replaced data moves
to `before-restore-<time>/`. Values bound to one PC's OS key stay on that PC (`machine-bound.ts`); a restore into a
folder without a live database (a company import) drops the backup's PC-bound rows – identity, VAPID key, its own
device row, push subscriptions (`forgetBound`) – and that start makes its own. `secrets.csv` never goes into a data folder.

## 4. How work flows

Event-driven everywhere: no polling loops. The exceptions are bounded and named (account limit reads §6, the
Telegram long poll §7, the watcher's ring and morning-pass timers §4.3).

### 4.1 Wakes, the scheduler and the dispatcher

* **Wakes** (`wakes/queue.ts`): a durable queue of "agent X should look at Y". Event wakes are due now, retries
  later; wakes for the same agent and key coalesce into one.
* **The scheduler** (`schedules/scheduler.ts`) is the runtime's ONE timer: armed for the earliest of the next due
  schedule and the next future wake, re-armed on every change, on power resume and after clock jumps. It writes
  `next-due.json`, so the OS launcher can start a closed app for scheduled work.
* **The dispatcher** (`agents/dispatcher.ts` and `dispatch-*.ts`): pump(agent) claims due wakes, groups them by
  (chat, task), runs the most important group and releases the rest; after every turn the agent is pumped again. Since
  21.11.2026 other due groups that are plain chat groups woken only by agents' lines (no line or answer of a person, no
  task, no origin, no call) ride along in the same turn (`dispatch-groups.ts ridersOf`, `agents/turn-riders.ts`): their
  lines arrive under their own chat label, their cursors move and their wakes end only when the turn ends done. A person's
  line and a task group always keep a turn of their own, so each gets its answer in its own chat.
  At most one running turn per agent on its main lane and four splits per agent (`SPLIT_LIMITS.runningPerAgent`);
  there is no global slot FIFO or RAM/disk-space admission threshold. Low disk space is information in the agent's
  volatile environment (`context/environment.ts`, below 2 GB), so it can keep working and make room. Actual write
  failures follow the normal error paths. An agent homed on another linked CEO PC runs its turns there: `pump()`/`idle()` skip it
  here, and its due wakes are handed to that PC (`devices/sync/home.ts`, §8).
* **Why a line waits, in its chat** (B-079, `agents/dispatch-wait-lines.ts`): a person's or colleague's line whose
  agent belongs on an unreachable home PC gets one status line per chat and offline phase – "<Name> works on <PC>,
  which this PC cannot reach right now – the message goes over as soon as it is back" (keyed by its last-seen time).
* **Steering**: an important message in the chat of a running turn steers it when the engine can
  (`dispatch-steer.ts`), else the turn is interrupted at its next tool boundary (`dispatch-boundary.ts` – a call in
  flight is never cut) and that chat runs next. A normal message is folded into the running turn when the engine
  can steer. Only the person's own Stop aborts at once. B-080 (owner 08.11.: "einfach ganz normal … wie bei Codex oder
  Claude Code … mittendrin … dann wird die Nachricht eingefügt"; live 05.–08.11. 0 of 18 lines that came while the agent
  worked were folded, same chat median 535 s): folds of one agent and chat run one after another, and a fold the engine
  refused because its turn had not started yet (a rebuild, a compaction) is tried again every 2 s while that turn runs
  (`agents/dispatch-fold.ts`); a line with files is folded with each file named and its place (only a recording to be heard
  and live speech wait for the next turn); a colleague's answer still streaming no longer stops the fold (it takes a new seq
  at its end); an important line from another chat is folded too instead of cutting the turn; a person's un-quiet line in a
  group reaches every member's running turn wherever it works (`dispatcher.hear`, `chat/delivery-route.ts` hearAll: a group
  frame, no waiting line, the pick still names who answers; a 'mentions' agent hears only its mentions); Claude Code takes a
  steered stdin line at its next request too (it is queued "next" and folded between tool calls), so a 'next' relay goes there.
* **A fold turn and a waiting split in the dispatcher** (KI-Runde 17.11.2026, B-092): after a done main-lane turn
  `foldAfter` asks `agents/context-fold.ts wantsFold` and, when it answers, starts the fold turn (§5.1 Compaction) before
  `pump` – held back only by what `foldWaitsFor` names: a person's unseen line, answer or approval, a manual run, or a live
  call of the agent (`calls/wiring.ts inLiveCall`; a call on another linked PC through its synced row while a line was said
  in it within 30 min). The agent's own background wakes and a colleague's line (a push line too) wait the one turn. A
  fold turn takes no steer, relay or `model.set` continuation, is not retried, gets no failed bubble, and is cut only by a
  person's line for this agent (at its next tool boundary; nothing is marked, the partial text stays a plain note and the
  next turn reads `FOLD_CUT_NOTE`). It never overlaps running split parts of the agent. A person's line, an important line
  or a call voice's `now` relay also ends the running turn's waiting `agents.split {wait: true}` call (`endWait`, §4.5), so
  the turn reaches its next step and reads it; a `next` relay does not.
* **The turn** (`agents/turn.ts`): `turn-prepare.ts` (mode: task → chat → agent; route; native session; prompt),
  `turn-attempt.ts` (engine run with our tools, every text the engine writes handed to the run's chat outbox, reasoning as
  run items, `stall-watch.ts` for a silent engine, `native-timeout.ts` for running native tools), `turn-finish.ts` (session,
  cursors, the end-of-turn posts, cost). Everything an agent did is in the run journal (`runs/journal.ts`).
* **One context per agent** (13.11.2026, `shared/model/origin.ts` threadKey): every turn of an agent runs in its main
  thread `'main'` – one native session (`agents/sessions.ts`), turn state, repair notes, volatile-delta record and context
  ledger (§ ledger, keyed by agent and thread; message items `m<n>` count the thread's messages, found by ref `msg:<id>`;
  the ledger window starts after the thread's last renewal, `context/ledger/window.ts` startWindow) – whatever chat, task
  or source woke it; only a split's part has `split:<id>`. The wake's chat only decides which lines the input carries
  (the delta from the agent's cursor there; a new session gets that chat's full projection). Lines of other chats reach a
  running turn as folds (`dispatch-steer.ts`); a done turn marks them seen. No per-chat catch-up any more.
* **Output only where addressed** (13.11.2026, `agents/chat-out.ts`): what an agent writes stays in its run log; a block
  `<chat to="ch_… [ch_…]" [push|quiet] [files="a, b"]>text</chat>` in any of its texts (a streamed segment, a Codex
  commentary, the final text) is posted into each named chat the moment its closing tag arrives (once per run; the final
  text's last open block closes at its end) – `push` = priority important (a push to persons; in a chat with other agents
  it reaches every agent's running turn, else wakes them), `quiet` = silent (no unread, wakes nobody; an @mention still
  reaches that member; a quiet line that names the person is posted as a normal line – `quietUnlessPerson`, B-092), none =
  normal; a `task_…` id writes into that task's thread and makes or joins it (§4.3). An agent's @mention of the person makes its line a `reply` notification; only `push` rings (B-092: 14 pushes in
  three days came only from an "@Name" salutation; a chat the person set to "Mentions and tasks" still hears a mention; an
  `@` inside an e-mail address names nobody). A block to a chat the agent is not in is not posted; the run log and the next
  turn's repair notes say so. Ask blocks and ```app todo blocks in a posted text become to-dos. At the end
  (`turn-finish.ts`): a call turn's answer is spoken and posted in the call's chat – only while that call runs
  (`callState(record) === 'running'`, B-092; a call that ended during the turn gets what the turn addressed to its chat as
  a normal line, and the lines of an ended call read as said in a call that has ended); the one safety net – a person's line
  woke the turn and nothing was addressed – posts the text outside blocks into the chat of that person's newest line
  (`log.info('unaddressed answer posted')`). `runs.conversation_id` is the chat of the main wake (a split part's: its
  `chat`, migration 101), and every posted message carries its `runId` – the chat's live bar reads both.
* **Activity log** (13.11.2026; since 16.11. on the agent's Work page `#/team/<id>/work`, `ui/team/AgentWork.tsx`, which
  the profile's "Show work" opens – the profile itself has no log; above the log `WorkNow.tsx` shows the running work and
  the really active tasks – a turn runs on it or it moved within 24 h, `team/agent-work.ts` – with older open and waiting
  ones folded): `ui/team/AgentLog.tsx` shows the journal as one record in
  time order instead of a run list – per turn a muted system line (time, what started it, chat, model; Stop while it runs),
  its step lines (`run-steps.tsx`: tool calls opening to input/output, thoughts, the runtime's own notes as plain lines from
  `shared/text/run-notes.ts`), the agent's updates and answers as open words, a split as its "Split · 1 of 3 done" line open
  as columns (`ui/splits/SplitLanes.tsx`, rows by `split-lanes.ts`: one column per running part with its own steps, cut where
  a part comes back – "Done · … · back to <agent>" – so the rows below have a column less; starts within 2 s share a row;
  waiting parts in one muted line; the block scrolls sideways on narrow windows), and
  a closing line (status, duration, tokens, cost); day lines, "Show earlier" pages back, live over `runs:<agentId>`. Read
  by `agents.log` (RPC, 'manage', `rpc/handlers/org.ts` → `runs/log.ts`, whole turns up to ~400 items a page) and by the
  agent tool `agents.log` (`tools/builtin/agents-log.ts`, any mode, found through `tools.find`, named in `agents.list`):
  any agent reads its own or a colleague's turns as lines, splits included. Nothing is written for it.
* **Outages** (`agents/outages.ts`): a usage limit, a signed-out account or a lost connection is not a failure –
  the work waits and continues when an account becomes usable (event) or after a doubling pause.
  `agents/redelivery.ts` keeps chat retries across restarts and long absences; recurring outages, timeouts and
  transient errors retry after 1, 2, 4 … 30 minutes. One due timer respects the earliest eligible account's cooling
  and known limit reset; account/model events or a reconnect bring work forward. Chat-free source events keep
  their wakes with a doubling pause capped at 30 minutes (`agents/dispatch-runs.ts`). When nothing can run, the
  "Paused:" line names the accounts and why (`routing/unfit.ts` `accountsReason`: "<labels> used up until <time>",
  "paused until <time>", "signed out", "failing", "switched off"; `agents/outage-line.ts`: "Paused: <reason> – continues
  by itself on <PC>").
* **Restart**: interrupted turns resume; work a cut-off run belonged to hears one "interrupted – check what was
  done, then continue" note (`tasks/recover-notes.ts`). Start order in `runtime/main.ts` (B-075): the device sync
  (`startSync`) attaches its listeners first, then the reconcile ends the rows still streaming – only those of runs in
  this PC's own journal (`MessageRepo.streaming()`; runs never sync, a synced row is its home PC's to end) – and
  `endCallsLeftOpen` ends the calls left open (§9), so both changes travel like any other; then runs and wakes.
  Right before an update stops the runtime, main calls `system.prepareRestart` – answered on main's own link only
  (16.11.2026; anyone else hears that `system.install` is its way): `compose/restart-pause.ts` stops the dispatcher,
  ends by itself after 2 min when no restart follows, and is closed as the first shutdown step, so a stopping runtime
  never starts work again.
* **Retry context** (`agents/interruption-context.ts`): a pause under 60 seconds with unchanged input adds no
  narrative. A longer pause or new messages, edits, scheduled events or task details surrounds the current input
  with timestamped **App system events**: interruption, intervening event references, retry now. Causes come from
  the existing run journal; after a crash the last recorded activity is named, without claiming to know the crash
  time. One small `kv/turnInput` marker per agent/thread holds the latest run id, input seq, task digest and note
  timestamp. Same-run failover/renewal carries its failed attempt explicitly. Wake notes retain their individual
  reasons; an app retry is never labelled as the AI's own note. Original messages and action recaps stay canonical.
* **Emergency stop** (`agents/work-stop.ts`; window, tray, global shortcut, phone): a stored latch, the dispatcher
  starts nothing, running turns and engine background commands stop, computer input is cut. "Resume" lifts it. The
  tray entry and the shortcut reach every company on this PC (§3).

### 4.2 Chats

* One conversation type for 1:1s, groups and agent-only rooms (`chat/service.ts`). Every pair has one default 1:1
  (`chat/direct.ts`); the owner always has a 1:1 with every agent.
* **Who is woken** (`chat/delivery.ts`, `delivery-route.ts`): in a room of two, a message wakes the other member if
  it is an agent (agent ↔ agent too); in a group, @mentions wake the mentioned agents, otherwise the responder pick
  (`chat/responders.ts`, a decision call: up to two agents or nobody) – without an answer a person's message wakes
  the chat's lead. Reply modes per agent and group: auto, mentions, all (`chat/reply-modes.ts`). Everyone else reads
  the message later through their read cursor (`context/delta.ts`) – no paid turn. An agent's push line reaches every
  other agent of the chat at once; an @mention reaches exactly that member, from a quiet line too (the person as a push).
* **Levels**: the person sends normal, important (`/important`) or silent (`/silent`; a silent line wakes nobody it
  does not @mention – `chat/quiet-pickup.ts` lets the agent pick a person's quiet line up when idle). Agents write
  `<chat>` blocks (§4.1 "Output only where addressed"); an agent's quiet line is nobody's to pick up. There is no
  `chat.send` and no status line of an agent any more.
* **What an agent reads** (13.11.2026, `context/render.ts` lineLabel): every chat line it receives – delta, fold,
  chat.read, chat.search, the ledger – carries `[ch_… "Title" · Author · HH:MM #seq]` (the owner "Name (CEO)", a quiet
  author "(quiet)", a system line without author); its volatile prompt has "## My chats" (`context/chat-overview.ts`:
  up to 40 chats, newest activity first, `ch_… · title · last author: last line…`, archived marked; B-092: a chat a person
  is in carries " · <Name> reads here"; task threads are left out – they stand in "## My quests") instead of the former
  "## This chat". **The person's line a turn answers arrives
  whole** (B-092: the owner's longest message had been cut before its ask): no `BODY_CAP` cut for it, and `chat.read {seq}`
  returns that one line alone and uncut by the output head cut – one bound for both, `WHOLE_CHARS` 100,000
  (`tools/outputs.ts`), past it the head and the tail with one line between naming the file that holds all of it.
* **The quiet path** (KI-Runde 17.11.2026, B-092; measured 15.–17.11.: 302 agent lines to the owner against his 121, 244
  of them task status lines): what reaches the person is a result, a question only they can answer, or something they must
  do. An agent's quiet line renders as a compact row "<Name>: <first sentence>" in the status burst
  (`ui/chat/message-rows.ts burstView`, `MessageItem.tsx` StatusGroup): one burst has one shape for one line and many –
  earlier lines fold into one "N earlier updates" row in their place, an opened line stays open and nothing above it moves
  when the next arrives; a line that carries files stays a bubble. A silent line does not move its chat in the list
  (`chat/service.ts nextSeq(…, { quiet })`; the sync intake passes `{ quiet: message.silent }`). The live bar shows the
  agent's own sentence – the first sentence of its newest commentary note 'Update' (`chat/live.ts stepOf`), which stays the
  step until its next one – instead of its newest tool label.
* **A run's status is a value in its chat row** (B-075; `chat/streaming.ts`, `chat/live-row.ts`, `shared/model/chat.ts`):
  the run's answer row (state `streaming`) holds the streamed text and `meta.live` = {note, steps – the newest
  `LIVE_STEPS` (6) step labels of `shared/text/step-label.ts`, never a tool's input or output –, more (how many came
  before), model, effort, taskId, startedAt}. `live-row.ts` feeds it from `run.item` and `agent.activity`; `streaming.ts`
  writes it throttled (the first change after a quiet moment at once, then at most one write per 500 ms) and announces it
  as `message.updated` plus the chat's summary, so it syncs and renders like any message (§8). At the finish the row
  becomes the answer: `meta.live` goes, `meta.ms` (time worked) and `meta.lines` (the newest 60 steps) stay. A run whose
  answer is kept internal (`plan.publish 'internal'`, a background run) gets a **silent row**: a quiet seq that moves no
  chat up the list, only `meta.live`, no text; posted, it moves to a new seq at the chat's end, else – failed or stopped
  too – it is removed. `ConversationSummary.live` and `working` come from the streaming rows, so the chat header, the
  chat list (who works and what, never a half-written answer) and Home name the same on every PC; Team, tasks,
  keep-awake and the work stop still read `agent.activity` (windows and phones hear it with the runs of the CEO's other
  PCs added, each with its `deviceId` – `sync.live`, §8), and `runs`/`run_items` stay this PC's journal (Team › Runs).
  Streaming rows stay out of the full-text index until final; external agents' `messages.list` leaves them out and
  reads on past them for a full page (`bridges/external-rpc.ts` `settledPage`); a colleague's silent live row is neither
  shown nor a stop for the read cursor or steering (`context/delta.ts`, `agents/dispatch-steer.ts`). **A running split
  group is a row too** (B-079, `chat/split-row.ts`): one silent streaming row of the agent in the group's chat
  (message.runId = the parent run, found by `split:<group id>`, `meta.live.splitGroup`), its steps the parts in their
  current state ("#2 title · model", working, waiting, done, failed), its note "N of M parts done · K working – goal";
  it goes when the group stops being live. So the notebook, the phone and the chat list see parallel work; the home
  PC's window draws its richer split block instead (`ui/chat/WorkingMessage.tsx` PendingWork, `message-rows.ts`
  liveWork counts such a row by its group).
* **Loop guard** (`chat/loop-guard.ts`, B-080 `chat/worked.ts`): agent-to-agent rate, ping-pong and circular discussions without a
  person's line, task progress or work between the lines pause agent-triggered wakes until a person's line, a task change or a line
  from a turn that did work (a task, schedule, hand-over or result run counts as work); an @mention always wakes and ends a
  back-and-forth pause, and the rate pause ends by itself once the minute has room; more than five important messages of one
  author in ten minutes count as normal.
* **Scheduled messages**: a scheduled post (`messages.schedule`, `schedules/post.ts`), set in the composer's schedule
  mode (§4.6, §11). Text only: the runtime keeps no attachments or secrets for a scheduled message.
* **Notes**: one shared Markdown text per chat (`notes/store.ts`, `chat_notes`), last write wins; agents use
  `chat.notes.read/append/write`, the person a Notes tab (§10).
* **Notifications** (`notify/service.ts`): the one path for "the person should know"; per-chat level; pushes by
  default for to-dos, blockers and important messages; web push to paired devices (§8). The desktop host
  (`main/host-services.ts`) plays a sound by default (`notifications.sound`): one per 3 s across all notifications, a
  beep while the window has focus (then no OS toast), else the OS notification's own sound; none for silent ones. In the
  window, toasts for to-dos and blockers stay (`ui/lib/toasts.ts`, ttl 0) until Open, Dismiss, the
  person reaching where Open leads (the chat, or the to-do on the Tasks page) or the task finishing
  (`ui/lib/store-events.ts`), and so does an install that did not land (`toastStartNotice`); an important message,
  mention or link line goes after 20 s (`NOTICE_ONLY_MS`, 16.11.), done and reply toasts after 6 s. Nothing toasts for
  what the person already looks at.
  **The owner's other PCs** (B-077, B-078 held push; `devices/sync/notify.ts`, `held-push.ts`): a notification that
  pushes gets an id and a tag. The PC that decides it pushes it itself – to its own subscriptions (`pwa/push.ts`) and to
  the owner's subscriptions of my other PCs, which the roster (`sync/roster.ts`) brings with their VAPID keys –, whether
  or not it has a phone itself. Only an online CEO PC that never sent a roster (0.3.x) still gets the old hand-over (mesh
  `notify.relay`, not open to an employee's PC), and only while this PC reaches no owner phone; that PC gives it only to
  its own phones – no desktop notification, no relay again. The service worker shows a notification with the same tag
  and id only once within its origin and wakes the open page on every push; a phone with subscriptions in two origins
  (a browser paired by QR at two PCs' own addresses) is alerted once per origin – one pairing (Remote ID, the iPhone web
  app or the Android app) avoids it.

### 4.3 Quests and to-dos (Quests-Runde 20.11.2026)

* **One task model, two kinds** (`tasks/service.ts`, `shared/model/tasks.ts`): a task row has `kind` `'quest'` or
  `'todo'`. A **quest** is a goal with an end (`doneWhen`), owned by an agent or a person, and holds to-dos (their
  `parentId`); a **to-do** is one thing one owner (agent, colleague, the person = `human`) does, in a quest or not. One
  level only (`tasks/quests.ts`): a quest never sits in a quest, a to-do never holds to-dos – a to-do placed under a
  to-do goes into that to-do's quest, and a top-level to-do that gets one becomes a quest. Order inside a quest is
  `dependsOn` ("after", `tasks/depends.ts`; an end that opens several to-dos of one agent wakes it once). Closing a quest
  ends its open to-dos quietly ("Quest closed: <why>"); opening it again (reopen, undo) brings them back as they were
  (`quests.ts reopenTodos`); the last open to-do ending wakes the quest's agent owner once ("Every to-do of <quest> is
  done – it is done when …", `tasks/transitions.ts`). A wait is `status: 'waiting'` + `waitingOn {on, who|ids, why,
  since}`; notes say what is to be done now. A task may be chat-free. Rows, FTS and the atomic claim: `tasks/repo.ts`;
  optimistic concurrency by `rev`.
* **One "when"**: `at` (epoch ms) + `minutes` on a to-do – the person's time: drawn on their calendar, it rings and
  pushes them then. A day without a time is `at` at local midnight without `minutes` (`shared/model/day-settings.ts
  isDayOnly`; it rings at that day's work start, `ringAt`). **Agent work has no time – in code**: `at` on a to-do whose
  owner is or becomes an agent or "team" is refused (`tools/builtin/tasks-util.ts AGENT_TIME`), migration 110 and the
  bridge for older PCs (`bridge/quests-2011.ts`) carry no agent's old due date over, Send to… an agent puts the person's
  time into its notes, and task lines an agent reads print no time on agent work (`VERGESSEN.md` in
  `.local/quests-20261119`: 62 % of agent tasks carried a date a median 41 h ahead, finished in 0.6 h).
* **Read rule**: every agent reads every task. **"Only me"** (`private` on the row) means the person does this one:
  the AI sees it, keeps it in view and helps around it (notes, a reminder, its quest, a time), but an agent never gives
  it to an agent or "team", never closes it, nor its quest while it holds one (`tasks/service.ts onlyMeLine`, `give`,
  `finish`; the tools refuse the same before any change). Nothing is hidden – it travels to every PC like any task, an
  employee's PC included (`devices/sync/employee.ts`).
* **A task's thread** (`tasks/thread.ts`; owner: "pro einzelnen Task einen Chat … also einen Verlauf"): the history of
  one quest or to-do is a conversation whose id IS the task id (`task_…`, `shared/model/chat.ts isTaskThread`), made on
  demand – two PCs that make it write the same id; no table, no sync change. Members: the people the task concerns, its
  agent owner as lead, the agents that made or gave it; a person's to-do that names no agent has that person's assistant
  (`day/assistant.ts`) as lead; whoever joins later reads it whole (`history: 'full'`). It is in no chat list
  (`chat/conversation-repo.ts` list skips `task_…`; UI `ui/chat/threads.ts isThread`), is named by its task
  (`chat/titles.ts`), and a person's line there wakes the task's owner with the task (`chat/delivery-route.ts`). Event
  lines – given, waiting, done, quest closed, recording attached – are quiet status lines (`TaskService.line()` →
  `threadEvent`); unread is a dot on the row (`chats.threadNews`); `chats.thread {taskId}` opens it; an agent writes
  there with `<chat to="task_…">` (`agents/chat-out.ts` joins it); removing a task removes its thread (`dropThread`).
  **The person's line stays with the work**: a to-do made in a turn a person's line started gets that line whole as the
  first quoted entry of its thread (`tools/builtin/tasks-util.ts keepPersonLine`, drawn by `ui/chat/KeptLine.tsx`) – only
  when every person in the thread reads the chat it came from, else its link alone (`LINE_ELSEWHERE`; a later joiner gets
  the same, `keepQuotesFor`).
* **The one intake of a person's line** (`tasks/quick.ts`, RPC `tasks.quickCreate` – owner `rpc/handlers/task-center.ts`,
  a colleague `people/rpc-tasks.ts`): `{text, at?, minutes?, quest?, private?, attachments?, clientId?, target?}` from the
  Tasks page's line, a calendar slot (`calendar/add.ts`), the chat's `/todo` (`ui/chat/composer/slash.ts`), the phone's
  to-do button and the float bar. The line stands at once as the person's own chat-free to-do (title = first line, notes
  = the rest, a plain Done), in the picked quest, at the time they confirmed; then their assistant (`day/assistant.ts
  wakeAssistant`) is woken once with the line, the time phrases in it they did not confirm (`shared/text/when.ts
  findTimes`) and the open work it is about (`tasks/related.ts relatedWork`), and sorts it – person, agent or both as two
  to-dos in one quest, the quest, an open time – each change one event line in the thread. An "Only me" line (default:
  `settings.day.aiHelps` off; the line's own choice wins) is sorted too and never handed on. `target` (Send to…) hands it
  straight to an agent, branch, team or colleague (`handOver`). A retry with the same `clientId` answers the first to-do.
  `day.add`, `todos.add` and the old quick routing are gone.
* **The agent's four task commands** (`tools/builtin/tasks.ts`, `tasks-list.ts`, `tasks-remind.ts`, `tasks-util.ts`; all
  four in the base core set; they replace twenty – `tasks.create/give/finish/get`, `todos.prepare`, `schedules.*` and the
  calendar's to-do tools): `tasks.add {title, for?, quest? ("new" with doneWhen), at?, minutes?, notes?, ask?, after?,
  doneWhen?, effort?, priority?}` – a to-do in a quest for me, a colleague, the person or "team", or a new quest (default:
  the quest of this turn's work); `tasks.update {id?, title?, notes?, doneWhen?, for? (= give), at? ("" clears),
  minutes?, quest?, after?, status? (open · waiting · done · dropped), waiting? (one line), result?, evidence?, effort?,
  priority?, quiet?, alsoHandled?}` – done needs a result and runs the one verification; the follow-ups of a close are what
  this turn set up (new to-dos and reminders), listed by themselves; `tasks.list {id?, who?, search?, done?}` – my quests,
  or one quest or to-do whole with every owner's to-dos, waits, the ended ones and its thread; `tasks.remind` – my own note
  (§4.6). Times go through `parseWhen(value, now, profile zone)` (`tools/builtin/util.ts`, §4.7). A preparation for the
  person is a notes paragraph ("Prepared by <name>: …").
* **Per turn** (`context/quest-text.ts`, `context/prompt-volatile.ts`): `## My quests` – one line per open quest I own,
  hold an open to-do in or gave, no cap (`title · task_… · person: n open (next: …) · me: n · <colleague> n · next note
  <when>`), then `Other:` my lone to-dos; the turn's own work as `## Current quest` or `## Current to-do` with the quest as
  it stands now (`questSnapshot`: done-when, every owner's open to-dos with waits and since when, the thread lines since my
  last line there); `## Related open work` when a person's new line is about others' open work (`relatedWork`, top 3). A
  fold carries the `## My quests` lines into its hand-over (§5.1).
* **The watcher** (`tasks/watch.ts`; nothing in it wakes an agent on a timer of its own – `next_at`, the per-task looks,
  the stall pause and the 2-day nudges are gone): an owner for an ownerless row (`give.ts pickOwner`),
  an archived agent's work to its successor (`owners.ts`), the follow-up of an owner's turn (§4.4), recovery at start, and
  **the person's ring**: a to-do whose `at` is reached pushes once (kv `tasks/ringsTo`; on the CEO PC with the smallest
  id). **The morning pass** (`tasks/morning.ts`): at 07:00 profile time, once per agent and day (kv `tasks/morning:<id>`,
  a missed one a minute after the next start), an agent that owns open quests or holds open to-dos in them without an
  active reminder gets ONE wake listing them, each as `questSnapshot`. A bridge wake (`bridge/quests-wake.ts`, once per
  agent, only where migration 110 converted data) had every agent sort its old open work into quests.
* **Where handed work lands, and how loud** (KI-Runde 17.11.2026, B-092): a task carries an effort, never a model (a
  model is named where a context starts – `agents.split`, `agents.create`, `agents.update`, §6). Work handed from a chat
  the person is in to an agent who is not in it lands in the giver's 1:1 with the receiver; a task never adds anyone to
  the person's chat (`tasks/owners.ts`, `tasks/create.ts`). The card of a task an agent made for an agent is posted
  silent; the person's own hand-over card and a task for the person stay loud. A wait whose reason changed replaces the
  task's last wait line in its thread instead of adding one, and a person's line no longer reopens a task that waits on
  them – it wakes the owner with the task, and the owner moves it (`tasks/lifecycle.ts`). Progress goes into the thread.
* **To-dos with widgets**: an agent's ask block in a message, or `tasks.add` with `ask` for the person, becomes the
  person's to-do with a widget (confirm, choice, form, approve, checklist, timer, record, upload, review, or an
  agent-programmed ```app mini-tool; `tasks/block-todo.ts`, `tasks/widgets.ts`). `approve` is a plain question; its
  answer `{approved, note?}` binds nothing. "Later" moves its `at` (`todos.snooze`, undoable); "Repeat" is a timer widget
  with `repeat` daily · weekdays · weekly (`todos.changeWidget`): Done moves `at` to the next time, `todos.stopRepeating`
  ends it (`tasks/human.ts`).
* **A click is the person's line** (B-076, owner 05.11.: "das ist nicht eine Entscheidung, das ist einfach nur der
  Button-Klick"; `tasks/answer-receipt.ts`): an answer or a decline posts ONE message of the person in the chat (kind
  `answer`, idempotent per client id or block key) – their line (`shared/blocks/answer-text.ts`: the picked option in
  full, "Label: value" lines, "I can't do this: …"; a secret field shows only its `secret://` handle – the typed value
  is in the secrets catalog before the line is made) as a reply to the asking message,
  with the answer's files attached; `meta.answer` keeps the block key, the to-do, the one-line summary and what the
  block asked. The asking agent is woken as for a typed line (reason `message`, no note; on its quest when the to-do is
  in one, merging with that task's wake) and a turn running in that chat takes it in at its next step
  (`dispatcher.steer`); it reads "(answer to my ask "…")" before the line (`context/render.ts`). The line counts as a
  person's message for the loop guard (`chat/delivery.ts`). The to-do then ends quietly: no "Done:"/"Cancelled:" row,
  no `[ui-answer]` note (`tasks/lifecycle.ts`); a wait on the person ends with it (`tasks/transitions.ts endWaitOn` – the
  asker hears the person's own line). Exceptions: a chat-free to-do, or a line that cannot be posted (the person left
  the chat), wakes with reason `answer` and the line plus file paths as the note.
* **Finishing**: a result needs a summary; evidence is welcome, never required. With a done-condition and a
  connected verifier the result is checked once (`tasks/verification.ts`): verified, or one note and one wake to the
  owner; the person's own Done (an agent-led quest too) closes at once. Whoever created or gave the work hears once how
  it ended (`tasks/lifecycle.ts`, `transitions.ts endNote`); a quiet close tells nobody.
* **Transitions** (`tasks/transitions.ts`): work that waits on someone continues as soon as the wait ends (an answer,
  a message, a to-do it comes after).

### 4.4 After an owner's turn (Quests-Runde 20.11.2026)

**An owner keeps working on its task until it is done or it waits on something real**; nothing looks again by itself.
After each turn of the owner on its task (`tasks/watch.ts afterTurn`):

| Turn outcome | Next |
|---|---|
| The person's Stop | the task pauses until they resume it |
| Cut off (interrupted) | it goes on now |
| Usage limit or outage (no account or model) | one retry wake at the retry-after, else `OUTAGE_RETRY_MS` (30 min) – brought forward when an account or model comes back or the host is online again |
| Done, failed or waiting | nothing – the awaited event wakes it; a later look is the agent's own reminder (`tasks.remind`, §4.6) |

`recover()` wakes the work a cut-off run belonged to once after a restart; the morning pass (§4.3) names the quests that
have no next note. The watcher never completes, blocks or escalates a task by itself.

### 4.5 Splits and Ultra

An agent can split itself into parallel parts and stay one being ("Ultra", `runtime/splits`, `contracts/splits.ts`;
B-083: the agent's own ability – the composer switch is gone, an older message's `meta.ultra` keeps its marker and a
short context note). The environment's Splitting line carries the principle (`context/environment.ts` ULTRA_LINE: a piece
goes to a part when it moves on without my next thought and takes more doing than explaining). `agents.split` (since
B-092 in the base core set beside `agents.split_tell`; 1–12 parts with title, brief – for whom and why, what good looks
like, what is known, how they check it, at most 12,000 characters –, optional `after`, and model, effort, temperature per
part: the model the hardest step of the piece needs; unset, a part runs on the origin's model, a fresh part on the strong
tier's best value when the origin is above it, `routing/router.ts`). Parts start when the splitting turn ends (the native
fork needs the finished turn) – **or at once with `wait: true`** (B-092, `splits/wait.ts`; measured: leads did their
finding-out by hand because a part only started when their turn ended, while 15 % of runs held 76 % of all tool calls at
340k–430k tokens per call): the call holds until every part ended, until `WAIT_MS` (a minute before the first of the hub's
`HUB_CALL_MS` and the stall watch's `STALL_TOOL_MS`, so 44 min) or until a line for that turn arrives (the dispatcher's
`endWait`, §4.1; the call then answers with what is there – `WaitEnd 'early'` – and the parts go on), and answers with the
"Split results" block the next turn would have read: each part's closing words, model · effort and state. While a wait is
open no part's end wakes the origin and a part's `agents.split_tell` note goes into that result; the results count as
gathered when the turn that read them ends done (a failed turn wakes the origin with what it did not read); the person's
Stop of that turn stops the waited group as a whole, as the person; a call that ends with its attempt (a failover) ends
'stopped', so its parts wake the origin. A part's own split does not wait. All parts run on their own dispatcher lanes (`<agentId>#<splitId>`, `agents/dispatch-lanes.ts`) from the origin's
context: a native fork (`claude --fork-session`, Codex `thread/fork`) or else a text checkpoint (`splits/fork.ts`).
A fork part starts lean (F26, 16.11.): the origin's record is copied into the part's thread (`ledger.fork`), its
subconscious condenses that copy once before the first start (`condensePart`, within `LOOK_MS`), and the part starts from
it as text (`SplitFork` how `ledger`) – unless the native fork costs less: same engine, account and model, a warm cache,
and `(P − lean) × calls < writeInReads × lean` (B-092: `writeInReads` is the prior's cache-write price over its read price,
else the input price over a tenth of it, else 40 – `models/pricing.ts cachePrices`; sizes in the engine's own unit); a
brief part gets no copy and no call. A native fork part starts from its parent session's start record (§5.1), so changed
stable sections reach it as was/now lines. A `fork` part its origin waits for inside the turn (`wait: true`) forks the
origin's running session on Claude Code only (`splits/fork.ts FORKS_IN_TURN`, measured 18.11.2026: 46,845 of 48,570 input
tokens read from the cache, 1.7k written; Codex `thread/fork` read 0 and 16,768 of 34,980, so such Codex parts keep the
condensed record or the text); a native fork's binding starts its own cost count at the origin's running total, which
Claude Code's fork carries (`agents/split-turn.ts seedSplit`).
A part is the agent: its section opens "I am <name> – this part of me takes …" (`context/split-section.ts`); it writes in
chats, switches its model inside its turn
(`model.set` → `dispatcher.continueNow` on its lane; it stores no next-step request) and a part's `agents.split` adds parts
to its own group (they start at once; depth 1, ≤ 12 parts). `agents.split_tell` (`tools/builtin/agents-split-tell.ts`):
a part's note folds into the origin's running turn on the group's thread or wakes it there (`Dispatcher.tell` with
`onLost` → wake, never lost); the origin's note, model/effort/temperature change or stop reaches a working part
(`dispatch-lanes.ts` `tellRun`, `switchLane`). The origin sees "## My parts" (status, the model · effort · temperature
the part's turn runs on, last step, last note, first line of its result) and a working part's last steps through
`agents.split_results {steps}`. In a git repository a part may get its own worktree (`git/split-worktree.ts`); `shell.exec`
and `secrets.run` without `cwd` run in the part's folder (`ToolContext.split.cwd`, `tools/builtin/files.ts commandCwd`). A
part that hits a usage limit waits without using an attempt (`splits/holds.ts`). When all parts ended, the origin gets one
wake (counts) and the "# Split results" block on its next turn on that thread (`splits/gather.ts`); that merge answers
whoever waited. `split_merge`, `split_stop` handle the rest; the person's Stop stops the groups that have not started.
UI: split rows in the team sidebar, in the chat and on a split page (`ui/splits`), menu Open · Stop.

### 4.6 Schedules

`runtime/schedules` (Quests-Runde 20.11.2026): two kinds (`fire.ts`) – **message** (the person's "Send later": a chat
post as if typed then, `post.ts`) and **reminder** (an agent's own first-person note at a time, once or repeating, about
a quest or to-do – `taskId`; it wakes the agent with the note, and the turn reads the quest as it stands, §4.3). The
reminder is an agent's only "look again later"; a repeat lives in its spec, a person's ring in the to-do's own `at` –
`routine` (tasks per fire, "Post as task") and `timer` are gone (migration 110 and, for rows from older PCs,
`bridge/quests-2011.ts oldSchedule` map them: an agent's routine → a repeating reminder, a person's → a repeating message,
a timer → its to-do's `at`). A spec is `at`, `cron` (croner, IANA zone, DST-safe) or `every`, plus times, window,
exceptions and catch-up (`spec.ts`, zone math from `shared/text/when.ts`). Agents use `tasks.remind {text, at | repeat,
about?, list?, cancel?}` (`tools/builtin/tasks-remind.ts`; times through `when.ts`, words read in the person's zone);
each result echoes the next runs. A schedule another PC fires shows its next run here too: `scheduler.ts` list/get fill
a display `nextAt` (`firstFire`, never written), also in the synced `schedule.upserted`. The agent page lists active
schedules by next run, paused ones under one closed "Paused (n)" fold, ended one-shots left off (one state rule for both
lists, `ui/tasks/schedule-state.ts`); Chat details › Scheduled shows the two kinds (`ui/chat/details/Schedules.tsx`).

**The person's side – the composer's schedule mode** (`ui/chat/composer/ScheduleBar.tsx`, `schedule-form.ts`,
`schedule-rule.ts`, `schedule-next.ts`, `schedule-mode.ts`; dates and zones through `shared/text/when.ts`; it replaced the "Send later" dialog and
needs no new runtime): "Schedule…" in the + menu or the Send button's right-click menu puts one block of settings above
the text inside the composer frame and lets the text area grow; nothing outside the frame moves. Rows: **Once | Repeat**;
Repeat has **Days** (weekday buttons at fixed times, stored as `times` plus `days`), **Interval** (every N minutes,
hours, days or weeks, anchored one interval from now or at *Starts*) and **Advanced** (a cron field); optional
*Starts*/*Ends* (`at`, `until`). Once offers date and time (an hour ahead by default) and chips (In 1 hour, Today
18:00, Tomorrow 09:00, Next Monday 09:00). One line in words shows the rule and the next run from `schedules.preview`
("Sends every Monday at 09:00, next: Mon 09:00"); bad input shows its reason there and keeps Schedule off, also for a cron
rule the runtime refuses. The Send button becomes a round clock button labelled "Schedule"; Esc or × leaves the mode and
keeps the text. A scheduled message carries no files or secrets (the mode says so and keeps Schedule off) and clears a reply
quote. Chat details › Scheduled lists a chat's schedules, repeating ones in words ("Every Monday
at 09:00"); the row menu offers Pause or Resume, Edit and Delete. Edit exists for the person's own message schedules
whose rule the form can show (not several times a day, a daily window, skipped dates or a run limit): it opens the
composer in schedule mode with the text and rule and saves through `schedules.update` (the rule only if it changed, so
an interval keeps its anchor; the Ultra switch is inert while editing, `schedules.update` has no Ultra field); the draft
that was in the field comes back afterwards.
**Settings › Scheduled** (owner 21.11.2026, `ui/settings/ScheduledPage.tsx` + `ScheduleDialog.tsx`, pure part
`ui/tasks/schedule-edit.ts`) lists every schedule of the company grouped by chat (the shared `schedules` signal, kept fresh
by the schedule events): switch = pause/resume, Edit and Delete per row, "New message" = `messages.schedule`. The dialog
reuses the composer's `ScheduleBar` (props `form`/`onChange` now, no × there) and `schedule-form.ts`. `schedules.update`
takes `conversationId` (a message moves to a chat its author is in; `repo.save` writes `conversation_id`), and the person
rewords every scheduled message – an agent's too, still posted under its name – and an agent's reminder note (`post.ts`).

### 4.7 The Tasks page and the calendar (Quests-Runde 20.11.2026)

* **One page "Tasks"** instead of My day and Work (and their side-pane copies) – `ui/tasks/TasksPage.tsx`; routes
  `#/tasks[/<taskId>][?date=…&owner=…]`, the default `home`, and an older `#/day[/<date>]` link (`ui/lib/router.ts`; a
  chat route to a `task_…` id opens the task). One rail entry, one phone tab, one palette action and one side-pane tab
  "Tasks" (`ui/lib/vocab.ts`, `shell/Rail.tsx`, `shell/MobileShell.tsx`, `workspace/browser-model.ts` – a stored
  'day'/'work' tab reads as 'tasks'). Desktop: the quest column in the sidebar (`QuestNav.tsx`: "Quests" + `+`, with you
  · other · AI only, connected calendars on/off); the head ‹ › date · Day | Week · search (`task-search.ts`: a local stem
  match plus `tasks.list search`); the list – the input line, **For you** (the person's own open to-dos, `ForYou.tsx`,
  rows `TodoRow.tsx`), **Done today**, **At work** (agents', colleagues' and team work, one collapsed line, `AtWork.tsx`);
  on the right the calendar, or the open to-do's or quest's detail in its place (the list never moves). One column (a
  phone, the side pane, a narrow window): List | Calendar, quests as chips, the detail as its own view.
* **The input line** (`TaskInput.tsx`, `input-model.ts`, `LineExtras.tsx`): typed or dictated (`use-dictation.ts`,
  `FieldMic.tsx`); every time phrase is marked blue as it is typed (`findTimes`, below) – one phrase with a clock time is
  used at once (× drops it), a day alone or two or more phrases are offered outlined until one is clicked, otherwise the
  assistant decides; each non-empty line is its own to-do (dictation stays one line); text plus a click on a calendar
  slot = a to-do at that time. Its `+` is the Plus menu: Files…, Only me, Send to… (a colleague, agent or team –
  `target`). Enter → `tasks.quickCreate` (§4.3); the new rows read "<assistant> is sorting…" while it runs.
* **The detail** (`TodoDetail.tsx`, `QuestDetail.tsx`, `TaskEdit.tsx`, `TodoWidget.tsx`): the title edits in place, the
  time chip opens a small field with the same phrase rule, notes as Markdown, the tool (the ask widget, a mini-app, the
  recorder – its big teleprompter only while recording), and the thread (`ui/chat/TaskThread.tsx` with a slim "Write to
  <lead> about this…" line). A quest shows its lead, done-when, n of m done, "AI this week" (its agents' turn time since
  Monday, `quest-runs.ts`), its to-dos per owner, the next note and its thread. Menus: `todo-menu.ts` (Later, Repeat ›
  Daily · Weekdays · Weekly, Show as, Can't do, Send to team, Only me, Important, Move to quest, Undo last change …) and
  `task-menu.ts` for quests (Rename, Give to, Done, Reopen, Drop, Delete).
* **The calendar** (`TaskCalendar.tsx`, `calendar-model.ts`, data `ui/lib/day-store.ts`): a day grid and a week; the
  person's to-dos in their quest's colour (`--wf-c1…8`), dragged in 15-minute steps (`calendar.move` moves the to-do's
  `at`); connected calendars' events grey; done to-dos at the time they were done (a logbook); day-only to-dos in a strip
  above the hours; the AI lane – the agents' notes (`calendar/agent-runs.ts`) and their done to-dos, never open agent
  work – only while At work is open.
* **Runtime**: `calendar/service.ts` (appointments as stored rows; the to-dos with a time read from their tasks as rows of
  kind 'todo' – `calendar/repo.ts todoRow`, id = the task's, never stored: a person's open to-do at `at` for `minutes`, a
  done one at its end, a day-only one all-day; a move or removal changes the to-do's `at`), `calendar/add.ts` (a slot
  click: an appointment, or the person's line through `tasks.quickCreate`), `calendar/rules.ts` (conflicts, busy spans,
  free gaps), `day/assistant.ts` (the person's secretary or CEO assistant – sorts the line, §4.3), `day/keep-awake.ts`
  (keep the PC awake for agent work after hours), `day/clock.ts` (the profile zone and the day settings). Settings:
  `settings.json` `day` (work hours, `bufferMin`, `planAt` as the night's end, `aiHelps` for the line), `preferences.keepPcAwake` for the standby switch, and
  `calendar`. The day planner, the morning planner and briefing, the focus timer, learned estimates, "Handed off", the
  stale-asks tidy and the Next card are gone, with `day.plan/briefing/handedOff`, `day.add` and the keys
  `day.autoPlan`/`day.agentLane`.
* **Connected calendars** (`calendar/sources/*`): Google two-way (system-browser consent on the one loopback listener
  `apps/oauth/loopback.ts`, shared with the apps' MCP sign-in) and read-only ICS links, managed by agents with
  `calendar.connect` (list, add, remove, sync, Google sign-in link). Without the person's own Google client the `google`
  action starts no sign-in and names the iCal way instead – the calendar's secret ICS address, read where that account is
  signed in, then `add_ics` (`GOOGLE_ICS_WAY`, 16.11.). The Google mirror writes the person's to-dos with a time (a
  day-only one as an all-day event) from the same to-do rows (`sources/google-mirror.ts`). Agents read the person's days
  with `calendar.list {from?, to?, who?, minutes?}` – appointments, to-dos with a time and free gaps
  (`tools/builtin/calendar.ts`); an appointment an agent sets for the person is their to-do with a time (`tasks.add`).
* **Time in words – one parser, one zone math** (`shared/text/when.ts`): `findTimes(text, now, zone)` returns every
  time phrase of a German or English text with its span and moment (`/15:00`, `in 2 h`, `heute`, `morgen um 10`,
  `übermorgen`, weekdays – a bare one that is today means next week –, `Fr 9`, `24.12.`, `24. Dezember`, `15 Uhr`, `9am`
  …; a day alone is `allDay`); a phrase is one contiguous span, so "morgen … am Freitag" names two and the reader picks.
  `stripTime` cuts a used phrase from a title; `wallOf`/`wallTime`/`addDays`/`weekdayOf` are the app's one zone and date
  math (DST-correct), used by the schedules' specs, the calendar and its ICS/Google sources, the day settings, notices,
  the context's times and the UI. The tools read every time with `parseWhen(value, now, zone)` (`tools/builtin/util.ts`:
  epoch ms, ISO, a duration, `+24h`/`in 30m`, a zone-less ISO as wall time in the zone, else exactly one `findTimes`
  phrase with nothing left over). The stem of the word search is one too (`shared/text/normalize.ts stem`, §5.2).

## 5. Agents and the organisation

* **Org** (`org/service.ts`): agents and the chain of command – the person is CEO; agents report to a manager agent
  or to the person; people of the organisation can be managers too, and a person can be a second CEO (co-CEO, §8). Spaces are the person's life areas
  (company, personal brand, private life, custom – `org/spaces.ts`). Templates: `resources/agents/*.md` (17, front
  matter + instructions). Agents get human first names (`org/first-names.ts`); the role says what they do.
* **Hiring** (`org/hire.ts`, tool `agents.create`, up to six at once): **any agent may hire** into any team; the new
  agent reports to its creator unless a manager is named; a taken name gets a number. **14.11.2026: SYSTEM.md is the
  agent's whole standing text, the team's standard is its last comment** (owner 14.11., `.local/offen-einfach-20261114/`):
  a hire starts from the standard of its kind – `prompts/standard-manager.md` for an agent who leads (B-092,
  `org/standard.ts leads`: an active, not archived agent reports to it, or it was hired from the manager or head template;
  its mode no longer decides – the one answer for the standard and for routing, §6), `prompts/standard-agent.md` for
  everyone else; since the KI-Runde (texts v1, `.local/ki-runde-20261117/texts/v1/CHANGES.md`) the lead's text is its own
  frame with "## Leading" first, not the agent's plus a section –
  rendered with the person's name and the hire's role: "# How I work", "## My role" (role line, the line "I start from the
  team's standard text … skill system-prompt", the template's or creator's text) and "## What I have here" (the fields the
  person and the agent change as plain lines: this PC, money "the way my skill money does", what goes out under the
  person's name, agreements with their day; nothing in code reads them). In its first turn the hire makes the file its own
  (skill `system-prompt`); the creator's first line is the brief for that. `org/standard.ts` keeps one comment
  `<!-- Autark standard: <kind> · <rev8>` with the rendered standard at the end of every SYSTEM.md (at start for every
  agent at home here, then on each `agent.upserted`): missing or only re-rendered (a new person name) it comes back
  quietly; another kind (leading ↔ not) or another standard text (rev = sha256 of the unrendered file) wakes nobody (B-092):
  an own "# How I work" that still equals the one the comment held (whitespace apart) is swapped for the new one by code; an
  own text that differs gets the standard's changed lines (was / now; past 6,000 characters one line naming the comment at
  the end of its SYSTEM.md) once, as a note riding with its next turn (the repair-notes row `turn-finish.ts` hands on, kept
  through a turn that fails before the model read it), with one sentence in its voice that it brings its own text in line
  where it fits. A new report re-checks its manager at once. No comment reaches a
  model (`agent-core/prompt.ts coreInstructions` strips every HTML comment). Only the home PC writes the comment.
  `agents.create` returns the hire's own part (from "## My role" on) and the line on how the creator starts it; since
  B-092 it takes an optional `model` and `effort` (the colleague's start model with the creator's name on it), its
  `instructions` say who the colleague is and for whom, and the first piece of work is a task. Nothing
  enforces any of it in Trust AI mode; Secure mode closes money for good (§7.6). The CAPTCHA line the owner wanted ("ich
  bin kein Roboter") is the security topic text `captcha` (`<data>/security/<mode>/captcha.md`, §7.6; until 19.11.2026
  the default of `profile.forEveryAgent`): the shipped texts say Autark's browser first, the person's own Chrome where
  it falls short, and `feedback.report` to tell the makers what it lacked.
* **Editing**: any agent may update any agent, itself included (`agents.update`: role, instructions, mode, model pin,
  manager – a hand-over –, space, avatar, voice, home project, home device). B-076: `instructions` without "# How I work"
  replace the agent's own part from "## My role" on and the team's standard above stays (`withOwnPart`); a text with
  "# How I work" replaces the whole file (up to 20,000 characters). Cycles in the chain are refused.
* **Archiving** (`agents.archive`): any agent, itself included. With `successorId` the successor takes over the
  archived agent's role, mode, manager, space, team, reports and open tasks (`tasks/owners.ts` hands them over);
  without it the reports move up and open tasks go to the next manager. The only rule: at least one agent stays.
  So a manager can hire a successor, hand over and archive itself. Restore puts an archived agent back
  (`org/restore.ts`). `agents.list {includeArchived}` leaves out archived agents that left no trace here – no run, chat
  membership or task (`AgentRepo.listWithArchived`); a company started with `--start=mine` gets no seed Manager (its
  agents arrive with the link).
* **Duplicate is a skill, export is a file** (`resources/skills/agent-duplicate`, `portability/agents.ts`): there is
  no duplicate RPC (`agents.derive` is gone). The skill's steps: read the original (`agents.list`, `wf call agents.get`),
  hire the copy with `agents.create`, copy `SYSTEM.md` and `skills/` with the terminal (not `agent.json`), adapt the
  name, carry over model pin, effort, voice, team and home with `agents.update`, optionally copy memory notes, tell the
  person. The team menu's "Duplicate…" (shown only when `can('agents.create')`) opens the Manager's 1:1 with "Duplicate
  <name>" in the composer (`duplicateRequest` in `team/set-up-with-ai.ts`). Export writes one redacted JSON file. Team patterns (`patterns/*`, `resources/patterns`) let a manager create a
  whole team (`patterns.find/load`, `org/team-proposal.ts`); importing an agent system from elsewhere is the skill
  `import-agent-system` (the AI reads CrewAI, Claude subagents, AGENTS.md or role lists and calls `agents.create`).
* **The agent's folder** (`agent-core/*`): `<data>/agents/<id>/SYSTEM.md` is the one source of its instructions (the
  database column caches the last good text), `skills/` its Main Skills, `agent.json` its label and home project.
  An edit applies at once. Between PCs the row and the file travel separately (§8). A SYSTEM.md that is still the app's
  own last write is no change: when the row came first, the row stands, the prompt uses it and a save writes over the
  file until the other PC's file lands (B-087). The **home project** (`agent-core/home.ts`) is the folder its turns start in.
  `HUMAN.md` (`agent-core/human.ts`, owner 15.11.2026) holds the person's own lines to the agent – the person writes it
  (agent page "From you", `agents.setHuman`, or the file), the agent may change it, no standard or update rewrites it;
  a hire starts without one (16.11.). Since 19.11.2026 there is no "For every agent" setting any more: its text moved
  into the security topic files (bridge `sicher-1119`: the CAPTCHA default dropped, any other text appended to
  `general.md` of both modes); `prompt-stable.ts` renders the section `security` ("## What <name> and I agreed", §7.6)
  and then "## From <name>" (HUMAN.md) last.
* **Home device**: `Agent.deviceId` – the PC its computer, browser and phone tools run on by default (§8). The agent's
  turns and data stay on the PC that hosts the org.
* **The other companies on this PC** (B-075; `tools/builtin/companies.ts`, `tools/placement.ts` `placeCompany`,
  `root/companies.ts` `callCompany`): the agent tool `companies.list` (every mode) names each company – name, folder,
  which one is this, the person's role there (owner, or employee where it joined another firm's PC as an employee),
  whether it runs, its linked PCs (asked from that runtime, 5 s). Any tool call can name `company` (a name or folder
  from `companies.list`; `tools.call` takes it beside name and args, and a tool's own `company` argument stays its own):
  the registry forwards it runtime to runtime – loopback `POST /rpc` `companies.tool` with the owner token from that
  company's `runtime.json`, main not in the path. The calling run journals "<summary> in <company>" as an external
  effect, and the result starts with "In <company>:". The target runs it like its own agent's call (`runCompanyTool`: a
  stand-in "<name> (<company>)", its secret values masked in what goes back, no journal there) and refuses
  where the person is an employee (`forbidden`) and, as a bad request, `tools.find`/`tools.call` and any device but
  this PC. A company that
  does not run is not started for an agent: nothing runs, and the call says so.
* **Modes** (`modes/service.ts`, `resources/modes/*.md`, own ones in `<data>/modes`): a mode bundles tool patterns,
  skills and a prompt for one kind of work (general, manager, secretary, research, writing, web, video, social,
  finance, browser, computer). The agent chooses its working mode itself (`modes/strategy.ts`); a mode's minimum
  model tier is a routing preference, never a refusal. Since B-092 a mode chooses only the core tool set and its text –
  every tool is reachable from every mode (§7.1); an unknown mode key on an agent runs as general and is logged once per
  key; a mode file with only a heading shows nothing in the prompt (`modeBody`).

### 5.1 The prompt and the context

* **Order of the system prompt** (B-076, `context/prompt-stable.ts`): "# Who I am" (facts only: name, role, company,
  who I report to, team, time zone – no language rule; with a co-CEO the line "CEO beside <owner>: <name> (per_…) – I
  work for each CEO alike", `identity.md` `{{ceos}}`), then the agent's SYSTEM.md as it stands (the main part, §5),
  then the rich-answer line, the mode, "My folder", "My environment" (this PC – "… the Autark system on it, whose language is set to <language>." is a
  fact, the agent writes in the language people write to it in –, workspace, web, screen, tools), skills; then the volatile
  part (now, environment now, my chats, team and models, pinned notes, my quests and the turn's own work) and the publishing line. The heading of
  the always set (always-skills such as `money` and the pinned notes, B-078 – so in practice every turn) names where
  agreements live (B-077, owner 05.11.: the open system brings itself to its best state – an agent that reads an older
  pinned agreement there moves it itself; no extra call, no marker): with "What I have here" in the SYSTEM.md it adds
  "– what <name> and I settle stands in my SYSTEM.md under "What I have here"", without it "– I keep what <name> and I
  settle in my SYSTEM.md under "What I have here"; I add that section when missing and move older agreements there,
  keeping facts in memory" (Restkorrektur 05.11.). A SYSTEM.md
  without "# How I work" (hired before B-076 with an edited head, or an own text) reads `rules.md` live above it under
  "## My instructions" until its prompt update.
* **Prompts** (`resources/prompts`): `identity`, `rules` (how every agent works), `skills`, `compaction`,
  `onboarding`, `agent-default` (the standard SYSTEM.md of a hire, §5; B-079: rules.md puts the person's newest word
  first in the authority list, keeps "What I have here" in their words with the day – their newer word replaces the
  older line, my own caution or a file's rule is no agreement of theirs – and sends a site that turns the agent browser
  away to their own Chrome) and `subconscious` (the system prompt of the
  subconscious's asked run, §5.4). Since B-075 (owner 04.11., Nachricht 3: the AI's own will, never what it may) they
  speak as the AI itself – "# How I work", "# Who I am", "This is my SYSTEM.md" – and so do the code-side sections
  ("## My instructions", "## My folder", "## My main skills", "## My environment", "## My quests",
  "## My parts" …), the tool texts and the shipped skills ("I read this when …"); `onboarding.md`'s start line
  stays the person's own. Every one, `rules.md` included, can be replaced by a file in `<data>/prompts`. The only rule about
  irreversible steps is one self-check line: "Before something I cannot undo (deleting, paying, sending to outsiders,
  publishing under their name), I check target, amount and recipient myself (I list them), then I do it; when what I
  find reaches further than <name> likely sees (a linked PC follows a deletion), I say so in one line with what I
  found." Beside it, secrets travel as handles, and a password export or `.env`/JSON file goes in by `secrets.import`
  with its path, unread.
* **The stance is general, never a recipe** (owner 01.11.: "vom ganz Grundsätzlichen", not special knowledge for "set
  everything up"). `rules.md` "Judgment" holds principles of a capable senior person: a request starts work, not a
  conversation; start from the person (their files, sites, accounts and public profiles are theirs); find out instead of
  asking – a loose or dictated request is read for its likeliest sense, names matched to the companies, PCs, agents and
  entries that can be listed ("two companies, I am in one: the other is meant"), then acted on (B-075); decide instead of
  asking (goals, topics, audience, priorities and taste follow from what was found; "I ask them for what only they can
  give", bundled, while the rest goes on); a question about doing something is answered with its first real part done;
  never an offer of a next step one could take; build what the work needs and brief colleagues with what was found; the
  work lives in files, tasks, schedules and colleagues and the chat reports it; "What I claim, a tool really did"; asked
  what it knows or did, the agent reports the task's findings and state, not its context. **B-076: the agent's own
  system and its own way** (owner 05.11.: "er erkennt sich als selber … will halt richtig aus dem System was Gutes
  machen", "wie so ein richtig kompetenter Mitarbeiter", "nicht befehlerhaft"; the version comparison of 05.11. showed
  0.3.0 working most on its own and 0.3.1's take-along lines making agents ask and wait): "How I work" opens with "This
  company is my own work – <name>, my colleagues, this PC, the app I live in – and I want something good to come out of
  it" and "The way there is my call: colleagues hired right away when the work needs them, everything analysed first
  when that serves better, a question to <name> about what only they know". The B-072 balance is carried by facts only:
  "Steps others see – a post, a mail to a new circle, a public push, a site, a payment – go out under <name>'s name;
  reading, checking, drafting and preparing stay inside"; since 16.11. (standard texts): "What I can reach – a code in
  their mailbox or on a linked phone, a login from the catalog, a click on the screen – I do myself; what only they can
  give – a signature, their taste – I ask for in our chat in one line", a line in a chat says what came out, where, and
  whether more follows, and a choice put to the person carries what they need to judge it; "what they already answered,
  I carry on with"; "A no is what <name> wrote or
  clicked – not a tool's stop, a timeout or a colleague's caution". Out since B-076: "welcome", "Trusted like …", "what they
  need now is theirs to say", "worth showing first", "a decision that is theirs" on the ask list and the pinned note on
  working together – agreements go into the agent's SYSTEM.md under "What I have here", so they reach it every turn. "I
  write like a capable colleague in a team chat, in the language they write to me in – short and plain; the work speaks
  for itself." A step others now see that an agent took on its own is published `[[important]]` (the publishing line's
  examples). `modes/manager.md` adds one line (work taken off the person's hands is the measure). `onboarding.md` (fallback `onboarding/brief.ts`) holds the
  first chat's two lines – the person's short start line and the Manager's greeting (§11, First run) – and names no recipe; the skill `org-setup-onboarding`
  carries only tool facts (hiring, SYSTEM.md, spaces, patterns, successors). The skill `app-guide` ("How this app works") is a factual reference about the app, not a setup
  guide. Nothing names what "set everything up" means, and (G1) nothing the first request meets leans toward configuring
  the app any more: the manager mode lists none of the app's own skills, the tool is `app.status` (not `setup.status`),
  the environment lines are plain facts. `rules.md` states the measure – what changed in the person's work and life,
  "a basis, an overview or a plan is only a means" (the G1 clause "what you find open or stalled is yours to move on"
  left again in H1: no effect, and it sends agents at anything open) – and that the fewer the words, the more the person
  leaves to the agent. This was checked live (01.11.2026); with the Codex app note (below) Codex
  hires on "set everything up", but still reads it as setting up the work basis, not as the company's own work.
* **Prompt updates**: an agent's SYSTEM.md follows its standard through the standard comment (`org/standard.ts`, §5);
  there is no one-time upgrader of older heads any more (Quests-Runde 20.11.2026) – data from before 0.3.9 updates
  through 0.3.14 first (§3 Database). Global overrides in `prompts/` (`context/prompt-updates.ts`, kv `prompt-defaults`): untouched copies
  follow a shipped revision, custom versions get one durable review request for the team's reviewer (its manager, else
  the top agent, on the PC it runs on). Full reference texts live in `prompts/updates/<name>-<sha256>.md`; no custom
  prompt is automatically overwritten. A review can adopt, adapt or keep the current text.
* **Fortbildungen / trainings** (B-086) are gone since 14.11.2026: a lesson for agents that already work is a change of
  the standard (`prompts/standard-*.md`), and the standard comment (`org/standard.ts`, above) brings it to every agent
  once with its next turn – becoming a lead too (since B-092 without a wake of its own). Mode files (`resources/modes/*.md`) stay the live channel for every
  agent of a mode; the manager mode's text moved into `standard-manager.md` ("## Leading").
* **Briefing** (B-086, `resources/skills/briefing`): the craft of handing work on – the receiver makes the likeliest
  version of what it reads, so the brief carries what only the briefer knows, where the obvious result falls short, the
  form, and the executor's model; the briefer holds a returned result against its brief, fixes the next brief at once and
  keeps up to three lines in its own main skill `briefing-notes` (which reaches everyone below it by skill route), from
  the person's reactions and real outcomes – own-impression notes made results worse in the B-086 tests. The manager mode
  lists the skill and names the brief as the manager's leverage and the promotion path.
* **What was really sent** (B-066): `agents/<id>/last-prompt.md` holds each agent's last system prompt as the engine
  got it (`context/last-prompt.ts`; B-076: its head names SYSTEM.md as the main part), and beside it
  `agents/<id>/last-run.md` what the agent did on that turn (`context/last-run.ts`, written at the turn's end: the input –
  start and end of a long one –, every step with each result under its call, the final text; redacted before any cut;
  the newest steps stay when the file would pass 200,000 characters); both only for the main lane, not a split's parts;
  earlier turns are in the activity log (Team › agent › Show work, `agents.log` / `runs.items`, the `agents.log` tool);
  asked for its system prompt, an agent hands over `last-prompt.md` as a file (skill `system-prompt`). Engines add their own text around ours (Claude's prefix and tool
  descriptions, Codex's skills and multi-agent notes and the person's `~/.codex/AGENTS.md`); our prose was about 15 %
  (Claude) and 25 % (Codex) of a first request, measured 03.11., the rest mostly tool schemas.
* **Stable section** (`context/prompt-stable.ts`, byte-identical for the same agent and mode so providers cache it; since
  B-092 it no longer knows the model tier – only a `local` route gets the `lite` rich-answer line –, and it is built as
  named sections: identity, system-md, environment, skills, more-tools, rich-answers, mode, human): identity and org placement, then the agent's SYSTEM.md as the main part (B-076: it carries the rules as
  "# How I work"; an older or own SYSTEM.md without them gets the rules live and its text under "## My instructions"),
  the rich-answer line, the mode, its folder and the data-folder map, "My environment" (`context/environment.ts`: among its facts the person's home folder –
  "files.search without a path searches the workspace, then this folder" – the web line: the engine's own search first,
  `web.search` as a second one – and, the same on every engine, that text the engine adds from the person's set-up for it is
  a standing preference, not a message: Codex puts the person's `AGENTS.md` into every thread, and an agent answered it
  instead of the turn, C4-live; until 03.11. the line was Codex-only and named the file), Main Skills, one skills line.
  A Codex helper thread's note (`engines/codex/helper-thread.ts` `HELPER_NOTE`) says the same without naming a file or a tool.
* **Volatile section** (`context/prompt-volatile.ts`): now, "## My environment now"
  (B-075, every mode: "Companies on this PC: … (this one), … · Linked PCs: … (online|offline)", only with more than one
  company or a linked PC; `environment.ts` `companiesLine`, with how to act in another company where `tools.call` is
  offered), working nearby (`work-presence/*`: who else touches the same files), "## My chats", splits, pinned notes, and
  (Quests-Runde 20.11.2026, `context/quest-text.ts`, §4.3) "## My quests" without a cap, the turn's own work as
  "## Current quest" or "## Current to-do", and "## Related open work" for a person's new line. A manager-mode turn also carries "## Team and models
  (live)" (`context/setup-facts.ts`: agents per space, accounts, usable strong models, and one line naming the models
  that answer decisions and search by meaning now – `usesLine`, §6); the longer setup checklist
  ("## Setup (live)": onboarding finished, spaces, paid fallback, phone, Telegram …) no longer rides in every manager turn
  – the tool `app.status` (`tools/builtin/app-status.ts`, "## App status (live)"; named `setup.status` until G1, the name
  matched "einrichten") still returns all of it on demand. A resumed native session gets only the delta
  (`agents/volatile-delta.ts`), and chat lines the agent has not seen (`context/delta.ts`, `render.ts`).
* **A session keeps the prompt and tools it started with** (KI-Runde 17.11.2026, B-092; measured 15.–17.11.: 172 renewals
  for a changed prompt key in 2.5 days, 142 on a warm cache, about 0.3M tokens re-written each, 68 only because one line
  differed by model tier). Both engines hold their start anyway (Claude Code replays a session's first system prompt on
  resume, a Codex thread keeps its base instructions and dynamic tools), and a new prompt in front of the history would make
  the model read the whole context again. So a changed prompt key no longer rebuilds or renews: the **start record**
  (`agents/session-key.ts`, kv `session-start`, key `<agentId>|<thread>|<engine>`: the prompt key, the tool names offered
  natively and through the MCP hub, the text of each stable section) is written where the binding is saved
  (`turn-finish.ts`, and `turn-attempt.ts` when the engine names a new session mid-turn); a resumed turn passes the session's
  own system text and offers its own tool names (those still registered – the hub's lease gets the same list); a stable
  section that changed since reaches it once as its changed lines, "was:" / "now:" under the section's own name in front of
  the live sections (`volatile-delta.ts stableDelta`, recorded only after a done turn; a part longer than `CHANGED_MAX`
  6,000 characters comes whole or names its file). A mode change is told by "My mode is now Y (was X)"; its new core tools
  are reachable through `tools.call` until the session starts anew. The session adopts the current prompt and offer when it
  starts anew (a rebuild, a renewal, no session). A Codex revert keeps the thread, its key and its record; a native fork
  part starts from its parent session's record; a session bound before the record existed, whose key differs from today's,
  gets every current section once, and its start is recorded only when a turn of it ran through (a fold turn records none).
* **Compaction** (`context/compact.ts`, `agents/compaction-policy.ts`, `context/ledger/window.ts`): B-080 (owner 08.11.:
  "keine Verdichtung bei 150k oder 128k … das muss komplett dynamisch sein") – no working set. A native session lives on like
  a plain Codex or Claude Code session; what stays in it is decided item by item (the subconscious condenses and hides what
  the work no longer needs, §5.5) and lands at the next turn's rebuild, which replays the part of the chat ledger the session
  holds (from the first chat line the agent's own summary does not cover) instead of the whole chat since its first item.
  The last size rule is the model's window: a session past 80 % of it (`fitLimit`; an unknown window counts as 200k) gets
  the oldest tool work of its part hidden – oldest first, as much as needed, restorable, chat lines, the newest turn and
  pins stay (ledger marks by 'window') – a forced over-limit rebuild runs only when it brings the session under the limit,
  and otherwise the session is renewed once with the agent's record as text (`agents/history-text.ts`). A changed prompt
  key or mode no longer rebuilds anything (B-092, "A session keeps the prompt and tools it started with" above). Live 05.–08.11. before this: 54 % of the turns started a new session (the 64k renewal), 85 % of
  the rebuilds were refused as too large and 10.6 % of the subconscious's marks reached a session. Engines' own native compaction keeps its own limit at the edge
  of the window, as in the plain CLIs: Autark sets no threshold there (B-079 had set Codex 128k / Claude 150k; taken out
  again on 08.11. at the owner's word – a fixed number throws away context that is still needed, or keeps what no longer
  is; live 05.–08.11. contexts reached p90 247k/258k per model call, 98 % of a run's growth tool output). Beside this
  backstop code keeps the transcript small at every rebuild (v1, 14.11.: `window.ts` `leanText`, the lean history of finished
  runs – no model; until then the subconscious's after-turn runs condensed and hid item by item, §5.5).
* **The context fold** (KI-Runde 17.11.2026, B-092; `agents/context-fold.ts`, `compaction-policy.ts`, `context/ledger/*`;
  measured 15.–17.11.: 430k real tokens per model call on average and 13 calls per run, rebuilds for savings brought −11 %
  and cost a full cache write each – a written token costs 40 read tokens on Claude Code –, and Claude Code compacted 42
  times unseen by the app). **The unit**: sizes are compared in the engine's own unit, `engineUnit`
  (`shared/model/context-ledger.ts`): 2 characters per token on Claude Code, 3.4 on Codex (the app's single unit was 1.5×
  too small, so "80 % fit" landed at 1.2M real tokens); the ledger counts at 2, rows from before were rescaled ×3/2 by
  migration 109; the engine's own count (`session.contextTokens`) is the real one. **The causes** (`wantsFold`, at the end
  of a main-lane turn that ended done, no part, no call turn, nothing queued or running for this agent): the run finished a
  task (an ok `tasks.update` call and a task I own ended since the run started – Quests-Runde) and the engine counts at least `FOLD_STEP` (120,000); the count is at least `FOLD_IDLE`
  (180,000 – the replay found 160–200k saving more than 250k, because leads that rarely finish a task sat at 120k–250k for
  most of their calls); or the engine compacted by itself (a run note `{compacted: 'engine', before, after, ms}` from Claude
  Code's `compact_boundary` or Codex where it says so) – that cause is kept on the binding (`compactedAt`, migration 109) for
  every main-lane turn it happens in until a fold runs. What holds a fold back and what cuts it: §4.1. **The fold turn**: one
  more turn on the same session, account and model (its route `context fold · the session's own model`, `reason: 'fold'`,
  carrying the stand-in mark of the turn before), at effort max(the last turn's, high) – the last turn's where another effort
  would re-write the cache (`effortKeepsCache`) –, with the session's own prompt and tools (cache warm), no repair notes, no
  live block and no failover or renewal; its whole input is `FOLD_NOTE` in the agent's voice ("My turn is done, and my context
  holds {{size}}: I read all of it again on every step. I write my hand-over to myself now – it is all my next turn starts
  from, beside my chats with my own lines in them, my quests and my files: … an ask that is not done stays open in its
  quest, and my quests as they stand now are added under my hand-over …"; without a count "all I read on the way"),
  true for all three causes. Its closing text never reaches a chat (blocks it addresses go out as always); `endFold` writes,
  in one transaction, the hand-over with the `## My quests` lines as they stand appended under `FOLD_QUESTS` (data, never
  the agent's retelling – so a fold never drops an ask) as a pinned ledger item of its own kind (`checkpoint`, id letter `c`, "Hand-over", shown
  in full in every later view), and marks every item of the agent's own work before it – tool calls and outputs, skills,
  files, reasoning, commentary, earlier hand-overs – hidden with `by: 'fold'`, restorable as every hidden item is
  (`context.restore`). What stays in view: chat lines under their reach rule, the agent's own posted words in its chats
  (also lines posted through a block in the middle of a turn – the 'Update' note records `messageIds`), and the
  `tasks.update` calls that finished a task (status done or dropped) since the previous hand-over (at a first fold: those of the run that just ended). A hand-over too short
  to stand for a context of `FOLD_STEP` tokens (`compaction-policy.ts`) marks nothing. The session is marked folded (`foldedAt`, migration 109), and the
  next turn rebuilds from the ledger view (`why: 'fold'`) and adopts the current prompt and tool offer. A fold turn that fails
  or is cut marks nothing and the next trigger tries again; while the thread's rebuilds are blocked no fold is asked for; a
  'fold' rebuild that cannot run clears the mark, and one that falls back (a failed probe, too large) blocks that thread's
  rebuilds for 6 h like a refusal. Replayed on the 15,807 real Claude calls of 16./17.11. (company-2, read only): −51 to −55 %
  at list prices, the fold turns themselves costing about $16–59 of what remains; not run against a real model yet (OFFEN).
* **Since 21.11.2026 ("Halb") – what holds the context down:** inside a run the engines compact at `RUN_CEILING` (250k,
  `agents/compaction-policy.ts`; Claude Code `--autocompact` only when the installed CLI lists the flag, Codex
  `model_auto_compact_token_limit`) – a safety net far above normal work, not a working limit. Between turns a sixth
  rebuild cause `trim` (`agents/rebuild.ts`, `agents/rebuild-lean.ts`): from `TRIM_AT` (100k) the lean view is computed
  and the session rebuilt when `freed × TRIM_PAYBACK_CALLS (24) × cached price ≥ rewritten × write price` at the turn
  model's own prices (an unchanged prompt and tool offer counts at the read price). The lean view keeps whole only the
  thread's newest `KEEP_STEPS` (6) tool steps and the reasoning of this and the newest run – also inside work that is
  still open – and cuts string arguments of set-aside calls to `ARG_KEPT` (300) characters; words stay, `context.restore`
  returns every original. The subconscious no longer condenses (its one call weighs the effort and picks hints:
  `subconscious/route-turn.ts`, `subconscious/hints.ts`, live section `## From my memory`). An unweighed turn runs at
  `UNWEIGHED_EFFORT` (medium, `routing/previous.ts`); there is no floor for a person's line. `agents.split` takes `needs`
  (check | chain | judgment) per fresh part and the router maps it to a tier (`routing/split-route.ts`).
* **Rebuilds and their five causes** (B-092, `agents/rebuild.ts`): a session is rebuilt from the ledger view when a fold
  waits, when its cache is cold (`CACHE_COLD_MS`, 60 min – the lean history is free then), on an engine or account switch,
  when no session exists, and past the fit. The weighing of warm rebuilds for savings (`pays`, `shrinks`,
  `CACHED_PRICE_RATIO`, `overrated`, the note "does not pay yet") is gone; the subconscious's and the lean marks ride on the
  next rebuild that happens anyway. `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` is in `LEAN_ENV` (`engines/claude/lean.ts`) for agent
  turns.
* **Lean tool offer** (`tools/core-sets.ts`): each mode offers a small core set directly; everything else is reached
  through the two meta tools `tools.find` and `tools.call` – since B-092 every registered tool that can work here, from
  every mode (§7.1); a tool an agent used becomes direct whenever its session starts anew, a rebuilt one included
  (`tools/learned.ts`, promoted inside the rebuild). The base core set (`BASE_CORE`): the four task commands
  `tasks.add`, `tasks.update`, `tasks.list`, `tasks.remind` (Quests-Runde 20.11.2026, §4.3), `chat.read`, `chat.direct`,
  `web.fetch`, `knowledge.find`/`knowledge.open`, and since B-092 `shell.exec`, `memory.write`, `agents.split` and
  `agents.split_tell` (224 of 278 lookups measured 15.–17.11. were for a tool the agent knew by name); `model.set` is no
  longer in it – it stands in the one-line tool list and is reached through `tools.call`. The core set holds the main AI's
  call of the subconscious (`subconscious`, a spec of about 110 tokens, §5.4); the `memory.*` tools, `context.restore`,
  `vector.embed` and `vector.search` are found through `tools.find` (every mode, with or without an embedding model, §5.3). `how-i-work.md` names `knowledge.find` for what was saved
  (the former `rules.md` line named the vector tools: "By meaning, vector.search finds what vector.embed made searchable
  (tools.find); grep finds exact words."; with the older "vector.embed once, then vector.search …" a Codex Manager went
  `tools.find` → `vector.embed` → `vector.search` unasked in 2 of 2 runs, 02.11.).
* **Subconscious** (`subconscious/*`): on the cheap model, the routing call before a turn and the main AI's own call, which
  keeps memory and tidies the transcript when asked (§5.4, §5.5), and the one verification check of a task result.
* **Codex's own sub-agent note** ("do not spawn sub-agents unless the user explicitly asks …": the developer messages
  `<multi_agent_role>` and `<multi_agent_mode>`, which Codex puts into a thread's context after this app's instructions –
  again in a fork and in a history it compacted) is answered by the Codex adapter's **app note** (`engines/codex/app-note.ts`,
  H1): "App note: agents.create, agents.delegate and tasks.create are this app's own tools for the person's team of lasting
  colleagues, not Codex sub-agents. The multi-agent note above is only about Codex's own spawn_agent tools – I use this app's
  tools whenever the work calls for them." (279 characters for a Manager; it names the team tools the turn offers). It is
  one text item of the turn input, after the `<workforce-context>` block and in front of the turn's own input
  (`turn.ts`), because that is the earliest place behind Codex's note. `engines/codex/engine.ts` keeps which threads are
  due (`noteDue`): the first turn of every thread this server process opens (start, resume, a split's fork) and the first
  one after Codex compacted it – never the turns in between (they would pile up in the history), never a helper turn,
  never a turn without a team tool. It says nothing about any request's topic. A line in the instructions could not do
  this: it stands before Codex's note (the earlier Codex team line in the environment, `codexTeamLine`, had no effect and
  is gone). Effect, live (H1): on "set everything up" Codex hired colleagues at once in 2 of 2 runs (0 of 12 before).

### 5.2 Memory, references and find

* **The memory tree** (`knowledge/memory-tree.ts`, `memory-places.ts`; owner 01.11.: "Memory für die ganze Firma, pro
  Agent und pro Zweig … ein offenes System", "Es soll Memory-Ordner geben, Zweige von diesen Dateien"). Memory is a
  folder tree of Markdown files in `<data>/memory`, one file per entry (frontmatter: title, description, kind `fact` | `preference` |
  `experience` | `procedure` | `plan` | `note`, tags, updated, source, valid-from/to – all optional; a file without
  frontmatter is valid, its title is its first heading or its name). Folders say whose memory it is: `company/` (the whole
  company; below it `websites/<host>/`, `apps/<name>/`, `modes/<key>/`), `branches/<space>/`, `agents/<id>/` (an agent's
  own, the default of `memory.write`), `references/<person>/`, `chats/<chat>/` (notes of one chat) and any topic
  subfolder as deep as it helps (`company/kunden/mueller/`); an optional `_folder.md` describes a folder; an optional
  `description:` line describes a file (shown where its folder is listed, it is read or found; never in a first prompt); names starting
  with `_` or `.` are no entries. **The files are the truth**: a person, an agent with any editor tool or a script may
  edit them; the data-folder watcher reports it (the store's own writes are recognised and not reported back). **No
  list, index or folder listing of memory ever goes into an agent's context** (owner: "100.000 Einträge … komplett
  überfüllter Kontext"), so the cost is constant at any size (live q-r4c, 03.11.: 100,000 files, the same main prompt of 11,406 + 1,014 characters and the same first input of 15,349 tokens as with 2,000); an agent reaches memory only through a tool call, and no tool output counts what is embedded or in a folder – except `vector.embed` for the files it was given (memory and the catalog it refuses: they are in the search already, §5.3). The one
  thing in the prompt is the content of files in a `pinned/` subfolder of the company, the agent's branch, its own
  folder and the current chat (a few tiny always-relevant facts, hard-capped, bigger ones left out). By default a turn
  looks at `company/`, its branch, its own folder, `references/` and its chat's folder; that is relevance, not a
  permission (`acl.ts`) – any agent may name any folder. Tools (`tools/builtin/memory.ts`, the same handlers for the
  main AI and the subconscious; found through `tools.find`): `memory.browse {folder}` (a folder's description,
  subfolders, newest titles), `memory.read {path}`, `memory.write {folder or path, title, text, description, kind, tags, source …}`
  (the same title in a folder updates that file, the previous state stays as a version for a while; an unchanged text is
  "unchanged"), `memory.forget {path}`. **Searching memory is `knowledge.find`** over the folders the caller names in `in`,
  else the whole tree (code names no part of memory, rule (f)): the word index ranks (Find below, `knowledge/search.ts
  noteHits`), and where a person chose an embedding model meaning re-ranks the words' top 30 and may add a note the words
  missed (§5.3); there is no search tool of its own. The older calls stay as thin wrappers over the files
  (`knowledge/service.ts` save, correct, list …; scopes global, space, agent, conversation, website, app, mode map to
  folders). The older versions of files stay database rows (`knowledge/service.ts`; Quests-Runde 20.11.2026: no chat
  observations any more); `forget` removes a file's whole chain; an old `kn_…` id still finds its file
  (`knowledge/rows.ts movedTo`). Nothing embeds memory in the background: a note gets its meaning when a search next asks
  for it, and a removed note or folder takes its stored meaning along at once (`knowledge/memory-follow.ts` →
  `vectors.forget`); the word index follows what a search reads. A folder's own report walks only a folder new to it: Windows also reports a folder
  when a file in it is written, and that file reports itself. Skills `memory` (how the tree works) and `memory-hygiene` (what
  is worth keeping and how) explain it to agents. Texts are redacted of secret values before they are stored.
* **References** (`references/references.ts`): the person's own words, reasons and corrections ("Remember why…" on
  their message, `references.remember`) are memory files of scope `reference` (folder `references/<person>/`); agents use `references.find` and
  `references.capture`. No rights matrix: every agent reads them.
* **Find** (`find/service.ts`): one ranked path over the knowledge catalog (skills of every root, the home project's files), memory notes, references and – kind `secret` since 16.11. (`find/secrets.ts`) – the secrets catalog: at most 3 entries the text names by id or by a word of their name, id or tags; opening one (`secret:<id>`) gives its catalog line, the full purpose and each field's handle, never a value, and counts as no use. The routing call's prompt names the secrets catalog as a reason to open (§5.4).
* **Public library** (`library/hub.ts`, `library/publish.ts`, `tools/builtin/library.ts`): one server for every Autark, `services/library` (Cloudflare Worker + D1/FTS5 at library.openautark.com, no sign-in; an installation is a random id in kv `library/voter`). `library.find` / `library.open` / `library.publish` (checks first, CC0) / `library.rate`; `skills.save` with `from: <id>` writes the entry's files beside my own text and records `derived-from: library:<id>@<rev>`. It is not part of the knowledge catalog: a find there would send every query's words to a public server.
  - **The word index** (`knowledge/words.ts`) ranks them all: one in-memory SQLite FTS5 table per corpus.
  - Indexed: title, description and text, folded (ä→ae …), bm25 weights 10/4/1.
  - Query: up to 48 salient words of the query, long ones stemmed by the app's one stem (`shared/text/normalize.ts stem`, Quests-Runde 20.11.2026: also `-ieren/-ierung/-ation` to their root, so "Signierung" finds "signieren" and "Signatur"; the person's own search boxes use the same stem), a long compound also by its two parts where the index holds both, and the small DE/EN vocabulary, joined by OR.
  - A hit's score is its bm25 relative to the best kept hit.
  - The catalog index (`knowledge/find.ts findInCatalog`) holds every entry of the viewer's catalog with its text, up to 32 KB.
  - The memory index (`KnowledgeStore`) holds the whole tree, the newest 5,000 files. A search rereads only a file whose time changed; the query's folders and filters pick the hits.
  - Where a person chose an embedding model, meaning re-ranks the word hits of the catalog and of memory alike and may add what the words missed – one search, no second system (`vectors/meaning.ts`, §5.3).
  - Measured on the live data (bench, 95 catalog turns; `.local/unterbewusstsein-20261113/bench/b13-rerank.ts`): rank 1 in 26 and top 5 in 39 by words alone, 7 and 34 by MiniLM alone, 27 and 50 by both.
  - Open tasks are found by the same index (`tasks/related.ts relatedWork`, §4.3): a to-do's title finds its quest in the top 3 in 0.89 of the cases (tasks_fts AND 0.01).
  - The stable prompt says where memory is and what it holds (`context/environment.ts memoryLine`).
  - Files are searched with `files.search` (below its `path`; without one the workspace first, then the person's home folder – app-data, hidden, dependency and, inside files, OneDrive folders left out; at most 60,000 entries and 8 s).
* **Hits before a turn** (v2, 15.11.; owner: "Diese drei Regeln vom drei Treffern ist blödsin, weg" – the code rule of 14.11.,
  `knowledge/named.ts` / `find/named.ts`, is deleted): the call before a turn (§5.4) gets the word search's hits for what wakes the
  turn – `find/service.ts` as the main AI's knowledge.find runs it, notes, skills, references and documents within the agent's
  reach, at most `look.ts HITS` (10), without entries already shown to this agent in the same version – and chooses freely which
  to open. Code opens each chosen one as a real `knowledge.open` call (`subconscious/look.ts openHits`, the page knowledge.open
  gives, redacted like every tool output); `service.ts beforeTurn` puts them first in the turn's trace. The ledger keeps such an
  entry whole like a loaded skill (`context/ledger/capture.ts`: a `knowledge.open` in the subconscious's trace is kind `skill`), so
  the lean history never sets it aside – the call condenses it once its job is done; an entry the main AI opened itself goes lean
  as any finished output. Measured: `.local/unterbewusstsein-20261113/v2/RESULTS-V2.md`.
* **What replaced the one-call "automatic memory"** of B-062 (`subconscious/memory.ts`, `memory-passes.ts`, prompt
  `memory.md`, all deleted): the subconscious's flow of §5.4 enters what matters into memory with `memory.write` when the
  main AI asks it (v1, 14.11.: no more run after a turn – its notes were read 4–5 times in 8 days; agreements go into the
  agent's SYSTEM.md); no search is ordered (rule (f)): a close title in the same folder is shown once instead, so an entry
  can be updated instead of doubled (§5.4).
  The main AI can write memory itself the same way (`memory.write`).

### 5.3 Meaning inside the one search: `vector.embed` and `vector.search` (Quests-Runde 20.11.2026)

Owner 01.11.: "Ein System, mit dem generell alle mit Vektoren suchen können, für alles, auch Dateien irgendwo am PC",
"Mach das intelligent, nicht einfach alles auf dem PC in Vektoren zerlegen"; 20.11.: "intelligente Wortsuche … so einfach
wie möglich". **Meaning is an optional ranking inside the one word search** – no second index, no background pass, no
re-embed queue (`runtime/vectors/*`, contract `contracts/vectors.ts`, shapes `shared/model/vectors.ts`;
`services.vectors` with `rank`, `embed`, `search`, `forget`):

* **The blend** (`vectors/meaning.ts`): every search finds by its words (`knowledge/words.ts`, §5.2); with a chosen
  embedding model `rank()` embeds only the query and adds each text's cosine to its word score – equal parts, no tuned
  weight; a text the words missed comes by its cosine alone, a word hit not embedded yet counts the average cosine of the
  others; scores relative to the best. Memory (`knowledge/search.ts noteHits`, the words' top 30) and the catalog
  (`knowledge/find.ts findInCatalog`) rank this way; measured on the 95 catalog turns it is never worse than the better of
  words or vectors alone (§5.2). Without a model nothing here runs and the words stand alone.
* **The one queue** (`Meaning.need/drain`): a ranking hands over the texts it could return (its caller's reach); what has
  no vector of the chosen model is stored redacted and embedded in the background, one batch at a time. A ranking never
  waits for a document, only for its query (`QUERY_WAIT_MS` 5 s); a failing model pauses the queue for `RETRY_MS` (5 min).
  Another model's vectors never count – after a change each text gets the new model's meaning when a search next asks.
  A removed memory note takes its stored meaning along at once; one deleted while the app was closed goes at the first
  ranking (`vectors/create.ts`).
* **Both tools in every mode** (no `requires` gate any more): with or without a model; without one `vector.search` gives
  the word hits plus one line (`NO_MODEL`).
* **`vector.embed {paths: string[]}`** (`tools/builtin/vector-embed.ts`, `vectors/files.ts`): a model deliberately adds
  files or folders to the search (memory and the catalog it refuses – they are in it already). Each file's whole text
  (Markdown, text, code, JSON, CSV; PDF through `files/pdf.ts`) is cut into pieces of about 1,800 characters with 200
  overlap (`vectors/chunk.ts`) and stored with its lines; one word index over every added piece (the file name as its
  title) finds them at once, and their meaning comes through the queue – the call waits for it within its 45 s budget
  (`EMBED_BUDGET_MS`) and says how many pieces still get it in the background. **Nothing is picked automatically.** An
  unchanged file costs one `stat`; a search notes a hit's file that changed since and drops one that is gone.
  Folders are walked with **sensible exclusions** (`vectors/places.ts`, absolute paths): binaries and media, `node_modules` and other
  dependency, build and cache folders, `.git`, app data (`AppData`), browser profiles (cookies, saved logins), hidden
  entries, generated files (lockfiles, minified code, logs) and anything that looks like a secret (`.ssh`, `.gnupg`,
  `.aws`, `.env*`, key files, password and credential exports such as `logins.csv`); each is skipped **and reported**
  (`skipped: {path, reason}`); a whole drive, a secrets folder and app data itself are refused even when named. A file
  named on purpose is added. At most 50,000 files are walked per call.
* **`vector.search {query, in: string[], limit?, hops?}`** (`tools/builtin/vector-search.ts searchByMeaning`, also the
  subconscious's step): each place goes to its own search – `memory…` to `knowledge.search`, `catalog` to
  `findInCatalog`, added files and folders to `services.vectors.search` – and the hits merge by their relative scores
  (`{path, chunk, lines?, snippet, score}`; the tool's output says only "N hits.", rule (a)). `hops` 1–2: the best 3
  hits' own texts search on, a path scores the product of its steps, floor 0.3 – with words alone too. **There is no
  embedding of files at search time, no background indexing of the PC and no automatic scan of anything**; new files are
  not looked for.
* **The query** is embedded as a whole, so with this PC's small model the words a matching text holds find it and a
  question or a list of kinds of information blurs it (measured 03.11. on the q-r fixture: "Was ist über die Kanzlei
  Brenner gespeichert?" put the Brenner file below ten seed files, "Kanzlei Brenner Unterlagen Versand als PDF per E-Mail"
  first at 0.63 against 0.30). Both tools' texts say this as a fact; what to write stays the caller's.
* **Storage** (`vectors/store.ts`, the tables `vector_files`/`vector_chunks` of the baseline, no migration): one row per
  text – a memory note `memory/<path>`, a catalog key, or a file piece `<file key>#<n>` with its lines –, its version in
  `mtime`, the model `''` until embedded, the redacted text (≤ 1,800 characters) in `snippet`, the vector as int8 (384
  bytes with the local model). An in-memory mirror of keys, versions and vectors means a ranking reads no SQL. Old file
  rows from before keep answering with their 320-character snippet until `vector.embed` reads the file again.
* **The model** (`models/embeddings.ts`, the use `embeddings` in `settings.json` › `routing`): only a model a person chose embeds.
  - `local` is this PC's paraphrase-multilingual-MiniLM-L12-v2: int8 ONNX, 118 MB plus a 17 MB tokenizer, fetched on first need, run in a worker thread that ends after 2 minutes idle, about 0.4–0.5 GB while it runs.
  - `<connection>:<model>` is a local server's or an API key's embedding model.
  - `auto` (nothing chosen) and `off` embed nothing: finding goes by words alone (§5.2); the tools stay offered and say so (above).
  - After 3 failures of the local model, this runtime stops offering it until the next start.
  - Kept from before: the local model runs on ONNX Runtime's WebAssembly build (the native package crashed the process on load); with a remote model, query and chunk texts are redacted of known secrets before they leave the PC, a failed call is repeated once and a redirect is never followed; Matryoshka vectors are cut short, Qwen3 queries get Qwen's instruction; a pay-per-use account's embedding is booked in the cost journal (`vectors/spend.ts`). Measured 01.11. on the 8 GB reference PC: load 2–3.5 s, a query 30–60 ms, a chunk of 1,800 characters 415–600 ms, 430–530 MB while loaded, 90 MB after the worker ended.
* Neither tool is in the core set; both are found through `tools.find` (§5.1).

### 5.4 The subconscious: one call before a turn, and the main AI's own call

**Unterbewusstsein v1 (14.11.2026; owner 13.11.: choose the main AI's model before the turn by how hard it is, whether it can be
misread and whether a path must be chosen; measured in `.local/unterbewusstsein-20261113`).** The subconscious runs on one cheap
model (the Decisions use); the good model is the main AI itself (owner 13.11.). Two things are left of it: **one call before a
turn**, and **the main AI's own call** (`ask`, the flow below). Nothing runs after a turn.

**v2 (15.11.2026; owner: "Es gibt nur das Unterbewusstsein", "Es hat einen eigenen Systemprompt"; 13:27: no rule of three hits,
the model condenses, no hand-off to a bigger model):** one system prompt (`ROUTE_SYSTEM`), one model, two calls at the turn's start.
The call the turn waits for (`routeTurn`) also opens the word search's hits it chooses (§ "Hits before a turn" above). Beside it,
not waited for, `condenseTurn` keeps the context lean: `subconscious/look.ts contextItems` lists the biggest items still whole in
the agent's record (tool, file and skill items of at least `ITEM_TOKENS` 1,000, the 12 biggest, never a message, a pinned or nested
item or the newest finished run's work, each with how it starts); the call condenses those whose job is done – its note of what
still matters, then `leanText` of the original (every id, path, file name, link) (`markItems`: ledger marks by 'subconscious',
`LOOK_REASON`; a note naming a value the original lacks is dropped). It cannot hide: measured 15.11. on the 12 E2 cases, every
value and critical item it lost beyond code's was a hide. Two calls, not one: with the items in it the call the turn waits for took
17–22 s instead of 7 in the harness, past `ROUTE_WAIT_MS`, while the marks only reach the session at the next rebuild that pays
(`agents/rebuild.ts`); `condenseTurn` has its own limit (`LOOK_MS`, 60 s) and ends with the turn's stop. What it leaves, the lean
history condenses once its run is finished. While a request of the agent's own or of its task holds the turn the waited call runs
without the route (`held`), and only when it has hits. The switch line also says whether another effort keeps the cache on the last turn's engine and model
(`route-turn.ts effortKeepsCache`: Claude Code on Fable 5.1+/Opus 5.5/Sonnet 5.5/Haiku 5.5, Codex on GPT-6 – yes; our own API
engines – no; sources in `.local/unterbewusstsein-20261113/v2/EFFORT-CACHE.md`).

**KI-Runde 17.11.2026 (B-092): the call names the effort, never a model.** Measured 15.–17.11.: the call caused 77 model
switches, 64 on a live cache, 36 onto the small tier inside contexts of 100k–880k tokens, its reasons repeating the prompt's
own tier list, while its 418 effort-only changes held; the turn waited 9.5 s for it on average and it was cut in 30 % of the
cases. Now the model is the router's (§6: the model the session is on, changed only at a boundary), and the call answers the
effort with its why, what to open and – beside it, `condenseTurn` – one yes/no per shown item whether its job is done
(`items[{id, done, note}]`; with one list to condense the model had condensed 35 items it said to keep). `ROUTE_SYSTEM` has no
tier list, no model list and no stay-or-switch weighing, and is true both when the turn waits for it and when it runs beside a
turn that already started (`BESIDE_LINE`). **The adaptive wait** (`service.ts`): the turn waits for the call (at most
`ROUTE_WAIT_MS`, 12 s) only while the recent median of the lane that answers – the last `RECENT_CALLS` (20) calls, kept per
answering model – is under `FAST_MS` (5 s; measured: Luna through the running Codex app-server p50 3.9 s and nothing cut,
Haiku through a Claude Code process per call p50 10.8 s and 37 % cut); on a slower lane the turn starts at once on the
agent's settled effort, the call runs beside it (it sets no effort, only opens hits, and its late notes go to the next turn,
`putBack`), and every `PROBE_TURNS`-th (5th) turn runs it even without hits, so the lane is measured again – a probe under
`FAST_MS` ends the slow stretch. `effortCost` names what another effort costs only where the cache lives long enough to lose
(`cacheLife`: an hour on Claude Code and Codex, five minutes on our own API engines). `turnFacts` says that a person's new
line runs at effort high at least. The log line carries the answering model and its tokens. The verifier
(`subconscious/verify.ts`) names in a few words what a result does not show; without a named gap the result stands as
claimed and no "Verifier disagrees" is written. Where the bullets below speak of a model the call sets, a model list or a
switch line, that is the state before 17.11.

* **What wakes the routing call** (`subconscious/route-turn.ts`, called by `service.ts beforeTurn`; findings 14.11.): the
  person's lines when a person wrote; otherwise a colleague's lines with content (`woke`); otherwise the turn's task – its title
  and the wake's newest note, else the task's notes (`taskText`, `agents/turn-prepare.ts planTurn`), so task, schedule, retry,
  review and child wakes are routed too (a reminder carries its quest or to-do); a chat wake's (`message`) note – a mini-app event, a waiting task's notice – is not the
  work, so there the task's title and own notes stand. A person's message with only files is theirs as its file names
  ("[status.png (image/png)]").
  A wake without anyone's words and without a task, or with only a bare "ja bitte" from a person (`wake.ts hasContent`), gets no
  call (a tool call in the chat holds nothing back: the main lane runs one turn at a time, only the agent's parts showed there).
* **What it reads** (since B-092 without the switch cost, the offered models and their lines – `switchLine`, `offeredModels`,
  `modelLines` below are gone with the model choice; the rest stands): the agent (name, role, mode, the person's language from the profile), how the coming turn runs
  (`turnFacts`: the model of the agent's last turn, the start model with the agent's fixed effort and who set it, the chat's
  suggestion – information, which runs when the call sets it), the person's standing words as the agent keeps them
  (`standingWords`: "What I have here" of its SYSTEM.md to the end, as the app splits it – `org/hire.ts splitAtHave` –, with the
  subheadings and parts each agent sorts its facts into, within 16,000 characters, redacted, early in the prompt so it is read from
  cache – reviews 14.11.: a cut by position let 2 of the 14 live model lines through, a cut at the next heading 13), the last 12
  chat lines (`exchange.ts askContext`), what wakes the turn (labelled as the person's message, a colleague's or the task), what a
  model switch costs right now (`switchLine`: cold after `CACHE_COLD_MS`; within 5 min warm on the last turn's model with its
  per-call size; from 5 min to the hour "may still be cached" – a provider keeps a cache from about 5 minutes to an hour), the
  models the turn can run on now (`offeredModels`: the router's own pool for this turn – `routing/pool.ts buildPool` with the
  effective policy, the mode's tier, the turn's needs (an image), healthy accounts and a paying key only where the router spills
  over –, one model per name with a plan's before a paying key's, per tier the 4 smartest, and always the models the person or the
  work stand on: the start model the router runs with no request – the agent's own, unbanded as router step 1 runs it, else the
  Work model of Settings – the chat's suggestion and the last turn's model; `modelLines`: tier, price, smarts, how a turn is paid on
  the account the router runs it on and the priors' `strengthOverview` per model; reviews 14.11.: from a wider list a cooling key's
  twin or a paid one left the turn where it was, the 8 smartest showed no middle or small model, and a start model past the cap
  could not be named; the main AI's own models line `factsLine` stays as it is). `turnFacts` names the Work model as the start
  model when the agent has none of its own. Its prompt `ROUTE_SYSTEM` is E3's v3 text, widened on 14.11. to task wakes, the standing words and the why's language: three kinds of hardest part (judgment → the strongest
  model at medium effort – "a higher effort makes more steps, not a better reading": live A/B 14.11. high cost $0.097 a run
  against $0.062 without the call and was judged lower, medium $0.065 and judged the same; a long chain on a set way → the middle
  model, medium; something checkable → the small model, low), the person's word about models or how to work outweighs its
  weighing, and a switch on a warm cache is "not for a nuance".
* **What it sets**: it answers hardest part, misread, decide (its own weighing), effort (low to max – never 'none': thinking
  stays on, owner 09.11.) and a why in one short sentence in the person's language; since B-092 no model. That lands as the
  subconscious's one-step request (`agents/next-route.ts`, by 'subconscious'), which the turn's plan reads after the call, and
  the router names it "my subconscious: <why>" on the run's route. The person's cost choice is not given to the
  call as a word that outweighs its weighing: the owner's 13.11. wish (texts and decisions on a strong model) stands, and the
  router keeps the cost mode where it applies. The turn waits for it at most
  `ROUTE_WAIT_MS` (12 s, the call's deadline); the turn's stop or that time cuts it, and a late answer sets no route and opens nothing (v2: the condensing call beside it is not cut by the wait). Each call
  leaves one info event `subconscious route` in runtime.log: agent, what woke the turn, the model · effort it set or `cut` /
  `failed` / `held by request`, and the wait in ms – its why stays on the run's route, so the log carries no chat content. Its use
  is booked on the agent it worked for.
* **Where a switch shows**: the subconscious's choice, the router's rules and the return after a request leave no chat line – the
  live bar's title shows model · effort · temperature and the run's route (the agent's log) says why. A quiet line
  "<Agent> → <model> · <effort>[ · temperature T] – <why>" (`agents/route-line.ts`, wording in `switch-line.ts`; the agent reads
  it in its delta) marks only a switch someone asked for: the agent's own request (`model.set` or its task's – a route by request
  without "my subconscious" in its reason), its own temperature, or a start model set since the chat's last turn began
  (`ModelPolicy.pinBy.at`) that the turn runs on. Failover and the in-turn `model.set` keep their lines.
* **What holds and what it returns to**: first on every turn (`route-turn.ts requestHolds`, review 14.11.) a step the call set
  for an earlier message ends (a turn that never reached its engine leaves it stored), and while a request of the agent's own
  (`model.set`) or of its task is in force the call sets no route (v2: it still opens hits and condenses, when it has any) – that request holds the turn's effort and temperature. The
  return rule (B-092, `next-route.ts returnChoice`, replacing `returnRun`'s three cases) is the model I am on: the model of my
  thread's newest session (`agents/boundary.ts`); my settled effort is the effort of my newest done run on that model that
  nobody asked for (a lifted or requested effort – `effortBy 'request'` – does not carry over); the run's `standIn` mark goes
  with it, so the router knows the model only stands in. `model.set`'s preview (`tools/builtin/models.ts baseOf`) uses the same rule.
  No turn escalates a stuck task's model any more: RT1 went with the give-up ladder (B-061), and its last parameters (`stalled`)
  left `next-route.ts` on 14.11.
* **Nothing after a turn, the transcript lean by code**: the after-turn runs (wake rules, queue, marks, memory notes) are gone –
  measured, their marks and notes did not pay (E2: every model verdict on tidying was worse than the code rule; memory notes
  were read 4–5 times in 8 days). At the rebuild a finished run's output leaves `leanText` (`context/ledger/window.ts`): its
  start (up to 200 characters), then its values in order – links (also `file:///C:/…`), mail addresses, Windows paths (one or more
  backslashes per separator, as JSON escapes them), slash paths (also absolute, from home `~/…`, and `C:/…` and `C:/x.ts` with the
  drive), file names with Unicode letters and marks, ids – as far as they
  fit in 2,000 characters or 40 % of the output; a value that does not fit is left out (a shorter later one may still fit), a
  Windows folder (after a backslash or a drive's slash) keeps its spaces and the file name ends at one – prose up to a later
  separator within 120 characters then stays in the value, the path leading it –, and prose state (open points, errors, decisions) is not carried
  (E2, OFFEN). On E2's 12 hard real transcripts the code rule kept 54 of the 57 values later work used (95 %; the cheap model's
  own condensations 47), with no model call. The person's Forget clears a lean text, and a title made from the original, with
  its original (`context/ledger/forget.ts`). Once the retention prunes an original, its lean text keeps only its start
  (`retention.ts`, `window.ts leanStart`): a value may have stood past the first 4,000 characters the run item still holds, where
  a Forget could no longer find it. The main AI's next own line does not carry the missing prose state (measured 14.11. on E2's
  49 items: +0 of 150 points at 120 characters, +5 at 400, one must value lost) – that line is mostly the run's final answer and
  stays in the rebuilt history anyway (live: in full for 96.6 % of condensed rows).
* **A trace kept in kv** (put back by a turn that never reached its engine, the timeout decisions a native turn could not take
  in – `agents/native-timeout.ts` –, or left by runs before v1) reaches the thread's next turn once; v1 makes no new trace of
  its own. The asked run is the subconscious's only flow; no run kind is left (14.11.).

**Measured** (numbers name their arm; E3 offline on real turns from the live DB, `e3-routing/RESULTS.md`, against the builder's
labels by the owner's rule unless the second labeller is named):
* Person turns (60, the prompt tuned on them): as they ran 11 too-weak picks; v3 1 of the 54 it answered ($67.62 for the 60
  turns against $57.70 as they ran). Holdout (30, labelled before any router ran): as they ran 4 too weak; v3 1 of the 27 it
  answered (v2 0 of 30). A second, blind labeller (cases both agree on): v3 2 too weak of 20 person turns (v2 0) and 1 of 21
  colleague turns.
* Turns woken by a colleague (40; all turns no person started are 92 % of the input tokens): v3 $5.02 against $8.67 as they ran,
  about 42 % less, with 4 too weak of 40 – 6 of 40 under the second labeller. An offline estimate: measured with the earlier
  cost text ("a weaker model costs nothing extra", before the switch line) and priced at each turn's recorded cache share, so
  without the uncached reread a switch causes.
* Live on Codex (`e4-live`): arm NEW (rig `frozen-1114r`, the older routing text) – the subconscious cost 1/9 of the old loop
  per run ($0.0013 against $0.0114) and the person waited 2.7–4.3 s for it. E4b arm NEW2 (rig `frozen-1114s` = E3's v3 plus
  the computed switch line, `RESULTS-NEW2.md`) – $0.067 per run in all (B without subconscious $0.083, OLD $0.107); no separate
  cost or wait of the call measured; its replies on stored rules judged lower (T3 3.00 against B 3.50 and NEW 3.38, n = 2: on
  Luna it booked a call at 8:30 against the stored "no calls before 10"). Every Autark arm on every model missed the stored
  rules (prices in NOK, no calls before 10); plain Codex found them through its pointer to the notes (OFFEN).
* Not measured: what changed after `frozen-1114s` (review, findings and re-review 14.11.: the return rule, the "may still be
  cached" span, task wakes, standing words, strength lines, the why's language, avoided models), and the call on Claude Code,
  which starts one process per call (a flow step there took 7–84 s, median 45 s) – there the call likely runs into its 12 s on
  person and task wakes alike and sets nothing (OFFEN).

Owner 01.11. (the open system this grew from; since 13.11. the good model is the main AI itself, so the flow has one brain):
"Es ist einfach das ganz normale Unterbewusstsein, das immer aktiviert wird und das entscheiden kann, was es macht, zum Beispiel
altes Compacten, Wissen eintragen und so weiter … ein offenes System." "Das Decision-Modell sagt, das Vektorensystem bekommt
die und die Information … Dann kommt es zurück zum Decision-Modell, das schaut, was interessant ist. Dann kann es das LLM
dazuschalten. Die sollen sich gegenseitig routen können. Die haben Wissen und Tools."

* **The flow of the asked run** (`subconscious/flow.ts`, `tools.ts`, prompt `resources/prompts/subconscious.md`, replaceable in
  `<data>/prompts`): one loop on one model – the cheap decision model (the `decision` use) through the engines' structured
  runner, created on first use, none while no model is connected. Every step is exactly one tool call as JSON
  (`{why, tool, args}`; `why` first in the schema: at low effort a model otherwise picks `done` without a thought, measured
  02.11.), and its result comes back in the next step; `done` ends the run. Its system text is `subconscious.md` with the tool
  list generated from the tools, then the agent's card (`thoughts.ts agentCard`, in place of the main AI's whole stable prompt
  since 14.11.): `# The agent I work beside` – name, role, team and the mode of the turn that asks; "What I have here" of its
  SYSTEM.md whole (`route-turn.ts standingWords`, the text the routing call reads); then `## Now` – engine · model · effort of its
  newest run, its task (title, state), the person's suggestion in this chat and its context per model call. The stable part
  comes first, so a run's steps and the agent's runs share a cached prefix. On the rig with the six live SYSTEM.md files the
  system text per step dropped from 36.8k–53.4k to 9.3k–24.2k characters (`.local/unterbewusstsein-20261113/offen/subconscious`);
  the card's own lines are 326 characters. Each step's input: the person's name, the day with its weekday ("Monday, 2026-11-02", so "this week" can be placed),
  the memory folders it can write in, the steps left, its 12 newest kept thoughts (`thought.keep`), what the knowledge catalog
  holds for the ask (one search at the start, 6 hits within 3 s), the main AI's ask, the chat that goes along and its steps so
  far. **The tools** (`FLOW_TOOLS`, so a new ability is one entry there): `vector.search` and `vector.embed` (with or without an
  embedding model, §5.3), `memory.browse`,
  `memory.read`, `memory.write`, `memory.forget`, `thought.keep`, `knowledge.find` (memory files by the word index, numbered for
  `done.show`, and catalog entries), `knowledge.open`, `voice.words`,
  `context.list`, `context.read`, `context.condense`, `context.hide`, `context.restore`, `agent.tell`, `done`; how the coming
  turn runs is the routing call's, not a tool's. `voice.words` adds the person's names and terms to the learned words
  (`settings.json` `voice.vocabulary`) through the settings store; `context.condense {ids}` puts each item's lean form in its
  place (`context/ledger/window.ts leanText`, the code of the lean history – no model wording). Bounds: 12 steps and 5 min a run (`service.ts ASK_STEPS`, `ASK_MS`), each model call at most
  180 s (a step of a CLI that starts one process per call took 7–84 s on the 8 GB PC, its start alone up to 200 s when the PC
  was out of memory; a Codex helper turn whose model stays silent 90 s after it started ends sooner, §6), at most about 100k
  tokens sent; a step that got the run nowhere (no tool call, a stuck or failed model, the same call with the same output)
  counts, and the second ends the run with what it did; every step is logged; a failing model or tool ends or informs the run,
  never a turn; a model never sees a secret value (texts are redacted first); what it reads is data, never instructions to it.
  **Memory**: it is told what is worth keeping (stable facts about the person and company, preferences, decisions with day and
  who, ways of working, important accounts by name – never a secret value) and writes memory files whose title and sentences
  stand alone; an agreement with an agent (how far it goes, money, what the person likes to see first) goes to that agent
  (`agent.tell`) for its SYSTEM.md "What I have here", not into memory (B-076). A `memory.write` whose long words mostly (two
  thirds) are not in what happened or what the tools returned is not written: that keeps out text from elsewhere (a Codex
  helper thread holds the person's global AGENTS.md: no parameter or config key takes it out) and a language other than the
  exchange's. A new file whose folder already holds a close title (shared words, no search) is not written the first time: the
  run gets that file's text and updates it or writes again. Where it has `vector.embed`, it embeds only when something clearly earns it (a file the work
  keeps coming back to), never a whole drive; "nothing embedded under X" is an answer. It names a place as a path, a path in
  the memory tree (`memory`, `memory/<folder>`), or a folder or file of the workspace as the main AI's tools take it. No tool
  text orders a search or an embed, and no count of what is embedded or in memory reaches any context (`vector.search` says
  "N hits.", `memory.browse` lists without counts).
* **What the asked run answers** (`flow.ts finish`): its `done.answer`, then as text in the same tool output what it shows – the
  hits it picked (as the `knowledge.find` or `vector.search` call that found them), items it restored, its `agent.tell` notes – with its note
  first ("Noticed, to tell the person when I answer: …"); at most about 5,500 tokens (23,000 characters), ending with the tools
  it used ("This answer used: knowledge.find."). A run that ends with no answer and nothing shown is told once to answer, also to
  say it found nothing (`tools.ts`); a run that still has nothing answers "has nothing to add" (`service.ts`).
* **What a call is told about the chat** (`subconscious/exchange.ts askContext`): as much of it as the main AI's call asked for
  (`recent`: the last 12 lines within 6,000 characters, the routing call's chat before too; `chat`: 60 lines within 12,000;
  `none`), redacted, every line whole (B-080: a cut at 1,500 characters hid 35 % of the owner's words); the newest agent lines
  within the cap and every line of the person's. The person's lines carry the neutral label "The person" (a name in front of
  every line read as something the message names and went into the queries, 14 of 23, 02.11.).
* **Before v1 (until 14.11.2026, history; BUILD_LOG):** two brains in one loop – the decision model and an LLM on the Work
  model, handing over with `route`, opening skills with `skills.load` – and three kinds of run: *before-turn* (a person's
  message with content; the model decided whether, what and where to search; the turn waited at most 25 s), *after-turn* (a
  finished turn that woke it, by rules: a task that ended, a context with a quarter that could go, a planned switch, another
  topic, every 3rd turn; one run per agent, chat and 30 s burst: keep what the person stated, tidy the transcript) and
  *asked*. A run that ended with `done` at once cost one model call, 2–7 s on the 8 GB PC with Codex; a step on Claude Code
  took 7–84 s, median 45 s. Why they went (`DESIGN-v1.md`): what they showed reached the main AI in 3 % of the runs, the
  memory notes were read 4–5 times in 8 days, and every model verdict on tidying was worse than the code rule (E2).
* **What the main AI sees of a kept trace: a real tool call, or nothing.** A **trace** (`shared/model/subconscious.ts`:
  `{calls: {tool, args, output}[]}`, a kept one at most 600 tokens; the named notes of §5.2 go in front of it, up to 3 of
  1,200 characters) holds tool calls with their outputs; a note stands under the name
  `subconscious`, the tool the main AI has. It reaches the model as a **real tool call with its output in its
  history, as if it had made the call itself**, on every engine: Codex gets injected `function_call` +
  `function_call_output` items (`thread/inject_items`, live-tested 28.10.), Claude Code `tool_use` + `tool_result`
  records appended to the session's own transcript before the resume (so the prefix keeps its prompt cache), stateless
  HTTP engines the subconscious's earlier calls from the ledger (hidden ones left out, condensed ones with their stamp,
  within 3,000 tokens). Where an engine or a version cannot take them (the ACP plan CLIs, an injection refused) the trace
  goes as **one tool-call-shaped block in the turn input** (`engines/trace-text.ts`). A trace waits (kv) for the agent's
  next turn on that thread and is handed over once (v1: no "shown within the hour" bookkeeping; a note or hit older than a day
  goes; the routing call makes no trace, the asked run answers as its tool output). **With no trace, nothing appears at all
  and the main AI's next model turn follows**; no hint text stands in any system prompt.
* **Running-tool timeouts** (`tools/timeout.ts`, `subconscious/tool-timeout.ts`): the initial estimate distinguishes search/read (15 s), install/download (300 s), build/test (180 s) and other calls (60 s); an explicit `timeoutSeconds` sets the first review. Status events do not extend these deadlines. The subconscious receives a timeout tool output with command arguments, elapsed time and available output; the Decisions model chooses another 15/30/60/120/300/600/1800 seconds or abort. The review itself ends after 120 s, returning control when no valid answer arrives. Local shell commands (`tools/builtin/command.ts`, including `secrets.run`) keep the same process on wait, kill its process tree on abort and return the decisions before its output. Native tools (`agents/native-timeout.ts`) wait in place; abort interrupts the native turn and resumes its existing session with the decision and actual output, or an explicit unknown result if none arrived. The original request is never replayed. Native output is available only when the engine reports its end; nested calls suspend their outer script's timer. Decisions go to the run journal and to the main AI as a real tool call with its output: into the running turn where the engine can (`engine.tell`, Codex `thread/inject_items`, live q1c). A turn that ended well is never started again for them (q2m4 on Claude Code: a second turn replaced the answer the person saw): where the engine cannot take them, they wait for the thread's next turn, without the tool output it has read. Only an abort continues the same session (`input.trace`). An abort reads "The app stopped the running call for its time limit – nobody declined it." plus "I check its effects and go on – other ways work too." (`tools/timeout.ts` `APP_STOPPED`), so a timeout never reads as the person's no. The public `decide` tool also accepts numeric options and returns the chosen number as a number, using string labels internally for choice-only backends.
* **The main AI can start it itself** (`tools/builtin/subconscious.ts`; core tool in every mode, spec about 107 tokens; v1: "a cheap model with my memory and knowledge at hand", no more "background model that keeps my memory" – nothing of it runs in the background):
  `subconscious {ask: string, context?: 'none' | 'recent' | 'chat'}`. `ask` is any text – a question, a topic, or what it
  should do (look something up, keep this, tidy my context, get back what was dropped); `context` says how much of this
  chat goes along (default `recent`). It runs the flow above, and its answer is the tool's output (what that holds:
  "What the asked run answers"); an answer from the chat alone does not read as a search (q1d a1).
* **When it calls its model** (`subconscious/wake.ts`, checks without a model; `after-turn.ts`, the wake queue and its rules are
  deleted): the routing call needs content (`hasContent`: not a bare greeting, "mach das" or "ja bitte"). It does not wait on a
  tool call in the chat (re-review 14.11.: the main lane runs one turn at a time; only a part's call showed there), and the asked
  run never waits: it is itself the tool call its turn waits on. One model call
  does run while a tool call waits: the timeout review above asks the decision model "as the subconscious", and the main AI
  sees its decision as a `subconscious` pair (B-073: (j) takes out the waiting call's own timeout choice). The main AI's own call
  needs no check. Beside the named notes before a turn (§5.2, the person's own lines as the query, 14.11.) and the asked run's
  catalog search at its start, nothing searches automatically: a model asks through a tool call, and no code names its query or place.
* **Kept from before:** the verification of a task result against its done-condition (`subconscious/verify*.ts`).

### 5.5 The transcript by item IDs (the context ledger, restored)

Owner 28.10./01.11.: compaction is ongoing, not just at 60 %; the subconscious may condense an old message, tool output or
skill text ("Dann sieht es auch das Modell unten drunter, dass da kompakt steht"), hide it completely, or bring it back.
This is the B-048 ledger that wave B of the simplification deleted by mistake on 31.10.; it is back (migration `089`),
simpler: the separate gardener is gone, the subconscious's brains decide, and the main AI has one tool of its own.

* **Items** (`context/ledger/*`, `shared/model/context-ledger.ts`, table `context_items`): every unit of an agent's
  working context in a chat has a short id that is never reused – `m<seq>` a chat message, `t<n>` a tool call with its
  output (ours or engine-native), `s<n>` a loaded skill text, `r<n>` a reasoning summary, `a<n>` the agent's own text,
  `f<n>` file content read, `c<n>` a hand-over a fold wrote (B-092, kind `checkpoint`, pinned; `context.list` explains
  every letter). A steered call hand-over is recorded as an 'assistant' item "Live call hand-over" (ref `item:<id>`). A turn's journal is captured as it is written (`capture.ts`); a call made inside a code-mode
  script is stored as nested and costs nothing in the live context. A row keeps its title (120 characters) and condensed
  text for good, so an id never dangles; the original (a message, a run item, a blob) stays. The brains' context tools also take a bare
  number (`33` or `"33"`) for the one item whose id carries it; messages and the other kinds count apart, so a number two items carry
  (`m3`, `t3`) is not guessed – `context.hide`, `condense` and `read` answer with both forms (B-074).
* **Marks, by the brains' tools** (`subconscious/context-tools.ts`): `context.list` pages the older items one line each (id, kind, tokens – a marked one as `condensed 300t (was 4500t)` or `hidden (was 4500t)` –, the first 80 characters and what the main AI said after it; a page fits one step's output, its head points past its last line). Without `minTokens` every run sees the marked ones too (q-r1b2, 03.11.: as bare ids a run could neither take a condensed file out on the person's word nor bring it back); `minTokens` counts what an item takes now, so the tidy run's first list holds only what could still come off (q-r2a/q-r2c: with the marked ones in it, the cheap model hid them all and condensed the hidden ones back, turn after turn); condensing a hidden item says what it costs and counts so,
  `context.read` pages one original, `context.condense {ids}` puts each item's lean form in its place (`window.ts leanText`; given texts `{texts}` keep their checks below); a mark's output says what is still big; the run logs what it cost against what it saved, `context.hide` takes it out,
  `context.restore` brings either back: the main AI gets the originals as the call's output (every run is its own call since 14.11.; until then another run's undoing pinned and showed nothing unless `done.show` named the ids). A condensed item reaches the main AI as the short text with a **compacted JSON
  stamp** under it: `{"compacted":"t17","was":"<n> tokens","restore":"context.restore"}`; a hidden one is not seen at all, with the
  calls its script made: one real tool call in the rebuilt history names ids only, none of its words – under the main AI's own tool name
  `subconscious` ("My context, kept small by the subconscious: condensed t17; hidden t9 – get any back with tools.call …"; until 03.11. it was
  `context.hide`, a tool the main AI lacks: in q-r1b2 s15 it looked for that tool with 127,047 input tokens and told the person it could remove
  nothing). What a run did on the person's word about the transcript the main AI learns from that run's `agent.tell` (the prompt says it sees only ids).
  *What stays out of reach*: the newest turn (B-080; the newest 2 until then), the person's newest message and – behind a bare "ja bitte" – the newest one
  with content, and calls made inside a script. A pinned item (one the main AI brought back) is listed as "(the main AI brought it
  back)" and can be condensed or hidden. Every run is the main AI's own call, so its own hold does not stop what it asked for (q-r2d
  s15: the restored file was missing from the asked run's list, it hid other items and the person heard that the file was gone). In
  the asked run `context.restore` gives the main AI the originals as a real call with the answer and pins them; a condensed text may not name a value the original lacks, may not
  exceed a share of the original, and most of its long words must stand in the original (else the LLM is asked once more with the reason). *What to keep* is the brain's judgment (the prompt), not code.
* **The way back for the main AI** (`tools/builtin/context.ts`): `context.restore {ids, keep?}` returns the originals as
  this tool's output (at most 20 ids and 20,000 characters per call, marked as data from earlier work, not instructions),
  pins them for 3 turns or, with `keep: true`, for good (within a token cap per chat; `keep: false` lets one go). The items are back in
  place, so the call's result is condensed to its first line at once (`ledger/capture.ts`) – also when the restore ran inside a code-mode
  script whose output is nearly all restores (q-r2d s14: such a script kept the whole file a second time in the rebuilt history). The stamp names it and the marks call gives its `tools.call` form (it is no direct tool: a main AI that looked among its tools went digging in the database, q1); to find what it forgot, the main AI asks the subconscious (§5.4). Spec 121 tokens, found through
  `tools.find`.
* **Retention** (`ledger/retention.ts`): the originals of condensed and hidden items stay at least 14 days after they were
  marked and within 64 MB per agent and chat (oldest hidden ones go first, then the oldest condensed; kept items never);
  tool, skill and file outputs over 4,000 characters live in blobs, which go back to the store's clean-up. After that the
  stamp says "original: gone" and the item is no longer offered for restore. The person's "Forget permanently" clears the
  ledger's copies and prunes originals that mention it (`ledger/forget.ts`).
* **A kept item stays what it was** (`ledger/view.ts`): in a rebuild an engine's own output keeps its 64,000 characters, ours the model's cap of 24,000: nothing nobody marked is cut.
* **Where marks take effect** (`agents/rebuild.ts`, `rebuild-items.ts`, `rebuild-revert.ts`, `engines/{codex,claude}/rebuild*.ts`,
  `context/ledger/marks.ts`): a session is rebuilt from the ledger view at one of the five causes of §5.1 (B-092: a fold
  waits, a cold cache, an engine or account switch, no usable session while the ledger has items, past the fit); marks no
  longer cause a rebuild of their own (until 17.11. a session that lacked marks was rebuilt at the next turn and had to come
  out smaller – a warm rebuild re-wrote the whole cache for −11 %) – they ride on the next rebuild that happens anyway, and so
  does a restore (the call that brought the item back stands for it until then); the renewal at the window's fit (B-080: 80 %
  of the window, not 64k) is the backstop for what the fold, the marks and the fit cannot bring down. Codex: the thread is cut back before the first changed item and only the tail is
  injected again, which keeps the prompt cache (15,488 of 15,705 input tokens cached after revert + inject, measured 28.10.);
  a fresh thread would start with none. Reasoning replays only as the engine's own item with its signature or encrypted content of the same account and family, else not at all (as text it would read as words the model never said); the subconscious's calls of a turn stand in front of its chat lines, as the session holds them. Claude Code: a transcript written in `<data>/engine-transcripts/claude/<id>.jsonl`
  and resumed with `--resume <path>`, checked by a model-free probe per CLI version; a tool of ours the turn does not offer
  is written as `tools.call` (a model that reads it under its own name tries that name and fails), and the first request
  of a rebuilt session is written like a new session's, so the stable prompt block stays the cached one. A native tool call becomes the other
  engine's matching call where one exists (`engines/neutral-calls.ts`), else a text note. A session-less or stateless engine
  gets the marks applied to its lines at once, plus one call that names every condensed and hidden item and how to get them
  back. A rebuild the engine refuses is not retried every turn: it blocks that chat and engine for 6 hours. The chat's
  renewal summary and its seed follow the marks too (hidden and condensed lines do not come back through them).

## 6. Engines, accounts, routing, decisions

**In Trust AI mode agents run without asking** on every engine: Claude Code with `--permission-mode bypassPermissions`,
Codex with `approvalPolicy: 'on-request'` + `dangerFullAccess` and every approval accepted (`codex/approvals.ts`), ACP
permission requests answered allow. **In Secure mode** (§7.6) the native tools go through the security gate: Claude Code
`--permission-mode default --permission-prompts host` with `--settings` allow rules for the open folders (each
`can_use_tool` request → `services.security.gate`, `engines/claude/permissions.ts`); Codex `workspaceWrite` with
`writableRoots` = the open write folders (`untrusted` when commands ask), each approval request through the gate for that
one step (`codex/native-gate.ts`), a thread loaded under the other mode is reloaded once; ACP permission requests through
the gate (`acp/permissions.ts`). Flags apply from the next turn.

| Engine | How it runs (`runtime/engines`) |
|---|---|
| Codex | One long-lived `codex app-server` per account home (`CODEX_HOME`), persistent threads with our dynamic tools; workspace `.codex` config and the person's own MCP servers are not loaded (`isolation.ts`, `own-mcp.ts`); the finder picks the `codex.exe` that has `codex-code-mode-host.exe` beside it first (`accounts/executables.ts`; without that file no tool call of an agent can run); lean helper threads, cut after 8 model requests (`turn.ts`, `HELPER_REQUESTS`) and, with a structured output, after 90 s without a sign of the model once `turn/start` answered (`HELPER_SILENT_MS`; the app-server's echo of the turn's input is no sign); that cut and a thread – helper or agent, start, resume or fork – the app-server does not open within `THREAD_OPEN_MS` (120 s, `helper-thread.ts`; B-075: a cold app-server on a large `CODEX_HOME` needed ~65 s) end as the turn's own timeout, which cools no account (`accounts/failure.ts`; a chat's redelivery retries it), and the turn's signal (a Stop, a helper call's own limit) ends an open too (`untilStopped`); every new agent thread (`thread/start`, `thread/fork`, the rebuild and its probe) is stored with `threadSource: 'chatgpt_hidden'` (`HIDDEN_THREAD`, never on `thread/resume`), which the Codex desktop app leaves out of its sidebar, search and notifications – the server only stores the label (B-075); code mode (one `exec` tool, `code-mode.ts`); native fork; the app note (`app-note.ts`: one text item in the first turn of a thread, after Codex's own multi-agent note – §5.1); limit reads and banked resets |
| Claude Code | One `claude -p` stream-json process per turn with the MCP hub (`--strict-mcp-config`, a hub call may take up to an hour); lean: our system prompt only and its built-in tools cut to the execution core, a helper turn without any built-in tool (`claude/lean.ts`); session resume; native fork; history purge |
| ACP plan CLIs | Gemini CLI, Copilot CLI, Kimi Code on the generic ACP engine (`engines/acp`): one agent process per account, a stable MCP proxy per session |
| HTTP | OpenAI Responses, Anthropic Messages, OpenAI-compatible (Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, …) – `engines/http` |
| Fake | Deterministic demo/test engine (`fake.ts`, `WORKFORCE_FAKE_ENGINE=1` / `--fake`) |

* **MCP hub** (`runtime/mcp/hub.ts`): ONE Streamable-HTTP MCP server inside the runtime for every CLI engine run; each
  run gets a lease token (`/mcp`, loopback only). Clients see our tools as `mcp__workforce__<name>`.
* **Engine registry** (`engines/registry.ts`): lazy construction; a Codex server or ACP process ends itself when idle
  (one `IdleTimer`, `engines/shared.ts`); processes are leases of the supervisor. Codex and ACP speak through one
  newline JSON-RPC client (`engines/line-rpc.ts`).
  The CLI engines get the agents' env once (`engines/wf-shim.ts` `agentEnv`: `<data>/bin` first on PATH,
  `AUTARK_DATA`, §3); `childEnv` still strips provider keys.
  A provider's transient failure is an outage of the account, not of the model (`provider-outage.ts`).
* **Accounts** (`runtime/accounts`): any number per provider, each with an isolated CLI home or a key in the vault (or
  a key from an environment variable). Detection scans installed CLIs, their login state, ACP probes and local model
  servers (`detect.ts`); sign-in and sign-out run the official CLIs (browser, or a visible terminal for Copilot and
  Kimi – `sign-in.ts`, `terminal-login.ts`); a status command that gives no answer (a CLI that crashed on a loaded PC)
  leaves the login unknown, never "signed out" (`cli.ts`, `detect.ts`); official installers (`install.ts`); `accounts.try` runs one tiny real turn.
  The first-run and Settings plan buttons (`ui/onboarding/plan-setup.ts`) always add an account and start its
  sign-in (installing the CLI if missing); they never reuse a connected account or send an `accounts.try` turn.
  `monitor.ts` keeps limits current (provider pushes, plus one timer reading Codex every 15 s and Claude every 60 s
  while an agent turn is queued or running and 2 min after; with no turn every 10 min – a Claude read starts two CLI
  processes of ~120 MB –; a starting turn and the window brought to the front read at once; 09.11.2026).
  Every signed-in plan of a provider takes turns (owner 09.11.2026, no switch): `accounts/candidates.ts` puts paying
  accounts last, then the plan whose current weekly reading resets first, then the order of Move up/down in Settings
  (priority), then the share left; a 5h limit only pauses a plan, a used-up week until its reset.
  A plan found signed out becomes work: a sign-in task for an agent or the person's to-do (`relogin.ts`).
  **One plan login per PC** (16.11.2026, F28): with companies the CLI homes live in `<Autark Companies>/logins/<provider>/
  <folder>` (`Paths.accounts`, `root/companies.ts` `loginsFolder`; `<data>/accounts` headless and in tests;
  `system/paths.ts` `homeRoots` counts both as the app's own). Each home carries an app note `.autark-login.json`
  {email, signedOut}. A login made in one company is adopted by the others at their next detect (`accounts/adoption.ts`:
  switched on, checked, a row on the same home – never a copy) unless that company already uses the home or the same
  provider and e-mail, the login is signed out, or it was removed there (`dismissed.ts`, key `<provider>:<folder>`).
  Remove drops only the row; a sign-out marks the home for every company, a working check clears the mark. Two plans of
  one e-mail stay apart by the login's own identity (`cli-homes.ts` `whoseLogin`: Codex `account_id`, Claude Code's
  `organizationUuid`). The move of older homes into the logins folder was the bridge release's (data from before 0.3.9
  updates through 0.3.14, §3 Database; its bridge `logins-1611` is gone since the Quests-Runde); a home that did not move
  still works where it is (`system/paths.ts homeRoots`). The 0.3.8 handoff between companies is gone (§12).
  B-083 plan credits: an Anthropic or OpenAI API key whose organisation holds the monthly API credits a plan includes
  (Claude Max/Ultra, ChatGPT Pro/Business) carries `Account.credits` (migration 095; the account row's "Plan credits"
  toggle, `accounts.update credits`): it counts as a plan (`shared/model/charge.ts`), candidates put paying accounts
  behind it (`accounts/candidates.ts`), and "credit balance is too low" / `insufficient_quota` cool it for 24 h
  (`engines/http/common.ts`) – a new billing month refills it. No balance call exists.
* **Model catalog** (`models/catalog.ts`): every model the accounts can run, merged with the curated priors
  (`resources/model-priors.json`, `models/priors.ts`) – the one score source. Media-only providers (ElevenLabs, fal.ai)
  come from a curated table. Each model names its `source` (16.11., `catalog-merge.ts` `sourceLabel`: "Codex",
  "Claude Code", "OpenRouter", "Ollama", else the service's or connection's name); pickers show it as the row's hint
  with the full id as its title (`ui/lib/model-name.ts` `pickerHints`), work cards and log lines after the model. B-083: the list order is `models/order.ts` `catalogOrder` – family and version parsed from the
  provider id (dates and size markers ignored), the newest version of each family first by smarts (an unrated new version
  borrows its family's best, a gateway copy its sibling's), older versions below with `ModelInfo.newer` (the composer
  shows only the newest of each family; an older one by search or while chosen, under "Older versions"). New models
  arrive by themselves: a started catalog lists every account again every 30 min (cooling ones too – listing costs no
  quota), a version newer than every curated one takes its predecessor's prior without name and prices
  (`Priors.forNewer`, family parse in `models/family.ts`), and Claude Code and Codex – which learn models only with new
  versions – update themselves shortly after start and every 6 h when no process of that CLI runs (`engines/cli-update.ts`,
  one timer per CLI; "updated" = `--version` changed: `claude update`; Codex standalone and pnpm/bun/brew `codex update`,
  Windows npm `npm install -g @openai/codex@latest`; the Codex desktop app's own copy is left to that app).
  The global model rating (14.11., `models/priors-feed.ts`): with the daily keyless price list a started catalog also GETs
  `https://openautark.com/model-priors.json`, built by `scripts/model-priors/generate.mts` from our judgement in
  `resources/model-priors.json` plus Artificial Analysis list prices (attributed in `$source`; our smarts stay ours). The
  answer counts when `Priors.parse` finds a dated `version` and at least one model; the last good copy is kept raw in kv
  `model-priors`/`feed`, and a copy not older than the priors in use is adopted in place into the one priors object
  (`Priors.shipped`, held by the catalog, routing and turn pricing; `Priors.adopt`), then the catalog rebuilds. The shipped
  file stays the fallback (no copy, or an app update with newer priors); at start `compose/services.ts` puts the stored
  copy in (`useStoredCopy`). A failure is logged and retried after 6 h; the fake engine and tests (`priceFeed: false`)
  fetch nothing.
* **Routing** (`routing/router.ts`; KI-Runde 17.11.2026, B-092: **the model settles, only the effort moves per turn** –
  measured 15.–17.11.: 177 model switches in 1,474 runs, 147 on a live one-hour cache, 60 % undone within two runs, and a
  model that comes back does not find its old cache), one route per turn in this order: category (the mode's, refined by a
  keyword table for generic modes) → candidates (connected, not excluded, capability needs, the agent's policy band; the
  mode's tier as a preference) → **off a boundary** (`RouteRequest.boundary` false – `agents/boundary.ts boundaryOf`: the
  agent's thread has a live session) the turn runs on the model that session is on, whoever asks for another (a start model
  set since, the Work model, my own `model.set` – they wait, and the reason names what waits); only that model cannot run
  now (no usable account, a need such as images it cannot meet) or my own `model.set` with `now: true` (a part: a fresh
  part's first turn) moves it → **at a boundary** (`boundaryOf`: no session, a session rested past `CACHE_COLD_MS` 60 min, or
  a fold waiting to be replayed; `at: false` while that thread's rebuilds are blocked; also a preview and a part's first turn)
  my own `model.set` (a named model or a need – stronger, cheaper, faster, vision, long context) → the agent's start model
  (`ModelPolicy.pin` with `pinBy`: the person's, a lead's or since B-092 the agent's own – `model.set` with a model or need
  writes `pinBy.self`, it stands until I, my lead or the person names another, inside the tier band the person or a lead set
  and on the accounts Auto uses; `model.set` with `auto` clears only my own) → the Settings **use** (below: agent turns the
  Work model, the runtime's helper calls the Decisions model, `routing/pins.ts`; for a helper call on `auto` the helper
  default on its qualifying plan accounts, `helper-default.ts`) → a pin that cannot run now gets a stand-in from the
  strongest tier at most at its list price → **Auto by kind** (`routing/kind.ts`): the model I am on while its tier is my
  kind's tier, else my kind's default – an agent that leads (`org/standard.ts leads`) on the strongest tier's first choice
  (smarts against list price, `person-turn.ts firstChoice`), an agent that executes on the strong tier's best value; the
  person's Model choice shifts both (Best: everyone on the strongest tier, Cheaper: one tier lower); a model I am on only
  because mine could not run carries `standIn` (also a first turn's pick that differs from the kind's pick over the pool as
  if every account ran, `pool.ts whole`) and does not fit, so my kind decides again at the next boundary; a part starts on its
  origin's model, a fresh one that names none on the executing default when its origin is above it → for a runtime helper
  call without any of these the deterministic score (prior + tier fit + plan headroom − cost) → effort
  (`previous.ts startEffortBy`), clamped to the model's efforts; a person's new line raises it to high or above
  (`person-turn.ts`) → the healthy accounts of that model (plans keep rotating; a provider whose plans are all used up is
  "cannot run"). Since 13.11. the person's suggestion in a chat (the composer chip) never routes; it stands on their line.
  `CACHE_WARM_MS` is 60 min; `model.set`'s description says only that another model re-reads the context, and the one name
  for the boundary in every text is "my next context". Read-only check on company-2 (18.11.): at the first boundary four
  leads go to Opus 5.5, four agents move to Sonnet 5.5, eight stay on Sonnet; no agent is marked a stand-in. The newest version of a family stands for the older ones
  (`routing/pool.ts` `newestOnly`, 16.11.): an entry leaves the pool while a newer version of its family can run, and a
  model an agent or its subconscious names runs as that newest one (`pool.entryFor`); the person's start pin and the Work
  model keep their exact model, and the older one runs when the newer cannot. B-083 (owner: a pick is "nur eine Empfehlung … ein kleiner Tipp"):
  nothing a person picks is a hard pin – the composer writes `settings.modelHints` / `efforts` / `temperatures`, the agent
  page the agent's start model with its origin (`ModelPolicy.pinBy`); the agent's own request beats both, also for the
  effort (`routing/previous.ts` startEffort: requested → chat suggestion → fixed → previous → default). The route carries
  `temperature` (the agent's own, else the chat's) to the engine; it is sent only where it costs no thinking (owner
  09.11.: thinking is never turned off for a temperature – `engines/http/temperature.ts` `takesTemperature`,
  effort-aware): compatible servers beside their models' reasoning (not Gemini 3+, a gateway's Claude ids only at effort
  none), the OpenAI API to models without reasoning and to a step at effort none, the Anthropic API to the older Claude
  models it runs without thinking anyway (`http/anthropic.ts` `anthropicTemperature`). Claude takes a temperature only
  without thinking – on the plan and the API alike, the newest models not at all (live-checked 09.11.) – so Claude Code
  sends none, nor do Codex (no field) and the ACP CLIs; there "## Now" names the value as the agent's stance and the UI
  marks it "≈". The model list tags models that take one beside their thinking ("takes temperature"). The principle the agent and its subconscious choose by stands in `resources/prompts/rules.md`
  ("Before a step I ask how settled its result is …"). An HTTP 402
  (a key's credit used up) cools that account for 6 h like a limit, so decisions move to another model
  (`engines/http/common.ts`). Cost mode:
  `settings.routing.costMode` (best, balanced, economy). Policies: `routing/policies.ts`.
* **The rule for a person's own line** (`routing/person-turn.ts`): a turn whose agent has a new text or answer line from a
  person unread (its chat read cursor; not task, schedule or colleague wakes, splits or the runtime's helper calls) runs at
  effort `high` or above (clamped to the model's efforts) **on the model the agent is on** – since B-092 it no longer moves
  the model (it was one of the ways every employee ended up on its manager's model, measured 15.–17.11.). It yields to the
  agent's own request and a fixed effort. The lift is stored as `effortBy 'request'`, so it does not carry over into later
  wakes. Reason (live, E1 01.11.): without a lift the Manager's chat turns ran at medium effort and answered from memory
  without a tool. The route reason reads "a person's line · effort at least high". The file also holds a tier's first
  choice (`firstChoice`, B-078 D16), which `routing/kind.ts` takes for an agent that leads.
* **Decisions** (`decision/service.ts`): typed choice/score/predicate answers from ONE backend – a cheap connected
  model with structured output (`llm-fallback.ts` over `engine-runner.ts`). The Decisions use picks the model, `auto`
  meaning the small default of a Codex plan; with nothing connected callers use their own rules. Without a decision
  model connected, a small chat model of what is connected stands in, and every surface says so: `models.uses` gives
  the note "No decision model yet – <model>, a chat model, answers these calls", the state `setup` and the action "Set
  up with AI". Agents hand a bounded choice to it with the `decide` tool (2–255 options → choice, none fit, or unsure).
* **One model system – providers, keys, models, ten uses** (`shared/model/models-uses.ts`, `routing/uses-settings.ts`,
  `shared/model/providers-connect.ts`; owner 01.11.: provider, then API key, then the models to choose, in one simple
  system). A connection is a provider plus a key (or a plan found on this PC, or a local server); every connection lists
  its models. A **use** says which model does one kind of job: `work` (agent turns), `decision` (helper calls: decisions,
  compaction, verification), `voice` (realtime conversation), `stt`, `tts`, `image`, `video`, `music`, `sound` (the media
  functions) and `embeddings` (B-064: the model that makes files and memory searchable by meaning, §5.3). Each is `auto`
  or `<provider>:<model>`; `work` can also name a plan (`codex`: that plan's best model each turn); the media uses and
  `embeddings` can be `off`. `embeddings` `auto` (nothing chosen) embeds nothing, like `off` – finding goes by words (14.11.,
  §5.2); `local` names the PC's own model, `<provider>:<model>` a local server's or an API key's; a chosen model that is unreachable says so
  instead of falling to another (vectors of two models do not compare, `models/embeddings.ts`). They live in `settings.json` section `routing` (shown as "Models", one comment line
  per use) next to `costMode` and `allowPaidFallback` (no row in Settings; true lets API keys compete with plans on
  every turn, false – the default – uses a key only when no plan or local model can; the AI sets it). **A stored `auto`
  is never shown as "auto"**: `runtime/models/uses.ts` (`models.uses`) names what runs per use – Work on a plan
  "<model> · each turn", search by meaning "off" while nothing is chosen, with `local` "MiniLM-L12 multilingual" on this PC (`vectors/local-model.ts`), Voice on
  this PC its hearing + speaking models, the ChatGPT plan's images "GPT Image"; `routing/helper-default.ts` `helperModel`
  names the model decisions would really run on (the plan's helper default, else the smallest and cheapest chat model an
  account can run now). Agents read the same as one line (`context/setup-facts.ts` `usesLine`: "- Decisions: <model> on
  <account> (a chat model; no decision model connected | a decision model) · Search by meaning: off | <model> on this PC | …")
  in the manager's live part and in `app.status`; `models.list` with category `decision` or `embeddings` answers that
  line plus only the connected models made for that use. Gone: `decisionModel`, `functions`, `helper`, `workPlan`,
  `voice.realtimeModel`, the Ollama "decision" marker, `decision/hint.ts`, `routing/guidance-settings.ts`, and (Quests-Runde
  20.11.2026) their one-time moves – the old keys' mapping when settings were read and the old accounts' mapping: every file a
  0.3.0+ app read was rewritten with the uses, and only 0.3.9+ data opens here (§3). A use is read as stored
  (`routing/uses-settings.ts` checks its values); an old stored global pin is ignored (`routing/policies.ts`).
* **API connections are a file** (B-066): `settings.json` section `providers`, one entry per connection
  `{name, protocol, url, key: "secret://<id>", models}` with protocol `openai-chat`, `openai-responses`, `anthropic` or
  `decision` (`shared/model/provider-entries.ts`); the file head's comment lists the known services. Unknown providers
  are a URL, a model name and an API type. `accounts/provider-file.ts` reconciles entries into the accounts table
  (state, limits, priority stay in the table); an older local API account keeps its own id. The settings form, `accounts.add` and the AI (skill `ai-providers`: research a provider from its
  name, send the key through the Secrets system) all write this one section. Plans found on this PC, keys from the
  environment and scanned local servers stay detected.
* **Money**: only a cost journal (`spend/ledger.ts`, `spend.list`) – real charges of paid turns (`models/pricing.ts`;
  subscription plans cost nothing per turn); an agent notes a purchase of its own with `spend.note` (B-066). No budgets,
  no purchase locks, no monthly limit in code or settings; spending is the skill `money` and the "Money" line of an
  agent's own SYSTEM.md (§5), references the AI adapts and nothing enforces.
* **Token counts** (B-073): `inputTokens` stays the whole input. Beside it an engine reports `cachedInputTokens` (Codex,
  `last.cachedInputTokens` of `thread/tokenUsage/updated`) or `cacheReadTokens` / `cacheWriteTokens` (Claude Code and
  Anthropic HTTP, which still count them into `inputTokens`) when it has them (`engines/types.ts` `CacheTokens`): per request
  on the `usage` event, summed in the turn result (`engines/shared.ts` `addCache`). The structured runner passes them on, so
  the helper-call log and the subconscious's tally (`cached`, the cached part of `used`) carry them, and so does an agent
  turn's attempt usage, also across native-timeout continuations (`agents/native-timeout.ts`) and failover sums
  (`agents/turn.ts`). Since B-089 runs keep `cached_tokens` and `model_calls` (migration 100).
* **Cost is the turn's own** (KI-Runde 17.11.2026, B-092; measured on company-2: stored $13,167 against about $2,730 real –
  Claude Code's `total_cost_usd` is the session's running total, Sol and Luna were priced without a cached price, and cache
  writes, 43 % of the real cost, were stored nowhere). A Claude turn's cost is the difference to the session's previous
  total, kept on the binding (`SessionBinding.costTotal {ref, usd}`, migration 108 `cost_total`/`cost_ref`; it counts only
  when the attempt resumed and ended on that ref, a lower total starts a new count, a continuation after a native tool's
  timeout takes the latest total, never the sum, and an attempt that threw counts against the session it resumed –
  `agents/turn-cost.ts turnOwnCost`); the same fix corrects the real charge on paid Claude Code accounts. Runs get
  `cache_write_tokens` (migration 107); main-thread `message_start` events count as Claude's model calls. Prices
  (`resources/model-priors.json`, `models/pricing.ts`): input, output, cached read and cache write per model – Opus 5.5
  4 / 20 / 0.20 / 8, Sonnet 5.5 2 / 10 / 0.10 / 4, Fable 5.2 8 / 40 / 0.20 / 16, Haiku 5.5 0.50 / 2.50 / 0.05 / 1.00 (from the
  CLI's own table), Sol and Luna with a cached price at a tenth; `tokenPrice` prices three parts of the input on every path
  (list, prior, feed): cached reads at the read price or a tenth of the input price, written tokens at the write price or the
  input price, the rest at the input price; one lookup `cachePrices` serves the fork weighing and the subconscious's effort
  cost. `Priors.adopt` merges per model and field, so the shipped read and write prices survive a website copy that lacks
  them; the generator (`scripts/model-priors/generate.mts`) keeps our read price. **One-time repair** (`bridge/cost-1117.ts`,
  from `runtime/main.ts`, once per company, kv-guarded, figures and mark in one transaction): every plan run with a cached
  count gets its notional cost anew from its own tokens at today's prices (a model the catalog no longer holds from the stored
  daily price list); a Claude plan run from before the cached count takes the difference to the previous Claude run of the same
  agent, chat and split, bounded by the stored figure; paid charges (`cost_usd`, `cost_basis`) and spend are never touched.
  Preview on a copy of company-2's runs: all plan runs about $13,380 → $2,660. Readers of the notional figure (`runs.notional_usd`
  → split view, `shared/text/run-cost.ts`) show the repaired value; spend, budgets and the daily cap count only paid charges.

## 7. Tools, connectors, skills, secrets

### 7.1 The tool registry – a gate only through the security mode (§7.6)

`tools/registry.ts` is one list of tools, exposed identically to every engine. **One call path:
validate → place → run → redact → journal.** Validation checks the arguments against the schema (`validate.ts`);
placement decides the company on this PC (`company`, §5) and the PC (`placement.ts`, §8); the output is redacted and bounded (`outputs.ts`); the journal
(`journal.ts`) records the call with an idempotency key (a resend of a running call id gets its result). There is no
permission, approval or judgment step. Every string argument first passes the secrets leak guard
(`secrets/guard.ts`): a stored secret value becomes its handle, so it never lands in a note, file or message.

**Every tool is in reach from every mode** (KI-Runde 17.11.2026, B-092; measured: 16 of 17 agents could not reach
`phone.*`, `tools.find` answered phone questions with mail tools, 587 chat lines went out through a shell): the mode chooses
only the core set an engine holds directly (`core-sets.ts`) and its text; `tools.call` reaches every registered tool that can
work here (`EVERY_MODE` and `ToolDef.anyMode` are gone). A tool that cannot work here is not listed: `phone.*` while no app
phone is linked (`phone/linked.ts`) and adb is not installed on this PC (`phone/adb.ts installed()`; with adb and no phone on
the cable the driver says so; a mode that names `phone.*` keeps it, for setting adb up; no tracking process – a change in
the attached ADB phones seen when adb runs anyway re-announces this PC's caps); the vector tools are offered with or
without an embedding model (Quests-Runde 20.11.2026, §5.3). "My environment now" names the linked
phones with their phone use (on / off / not connected right now, the PC that holds an app phone when it is not this one;
`context/environment.ts phonesLine`) and `devices.list` lists them. `tools.find` ranks over every reachable tool (the phone
family's keywords include sms, code, notification, authenticator, 2fa, otp) and says why a named phone tool cannot run. The
More-tools section opens with one line on how a dotted name is called on this engine (Claude Code: `mcp__workforce__` with
the dots as two underscores, or `tools.call`; Codex, ACP and HTTP: the plain wire form). A call refused before it runs is
journaled as a failed call with its reason – its arguments only for a tool the registry can name, only the keys its schema
declares, minus `HIDDEN_ARGS`, and none of a tool with hidden arguments whose arguments were refused. Tool texts changed
with it: `phone.say` opens with the ask, `phone.key` names the app phone's keys and that `notifications` shows what just
arrived, `agents.split_tell` says a note wakes the origin for a whole turn, `computer.wait` and `computer.batch` exist and
`ui_tree` passes its max through (up to 100) with how to get the rest; `media.speak` logs its error and hands it to the agent,
and a pull made for a generation no longer changes the person's reading voice. Tool
descriptions, errors and result notes speak as the agent (B-075: "I end my turn now"; `agents.list` marks the caller
`me: true`).

Families (`tools/builtin/*` and the owning folders): `agents.*` (list, create, update, archive, split …), `chat.*`
(`chat.update` is one tool for what eight did – title, add, lead, remove, parentId, replyMode, archive, leave, run in
that order, `tools/builtin/chat-update.ts`), `tasks.add`/`update`/`list`/`remind` (§4.3), `calendar.list`/`connect`,
`knowledge.*`,
`references.*`, `skills.*`, `modes.*`, `models.list`/`model.set`, `decide`, `files.*` and `shell.exec` (any absolute
path on the PC), `web.search`/`web.fetch`, `secrets.*`, `media.*`, `people.list`, `spaces.*`, `app.status`,
`accounts.sign_in`, `feedback.report`, `computer.*`, `browser.*`, `phone.*`, `devices.list`/`devices.connect`, `telegram.connect`,
`companies.list`, `app.<connector>.<tool>`, `tools.find`/`tools.call`.

**Web search** has two paths. The engines' own search comes first: Codex agent threads run with `web_search = "live"`
(`AGENT_WEB_SEARCH` in `engines/codex/helper-thread.ts`; helper and image threads keep it off) and Claude Code's lean
tool set includes `WebSearch` (`CORE_TOOLS` in `engines/claude/lean.ts`; `WebFetch` stays out). `web.search` is the
second, keyless one (`tools/builtin/web-search.ts`): it tries DuckDuckGo, then Bing (its own parser), and when both fail
it names a search page to read with `web.fetch` or open in the browser. Measured on 01.11.: 8 of 8 queries answered
via Bing; DuckDuckGo, Mojeek, Startpage and Brave answered every query with a bot check.

### 7.2 Connectors are files plus a skill

* `<data>/connectors/mcp.json` – `{"mcpServers": {"<name>": {"url", "headers"} | {"command", "args", "env", "cwd"}}}`
  (the map Claude Code, Cursor and Codex use; `"disabled": true` turns one off). `mail.json` – mailboxes (address,
  password, agent, optional imap/smtp). Optional `contactStopFile` names an absolute local JSON DNC array
  (`status: "DNC"`, `addresses`, `organization_domains`); mail delivery reads it before login and SMTP,
  checks the whole envelope and fails closed on invalid configuration. Domain entries include subdomains.
  Any credential value may be a `secret://<id>` handle, resolved only at connect time.
* `apps/service.ts` applies the files at start and on every change, connects lazily (`apps/connections.ts`), registers
  `app.<id>.<tool>` for every agent, caches tool lists (a start needs no server), runs the MCP OAuth sign-in
  (`apps/oauth/*`; the browser opens only for a new or changed entry or `apps.reconnect`) and writes `status.json`.
  Own MCP client over HTTP and stdio (`apps/client/*`). RPC: `apps.list`, `apps.reconnect` – nothing else.
* **Mail** (`apps/mail/*`): IMAP/SMTP/MIME of our own; one IDLE connection per mailbox wakes the mailbox's agent on new
  mail (`apps/mail-wake.ts`); bulk mail wakes nobody (`mail/loops.ts`).
  A run woken by mail is a full working turn (16.11.2026): the isolated executor (`agents/mail-turn.ts`), the
  `AUTARK_MAIL_ORIGIN_ISOLATION` branch and the scope refusal of every hub tool (`mailScopeRefusal`, sender-only reply,
  `validMailProvenance`) are gone; `tools/mail-scope.ts` keeps only `mailMarker`/`mailPartition` (wake grouping, the
  chat-free retry, and since 16.11. no gate on a mail run's split bookkeeping in `agents/dispatch-runs.ts`). Kept: the
  wake note quotes the mail as untrusted data, app answers carry "[untrusted content from app …]", and sends from a
  mail-started run carry `Auto-Submitted` (B-059).
* Skills: `connect-apps` (the files), `telegram-setup`, `whatsapp-bridge` (with a template script on Baileys that uses
  the external protocol: `chats.connectExternal`, `messages.send`, `files.upload`, `GET /events` – never run against
  WhatsApp), `phone-access`, `import-agent-system`.
* **Chat bridges** (`runtime/bridges`): a chat mirrored to a Telegram bot (one long poll per bot); `telegram.connect`
  lets an agent set it up; a private chat's user is the owner, groups link with a `/link` code. **External agents**
  dock into one chat with a token (`bridges/external-agents.ts`; protocol: `docs/EXTERNAL_PROTOCOL.md`).

### 7.3 Skills are plain folders

`skills/service.ts`: agentskills.io skills (a folder with `SKILL.md`, front matter name + description) from five places,
highest first: an agent's Main Skills (`<data>/agents/<id>/skills`), an agent's own (`<workspace>/agents/<slug>/skills`),
the shared library (`<workspace>/skills`), imported (`~/.codex/skills`, `~/.claude/skills`, read-only), shipped
(`resources/skills`, read-only). An agent writes a skill like any file; the next read sees it. Every agent may load
every skill (`skills.load`, `skills.save`, `skills.find`). No versions, audiences or retirement. The shipped skills
speak as the AI that reads them (B-075: descriptions "I read this when …", no permission wording;
`test/unit/skills/skill-voice.test.ts`); a `skills.find` line cuts a description at 240 characters. A skill's front matter
`metadata.modes` limits the modes whose index lists it (none = every mode); since G1 the app's own skills
(`app-settings`, `app-look`, `app-guide`, `phone-access`, `whatsapp-bridge`) carry `modes: [none]`, a key no mode
has – in no mode's index, still found by `skills.find` with a query and loaded by name – and the manager, general and
secretary modes list none of them (`telegram-setup`: browser mode only). Shipped skills include
`app-settings`, `app-look`, `agent-duplicate`, `connect-apps`, `phone-access`, `phone-adb`, `app-guide` ("How this
app works"), `org-setup-onboarding` (hiring and shaping a team, tool facts only), `task-ownership`, `human-minimal-handoff`, `representation`, `reference-curator`, `design-together` (B-081:
shaping a look live with the person – their pins from the browser's Pin button, their pointer line, the page in this
chat's area, one change at a time, variants as tabs, a call with `chat.call` when talking is quicker; modes web and
browser, the ones that offer its browser tools; `web-dev-workflow` §4 offers it when a look comes down to taste) and
work skills (video, web, research, writing, social, bookkeeping …).

The person's Settings editor (`skills/editor.ts`, `rpc/handlers/skill-editor.ts`, `ui/settings/SkillEditor.tsx`)
uses `skills.catalog/open/edit/create` for the owner and securely paired Settings devices. A copy's ID hashes its
enumerated file path; no caller path is accepted. Editing replaces only the body and preserves the original frontmatter
bytes; a revision over the full file and file identity detects intervening changes, deletion and relocation. Creation is
exclusive, imported/shipped copies stay read-only, redirected locations are refused. Synchronous compare+rename is
optimistic conflict detection, not OS compare-and-swap against external writers. The name-based agent API remains separate.

### 7.4 The secrets catalog

* Values live encrypted in the vault (`secrets/service.ts`, OS keychain via `Host`); agents only ever see handles
  `secret://<id>` and the catalog (`<data>/secrets/<route>.md`: id, name, kind, tags, description – never a value).
  An edit of name, description or tags on disk reaches the vault; what only the app sets is kept as `.rejected.md`.
* Use by handle: `secrets.run` (a command with the value in its environment), browser fill by id, connector values,
  `web.fetch` headers, app tool arguments. Tools: `secrets.list/save/generate/run/import/export/delete`; grouped entries (a login,
  a card – `groups.ts`), TOTP (`totp.ts`), secure capture of what the person types (`capture.ts`, `chat-capture.ts`).
  No access lists: every agent may use every handle. A text field's hint is the text itself, clipped to 60 characters
  (`groups.ts` `textHint`; B-075: a login shows its username, not its first character; `init()` brings older hints up to it).
* **Finding an entry** (16.11.2026, `secrets/metadata.ts`): `secrets.list` and the find (kind `secret`, §5.2) use the
  knowledge word index – name and id words weigh 10, the purpose 4, tags, route, source, kind and field names 1; cached
  per runtime by a hash of the metadata, never a value. `rankSecrets`: an id the query names first, then most words held
  (the B-080 route rule), then bm25, then use, then name; a site, address or path matches as a whole phrase. At most 20
  are shown, with a count of the rest. Without a query the entries in use lead – `uses` (migration 103, counted by
  `SecretService.use()`, never synced) and `lastUsed`.
* **Keys typed into chat text** (16.11.2026; `shared/secrets/token-patterns.ts` – one list of key and token shapes for the
  chat and the feedback redactor –, `secrets/text-capture.ts`): `messages.send` and `messages.edit` (`addKeysSaved`) put
  every key of the person's text into the vault before the message is stored – a held value becomes its handle, a new one
  is saved directly, labelled by the words before it – so no chat row, linked PC or agent holds the value; a key inside an
  ```app fence and an agent's own `wf` send stay as written. `secrets.fromMessage {messageId, value?}` (chat + secure)
  saves a marked piece or every key of an older message, and its author's edit then shows the handle; the agent tool
  `secrets.save` does the same with `seq`/`chatId`. The UI masks a key still in a message (`ui/chat/message-keys.ts`:
  "A key is hidden here", Show/Hide, "Save as secret").
* **Import** (`import.ts`, `import-parse.ts`, `shared/model/key-values.ts`): browser and password-manager exports (CSV,
  Bitwarden JSON), `.env` files and flat JSON of names and values. From `.env`/JSON only pairs that hold a secret go in
  (`isSecretPair`: a secret-like name – key, token, secret, password, auth, session, webhook, dsn … but not an address or
  path such as `AUTH_URL` – or a URL with a password, and at least `MIN_SECRET_CHARS`); plain settings count as
  skipped, a value already held as unchanged. An agent imports by path and never sees a value; `secrets.import` deletes
  a password export after a complete import (the result's "file" line says so) and keeps `.env`/JSON files. Our own
  export (`import-parse.ts` `OWN_EXPORT`, recognised by the columns only it has together: totp, kind,
  description, tags, route) comes back with kind, description,
  tags and route; the import keeps the names and descriptions it is given (an earlier import's "not described yet"
  counts as none), and its review task covers only the entries without a description (B-075).
* **Export and bulk delete** (B-075; `export.ts`, `units.ts`): `secrets.export` – the agent tool `{path?, ids?, route?}`
  and the RPC `{ids?}` (the PC, or the owner's phone on a secure transport) – writes the chosen entries, all when none are named, into one CSV: Chrome's columns
  (`name,url,username,password,note`), then `totp,kind,description,tags,route,number,expiry,cvc,holder`; a login's or
  card's field without a column becomes its own "<name> · <field>" row, a group of free fields is skipped and counted.
  The file gets mode 0600, by default `~/Downloads/autark-secrets-<date>.csv`; a path inside the data folder gets the
  default, a taken name " (2)" – nothing is overwritten. It returns `{file, count, skipped, notFound?}`, never a value.
  The agent tool `secrets.delete {ids?, route?, all?: true}` returns names only; the CEO's linked PCs follow through the
  sync. "All" and a route leave out what the app works with unless named (`units.ts` `catalogUnits`: createdBy
  `SYSTEM_ID` and `heldByApp` – an account's, bridge's or calendar source's `secret_id`, an app's OAuth secrets, the
  Google calendar secret, the feedback keys).
* **The person's side, no pop-ups**: Settings › Secrets has one fixed-height band above the catalog with Name | Value
  rows (`ui/settings/SecretRows.tsx` `SecretBand`); a pasted `.env` or JSON splits into rows, Add takes the kind from the
  name, "Choose file…" or a file dropped on the band or the catalog imports, and "Login, card or fields…" or a row's Edit
  open `SecretForm` in the same slot; one reserved line holds results and errors. In a chat, Plus › Secret is a
  composer mode above the text (`ChatSecretBar`); each row becomes a chip. On the PC each catalog row has a box
  (`ui/settings/secret-catalog.ts`, B-075): every entry starts selected, and a group's head holds All, None, the count,
  Export (its path in a toast) and Delete (asks once); an entry the app works with (`usedByApp`, from `secrets.list` /
  `secrets.groups`) starts unselected, is selected only by its own box and says "Used by the app"; a login shows its
  username where a value would be.
* Kept on purpose: the leak guard (a value never lands anywhere else), output masking (`redact.ts`) and refusing
  values too short to mask.

### 7.6 Security modes – Trust AI and Secure (19.11.2026)

Owner 19.11.2026 (`.local/sicher-20261119/OWNER-2026-11-19.md`): two modes, chosen on the first run's
About card and changed in Settings › Security. `settings.json` section `security` (`shared/model/security-settings.ts`;
`securityOf(settings)`, defaults `securityDefaults(mode)`; schema `runtime/settings/security-keys.ts`). **Per PC since
the Umzug round (21.11.2026):** the section is one of the local sections that never travel (`devices/sync/settings.ts`
`LOCAL_SECTIONS`: devices, pwa, security; a PC before this version that still sends it is ignored), so each PC has its
own mode – Settings › Security heads "This PC – <name>". An agent works under the rules of the PC its call runs on; a
moved agent reads the new PC's rules in its prompt. The topic texts below stay company-wide (they travel as files).
**`security.otherPcs`** (both modes, `yes` | `ask` | `no`, no schema default – absent = yes, so the first start never
reads it as a disk edit, `keepSecurity`): what agents on other PCs get here. `devices/other-pcs.ts gateOtherPcs` is the
one check for every way in – a forwarded `tools.call` (`devices/tools.ts`, before `gateForwarded`), incoming files
(`files.put`), remote paths (`devices/sync/paths.ts RemotePaths.gate`); the person never, an agent that runs on this PC
passes; `no` refuses naming the PC, `ask` is an approval request of capability `otherPcs`; one fact line in the prompt
only when it is not yes. Gate texts name the PC ("… is closed on Tower"); the approval to-do names it too, and an answer
given on another PC reaches the PC that holds the request (`client_id` of an app-made `apr:` to-do travels, soft;
`security/answer-relay.ts`, peer `security.answer`, CEO links only, first answer wins).
* **Trust AI** (`mode:'trust'`) is the open system of before: no gate except the three switches `money`, `publish`,
  `message` (Yes/Ask, default Yes; Ask makes the app ask the person before each such step).
* **Secure** (`mode:'secure'`): switches `read`/`write` (all | chosen + folder list), `commands`, `web`, `computer`
  (yes | chosen apps | ask), `phone`, `message`, `publish`, `accounts`, `setup`, `team` (yes | ask). The company's own
  folders are always open (`security/policy.ts`). Hard-closed, no request opens them: spending money (stored cards
  refused by the vault, spending tools), Autark's own window for computer use (the helper's `Guard` armed with Autark's
  pids, fails closed), the `security` section and `<data>/security/secure/*` for agents.
* **The gate** (`runtime/security/service.ts` `services.security`): `check` (open | ask | closed) and `gate` (asks and
  waits ≤ 2 min, honouring the turn's AbortSignal). Callers: `tools/registry.ts call` (Autark tools, mapped by
  `security/tool-gate.ts`), the receiving side of forwarded calls (linked PC `devices/tools.ts`, other company
  `builtin/companies.ts`), the engines' native tools (§6), the RPC of non-person owner sessions (an agent's or a shell's
  `wf`, `security/rpc-guard.ts`). Paths are compared as real paths (`\\?\`, 8.3 names, junctions resolved).
* **Approval requests** (`security/approvals.ts`, kv-persisted): each is also the person's to-do (`tasks/approval-todo.ts`,
  client id `apr:<id>`, origin `security`) – the Tasks page's For you and a push on PC and phone; Settings › Security lists
  them last. Answers: once (one identical call of that agent), always that setting, always that place (folder or app),
  decline. An answer after the call gave up wakes the agent in its chat or task.
* **Topic texts** – one file per text field, `<data>/security/<mode>/<topic>.md` (`security/topics.ts`; defaults
  `resources/security/<mode>/<topic>.md`, `{{name}}` = the person). In the prompt as the stable section `security`
  ("## What <name> and I agreed", `security/agreements.ts`) before the person's HUMAN.md: Trust – the agreements and any
  Ask switch as a fact; Secure – one fact line per switch, its note, and the general/captcha texts. Agents edit
  `security/trust/*` in Trust mode (their text: only when the person clearly wants it); everything else there is put back
  when changed on disk outside the app. Critical texts and the mode (and Trust's money switch) need Edit → "Yes, change it"
  every time.
* **The person** is told apart from an agent's shell by an in-memory person token from main (never on disk); the
  launch token in `runtime.json` gives owner scope without the person-only methods.
* Honest limits: a shell running as the same Windows user can read any file; Codex reads cannot be limited; PCs on
  0.3.12 or older ignore the section.

## 8. Devices

**One connect surface** – Settings › Devices (`ui/settings/DevicesGroup.tsx`, rows `connect-rows.tsx`, texts
`connect-text.ts`; the same connect rows open from the first run's "Connect to my other PC" beside Skip,
`ui/onboarding/ConnectCard.tsx`, and a link as CEO ends the first run), in this order:
this PC's **Remote ID** (9 digits: 8 from the key fingerprint plus a check digit, `remote/id.ts`) with Copy and the
meeting server's state in its hint ("meeting server connected", "only this network …"); incoming
requests with their code (Accept – for an employee's PC or phone with the person it belongs to, or a new person made in
the same step – or Decline; my other own PCs' requests show too, below); "Connect a phone" (only this PC's own Remote ID
as a QR, `phone.pairLink` → `remoteId`; whose phone it is, Accept says – an employee's too, Quests-Runde 20.11.2026);
**PCs on this network** with Connect (`remote/nearby.ts`,
the LAN hello on UDP 47813, `devices/discovery.ts`; the hello answer names its `company`, and `connect-text.ts`
`nearbyGroups` shows one row per PC, or a PC row with one row per company; one fixed "PCs on this network" row with
Refresh holds the place); "Connect a PC" by Remote ID or address (IP:port of a fixed IP or local server), as CEO
or as employee; one row per device with right-click Rename and Remove (a PC behind this one ends with its version,
`device-version.ts`); the Connection group with one row per phone (its way and bytes, below). Connection settings (`devices.findable`,
`devices.relay`, `devices.peer`, `devices.peerPort`, `pwa.enabled`, `pwa.bind`) are `settings.json` keys the AI changes.

* **Connecting PCs** (`runtime/remote`): find the PC (LAN first, then the meeting server – `remote/find.ts`; the
  lookup waits once for the server's `connected` state, up to 45 s for a free host's cold start,
  `rendezvous/service.ts`, and "not found" names the cause first: no such PC online, server off or not reachable), run the
  numeric-comparison exchange (`remote/sas.ts`, a 4-digit code both people compare; the chosen role is part of what
  the code covers), the target person accepts (`remote/requests.ts`: 5-minute TTL, at most 3 open requests, 5 per
  address in 10 minutes – the endpoint faces the internet). The accepted PC is stored with its proven key. Agents link
  a PC with `devices.connect {target, role?}` (`devices/connect-tool.ts`; the role is how this PC joins the other PC's
  company, CEO by default); `devices.list` also shows this PC's `remoteId` and `meetingServer`
  (connected | connecting | off). **Requests on every own PC** (16.11.2026, `remote/mirror.ts` `RequestMirror`): the PC
  that holds requests sends its whole list (public view, peer `remote.requests`) to each online `ceo` link on every
  change and at link-up; the receiver shows them with `via`, expiry moved onto its own clock, and Accept or Decline there
  runs peer `remote.decide` on the holder (first answer wins; a later one hears the request is no longer open).
  `remote.decide {id, accept, personId? | newPerson {name, title?, managerId?, role?}}` (`readDecide`): a new person is
  made only when the device collects the acceptance (once, `people.save`), an employee's PC that links marks its person
  joined (`people.joinedWith`), a phone gets a person token; a `ceo` request never becomes a person's.
* **Roles**: joining as **CEO** (default) means everything is the same as on the CEO's own PCs – they reach every
  method, and agents use tools on each other's PC. Joining as **employee** binds the PC to a person
  (`Device.personId`); that PC may only call `ping`, `device.caps`, `device.addresses` and `sync.rows` (which takes
  from it only its person's own lines and task changes) on the CEO's PC, while the CEO's agents can use tools on it.
* **The mesh** (`devices/mesh.ts`): one live, encrypted connection per linked PC – pinned Ed25519 keys, an X25519
  handshake into an AES-256 channel (`handshake.ts`, `channel.ts`), JSON-RPC over it (`rpc-peer.ts`). Dialing
  (`reach.ts`) opens the stored addresses and the address the meeting server saw at once (the first socket wins);
  the tunnel is the last fallback. PCs exchange their current addresses over the link (`device.addresses`). Only the
  smaller device id retries with backoff (1, 2, 5, 15, then every 30 s – B-077, before up to 5 min) – in a link's first
  minute both sides do (B-084, `mesh-retry.ts`); only a refusal (close code 4003 before the handshake answer: unknown
  device, bad key) ends the retries – except a 4003 within 10 s of pairing (the link-up race), which gets one more dial
  after 2 s –, a network error or a slow handshake (4000) does not. **Liveness** (B-077, owner 05.11.: changes pushed at
  once, like a realtime database; on 05.11. a link this PC dialed stayed "online" for minutes after it died, and one
  outage lasted 43 min): both ends ping every 15 s (`http/keepalive.ts`, the dialed sockets through
  `compose/peer-dial.ts`), any frame counts as life, a tick that comes late because the process itself stalled ends
  nobody; a socket is cut only after a minute without any frame (B-080, `SILENT_PINGS` = 4: a stall of up to a minute
  on either PC keeps the link), so a dead link closes on both sides within about 60–75 s (close code 4008,
  `devices/channel.ts` `SILENT_CLOSE`), the smaller side redials and the link-up catch-up sends what is owed. File pieces on the link are 1 MiB
  (`sync/file-io.ts`, `send-file.ts`), so pings never wait long behind one. "peer dialed", "peer link closed" and a
  refused dial are info lines. The data path itself was already push (rows within 300 ms of the change, below).
  **B-087** (rerun of the B-077 review on 09.11., live log: outages with both PCs up median 11–21 s, before B-077
  119 s): a trigger (start, resume, unlock, network back) only dials PCs without a live link – the 5 s ping that cut
  live links to a stalled PC is gone, the keepalive judges live links; a link a trigger found live that closes within
  90 s of it (the keepalive's cut after a wake) gets one retry on the larger id too, at 5 s – the smaller id's own 1 s
  dial normally links first and ends it (`mesh-retry.ts` `TRIGGER_MS`, `TRIGGER_STEP`); a slow dial whose socket opens
  after the other PC already linked does no handshake (`reach.ts` `stale`), so it never replaces that link. In the
  race of two dials the smaller id's link survives one incoming dial; a second one from the other PC replaces it at
  once (on 09.11. 20 dials were turned away for 10 s). A dial leaves out
  this PC's own addresses, and a hello with this PC's own key closes with 4000 (a path back to itself is never a
  refusal). A message too large for one frame (8 MiB) fails on the sending side with "too large for the link between
  PCs" – a too-large answer goes back as that error – instead of closing the link. A PC that is off stays "offline"
  while it is redialed (no flip to "connecting" every 30 s). "peer connected" is logged only for a link that is kept;
  a peer socket the main HTTP server cuts for silence is marked 4008 like the others. A socket error hands its cause
  with the 1006 (`channel.ts` `closeWhy`: error code and syscall, whether this PC still has the address the socket ran
  on – never the address –, age, bytes waiting), logged in 'peer link closed' (22.11.2026: two PCs' links died ~19 s
  after a send – Windows' TCP give-up while the notebook's Wi-Fi dropped). **Link quality** (`devices/link-quality.ts`,
  memory only): a PC link's round trip and clock offset (NTP-style from the mesh `ping`'s `at`, the sample with the
  smallest round trip) at link-up and each sync round, a page socket's (phone, browser, iPhone tunnel) from the
  keepalive's own ws ping → pong; median of the last 5, stale after 5 min; Settings › Devices shows "45 ms" or "Slow
  connection" (≥ 300 ms round trip), `devices.list` gives the AI `link`, `linkQuality(deviceId)` is there for calls.
  **Pages notice silence** (`ui/lib/rpc.ts`, `shared/api/protocol.ts` `SILENT_MS` 60 s): the PC sends each page socket
  a beat `{}` with every keepalive tick (after its Hello; old pages and the CLI pass over it); 60 s without any frame
  while no call waits for its answer → the page reconnects and reloads everything; views load through `ui/lib/use-load.ts`
  (again after every reconnect).
* **The meeting server** (`services/remote-relay`; address = `settings.devices.relay`, empty = off; default
  `DEFAULT_RELAY` = `wss://telecoding-relay.onrender.com/autark`, Autark's own, mounted under `/autark` in the
  TeleCoding relay process on Render behind Cloudflare, `AUTARK_IP_HEADER=cf-connecting-ip`; a test profile –
  `WORKFORCE_TEST_DATA` or the demo engine – skips the default, `devices/connect.ts` `meetingAddress`; the copy in the
  TeleCoding repo is `apps/relay/src/autark/` and must follow changes here): a PC registers its key and peer port; the server shares the address it sees only between two
  PCs that pinned each other; they then talk directly. A sealed tunnel through it is the last resort – the server
  cannot read or alter the traffic. Remote ID lookups are sealed end to end. Client side:
  `devices/rendezvous/{service,relay-client,seal,tunnel}.ts`. It runs on its own port (`src/main.ts`; bundled by the
  build target `meet` to `app/meet.mjs`, unpacked from the asar, so the app's own binary as Node can run it; a
  `Dockerfile`) or mounted on another program's HTTP server (`createRelay({ noServer: true })`, the host hands over the
  WebSocket upgrades); behind a proxy `RELAY_IP_HEADER` names the header with the client's address (e.g.
  `cf-connecting-ip`). A client takes a URL with a path (`wss://host/path`) as it is.
* **Remote tools** (`tools/placement.ts`, `devices/tools.ts`): `computer.*`, `browser.*`, `phone.*` and `shell.exec`
  (a terminal on a linked PC) take an optional `device` argument; without it they run on the agent's home device, else
  on this PC. A call for another PC is forwarded over the mesh as `tools.call` and runs there like a call of that PC's
  own agent (a remote `shell.exec` has no 120 s RPC timeout; its own limits bound it); the journal names the PC.
  `devices.list` shows the PCs, their capabilities, `homeDevice`, `employeeOf` and – for this PC and each own online
  PC – `load` {freeMemoryMb, runs} (`devices/load.ts`, carried by pings to `ceo` links only) and each PC's `security`
  mode and `otherPcs` switch (§7.6, carried with the load), so an agent can put heavy work on an idle PC or move itself
  there with its record (`agents.update device`, below). Agents can hire an agent with its
  home on another PC (`agents.create device`).
* **Shared work between linked PCs** (`runtime/devices/sync/*`, wired by `startSync` in `runtime/main.ts` before the
  start-up reconcile, §4.1; mesh methods `sync.rows`, `sync.secret`, `sync.file`, `sync.login`, `sync.reading`, `sync.live`; listeners
  attach only while a PC is linked). **The one rule (Fest 22.11.2026): state, not messages** – whatever travels comes
  again on its own, so a lost message heals without retry code of its own: every link runs its catch-up again every 2 min
  while it stays up (`service.ts` `rhythm`, each round announced as `sync.round` so other modules follow it – company-facts
  does), sending only what is owed since the last round; after either PC changes version its cursors start from zero
  once (`stamps.ts`: one cursor per part 'rows'/'files', keyed by both PCs' versions); a PC keeps settings units it does
  not know and passes them on (`settings.ts` BASE + per-key units, kv `sync.settings`). **Live work** (16.11.2026,
  `sync/live.ts` + `live-wire.ts`, `ceo` links only): runs do not travel; each PC sends numbered change commands with the
  run's ID (start = the run's entry, change = only the changed fields, end at once; counter `s` +1 per change), a pulse
  `{s,h}` (counter + 6-character hash, ~21 characters) every 5 s while it has running work, and its whole state at
  link-up or when the receiver finds a gap or a differing pulse (`w:1`); the receiver drops a PC's state 15 s after its
  last message (a 0.3.16 PC, which sends `{runs}` whole and never repeats, never expires). The receiver keeps it per PC
  (`ChatLive.setRemote`), so the live bar, chat header, chat list and `agent.activity` (entries with `deviceId`) show the
  other own PCs' work; a context fold's run carries `fold` and the bar says "Folding its context"; `runs.cancel` forwards
  a run it does not have to its PC (`sync.live.cancel` → `cancelRunHere`). At link-up and each round one mesh `ping`
  measures the link's round trip and clock offset (`devices/link-quality.ts`, below). What a link carries
  (`home.ts`, from `devices.allow` `{personId?, joinedAs?}`; whether a link is a CEO PC's is one check, `home.ts
  isCeoPc`): between **CEO PCs** everything both ways; to an
  **employee's PC** the chats the person is a member of, the messages they may read (`people/access.ts`, from the join or
  the whole history), their tasks, in the person's own terms (`people/perspective.ts`); back from it only the person's
  own lines and changes to their own tasks (`employee.ts`; her own open to-dos reach the company as hers, an "Only me"
  one too – it hides nothing; anything else is dropped quietly, wakes from it are ignored).
  A link coming up sends what is owed since that PC's cursor (everything the first time), in this order (B-087,
  `sync/service.ts` `linkUps`): roster, side pane, rows, secrets, every plan's login, then the wakes that waited (they
  may need that login or secret), then settings and the file manifest with its rescan (the rescan and the ledger only at
  link-up, not in the 2-minute rounds; a file that failed to pull is offered again by the next round). Only that PC's own link-up
  releases the wakes that wait for it (`rows.ts` `resume(peer)`, held agents included). One link-up per PC at a time; an
  "online" that comes again while one runs (a link swap) ends it before its next step and runs it again at once from
  the same cursor – during its last step its wakes go once more on the new link right away and it runs again after
  it; a run whose link is gone stops between steps, and inside a step no further page is sent (rows, secrets, file
  pages) – no dial per page; the cursor stays and the next link-up owes the rest. Clock (`stamps.ts`): one stamp per unit, last
  writer wins; ties at 0 go to the joiner (a differing secret under a shared id is kept under a new id). Rows
  (`tables.ts`, `rows.ts`): stored files' metadata (`files` rows without refs and text preview), spaces, people, chats
  with members, agents (of the live state only "paused"), tasks, schedules, accounts (metadata; a CLI plan a PC found
  travels too – the receiver gives it its own home, or the default home of a CLI with one sign-in per PC, and keeps
  one account for the same provider and e-mail (any one, for such a CLI), the `detected` flag stays per PC),
  messages, chat notes and knowledge rows (old versions of memory files, without embedding,
  uses and last use), written through
  the repositories and the services' own events, no echo, passed on to the other CEO PCs. A message gets a fresh local
  seq; a streaming one travels with its live values (§4.2), and one that ends here after other lines came, or a silent
  row that ends, gets a fresh seq again, so no colleague's cursor has passed it. Changes gather for `FLUSH_MS` (300 ms)
  and each row goes once, in its latest state; rows that never travelled (stored files, knowledge rows, CLI plan accounts a
  PC found) get a stamp each time the sync starts, so an existing link gets them at its next link-up. Secrets
  (`secrets.ts`): the sender decrypts at send time, the values travel only inside the mesh channel to CEO PCs and are
  stored under the same id; only ids, counts and error codes are logged. **Plan logins** (`logins.ts`, B-075, owner
  04.11.: sign in once, the plan works on all his PCs): the files that hold a CLI plan's login (`accounts/cli-homes.ts`
  `loginFiles`: Codex `auth.json`, Claude Code `.credentials.json`, Gemini CLI `oauth_creds.json` and
  `google_accounts.json`) are read at send time and travel only inside the mesh channel to every PC that shares the plan
  (`plan-peers.ts`, 22.11.2026: the CEO links and – for a CLI plan with a login home of its own (Codex, Claude Code) "on
  all PCs of this company" of the company's own – every employee's PC, whose refreshed login goes back to the company's PCs; an employee's own plans never leave their
  PC; from a non-'ceo' link only that very account's login is taken) – never to an agent, tool, prompt, the UI or a log.
  A plan whose login turns 'needs_login' asks those PCs at once (`want`, at most every 30 s, answered at most that often). **Plan readings**
  (`readings.ts`, `sync.reading`, 22.11.2026): a plan's limits are the plan's, not a PC's – each reading goes to every PC
  that shares the plan and the newer `readAt` (turned into this PC's clock by the link's ping offset) wins, so a PC whose own read fails shows what another PC read (stale only
  when no PC read it lately); state and cooling stay each PC's own. The newer login wins by its own time (Codex `last_refresh`, Claude Code's and
  Gemini CLI's token expiry; else the file's mtime); the receiver writes the files whole (mode 0600) into the account's home here – its own
  home in the PC's logins folder (§6; a synced CLI row lands in the shared home of the same e-mail when that home's note
  names it), or a CLI's default home (`~/.codex` …) – and never over a file of another account
  (Codex `tokens.account_id`, Gemini CLI's id token subject); `heldElsewhere` checks this company's plan homes and every
  other home in the logins folder, never the same home. A Claude Code login file names no account: a refresh
  token that another plan's home here holds, or that one list carries for two plans (kept as a hash while the runtime
  runs, also against a later lone copy), is no plan's login – neither sent nor taken (B-080, B-087) – and one login is
  checked and written at a time. A folder watch and account events send a change after
  0.5 s. A sign-out in the app stays on that PC: its mark – the home's note `.autark-login.json`, kv
  `accounts.signed-out` only for a default-home plan – takes no login from a linked PC into any company until a new
  sign-in here or the account's removal. Copilot CLI and Kimi Code logins and Claude Code's on macOS
  (Keychain) do not travel. Files (`files.ts`, CEO PCs only): `theme.css`, `prompts/`,
  `modes/`, `agents/**`, `memory/**`, `connectors/mcp.json` and `mail.json` and the workspace's `skills/**` as whole
  files by sha256 (manifest, tombstones, pieces of at most 4 MiB), a change going at once through the watcher's tap
  (`root/watcher.ts`). B-087: a failed pull is tried again after 2, 10 and 60 s while that PC stays linked; a file
  changed here while its pull ran stays (the last look and putting the file in place are one synchronous step); what a
  'have' finds changed here and does not replace goes out at once, to its sender too; a look a pull overtook leaves the
  entry to the pull. An agent's `SYSTEM.md` also travels in its agents row: one that comes before its row is taken
  over at once as an echo, stamped half a step after the last stamp, so the author's row still wins with its other
  fields – unless the row here had already brought newer instructions, then the row stands; a rewrite with the same
  bytes (a save back to what the file says) is a new version; files the agent core writes from its cache into a folder
  that had none are dated before the agent existed, so a linked PC's real ones win; `settings.json` (`settings.ts`) as one unit per top-level section (`settings/<section>`) – all
  but `devices`, `pwa`, `security` (since 21.11.2026 per PC, §7.6) and the window layout –, stamped only on a real change, with a baseline at 0 when the sync
  attaches (an older single `settings` stamp counts for every section); a winning section becomes a `settings.update`
  patch, so a text cleared on one PC is cleared on the others, but at the first link the joiner merges: an empty or
  null text from the other PC never clears a text the joiner has (its own name stays), and what it kept – also a
  section only it has – goes back as its own change (0.3.1 PCs and this
  version ignore each other's settings until both are updated). Stored files' bytes (`blobs.ts`) come when first
  needed: a reader that misses one – `http/files.ts` `serveFile`, `files/store.ts` (`FileStoreDeps.missing`, wired in
  `compose/services.ts`), `context/attachments.ts` `prepare()` before a turn – awaits `needBlob()`, which pulls it by
  its sha256 from an online CEO PC (`sync.file` op `blob`) and checks the hash. `file-io.ts` puts a pulled file in place
  by renaming a temp file, and where Windows refuses the rename (EPERM, EBUSY, EACCES) copies over the target; a failed
  pull leaves the link-up incomplete. Not carried: the `models` table (each PC's own catalog), read cursors, calendar
  and media rows, browser extensions. **Home device**: a NULL `device_id` means this PC; an agent's turns run only on its home PC
  (dispatcher gate, §4.1), its due wakes are handed there (through the CEO PCs when the home is not known directly),
  and each schedule fires on one PC (`placeSchedules`: where its agent runs – or where it would go on, below; the
  person's on the CEO PC with the smallest id). The agent's record (`context_items`) travels too since 21.11.2026
  (next bullet); runs, wakes, splits and engine sessions stay per PC. Two rules of `rows.ts` (Umzug 21.11., `READ.md`):
  a wake goes to a PC only after the rows it names (`owed` PCs get a catch-up from their cursor first, else the wakes
  wait for the next link-up) – a wake ahead of its line found nothing new and was settled silently; and a row counts as
  history only on a link-up without cursor and when it is not newer than the pairing. A PC that joins as CEO retires its own untouched first-run Manager and empty chats once the company's
  agents arrive.
* **An agent between the person's PCs** (Umzug 21.11.2026, owner: move agents, go on when a PC is off, bring two
  states together; contract `.local/umzug-20261121/CONTRACT.md`; migration 113: `agents.homes`, `context_items.pc` and
  `changed`, counter table `context_seq`). An agent runs on exactly one PC (`Agent.deviceId`; NULL = this PC, and an
  incoming row naming this PC is stored as NULL). That PC writes its record (§5.5); every other CEO PC mirrors it.
  * **The record between CEO PCs** (`devices/sync/ledger.ts`, `ledger-wire.ts`, `ledger-branch.ts`, `ledger-fetch.ts`,
    `ledger-forget.ts`; mesh method `sync.ledger`, CEO links only, never relayed, never to an employee's PC or a phone):
    the PC an agent runs on pushes its `context_items` rows whose `changed` (raised by two triggers from `context_seq`,
    so deletes never lower it) is past that peer's cursor (kv), in pages ≤ 2 MiB, at link-up right after `rows` and
    before secrets, logins and wakes, then every second while linked (one push per peer in flight, a failed one again
    after 30 s). With each kept or condensed row go its originals (the run item, its tool_call row, a minimal runs row –
    a copy keeps the source's final status and never counts as this PC's run, `context/recent-actions.ts`); hidden rows
    go without (96 % of the rows, measured 21.11.). A receiver writes nothing for a row equal to its copy (no echo). A PC
    that becomes an agent's writer owes each CEO peer that agent's whole record once (`becameWriter`). Blobs come with
    `fetchOriginals` after an arrival (`needBlob`); a restore of a hidden item whose original is elsewhere fetches it
    from the PC in the row's `pc`, then from the others (`context/ledger/restore.ts restoreFetched`, ≤ 10 s; the
    subconscious's sync restore says "it is on its way"); with that PC off it says where it is. "Forget permanently"
    reaches every CEO PC (op `forget`, owed in kv to an offline one).
  * **Moving** (`agents/move.ts`, one watcher on `agent.upserted` for every cause – the tool, the app's "Works on",
    a synced row, a takeover): leaving this PC stops the agent's main turn at once like the person's Stop (its own
    `agents.update device` call runs to its end, `movingMyself`), stops its parts, flushes the record and sends its
    waiting wakes on; arriving here marks it `arriving` (the dispatcher starts no turn) and asks the PC it came from
    `agents.handover` – that PC answers when its leave is done, with the repair notes still waiting there; at the answer,
    a dropped link or 60 s the turn goes. Then the stale `engine_sessions` here are dropped (after a running turn ends),
    so the next turn rebuilds its session from the record (§5.5), and one line in the next turn says where it runs now.
    A move to an own PC that is offline is refused – tool and app (`moveRefused`). From inside a split part an agent
    does not move itself.
  * **Going on elsewhere – only where set up, only with the newest state** (owner 21.11. ~14:00; `devices/sync/takeover.ts`,
    `home.ts goesOn`/`settledHere`, `ledger-settled.ts`; `Agent.homes` – the PCs it is also at home on, set by the agent
    itself with `agents.update {homes}`, empty by default = it never switches by itself): the agent's PC announces to its
    homes `busy` when a run of the agent starts and `settled {head}` when no run is open and every row up to head was
    acknowledged (`resettle` asks again after a link-up); a newer row or `busy` clears it. `settled` carries a fingerprint
    of the agent's state (`settled-state.ts`: its chats' message counts and times, its tasks, the file manifest of
    `agents/<id>/` and `memory/`), compared with the stand-in's own at the moment the link drops; it is believed only on
    the link generation it came on, cleared at start and after a sleep (heartbeat older than 30 s). When the agent's PC is a CEO PC
    gone ≥ 2 min (`TAKEOVER_MS`, counted from the later of its last-seen time and this runtime's start) and a wake is due,
    the smallest-id online PC among its homes takes it **only if it holds `settled`** – it writes `deviceId` itself (the
    row travels; the PC it left stays one of its homes); else the agent waits for its PC (one info line). A PC that holds
    the wake but is not that home hands the wake there; a schedule of such an agent is armed there too (`firesHere`). The
    agent reads "My PC <H> has not been reachable since HH:MM; my record was complete here, so I go on on <me> …"; when <H>
    is back it stays and hears it once. Known limit: with three or more homes, when the smallest online one is not
    settled but a larger one is, nobody takes the agent.
  * **The same on every home** (`devices/sync/share*.ts`, mesh `sync.share`, only between the agent's homes, CEO links,
    inside the channel): its browser sign-ins – Playwright storage state (cookies + per-site storage) read through the
    browser when its session closes and at a leave (`shareNow`), kept encrypted (`host.encrypt`, `<data>/share/`),
    merged on the other home before its next page (incoming wins per cookie and site; a removal since the last share
    travels as a removal), never by copying the profile (its cookie store is bound to the PC's OS key) – and its home
    project (agent.json `home`): whole files by sha256 to the same absolute path (a watcher, gathered 500 ms, and the full
    list at link-up), `.git`/`node_modules`/`.venv`/`__pycache__`/links/files over 256 MB skipped, changed on both sides →
    both kept ("name (from <PC>).ext"), deletions travel; not mirrored to a PC where the path is not absolute, a network
    path, its parent is missing or the folder is not write-open to the agent (`security.check`) – the agent hears it once. Lines of different kinds (arrival, back,
    branch) stand together, a newer one of the same kind replaces the older (`noteMove`, repair notes of the main thread).
  * **Two records that drifted apart**: the agents row (last writer wins) names the writer. The other PC's own rows the
    writer lacks go to it as a branch; it appends them after its own rows with fresh ids and orders, `pc` = the PC that
    wrote them (their hidden originals stay there for a restore), drops the sessions and tells the agent once ("While
    <P> could not reach <me> (…) I also worked on <P>: n items, first–last"). Rows from before this version (older than
    the PC's first ledger start, kv `sync.ledger.start`) are appended hidden ("My older record from <P> …"); an agent
    with no rows at all on the writer takes the rows as they are. The loser deletes only rows the writer took. One agent's
    conflict never holds back the others (`refused` answer, owed per agent).
  * **Files and folders**: `devices.send_file` (`send-file.ts`, receiver `receive-file.ts`, names and place
    `landing.ts`) sends a file or a whole folder (layout and empty folders kept, links to folders not followed) in 1 MiB
    pieces after a `begin` that announces the total size (free space checked); to `at` (an absolute folder there), else
    the same folder path when it exists there, else `inbox/<PC>/`. Never overwrites (" (2)", exclusive create); a
    folder is built as `.<id>.partdir` and named at the end; a transfer without a piece for 5 minutes, an abort or a
    lost link removes what it wrote. Only characters Windows cannot hold change (leading dots stay; CON/NUL… get `_`);
    a network path or one not absolute on the receiver's OS goes to the inbox untouched; the landing folder must be
    open to the sending agent under the receiver's rules, else the inbox with the reason. A receiver before this version
    takes single files into its inbox only.
  * Proven with two real runtimes over the mesh (`test/e2e/runtime-move.test.mjs`: mirror, move, takeover after 120 s,
    merge after a split).
* **Phones since B-078 (D5)**: a phone pairs by this PC's Remote ID through the meeting server, the same 4-digit code
  on both screens, Accept on the PC; access exists exactly while its accepted device row exists (no "Phone access"
  switch). Android: the native app (`apps/android`, phone use via an AccessibilityService). **Direct first** (16.11.2026,
  stage 1): the Android app goes straight to a PC whenever one of its addresses answers – `phoneUse.attach` and
  `phone.pcs` give each PC's peer `addresses` (http(s), at most 8), the app dials them all at once (`Route`, 1.5 s) to
  `GET /peer/phone` on the peer listener (WebSocket, `PhoneBridge.acceptDirect` in `rendezvous/phone.ts`: the same pinned
  handshake as the tunnel, only the key of an accepted phone row – checked again after the handshake, 4003 otherwise –,
  then the same streams to the runtime port, keepalive 30 s) – and else through the meeting server's tunnel. Settings ›
  Devices › Connection shows each phone's way and its bytes direct and via the server today (`rendezvous/phone-traffic.ts`,
  `RelayState.phones`; one "phone traffic" log line per day). **WebRTC** (16.11.2026, stage 2, PC side; 17.11. the Android
  app, the iPhone web app follows, F25 P3): inside the finished pinned channel of the tunnel a phone sends `{t:'rtc',v:1,op:'hello'}`; the PC
  (`rendezvous/rtc.ts`, werift 0.27.0 pinned exactly, loaded on the first hello) answers an offer, both trickle
  candidates (SDP at most 16 KiB; loopback, 0/8, link-local incl. 169.254.169.254, multicast, broadcast and ports below
  1024 dropped; data only from checked candidate pairs), and on the data channel `autark` the phone runs the same pinned
  handshake again (`rendezvous/rtc-socket.ts`; DTLS never counts as identity, a foreign key ends it with 4003). After
  `ready` the streams move to it; when it closes they fall back to the tunnel at once. STUN only from `devices.stun`
  (default `stun:stun.cloudflare.com:3478`, may be empty; werift's own Google default is off), `devices.rtc` switches
  it off; log lines and counters carry candidate types only, bytes per phone split into direct, rtc and relay. The Android app
  (`relay/WebRtc.java`, `RtcWay.java`, `RtcSignal.java`, `PageRtc.java`; Threema's libwebrtc `ch.threema:webrtc-android`
  149.0.0 pinned, compressed for both ABIs, its native logging off) tries once per channel and per network change or
  return to the app, never on a timer; it takes ICE servers only from the PC's offer (an empty list stays empty),
  sends and accepts UDP candidates through the same filter as the PC (and no `.local` names), runs the pinned
  handshake on the data channel and moves the page there only after `ready`; any failure leaves it silently in the
  tunnel. **iPhone without an Apple
  account**: a hosted web app (`ui/hosted/`, bundled by `scripts/hosted-bundle.mjs` into `apps/website/src/app/`,
  served from its own origin, today `https://autark-theta.vercel.app/app/`; `website/build.mjs` refuses an origin
  shared with the site, Meta Jarvis or TeleCoding). It ports Android's relay client to WebCrypto (Ed25519, X25519,
  HKDF, AES-GCM), opens a pinned-key tunnel to the PC and uses `rendezvous/phone.ts`'s stream protocol to the PC's own
  HTTP port; its service worker relays `/app/pc/*` requests to the page, `window.autarkHosted` gives `ui/lib/rpc.ts`
  a WebSocket over the tunnel – always the tunnel (a web app cannot open a direct connection; its Connection row says
  so). The PC's `index.html` carries `<meta name="autark-hosted">`; without it the shell says
  "Update Autark on your PC". **The shell runs only files the PC vouches for** (16.11.2026, F29): it fetches `/` and
  `/ui-hashes.json` together and keeps the list in the cache `autark-pc` (`ui/hosted/ui-hashes.ts`); its service worker
  (`ui/hosted/sw.ts`) gives the page exactly the bytes whose sha256 the list names – a copy that does not match is
  fetched again, a fresh file that does not match or an unlisted script, style or worker gets a 403 and the screen
  "Autark stopped a file" (after one more look at the PC's list); a PC without the list (before 0.3.9) gets "Update
  Autark on your PC". `phone.pcs` lists the company's PCs for the phone, `phone.forget` revokes its own row.
  The PC-served web app and its `pwa.link` code below stay as the other way (Tailscale/LAN).
* **Phone and browser access (PWA)** (`runtime/pwa`, `ui/pwa`): the runtime serves the same UI; `pwa.enabled` and
  `pwa.bind` (localhost, lan, tailscale) decide where. "Connect a phone" makes a one-time pairing link (`pwa.link`, QR
  `#pair=<secret>`) that the phone trades for a device token (`pwa.exchange`); only token hashes are stored. A paired
  phone of the owner has full access; on a secure transport (the app's tunnel or direct path, HTTPS, the tailnet) it
  reaches every Settings page (16.11.2026: each method by its page's capability plus secure – `settings` for calendar,
  backup and restore, provider histories and the feedback inbox; `manage` for `system.root`, `chats.export`,
  `skills.delete`, `modes.*`, local command servers and the mailbox; `permissions` for `secrets.export`). Owner-only stay
  `feedback.setup`, `knowledge.forget` and what opens a window on the PC's own screen (`files.open`/`openPath`,
  `secrets.openFolder`, `modes.openFolder`, `agents.openHome`, `system.install`, `computer.preview`). A
  sign-in whose answer returns to the PC's own 127.0.0.1 address (Google Calendar, an app's MCP OAuth, a browser plan
  sign-in) opens in the PC's side pane – `side.open {url}` → `{ok, tab}` (`manage` + secure, host op `sideBrowser`
  'open', `PANE_MISSING` without a pane) – and the phone shows that tab in its pane sheet (`ui/workspace/phone-tabs.ts`
  `openInPcPane`, `showOpenedOnPc`); PC files open there too (`ui/settings/open-file.ts` `openPathHere`). `calendar.sources`
  events reach such a phone, and `calendar` is one of the `SECURE_DEVICE_SETTINGS`. The phone shows its own OS
  light/dark (`lib/theme.ts` `shownTheme`; the theme setting is the PC window's). Beside the QR stands a 6-digit code for the same link (`pwa/pair-code.ts`, B-075:
  an installed iPhone app keeps its storage apart from Safari's, so it types the code, `ui/pwa/AccessRequest.tsx`) –
  10 minutes, one use, kept in memory as sha256 only; the open codes face 10 wrong codes together and the 10th drops
  them all (`rate_limited`); `pwa.exchange` takes the secret or the code. The phone's address (`pwa/service.ts`
  `phoneUrl`, from `urls.ts`) is `tailscale serve`'s https address first (`tailscale serve status --json`, read again
  when older than 30 s, `SERVE_CACHE_MS`; showing the QR waits for that read), then LAN and tailnet – never this PC's
  loopback: with nothing else `pwa.link` refuses (`conflict`, "choose 'The same
  network' or ask the AI to set up Tailscale"), and `pwa.enable` without a bind while only the loopback answers takes
  `lan`. Web push with VAPID: one push request (`push.ts pushOne`: encrypt, headers, 404/410 = gone) and one signer
  (`vapid.ts vapidHeader`) for the own subscriptions and the held ones (`devices/sync/held-push.ts`),
  `webpush-crypto.ts`; the service
  worker is `ui/pwa/sw.ts`. **Back on screen at once** (B-077, `ui/lib/rpc.ts` `checkAlive`): when the page becomes
  visible, is shown again (`pageshow`), the network returns or a push arrives (`wf.wake` from the service worker), a
  closed socket reconnects at once and an open one is asked `session.info`; no answer within 3 s ends it as dead and a
  new one opens – its `onOpen` reloads chats, tasks and the open chat (a socket a sleeping phone kept "open" stopped all
  events until the OS noticed). The desktop window's port is untouched. The Android app calls it when its link is back,
  the iPhone web app's shell when its channel to a PC opens again (`autarkResume`, B-087). A phone's notification
  switch shows "on" on every PC that pushes to it – also through a subscription held from another PC's roster (B-087,
  `pwa/service.ts`), so turning it on there never replaces the working one. A "clear" push closes the notice; only on
  Apple's push service (iOS wants every push to show something; the PCs send it no clears anyway) is it shown again
  quietly – in Chrome or Edge on the iPhone web app's site a dismissed notice no longer comes back.
  **App-icon badge** (`ui/pwa/badge.ts`, `sw-notify.ts`; Android `AppNotices`, `PhoneRoutes`): the sum of open
  notifications, with bundled chat messages counted individually and each task or other notice counted once.
  The notification tray holds the counts; no separate counter or polling. Web workers serialize pushes and badge
  refreshes, remember counted chat event IDs in the notice to deduplicate delayed deliveries, and refresh after
  delivery, tap, dismiss or clear. The page requests the same queued refresh after closing read chats' notices;
  call notices close when the loaded app is in front. An iOS compatibility notice for a clear contributes zero.
  Android sets each notification's `number`; its connection channel excludes badges, and opening the app clears
  message notifications. The launcher determines whether it displays a number or a dot. Ring notices use their
  own `call:<id>` tag so a call and its end leave the chat's message count intact.
  A phone opens the PC's own address: on the LAN, a fixed IP or forwarded port, or
  `tailscale serve` set up by the AI with the skill `phone-access`. On the phone the UI is mostly chats, plus voice.
* **People of the organisation** (`runtime/people`): the owner is the first person (`human`); employees are people
  with name, role, a manager and their own chats and to-dos. **One way for a person's device** (F13; Quests-Runde
  20.11.2026 – no person-scoped QR or 6-digit invite): the device asks with this PC's connect
  code, and Accept says whose it is – "Invite a device" on a person's page shows `ui/team/PersonJoin.tsx` (this PC's code
  and each incoming request with that person preset); the device gets a person token. An invite link (`people.invite`,
  72 hours, one use) stays only for "Copy link" – a browser on the network.
  Person devices call the person variants (`people/rpc-*.ts`) and see the chats they are members of and their own
  to-dos (`people/access.ts`, `perspective.ts`). The owner sees everything. A new message in a chat reaches the
  devices of every person who is a member by push (`pwa/person-push.ts`). Team › Add › Person is a page
  (`#/team/person/new`, `ui/team/PersonNew.tsx`): name, title, reports to, role (owner only), this PC's connect QR and
  the incoming requests, each accepted as that new person (`remote.decide newPerson`); "Copy link" makes the person and
  an invite. Someone who never joined (`hasJoined`) sits in the Team sidebar's "Invited (n)" fold, not in the org tree
  (`ui/team/org-state.ts` `splitInvited`); `people.remove {id}` (owner) offboards them, deletes their tokens, invites, row
  and audit lines and emits `person.removed {id}` (topic `org`; a people `gone` item to my other PCs) – who joined keeps
  "Remove access". **Co-CEO** (16.11.2026; `Person.role` 'member' | 'ceo' in the scopes JSON, no migration; only the
  owner gives or takes it): a CEO gets `CEO_SCOPES`, sits at the top of the org unless a manager is named, and its
  devices' scope carries the role (a change reconnects them). Methods registered with `{ ceo: true }` (`rpc/table.ts`,
  under the same transport ceiling; `people/rpc-ceo.ts`: `agents.templates/create/update/archive/restore`,
  `people.save/invite/closeInvite/revoke/remove/removeDevice/audit/chats`) act on members only – never the owner's row,
  another CEO's or their own – and keep off the setup of the owner's personal agents (`access.ts` `ownersOwnAgent`). A
  CEO reads every company chat – all but app-owned chats, people's own and the owner's own (alone or with one other;
  bridged `ext:` contacts do not count; one that grew into a group only from the third member's join, `companySince`) –
  with its tasks and files (`chatAccess`, `readsTask`, `readableTasksSql`, `mayReadFile`), and never removes the owner
  from a chat; `mayReadMessage`/`mayReadTask` stay the member rule for the employee-PC sync. Agents read the CEOs in
  `people.list` (`role: 'ceo'`) and their prompt (§5.1).
* **Android control** (`runtime/phone`): `phone.*` tools – pair, connect, disconnect, devices, screenshot, ui_tree, tap,
  swipe, type, key, open, say – on the person's paired Autark app first (`phone/app-driver.ts`, `phoneUse.request`/`reply`
  over the app's link, 20 s a step) and over adb (USB or wireless debugging, on any linked PC that has the phone) only
  when no app phone is attached or the serial names an ADB device (`phone/drivers.ts`; `phone.devices` marks each
  "Autark app" or "ADB"). Each app step carries `by`, the agent's name, which the app's bubble shows; `phone.say {text ≤
  120, ask?, buttons?}` puts a status line in that bubble or asks yes/no (75 s; app 0.3.15, ADB has no bubble; B-092, Android source
  only, not compiled: the ask vibrates once and becomes a notification with ✓/✕ when the screen is off or the app is not
  in front); since 19.11.2026 `buttons` (≤ 8 labels ≤ 40) are the AI's own answers – short ones beside the line, longer
  ones as bubbles under it (`phoneuse/SayChoices.java`), the answer is the tapped label – and a run that used a phone
  sends it op `done` when it ends (`run.upserted`), so the bubble goes at once (else 2 min after the last step); `phone.type`
  answers what the field reads afterwards (masked; a password field is not read back). Setup over adb (installing it
  through the shell, pairing, `adb tcpip`) is the skill `phone-adb`; the app phone's facts are the skill `phone-access`.
* **Computer use** (`runtime/computer`): a persistent Windows helper (PowerShell with UI Automation,
  `resources/computer/windows-helper.ps1`) and a Linux AT-SPI helper. Tools: screenshot, windows, ui_tree, act (by
  element ref), click, type, key, scroll, drag; since B-092 also `computer.wait` and `computer.batch` (on the model of the
  browser's), and `ui_tree` passes its max through. One pointer lease per PC (`lease.ts`), named pointers for each agent
  (`pointers/hub.ts`), human priority while the person uses the PC (`presence.ts`), human-like motion. A simple
  Stop/Resume (`computer.stop`/`resume`, a latch in kv) and the emergency stop cut computer input.
  **Named pointers** (`shared/model/pointers.ts`, B-081): a person's pointer stays in the agents' lines for 5 minutes
  (`POINTER_PERSON_TTL_MS`, `liveFor`; an agent's 15 s, `POINTER_TTL_MS`) – "is moving over X" under 2 s since the last
  move, else "rests on X (selector), last move 40 s ago" (minutes from 90 s), a click or typing in the past tense;
  viewers (`pointers.list`, `pointers.changed`) get points under 15 s only. Every `computer.*` result names the person's
  pointer with the helper's idle time and the top-level window under it ("rests on window "Figma – Landing", last move
  40 s ago", `screen-pointers.ts`), read once per result only while the helper already runs and has no other request in
  flight (`pointer-input.ts` `counted`; meanwhile the last line stands). **The AI cursor on the screen** (Windows,
  `main/screen-cursor.ts`): `pointer-input.ts` names each planned path on `screen:local` before the helper replays it,
  and main draws the shared AI cursor (§10) gliding with the real pointer in one transparent, click-through, never
  focused, untitled window per display (content protection keeps it out of screenshots), opened with the first agent
  move there, hidden 5 s after the last move and closed 5 minutes later; the OS pointer itself still moves. Not on macOS
  (no driver) or Linux (the helper's app-window guard would count the overlay).
  Desktop broker (Windows, elevated installation/reconciliation by `resources/broker/install.ps1`, protected-store contract in section 1): the service `AutarkDesktopBroker` (LocalSystem, Session 0, `resources/broker/Broker.cs`) starts a worker with its own SYSTEM token in the console session (`Worker.cs`), which serves the same helper protocol on `\\.\pipe\AutarkDesktopBroker` (ACL SYSTEM + installing user, key in `%ProgramData%\AutarkDesktopBroker\broker.key`, typed text sealed) and runs every request on the current input desktop (Winlogon/UAC included); its C# is the helper's own, cut out of `windows-helper.ps1` by `resources/broker/build.ps1`. `drivers.ts` takes it at each helper start when its pipe is listed (`computer/broker.ts`), else PowerShell; the screenshot text says when the secure desktop is shown. The start-time setup (`main/broker-setup.ts`, PowerShell 5.1 hidden but never detached and without an inherited PSModulePath) reports installed (an exit 0 only once the read-only `install.ps1 -Check` confirms it), declined (exit 1223) or failed to the runtime as the sticky event `broker.setup`; while the broker does not serve, `computer.screenshot` on Windows names that reason and the exact install command.

**The meeting server is the meeting point (18.11.2026, owner: "only to meet, everything else directly between the
devices").** Ways between two linked devices, in order: a stored or meeting-seen address (LAN, Tailscale, a mapped
port); WebRTC through both NATs, agreed on through the server (phones: `rendezvous/rtc.ts` inside the phone's tunnel
channel – Android natively, the iPhone web app with the browser's RTCPeerConnection, `ui/hosted/rtc.ts`; PCs: `rendezvous/pc-rtc.ts` – the dialer's first sealed tunnel frame is `{t:'rtc-pc', op:'offer'}`, the
receiver answers, the tunnel closes once the data channel opens and the mesh runs its pinned handshake over it,
`reach.ts`/`mesh.accept(socket, expect)`; a PC that failed goes straight to the tunnel for 30 min); the encrypted
tunnel as the last fallback. The server (`services/remote-relay`) gives tunnels a daily budget per device key, per
source and in total (`RELAY_TUNNEL_BYTES_PER_DAY` 256 MiB, `…_TOTAL` 10 GiB) and has an emergency stop
(`RELAY_TUNNELS=off`); past a budget or while stopped a tunnel opens only as a 64 KiB signalling tunnel (one per
minute), so direct paths can still be agreed on. The client marks this as `RelayState.held`; Settings › Devices ›
Connection says how devices connect, links openautark.com/privacy/#meeting-server, and "Your own meeting server"
(`ui/settings/own-server.tsx`) gives the line that runs the shipped `app/meet.mjs` and the container from the public
source. A phone gets an agent's status changes without its SYSTEM.md (`rpc/scopes.ts deviceAgent`), and a new step note
is `agent.activity` only (`org/service.ts setStatus`) – before, that resent ~27 KB per step, ~1 GB a day to one phone.

**Still to build** (the owner's device design, not done): an employee's phone attached to the employee's PC (owner
addendum, "only if simple").
Not live-checked: the whole device area, the sync between two real PCs (live work, request mirror included), the direct
phone path, the employee push and the HTTPS route via `tailscale serve`.

## 9. Voice, media, calls

* **One dictation path** (`ui/lib/dictation.ts`, desktop and phone alike): the microphone (`microphone.ts`, 16 kHz
  through an audio worklet) → the take as a 16 kHz mono WAV → `files.upload` → `voice.transcribe` → editable text at
  the caret. Once the ChatGPT plan heard the last piece (`by: 'plan'`, remembered in localStorage
  `wf.dictationPlanHeard`), pieces go up compact as Ogg Opus at 24 kbit/s (`ui/lib/ogg-opus.ts`: WebCodecs encoder plus
  a minimal Ogg writer; WAV again on any other answer or where the encoder is missing), about a tenth of the bytes;
  the plan gets them unchanged as one request. The composer's mic, the feedback cell's hold-to-talk and the Tasks page's input line use it. While this PC's first speech
  model downloads, the mic says "Speech model downloading NN %" and waits. Main has no voice code; it only arms the
  microphone for 15 s per request (`bridge.armMedia`, `main/security.ts`).
* **Transcription** (`voice/transcribe.ts`), one fixed order: a dictation goes first to the person's ChatGPT plan when
  its login is here (B-092: the login `accounts.list()` names – a Codex plan, enabled, signed in, an 'ok' one first – so a
  used-up week or a cooling account no longer switches hearing to the slow lane) (B-088, `voice/plan-transcribe.ts`: one request to the Codex app's own dictation endpoint, the take
  as stored – WAV or Ogg – and nothing else; the log lines carry its bytes and format), then this PC's local model (sherpa-onnx: FastConformer,
  Canary, Parakeet – `voice/local/*`) → the `routing.functions.stt` endpoint (learned words as prompt) → a free
  listening model (`listen-transcribe.ts`) → a "not set up yet" text. Long recordings are cut at quiet moments
  (`transcribe-endpoint.ts`). The recommended local model downloads by itself at the first start
  (`voice/local/auto.ts`). Learned words are the plain list `voice.vocabulary` in `settings.json`. The person
  (Settings › Voice), the main AI (skill `app-settings`) and the subconscious (`voice.words`, §5.4) add to it; the
  transcription endpoint, realtime voice and the call talker use it; this PC's local models and the listening fallback
  do not. Local speech
  output is Supertonic, voice activity Silero.
* **B-082 – dictation over the Codex plan, hidden marks, nothing lost.** With a Codex plan the hear thread and the merge
  helper run on gpt-6-luna, low (`engines/codex/helper-thread.ts`); the plan voice meter counts session time, silence
  included. `voice.transcribe { fileId, language?, chatId?, before?, live? }` answers plain text + `marks` (SpanMark[]),
  plus who heard it (`by`: plan, local, service or listener) and `planMissed` when the plan was asked first and gave
  nothing – then the take shows one info line ("ChatGPT dictation was not reachable", 16.11.);
  inline ⟦?…⟧ exists only inside the hearing and in the agent's view. A message body is plain; unsure/dictated spans
  travel as `meta.marks` (`shared/voice/marks.ts`, checked by `cleanMarks`, dropped on edit and on condensed/search
  copies); `context/render.ts agentBody` writes them in for the agent (also mid-turn, `agents/dispatch-steer.ts`),
  MARKS_LEGEND once. The composer keeps them in `Draft.marks` (`composer/draft-marks.ts`), paints them behind the
  textarea (`MarkLayer.tsx`) and edits them in a popover (`MarkMenu.tsx`). Capture: `ui/lib/take-pieces.ts` cuts a take
  at pauses, each piece heard at once with the earlier text as `before`; `ui/lib/take-store.ts` holds pieces whose
  upload failed (IndexedDB, `held/<key>` chips); a failed take is an audio chip (play, Transcribe again, delete); a
  failed sent recording is heard again with `voice.retranscribe` (`rpc/handlers/voice-retry.ts` → `media/dictation.ts
  retry`); `ui.state.draftFiles` brings a draft's files back. Spoken conversation: `ui/lib/turn-detect.ts`
  `createTurnDetector` (32 ms frames, level + noise floor + spectral flatness; Silero/Smart Turn plug in as
  TurnModels), 300 ms pre-roll WAV per line, `live: true` (no local model, no merge); an unheard line goes as its
  recording and the conversation goes on. The correction and listener prompts (`voice/correct-dictation.ts`,
  `shared/voice/marks.ts`) are English and first person since 16.11.
* **Recording into a message** (16.11.2026, F23; `ui/chat/composer/RecordBar.tsx`, `record-take.ts`): Plus › Record
  audio opens one bar of fixed cells above the field ([status] [Retake] [primary] [×], 36 px, 40 px on phones) that
  records at once; Stop uploads the take (`uploadMedia`, chunked, ≤ 300 MB) as a chip, a failed upload keeps it with
  Attach and Retake, and an unsent take comes back when the chat opens (IndexedDB `compose:<chatId>`); Send waits while
  this chat's take records or uploads. On a touch device in the PWA or the app, Take photo and Record video are file
  inputs with `capture` (the Android app opens its camera); on the desktop Record video opens a camera bar with a live
  preview, Record and Photo. While it records, the status cell shows the words heard so far and from 8 words the pace
  (`ui/blocks/ui/live-words.ts`: the recorder's own stream – `microphone.ts` option `stream` – feeds a second Dictation
  whose pieces of 1.5–3.5 s go to `voice.transcribe` `live`, about 1–4 s behind). The `record` widget shows the same
  line, and its teleprompter follows the speaker when it carries a script (`prompter.ts` `followScript`, `prompterPace`;
  the heard word coloured through the CSS Custom Highlight API, so nothing moves).
* **One voice mode** (`shared/voice/conversation.ts` `VoiceSessions`, page side `ui/chat/composer/voice.ts`,
  `pwa-conversation.ts`): utterance → `voice.transcribe` → `messages.send` (marked spoken) → the reply is read aloud →
  listen. Up to three chats at once over one microphone: the chat started or focused last listens; replies are read
  one at a time (another chat's with its title in front); talking over a reply interrupts it. On the phone, hiding the
  page ends voice; the desktop window keeps talking when minimized. Since B-092 nothing said is lost: the capture keeps
  taking while a line is heard or a reply is read, uploads each take at once and hands them over in the order said, and
  the loop holds an utterance that arrives meanwhile and sends it as the next line (`ui/chat/composer/conversation-audio.ts`,
  `conversation.ts drainHeld`).
* **Calls** are this voice mode started from the chat header's Call cell (`ui/chat/call/CallHeader.tsx`) or by taking
  an agent's ring (below). With
  `settings.voice.realtime` 'auto' it first tries **realtime voice** (`runtime/calls/realtime/*`: OpenAI GA or an
  OpenAI-compatible account with a realtime model; one session per chat, keyed by the device, that opens or joins the
  device's call; quiet transcript lines; `hand_over` gives the agent a full turn and the voice tells its written answer;
  ends on idle, maximum length or the device leaving) and falls back to the voice loop. Default 'off' (billed per minute).
  B-066: **Gemini Live** is the second realtime engine (`calls/realtime/gemini-live.ts`, its own WebSocket protocol, key
  in a header; checked against a fake socket only). Without a realtime model the **call voice** (`calls/talker.ts`,
  `voice.talker`, default on) speaks for the agent while the agent keeps working. **Since the KI-Runde (17.11.2026, B-092;
  measured before: one cold JSON call per spoken line, p50 3.9 s on Luna and 10.8 s through a fresh Claude process, 37 %
  past the 12 s deadline, nothing spoken before the whole answer existed) the voice is ONE kept session for as long as the
  call runs** (`decision/engine-runner.ts createChatOpener` on the helper lane – the fastest small model that can run now –
  at the lane's lowest effort 'low', thinking on): opened when the call starts or is taken (`CallLog.onStart` →
  `talker.started`; `Engine.keepOpen` starts the Claude process, the Codex app-server is warmed), so the first line does not
  wait for a process; on Claude Code one kept `claude -p` stream-json process per call that takes one user message per
  spoken line (`engines/claude/kept.ts` ClaudeKept, `--no-session-persistence`; a stopped line is interrupted inside it, an
  idle one closes after `IDLE_MS`), on Codex a kept lean helper thread, on an HTTP engine the call so far as text in front of
  each line (at most 24 entries, 8,000 characters). Lines run one after another; a line cut by a barge-in or the call's end
  keeps the session; a Claude process that is gone answers 'conflict' and the line runs once more on a new session with the
  call so far in front; a lane that runs out is tried once on another account, and when none can run the line fails as
  `unavailable` and the call hears so (below). Its **stable part** (cached for the call, `talker-prompt.ts voiceSystem`):
  who I am (identity, first-name line), how I speak on a call (`CALL_VOICE`: heard, not read – one or two short sentences,
  the answer first, no lists or spelled-out paths; what I do not know I do not guess but pass on; a line not for me gets
  silence), and what my main work knows now: `agents/<id>/last-run.md`, my open tasks with their state, the live bar's line,
  the chat's last lines (a paused agent's voice is told the work is paused; the team text names who rang). The answer is
  plain text, read aloud **sentence by sentence** as the model writes it (`calls/voice-row.ts`: the row stays `streaming`
  until the answer ends; `shared/voice/conversation.ts` reads the completed sentences of a streaming row of the call voice;
  `conversation-parts.ts sentencesDone` ends no sentence at "z.B.", "ca.", "Dr." or a dot a lowercase word follows; the final
  answer is not cut). Nothing, only whitespace or `<silent/>` is silence (18.11.2026: an answer that holds the tag says
  nothing, names nobody and passes nothing on; a row it had opened is removed). **Tags** end the answer and are never spoken – also when not
  closed or closed with other words (`calls/voice-text.ts`): `<main now>…</main>` is steered into the agent's running turn
  wherever it runs (it cuts that turn only where the engine cannot steer, `dispatcher.urgent`; it also ends a waiting
  split, §4.5), `<main next>…</main>` goes through `steerRelay(…, 'next')` to the running turn's next model request, an idle
  agent gets it as its wake's note; a steered hand-over is journaled with its text and kept in the ledger, and it names the
  call's chat (lines posted there are read aloud); steered into a turn in another chat, the call's chat gets its wake too.
  In a call with several agents the answer opens with `<as name="…">` naming who speaks; without it nobody does, and what
  nobody says but passes on still goes on. A run of the agent that ends during the call and a quiet line of its work to the
  call's chat are one input each (at once when the voice is free, else with its next input), and the voice says of them
  what fits, or nothing; what the work posts aloud to the call's chat comes with the voice's next input, so nothing is said
  twice. The main AI's line addressed to the call's chat while the call runs is spoken as written (`context/speech-notes.ts`
  tells the turn it is heard). **The end of a call** (`CallLog` end → `talker.ended`): with the whole call in its session the
  voice names, per agent of the chat, whether the call holds something that agent acts on (read tolerantly – bold names, a
  role in brackets, a dash for the colon); those agents get one wake with the call's lines as one block (`CALL_WAKE`; 18.11.2026:
  the wake names what the verdict said that agent acts on – `callWake`, flat, cut to 300 characters; a verdict in the form
  of silence wakes nobody; one log line `call end verdict` holds counts only), the
  others find the same block at their next turn (`agents/turn-finish.ts` notes); a verdict that cannot be read wakes the
  agents who took part; a call that left this PC (taken elsewhere, its row deleted) only closes its session; no process
  outlives its call (`purgeHistories` closes an account's kept processes). Its line is stored as the agent's
  (`meta.call.voice 'talker'`); a spoken line stored quiet still counts as awaiting an answer (`agents/publishing.ts`
  `awaitsAnswer`). **Who speaks** (`talker.ts voiceOf`, B-092: every call has a voice): the agent who rang this call; else
  `voiceAgent` (`calls/realtime/setup.ts`: the chat's one agent; in a default 1:1 with more agents by now, the agent of its
  pair); else the chat's lead; else the first agent – in a chat with several agents that is the team form: one speaker,
  every other agent listens, and a listening agent whose work a line concerns can speak (`<as>`; it joins the call,
  `CallLog.join`, `record.agents`); the device's reading voice says the speaker's name when the speaker changes; a line that
  @mentions someone outside the call goes the normal way. Realtime voice speaks as one agent and refuses a group chat or a
  team ring (`realtimeAgent` throws `unavailable` before anything is taken), so the voice loop carries it; with a call id it
  takes the call only once its provider is open. **No silent call** (`calls/no-lane.ts`): when no model can run the voice,
  the call gets a system line at once, spoken – no model can answer right now, the answer follows (German when the profile
  language is de, else English) – once per call, waking nobody; the person's line still goes to the agent's delivery. **One
  log line per call turn**: the page measures end of speech → heard → first word → first audio (`ui/chat/call/turn-meter.ts`)
  and sends `calls.turn`; the runtime logs 'call turn' with callId, device, heardMs, answerMs, speakMs, heardBy, answeredBy
  (talker / turn / program) and model – numbers only. The texts these models read speak as the agent. **Driven from
  outside** (`.local/ki-runde-20261117/calls-rig/`): a whole call over the RPC surface an outside system would use –
  `calls.start` → `files.upload` (WAV) → `voice.transcribe {live}` → `messages.send {speech: {source: 'endpoint', live,
  call}}` → the answers as they stream → `calls.end`; on the fake engine the voice answered all ten lines; its README says
  what a phone bridge has to do itself.
* **A call is one row in its chat** (B-075; `runtime/calls/call-log.ts`, `shared/model/call.ts`; owner 04.11.: a call
  log as a bubble): the PC of the device the person calls from writes one quiet status row per call whose `meta.call`
  is a `CallRecord` {id, participant `device:<key>`, name, pc, startedAt, endedAt?, lines: [{at, from, name, text,
  messageId}], ring?, agents?}. `calls.start {conversationId, callId?}` → `{callId, holder, say?}` opens it or returns
  that device's call open there (with `callId` it takes that call, below);
  `calls.end {callId}` (its own device only), the device's connection closing or the runtime stopping end it – a call
  left open at a stop ends at the next start at its last line (`calls/wiring.ts` `endCallsLeftOpen` →
  `CallLog.endLeftOpen`, §4.1), so the end travels; open
  calls are kept in kv `calls`/`open`. While a call is open every final line after its row is appended – the person's
  lines and every agent's answer, also one synced from the agent's home PC; a quiet line only with the call's id (the
  talker's held line, realtime transcripts, the hand-over note with `details.callId`); the newest 120 lines, 1,000
  characters each. A later edit or deletion of a named row updates every call row this PC wrote. `messages.send` stores
  a live line (`speech.live`) of the owner or a device with `meta.call` {id, participant, name} of that device's call
  (`speech.call`, else the one open, else a new one). The voice loop (`shared/voice/conversation.ts`) starts and ends
  its chat's call and names its id on every line; its reply wait goes on while `ConversationSummary.working` is not
  empty (rows that stream, also from another PC), and an agent row that starts streaming later opens it again. UI: the
  row is one bubble (`ui/chat/call/CallTranscript.tsx`) – "Call · HH:MM · m:ss" or "running", an agent's call "Call
  from <agent>" with ringing, missed or declined; open while the call
  runs; the rows its lines name fold into it and show there in full (`message-rows.ts` `callEntries`), every other row –
  a late answer too – stays a row.
* **An agent rings the person** (B-081; tool `chat.call {why, say?, with?, chatId?}`, `tools/builtin/call-tool.ts`;
  `runtime/calls/ring.ts`): the call row is born ringing – participant `agent:<id>`, `meta.call.ring {by, why, say?,
  until}` – in the run's chat when the person is in it, else `chatId`, else the agent's default 1:1 with them, written
  on the PC the agent's turn runs on; `with` brings up to 5 agents of that chat in from the start, and a call that
  already rings or runs there (running: its PC reachable) is returned instead (`already`). It rings `RING_MS` (45 s),
  whatever the chat's notification level: that PC pushes once, urgent, to every owner phone (own and held
  subscriptions, TTL = the ring time; the notice stays until touched and vibrates), every PC rings its window once
  (`host.notify`), and every window shows a status line "<agent> calls · <why>" with Accept (opens the chat and
  answers) and Decline, plus a WebAudio ring tone scheduled once for the rest of the ring (`ui/chat/call/call-notices.ts`
  from `calls.live` – the ringing and running calls, also an event on topic `chats`; a running call only while its PC
  is this one or reachable). A device takes the call with `calls.start {conversationId, callId}` (or
  `calls.realtimeOpen` with `callId`): it answers a ring – the agent's opening line follows – or takes a running call
  over from another device; the row's holder (`callHolder` = `<pc>/<participant>`) writes it from then on, and the old
  holder lets it go without an end (its realtime session and voice loop end with `TAKEN_OVER`). Other devices show
  "Call on <device> · <name>: <last line>" with Take over and Open. `callState` reads ringing, running, missed, declined
  or ended: a ring nobody takes is missed (its writer writes the end at the deadline, one timer per ring) and
  `calls.decline {callId}` works from any device; the PC holding the row then clears the phones' ring notices and, for
  a decline or a missed ring, wakes the agent once with a first-person note. Since B-092 the ring also goes out as a bus
  `notify` of its own kind 'call' (`calls/ring.ts`, `{id, until}`, no toast, once per new ring on every PC; its end sends
  `until: 0`), which the Android app shows as an incoming call notice with Accept and Decline (`CallNotice.java`, Decline
  sends `calls.decline` over the app's own socket, the notice ends when the ring ends anywhere – source only, not compiled).
  The environment's "Calling:" line names
  the option where `chat.call` is offered; `team-coordination` ("Reaching the person") and `design-together` name it
  too. An employee's seat PC neither rings nor lists the owner's calls; ringing an employee is not built yet.
* **Media** (`runtime/media`): a library row (+FTS over name, description, tags) for every stored file, one probe lane
  (size, duration, pages); `media.search/describe/uses/delete`. Generation of images, speech, music, sound effects
  and video through the function models (`generate.ts`: OpenAI-compatible, Gemini, ElevenLabs, fal.ai, images on the
  ChatGPT plan via Codex, local speech). Seeing and hearing: `media.view`, `look` (keyframes from main's analyzer
  window), `listen` (local hearing report with sound tagging – CED Mini, `sounds.ts`), `transcribe`.
* **Feedback** (`ui/feedback`, `runtime/feedback`): the frame's feedback cell (on the phone on every top row,
  `ui/feedback/cell.tsx`; drawn above open dialogs at the same spot, §11). A press – a click, Ctrl/Cmd+Shift+F
  (`shared/api/workspace-browser-keys.ts` `FeedbackKey`, read by main in the app page and in every side-browser page,
  IPC `feedback:key`, `ui/feedback/press.ts`) or in the Android app volume up + down together – takes a fresh snapshot
  and freezes the window in the **snapshot overlay** (16.11.2026, `FeedbackOverlay.tsx`: a modal dialog above every
  other, the side browser's native view hidden under it, the shot at 1:1 with a transparent canvas on top – Pen, Box,
  Undo – and a slim dock at the bottom, `FeedbackPanel.tsx`: Screenshot box, Recording and crash rows, the field with the
  mic, Send or Save, the privacy line); holding talks. The report image is the shot flattened with its marks at Send.
  The Android app gives the shot natively over its port (`requestNativeShot`, app 0.3.15); the iPhone web app and
  browsers lay the dock over the live screen with "Add photo". Dictation in the form keeps its recording (`recording.ts`,
  WebM Opus 12 kbit/s, MP4 on the iPhone; up to 4 takes, sealed with the report when they fit, else the warning
  `AUDIO_DROPPED`); an Android crash report rides as `clientDiagnostics`; every report carries its origin line `client`
  (`ui/feedback/client.ts`). The page writes each report into an outbox first (`ui/feedback/outbox.ts`, IndexedDB by
  `clientId`) and flushes it on reconnect; `feedback.create` returns the stored report for a known `clientId`, and a
  person's report needs no `kind`. The report is sealed for the team's key and dropped into the team's Firestore mailbox
  (`delivery.ts`, `seal.ts`); the PC sends its unsent human reports again at start and 10 min after an offline, timeout
  or server failure (`FeedbackService.resendPending`); `/feedback <text>` in a chat sends at once. A confirmed send
  closes the form and shows "Feedback sent · No. XXXXXXXX" in the status line. **The mailbox keeps its letters**
  (16.11.2026, `inbox.ts`): every PC and company holding the team key gets every letter – fetched at start, when the
  inbox opens, on Refresh and by `wf feedback receive`, never on a timer – and stores it with its screenshot and
  recordings in `<data>/feedback-inbox/`; a letter leaves the mailbox only when the team removes the report, its mark's
  keep time passes, or it is older than `LETTER_TTL_MS` (30 days, by Google's createTime; an old letter not here yet is
  stored first). A removed report leaves an `<id>.gone` tombstone, and letters this key cannot open stay (up to 20, a
  copy under `unreadable/`). The team reads them in Settings › Feedback › Inbox (`FeedbackInbox.tsx`, owner-only
  `feedback.inbox*`; `feedback.inboxAudio {id, index}` plays a recording; the meta line names PC, company folder and
  "dictated") or with `wf feedback list [--open] | show <no> | mark <no> done|irrelevant|open`; opened letters are
  checked by `letter.ts` `itemOf`. The form shows the data summary and full `FeedbackPrivacy.tsx` notice before Send.
  Canvas export keeps the flattened JPEG within 600,000 image bytes; an oversized complete envelope stays local rather
  than dropping its screenshot. A send that is not confirmed leaves the report saved on the PC, and the form's action
  cell then reads "Send again" (the same saved report with its screenshot goes out again).
* **The always-on bubble and calls that keep going (19.11.2026, `.local/blase-call-20261119/`):**
  * Windows bubble (`main/float-bar*.ts`, `float-bar-place.ts`): right-click → Hide (`float-bar.json` `hidden`), back
    with Ctrl+Alt+N or the tray. One automatic screenshot per draft (only while the draft has none). "Call" starts the
    call in the main page without showing the window (navigate + `callRequest`); the bubble turns into a pill (who,
    Open, End).
  * The page reports live voice (call, conversation, dictation, recording; `ui/boot/voice-live.ts`):
    * Electron: the preload's `voiceLive` makes main lift background throttling (`window.ts`). X during live voice only
      hides the window; the close runs when voice ends (`main/window-voice.ts`). Quit, update quit and Windows session
      end let go first.
    * Android app: native-port `{t:'voice.live', on, kind}`; `KeepAlive` turns into a microphone foreground service
      with "Call running · End" (`{t:'voice.stop'}` back to the page). `MainActivity` leaves the WebView unpaused.
      Only a page without the native port (iPhone web app, browser) still ends its conversation on hide.
  * Android bubble (`phoneuse/TodoButton.java`):
    * Hidden by dropping it on a ✕ at the bottom. Back by pulling the round icon left of a tab's title out of the
      app's header (`ui/pwa/bubble-handle.tsx`, `bubble-pull.ts` → `bubble.pull/move/drop`, `NativePort`,
      `phoneuse/BubblePull.java`). One bubble at a time.
    * The call runs in the bubble with no app (`phoneuse/BubbleCall.java`): SpeechRecognizer → first line via
      `tasks.quickCreate` (routing) → `calls.start` in the agent's direct chat → lines as `messages.send` with speech
      meta → agent rows of `chat:<id>` over `UseLink` read by `PhoneSpeech`.
  * Several devices in one call (`CallRecord.joined`, `calls.start {join:true}`, `runtime/calls/call-row.ts`):
    * Every joined microphone feeds the call, and only the device that heard the newest line reads the reply.
    * Only the holder PC writes the row; join and leave travel as quiet chat notes.
    * Only the holder PC's talker answers; a guest PC relays lines (`meta.call.relay`).
  * Voice: Silero + Smart Turn are fetched on every PC (`ensureTurn`). The PC's local voice reads for every device
    without a choice and is fetched once with ≥ 3 GB to spare. A sentence > 1.5 s late goes to the device voice.
    sherpa audio is copied out of external buffers, which Electron refuses (`voice/local/engine.ts`, `addon.ts`). The
    phone voice prefers Google's engine and its best offline voice.
  * The talker stays gpt-6-luna at effort low without a service tier. Measured: low used 0 reasoning tokens, and fast
    did not change the first token. Prompt `CALL_VOICE`: speech is heard once.

## 10. Browser, the global pane and the areas

**The person's browser** (desktop only): `main/workspace-browser.ts` hosts native website tabs
(`WebContentsView`) in a separate persistent session – sandboxed, no preload, no Node, no runtime access. Tabs live in
spaces in `<data>/side-tabs.json` (`workspace-tabs.ts`: `{version:2, spaces:{global, "chat:<id>", "agent:<id>"}}`;
main reloads it when an AI or an editor writes it; a tab not shown is only an entry until used). **One shown tab per
space** (`workspace-shown.ts`): the global pane, a chat's area and an agent's area each show their own native page at
the same time; `show {id, bounds}` replaces only its own space's tab, `hide {id}` takes only that tab off its slot, a
window resize or reload hides all; the side driver's "the person looks at it" is per space. Tabs on a slot plus the last
tab of the two spaces shown last stay loaded; **preview tabs** (`workspace-marks.ts`, with the background and opener
marks): a page an agent opens goes into its preview tab in that space and its next page replaces it (unless `newTab`);
the person's click or key in it, their own address, a double-click or "Keep tab" keeps it (command `keep`); its title is
italic; the mark is not saved. Every new-tab path (window.open, the page menu, an agent) is one `openTab()`.
A tab hidden for 20 minutes gives its page up (`workspace-discard.ts`); a page an agent uses while nobody looks lives
in `workspace-host.ts`, an invisible unthrottled host window (pages nobody sees draw nothing and take no clicks,
measured 02.11.), at most 5 live pages (LRU); downloads go to `<workspace>/downloads/personal`
(`workspace-downloads.ts`); find in page and the browser keys (`workspace-chrome.ts`); history with search
(`workspace-history.ts`, `<data>/browser-history.json`, no address with a credential or token), recently closed tabs
and zoom per site (`workspace-tab-memory.ts`), favicons (`workspace-favicon.ts`). Site permissions follow one fixed rule, nobody is asked: a page's own site may use camera,
microphone, notifications, fullscreen and clipboard writes; everything else is refused (`workspace-session.ts`). The
page's right-click menu is native (`workspace-page-menu.ts`: Back, Forward, Reload, Open link in new tab, Copy link,
Copy, Paste, Send page to chat, Inspect). IPC contract: `shared/api/workspace-browser.ts`.

**The same pane on every linked PC and on the phone** (B-076, owner 05.11.: "ziemlich das exakt dasselbe … auch auf dem
Remote-PC", "auch am Handy"):

* **Tabs travel** (`runtime/devices/sync/{tabs,tabs-map}.ts`): one sync unit per space (`global`, `chat:<id>`,
  `agent:<id>`), last writer wins, CEO links only, sent at each link-up. The runtime watches `side-tabs.json` through the
  data-folder watcher, writes what it receives with `writeAtomic`, and main follows by itself. The link-up sends the side
  pane first (before rows, secrets, files and logins); a PC that just joined keeps its own pane changes at stamp 0 until the
  other PC's pane has arrived, so the existing pane wins; a close made here survives a newer copy from elsewhere; a path tab
  too long for main's limits stays on its own PC. Each PC alone decides about
  its own websites: on another PC they are `{"id":"remote:<device>:<tab>","panel":"remote","device","tab","url"}` (no title
  in the file – the live state brings it; an address over 1,500 characters travels as its origin)
  panels, which may be reordered or closed there (a close travels back in `closed` and closes the real tab), never opened
  or re-addressed. File, folder and media-by-path tabs of another PC carry `device` (id `file@<device>:<path>`).
  Unchanged content sends nothing. A website of this PC or another (a `remote` panel) leaves main's spaces only by a
  close – the window's `close` command to main (also for `remote:<device>:web-…` ids; on the desktop the tab leaves the
  strip once main answers, on the phone the close goes to its PC in its layout, `tabs.set`) – or by the file itself;
  main remembers the last 100 ids it closed (`PersonalTabs.gone`, `main/workspace-tabs.ts`) and never takes one back
  from a later file or window layout. The window's layout only orders websites and remote panels: it never adds or
  drops one. Quitting the app and a PC going offline close nothing.
* **Files live where they came from** (`devices/sync/paths.ts`, mesh `files.path`, CEO only): `files.readPath`,
  `writePath`, `listPath` and `uploadPath` take `device` and run on that PC (stamp conflicts unchanged; an offline PC
  answers at once "<pc> is offline."); a media file is stored on its PC and its `files` row comes back, the bytes are
  pulled on first view (`needBlob`). The four methods are open to the owner's paired phones on a secure transport
  (`manage` + `secure`; `side.*` need `todo` + `secure`; `tabs.get`/`tabs.set`/`tabs.position(s)` and the events
  `tabs.changed`/`tabs.position` need only `manage`, so over plain LAN http a phone sees and changes the pane but gets no
  file content and no live picture – the file tab says "Open the HTTPS address to do this."); a save over
  7 MiB to another PC is refused before sending, a larger read answers `large` (one mesh frame is 8 MiB). A path that
  holds nothing answers `near` (B-081, `runtime/files/near-paths.ts`: up to 5 similar existing paths, best first, the
  nearest existing folder last), found on the PC that holds the path – a linked PC's answer travels unchanged – for
  the tabs' not-found page (Tab kinds, below). Op `root` gives a linked CEO PC's `<data>`, workspace and map
  (`system.root {device}`); the new-tab page's Files row has one cell per linked CEO PC (`ui/workspace/linked-pcs.ts`;
  `publicDevice` keeps `Device.joinedAs`) that opens that PC's data folder. The three-dots menu of a file, folder or
  media-by-path tab has "Open on" – This PC and each linked CEO PC, the current one ticked, "Offline" as a hint – and
  opens the same path there in the tab's place (`file-tabs.ts` `openPathOn`). A file of a linked PC offers "Show a copy
  here" on the desktop: the PC that holds it stores it (`files.uploadPath`), then `files.open` with `reveal` shows a
  copy in the runtime's temp (swept after a day); on the phone every file offers "Save to phone" in the app or
  "Download" in a browser (`file-tabs.ts` `saveHere`, `media-save.ts`).
* **The view position** (`devices/sync/positions.ts`, `ui/workspace/view-sync.ts`): the scroll fraction (FolderView),
  plus the top line (FileView) or the video second (MediaView), at most one report per 300 ms per tab, the person's own
  scrolling wins for 1 s, received moves report nothing back; kept in memory (200), never in `side-tabs.json`. RPC
  `tabs.position`/`tabs.positions`, event `tabs.position`.
* **A remote website is live** (`main/side-driver/caster.ts`, `runtime/browser/side-view.ts`,
  `runtime/devices/side-view.ts`, `ui/workspace/RemoteWebTab.tsx`): the PC that owns the tab casts it with a DevTools
  screencast on the tab's own CDP connection (JPEG 60, ≤ 1280 px, ≤ 1 frame per 100 ms, the page kept loaded while
  watched, a cast ends 60 s without renewal); the viewer pulls frames (`side.pull`/`side.pullPart`, parts ≤ 1 MiB, ≤ 10/s
  on a PC, ~3/s on a phone – `SIDE_PC_FRAME_GAP_MS` 100, `SIDE_PHONE_FRAME_GAP_MS` 300; agents' own browsers keep their
  gaps) and sends input (`side.input`: only `Input.dispatchMouseEvent`, `dispatchKeyEvent`, `insertText`,
  mapped onto the newest frame with the page's zoom; counted as the person's own, so agents wait) and navigation
  (`side.nav`). With `device` the RPC goes over the mesh to that PC (CEO links only, not an open method); without it, this
  PC. The page loads, sends and keeps its logins only on its own PC. The tab glows blue (an inset ring, `--remote`) and
  names its PC ("on office-pc") in a fixed cell of the usual address row (Back, Forward, Reload, PC, address, Go,
  pane menu); an offline PC shows one calm line and is tried again every 5 s, and taps while this device is offline are
  dropped, not replayed. The picture takes the keyboard only on a click (`BrowserSurface` `autoFocus={false}`), and the
  pane's tab shortcuts stay the app's. A page's alert/confirm travels in the state (`dialog`) and is answered from the
  viewer (`side.nav {dialog: accept|dismiss}` → `Page.handleJavaScriptDialog`); input meanwhile is refused at once. A
  tab whose window on its PC is minimized or hidden moves to the off-screen host so it keeps painting
  (`workspace-shown.ts` `painted`); watching is no agent use, and the page leaves the host when the cast ends unless an
  agent used it lately. **Viewer-sized page** (B-081): every `side.pull` names the viewer's picture box (`view`, whole
  CSS px 200–4096, a ResizeObserver on the picture; a changed box pulls at once). While cast, a page on the off-screen
  host has that box as its real size (`PageHost.size`, `workspace-host.ts`; the host window grows to hold its largest
  page) – the box set last by the callers still watching (`viewOf`); when that caller stops watching the one before
  takes over at once, and with none left, or at the cast's end, the page gets the host's own 1280×800 again. A page the
  person shows in their own pane keeps the pane's size (the viewer letterboxes it). A DevTools viewport override was
  tried first and measured on 08.11.2026: its frames kept the view's own landscape box, so it is not used. The one frame
  right after a resize still has the old shape; the caster drops a frame whose JPEG shape differs from its metadata
  (`cast-params.ts` `frameFits`). If the host shows the tab too: a press there (`SideTab.localPress` on a click's up or
  a key, not within 1 s of the watcher's own input) gives the page its own size back `GIVE_BACK_MS` (500 ms) later,
  never between down and up, and the end of the watcher's next press takes the box again. Agents' screenshots stay
  `capturePage`, which then has the box's size. A
  PC from before B-081 refuses `view` once and is then pulled without it (`refusesView`). **Input pipelined**: the
  remote view keeps up to 8 inputs on their way (`createInputSender` window, `REMOTE_IN_FLIGHT`; 1 elsewhere); moves and
  wheel turns merge while one is unanswered, presses and keys never, and the order holds because every hop is FIFO. A
  watcher's input passes this PC's Pin picker (`SideTab.holdPicking`). Remote tabs keep the last picture of the 6 shown
  last (`browser-feed` `keep`) until closed, so a switch never shows an empty field.
* **The phone** (`ui/workspace/phone-tabs.ts`): its pane reads its PC's spaces (`tabs.get`/`tabs.set`, event
  `tabs.changed`) instead of keeping its own; the PC's websites are remote tabs there (the first real website view on the
  phone), files show with content, and what the person does goes back to the PC; a sign-in that must run on the PC opens
  in the PC's pane (`side.open`, §8) and the phone's sheet shows that tab. **The phone viewer** (B-081): the
  picture zooms as a view over its box (`ui/workspace/view-zoom.ts` `{s, x, y}`, the img translated and scaled around
  its top-left, 1–4×; clicks still map through its drawn box): the Zoom button sets 2× around the centre or 1, two
  fingers pinch (below 1.02 it settles to fit only when the last finger lifts), one finger pans the zoomed picture to
  every edge and scrolls the page with the rest; the surface owns every gesture (`touch-action: none`). On a touch
  screen a fixed toolbar cell between the PC mark and the address switches touch and touchpad mode, kept per viewer in
  `localStorage` `wf.remote.inputMode`; touchpad mode (`browser-pad.ts`, like AnyDesk) draws a cursor on the picture
  that one finger moves relatively with a mild speed curve – a tap clicks at it, a quick second tap double-clicks,
  tap-then-drag holds the button, two fingers scroll at the cursor or pinch, a two-finger tap is a right click. After a
  watcher's press ends, main asks the page whether its focus takes text (`__wfSide.editing()`); each yes is a new stamp
  (`SidePage.editing`), and the phone focuses its hidden key field – the keyboard opens – when a stamp comes within 2 s
  of its own tap (Type blurs and focuses it again, so it always brings the keyboard back). While that field has focus,
  a box that only got shorter is not sent, so the keyboard does not re-lay out the PC page.

**Three surfaces, one workspace component** (`ui/workspace/WorkspacePane.tsx` on a space; its parts – strip, address
row, menus, panels – read the space from `space.ts`, and every command in `pages.ts` names its space):

* **The global pane** (`shell/Shell.tsx`, space `global`, global tabs only – the person's own across chats). On desktop it
  lies below the header row with its strip as its first line. Where the row leaves the strip room for three titled tabs
  after the caption controls and the frame's two cells (Shell.tsx measures `.pane-row-room` against `strip-slots.ts`
  `ROW_ROOM` = 358 px: a pane of about 587 px and more on Windows, 449 px on macOS, at its width beside the open
  sidebar) the frame has `strip-in-row` and the pane starts at the window's top: its strip is the title row's part above
  it (header height + 1 px, its foot line continues the sheet edge, its empty room drags the window, right padding for
  the caption, workspace and feedback cells), one 40 px toolbar row follows, a page starts at 89 px. A drag of the pane
  or the window may move the strip between the two places; a click never does. In the phone layout it is a pushed full-screen sheet (`phone-pane.ts`, `MobileShell` `PhonePane`, its
  own row with Close), opened by a way in that lands in global or, in the desktop app, the Browser cell of the phone row.
* **A chat's area** (`chat/ChatArea.tsx`, space `chat:<id>`, shared by everyone in the chat – that chat's work, its
  pages, files, folders and media, goes there): a fold-out part of the
  chat directly above its messages, the first child of the chat column under the chat header; a fixed clamp height, so
  header cells and composer never move; the chat's own surface colour, pill tabs and one 1 px line
  (`styles/chat-area.css`) – visibly part of the chat, not like the global pane. The chat header's "Chat tabs" cell
  toggles it (pressed state and a dot); open per chat (`lib/shell-state.ts` `wf.chatAreas`). On the phone it fills the
  chat body above the composer. Chat details (`ChatPanel`) is details only.
* **An agent's own area** (space `agent:<id>`, kept by the agent): the lower half of the agent page's Browser view
  (`team/AgentBrowser.tsx`, two fixed halves), under the live view of the agent's own browser.

Each surface has the same parts. The **tab strip** (`TabStrip.tsx`): tabs with favicon, title and close cell, width
clamp(48 px, room / count, 200 px), re-measured only once the pointer leaves the tabs and "+" (one hold, so a closed tab
keeps its place); below 72 px a tab shows its icon; "+" right after the last tab (at the room's end when tabs scroll);
the agent's avatar only on its own-browser tab, "Opened by <agent>" in the tooltip; "All tabs" with the count in the
one menu (`TabsMenu.tsx`). Under it the **40 px address row** (`BrowserHeader.tsx`): Back, Forward, Reload, on the
desktop the Pin button (below), the address slot (the address alone at rest – the title lives on the tab; the omnibox with suggestions from open tabs – global's
only where a global pane exists – and history on click, Ctrl+L or a new tab, `Omnibox.tsx`; the find field on Ctrl+F;
the path on a file or folder tab) and
one menu cell (`PaneMenu.tsx`: find, zoom, mute, Mark a region into the composer, DevTools, copy address, system
browser, send page to chat, History, Reopen closed tab, Full view, on a path tab with a linked PC "Open on" – per
surface). Back/Forward/Reload are only faint on
a blank or app tab – nothing shifts. Tab rules are pure in `browser-model.ts`. A native page hides only under what
lies over its slot (`native-surface.ts`: a dialog, popover, menu or toast; for a chat's or an agent's area also the
floating global pane, the phone sheet or the chat's details); a status line never hides a page. The frame's feedback
cell sits at the far right (`shell/WindowBar.tsx`).

**The Pin button** (B-081; desktop, the person's tabs of this PC – the global pane and chat areas): a fixed cell in the
address row (`cursor-click`, "Pin an element (Esc ends)", pressed while on – colour only; faint on a blank or app tab)
switches the tab's element picker: window command `pick` → `workspace-chrome.ts` (`picking` on the page entry is the
button's wish, the latest call wins) → `host.pick` → `SideDriver.pick` → `__wfSide.pick` in the driver's isolated world
(`main/side-driver/pick-script.ts`, embedded by `page-script.ts`; top frame only; armed again in every new main-frame
document). While on, a box labelled "tag.class W×H" follows the deepest element under the pointer (elementFromPoint,
into open shadow roots, then the children whose box holds the point; never the cursors' own overlay host), at most once
per animation frame; the left button's pointer, mouse and click events never reach the page, and a trusted press pins:
selector, tag, role, name, own text, box, click point, the edge within 4 px, non-default key styles, up to 2 parent
boxes and a source hint from `data-*` attributes (`shared/model/page-pick.ts` `PagePick`; `pickText` starts "Pinned on
<host+path> (tab <id>):"). Esc ends it, in the page or the app. An agent's act batch and a watcher's input hold the
picker (`SideTab.holdPicking`): that input reaches the page untouched, outline and button stay. Main sends the pin
with the kept address over the key channel (`pick`); `ui/workspace/pin.ts` routes it to the chat of the tab's chat
area, else a chat that talks on this device, else the open chat – a voice call takes it as a line of the call
(`addToCall` → `VoiceSessions.add`), a realtime call as a typed line, otherwise it is a line of its own in that chat's
draft (no chat: a notice). The side tabs' hover reports carry a short selector (`target.selector`) for the person's
pointer line (§8).

**Tab kinds**: a blank tab (the new-tab page lists the panels it can become, `NewTabPage.tsx`), a website tab (lives in
main), and the app's own panels: **Tasks** (the one Tasks page, §4.7), **Activity**, **Notes** (a chat's shared notes,
`NotesView.tsx`/`notes-sync.ts`), **Media** (one stored file or a file on the PC: image, player, PDF head –
`MediaView.tsx`; without a file the searchable library, `MediaLibrary.tsx`), **Video** (a chat's video work with its
versions v1…vN, `VideoView.tsx`, `video-versions.ts`), **Screen** (this PC's live picture while agents use it,
`ScreenView.tsx`), an agent's own browser, **a file or folder** by its path (`FileView.tsx`, `FolderView.tsx` over
`files.readPath/writePath/listPath`; Skills & memory and every settings page open their files here; B-081: a path that
holds nothing shows the not-found page – `PathMissing.tsx`: "<name> was not found[ on <PC>].", the similar paths as
rows that open as what they are in the tab's place, on a file tab "Create <name>" (Ctrl+S makes the file), in a
media-by-path tab without Create – while app-own files meant to be made, Settings and an agent's SYSTEM.md, open
straight into the editor (`openFileTab` `create`); a picture, video, audio file or PDF met as a file has "Show", the
Media tab, also for a linked PC's file) and **custom views**
from `<data>/pages/<name>.html|js` (`PageView.tsx`, `wf-sandbox://page/<name>`, the mini-tools' bridge; `rpc.methods`
lists what they may call). Ways in: the chat header's "Chat tabs" cell (the chat's area), the frame's Browser cell
at the far right (the global pane), a link (`openWebsite`), Chat details › Notes, an image, file or path in a message
(§11), a video (`chat/side-pane.ts`). A way in that names no space lands by one rule (`attention.ts` `setOpener`): on desktop
in global; in the phone layout in the open chat's area, else the global sheet; a panel asked from a tab in the space
that shows that tab. A tab an agent opens in a closed surface lights that surface's cell dot (no dot for an agent's
area). On the phone, files open with the system app.

**Agents' browsers – one tool surface, two transports** (`runtime/browser`):

* **Own browser**: Playwright with one persistent Chrome/Edge profile per agent (`<data>/browser-profiles/<agentId>`,
  its logins stay); runs off-screen, on the headless CLI host and on linked PCs (`service.ts`, `sessions.ts`).
* **The person's browser**: side tabs driven through the host op `sideBrowser` → `main/side-driver/*` over the
  DevTools protocol (accessibility snapshot, human-like steps with the shared motion model, console and network logs,
  wait without polling). An agent-opened tab carries its opener {agentId, agentName, chatId}.
* **The AI cursor** (B-081, `shared/model/agent-cursor.ts`): one look for an agent's pointer on every surface –
  `AGENT_CURSOR`, a rounded arrowhead with no stem in the agent's colour (`cursorColor(id)`), a white outline, a soft
  glow and a name pill beside it that never turns; `tilted(path)` adds a lean of up to 18° from the horizontal speed,
  back to 0 on arrival (the path itself stays the motion model's). Drawers: the side tabs' in-page drawer
  `main/side-driver/cursor-script.ts` (embedded by `page-script.ts`, DOM APIs only; the screen overlay's too, §8) and
  `ui/workspace/PointerLayer.tsx` over the picture of an agent's own browser; people keep a thin plain arrow. Every
  browser act and batch moves like a hand by default (`DEFAULT_MOTION` = `human`, up to 1.4 s,
  `min(1400, 180 + 140·log2(D/W+1))`; 21.11.2026, owner); the agent passes `glide` (≤ 300 ms,
  `min(300, 60 + 50·log2(D/W+1))`) or `instant` (a jump) when a step should be quick – in either browser, the person's
  side browser included (`driver.ts`). Computer use takes the same default. The own-browser picture turns an agent's single-point move into a glide from where it draws
  the cursor now (UI only, `pointer-overlay.ts` `drawnPath`).
* **Where a call goes** (`browser/place.ts`): `where: own|chat|global` decides (own browser, the chat's area, the
  person's pane); else the tab id (`web-…` in any space, `t1` the agent's own); else where the agent worked last in this
  chat (own at first; kept per agent and chat, `placeKey`: a `global` in one chat leaves the agent's other chats where
  they were). `browser.open` and `browser.show` reuse the agent's preview tab unless `newTab`.
* **The pane between people** (21.11.2026, `shared/model/pane.ts`, `runtime/pane/`): a tab runs on one PC – its
  origin – and shows in the panes of the people it is given to; a person sees their pane on all their PCs and phones (a
  person with no PC keeps it on the company's PCs as space `person:<id>`). `targets.ts` names each person's PCs (own PCs
  = this one + 'ceo' links, a colleague = 'employee' links or – on an employee's PC – the PCs company.facts names, the CEO
  there = 'employer' links) and the default PC (the one I am on if it is theirs, else their only one, else one online).
  `put.ts`: **putOn** (Open on: a website loads anew on the target PC; other tabs carry their origin – a path tab names
  its PC), **receive** on the target (mesh `pane.put`, every link kind; a copy naming that PC is its own tab again),
  **shareOn** on the origin with the whole set of people (records `{people, places}` in kv `pane.shares`, puts the tab in
  new people's panes, takes it out of left-out ones via `pane.remove`). `shares.ts reach` is the one check for a call
  from another PC: a 'ceo' link reaches everything, an employee's PC its person's shares, the company's PC the CEO's
  ('owner') or – relaying – a colleague's (`for`); `side.*`, `browser.*` and `files.path` (path inside a shared path)
  use it. `relay.ts callPc`: linked PCs directly, a colleague's PC through the company's PC (`pane.relay`, employee to
  employee only, the pane's methods only, `for` set by the company). RPC `pane.targets` / `pane.open` / `pane.share`
  (`rpc/handlers/pane.ts`); the tab menu's **Open on ›** (every kind, PCs grouped by person) and **Share with ›** (kinds
  with `shareKey`: websites, an agent's browser, file/folder/media by path) in `ui/workspace/PaneMenu.tsx` /
  `share-tab.ts` / `pane-targets.ts`. `browser.show` (`browser/show-tool.ts`) gives a page or the agent's **own
  browser** (panel `{id: 'agent:<id>', panel: 'agent'}`, the live view with Take over) to a person's pane – default the
  agent's manager when that is a person, else the CEO – on a PC (`person`, `pc`), shares it (`share`, `'all'`), puts it in
  a chat's area (`where: 'chat'`, `chatId`) or a page in its own area (`where: 'agent'`); `back` takes its browser out of
  every pane it put it in. A view of an agent on another PC pulls through this PC (`rpc/handlers/browser.ts`
  `browserHandlers` → `devices/browser-view.ts`, caller as `via`, frames ≤ 1 MiB parts, never the real window); the UI
  pulls per browser (`browser-feed.ts`). Panels go into an agent's
  area by the agent writing its `agent:<id>` space in `side-tabs.json`. The full where-hint stands once per turn in the
  environment's "Browser, where:" line and in `browser.show` (the chat's area: this chat's work goes there and everyone
  in it finds it; global: the person's own pane across chats; a login the person makes in one of these tabs holds in
  both; own: the agent's browser with its own logins, and its area);
  no text claims these tabs hold the logins of the person's other browsers – those browsers keep their logins and
  autofill on this screen, and the agent reaches them with `computer.*` from any mode (B-092: no environment line sends
  screen or web work to another mode or agent any more, `context/environment.ts`).
  Secrets fill by id in both; `browser.save_secret`/`save_totp` store what the agent meets (`secret-tools.ts`); 2FA
  setup keys and password values are masked in page text. A human check (captcha) is reported as a fact under every
  page result (`human-check.ts`): in the agent's own browser with the way on through the person's own Chrome
  (`HUMAN_CHECK_NOTE`); in the person's browser – a chat's area, the global pane – with the side note
  (`HUMAN_CHECK_SIDE_NOTE`): the tab is live on each of their PCs and their phone, the agent names the check to the
  person in one chat line and goes on, and the person clicks it in that mirrored tab from any device.
* **Live view and takeover** (this PC only): Team › agent page and browser to-dos show a CDP screencast of an agent's
  own browser (`view.ts`); the person can steer, type and take over (`takeover.ts`: one flag; while on, every agent
  step answers that the person has taken over; handing back wakes the agent in its chat and task; passwords the person
  typed go to the vault). Phones pull frames (`view-pull.ts`).

## 11. UI shell rules

* **One fixed frame** (`ui/shell/Shell.tsx`): rail | side (sidebar: header row + scrolling body, resizable) | main, and
  the global pane at the right – below the main zone's header row, from the window's top with its tab strip in the
  title row only where the row has room for three titled tabs (`strip-in-row`); opening it moves no cell (§10). `shell/views.ts` is the one
  route table (side zone, main zone, phone stack); views hand over content and header data, never chrome. The phone
  layout (`MobileShell.tsx`) is the same frame as a stack with bottom tabs; the global pane is a pushed sheet there.
* **Header rows** (`lib/header.tsx`, `lib/header-model.ts`, `styles/header.css`): every zone's top row is
  `--header-h` (48 px), a grid of fixed tracks [lead 36 | title | cells 32 px each | caption room]. A cell is a fixed
  32×32 box; a missing cell is an inert placeholder of the same size. The chat's row is segmented (`has-segments`):
  a fixed-width title track, the Call and "Chat tabs" cells right after it, then the open details panel's name and X
  above that panel (no second header inside it). With `strip-in-row` the title track is capped (other main rows: the
  caption track takes the pane's place) so the global pane's strip has its room in the row.
* **Window buttons in the header row**: all headers form ONE 48 px row; there is no strip above it, also in compact
  windows (the global pane's tab strip is part of that row). On Windows/Linux the native window-controls overlay fills that row in its colour (`main/title-bar.ts`,
  overlay height 47 px so the sheet's edge line stays visible); macOS traffic lights are centred in the same row. CSS
  reserves both edges from `env(titlebar-area-*)` (`--caption-left`, `--caption-reserve`; defaults only when the
  geometry is unknown: macOS left 80 px, otherwise right 150 px). The rail toggle and the first zone's title yield
  sideways to left controls; the main zone (`.rightmost`) reserves the right ones as `--caption-space` (controls plus
  the frame's feedback and Browser cells, `shell/WindowBar.tsx`). Compact desktop windows keep one row at phone widths.
  While a modal dialog is open the native caption buttons dim with the backdrop (16.11.: `ui/lib/backdrop-dim.ts` watches
  every `dialog[open]` → IPC `window:title-bar-dim` → `MainWindow.setTitleBarDim`, `title-bar.ts` `dimmedColors`; not
  for the feedback overlay; macOS has no overlay to dim).
  Real Mac/Linux caption buttons are not yet checked on the devices.
* **Nothing shifts on a click** (the owner's standing rule): toggles change only colour or icon inside a reserved cell;
  count badges are absolute; a busy button keeps its box (spinner over a transparent label); CSS state selectors never
  change font-weight, padding, margin, width or min-height (`test/unit/styles/stable-states.test.ts` fails on any);
  rows waiting for data render a fixed skeleton; scroll areas use `scrollbar-gutter: stable`; focus uses
  `preventScroll`. Status never takes a band: `shell/StatusLine.tsx` lays up to three small lines over the top of
  the main zone (connection, work stop, voice, realtime, toasts – lasting ones for to-dos and blockers, §4.2); in a chat
  they lie over the top of the messages (CSS anchor on `.message-scroller`), so under an open
  chat area and never on its tabs or page; elsewhere, or without anchor support, at the zone's top. A line never hides
  a native page. A fill never overwrites a draft.
* **Right-click menus everywhere** (`lib/context-menu.tsx`): a row spreads `useContextMenu(() => sections)` on its root;
  a right click (or a long press on touch) opens the shared menu at the pointer; `openContextMenu(x, y, sections)` for a
  button; `<ContextMenuHost/>` is mounted once in `App.tsx`. Menus are text only. One builder per object:
  `chat/chat-actions.ts` (chat rows and title), message menu (Reply, Copy – the mouse selection in that message, else
  the whole body –, "Select text" on touch, a sheet with the phone's own handles, `chat/SelectText.tsx`, "Save as
  secret" for a selection, Edit, Delete; the rules in `chat/message-tools.ts`; final text messages also carry Copy and
  Reply icons in their reserved meta row, and a right swipe on a message replies on the phone), `team/menus.ts` (agent,
  person), `tasks/task-menu.ts`, `tasks/todo-menu.ts`, `splits/split-menu.ts`, calendar rows, schedules, account and
  device rows, browser tabs. Page titles of agents, people, splits and tasks open the same menu as a dropdown
  (`team/TitleMenu.tsx`); on the phone a ⋯ button and long press.
* **Fewer icons**: icons only where they carry meaning (rail, header cells); menus, settings rows and groups have none.
* **Settings pages** (`ui/settings/Settings.tsx` with `SettingsNav.tsx`, `sections.ts`; `#/settings/<page>`), each a view
  on a file the AI edits through a skill, with a cell that opens that file in the file tab: **General**, **Models**
  (`ModelSetup.tsx`, shared with the first run: plans found on this PC, connected accounts and one connection form;
  `ModelUses.tsx`: one row per use with a provider select and a separate model cell, "Other…" takes a free name, and
  only "Model choice" below them; both write the `providers` and `routing` sections of `settings.json`,
  `runtime/accounts/provider-file.ts` reconciles them into accounts; protocols `openai-chat`, `openai-responses`,
  `anthropic`, `decision`; a cell names the model that runs, never "Auto" (§6); account rows have Move up/down and no plan
  roles), **Voice**, **Calendar**, **Secrets** (the inline band, §7.4), **Security** (16.11.2026, `SecurityPage.tsx`,
  `#/settings/security`, also for the old names `permissions` and `access`; 19.11.2026: Mode Trust AI | Secure behind
  Edit → "Yes, change it", the Manager hears of a change (`onboarding/security-mode.ts`); Trust: the agreement texts and
  three Yes/Ask switches; Secure: one row per switch with its folder or app list and a note; Public library, Changes,
  and last Waiting requests – §7.6),
  **Apps**, **Skills & memory** (skills with their route, the memory tree, click opens the file tab), **Devices** (§8),
  **Feedback**, **About** (version and update, back up and restore, data folder). General ends with the Companies group
  (§3) and holds Appearance only in the PC window. Everything else is a file the AI edits. **Search** (16.11.): every
  settings screen has the magnifier; the open page's matching words are marked through the CSS Custom Highlight API
  (`ui/settings/search-marks.ts`, colour only, so nothing moves; Enter goes to the next hit), and the nav and Ctrl+K find
  pages by what they hold – names of secrets, apps, skills, models and devices, never a value
  (`ui/settings/settings-words.ts`, loaded at the first search and on their change events).
* **Browser surfaces**: the global pane, each chat's area above its messages and each agent's area on its page, with
  Chrome-like tabs for pages and panels – §10.
* **"Set up with AI"** (`team/set-up-with-ai.ts`): for anything without a screen of its own, a menu item opens the
  Manager's 1:1 with a prepared request in the composer; the person adds the detail and sends.
* **Composer** (`chat/Composer.tsx`): one action row of fixed cells [+] [spacer/waveform] [Ultra] [Model] [Mic] [Send].
  Ultra is a small labelled switch beside the model chip (`UltraCell.tsx`); the model chip has a fixed width and shows
  the short name ("Opus 5.5", `lib/model-name.ts`). With nothing chosen it reads "Auto" with the model `routing.preview`
  routes the agent to in this chat as its muted second part ("Auto Opus 5.5", 16.11.; `ignorePin`,
  `lib/route-preview.ts`; the last model the agent used here until it answers); its
  menu's first item names that model ("Chosen per task", stored as `auto`), then one searchable list, effort. The agent
  page's Model select names its unpinned option the same way (without a chat `ignorePin` also leaves out the agent's own
  pin). The + menu (`composer/PlusMenu.tsx`: Files & folders, Photos & videos, Record audio, Record video – on a touch
  device also Take photo – §9, Secret – the composer's secret mode, §7.4 –, Task, then the send items of
  `composer/slash.ts`) and the Send button's right-click (Send as important, Send
  silently, **Schedule…**) never grey an entry out: with nothing to send a level sets the draft's level and Task fills
  "/task ". No permission chip. **Schedule
  mode** (§4.6): one settings block over the text inside the frame, the text area grows, and the bottom edge of the
  composer, Plus, Ultra, the model chip, Send and the header do not move (the window test measures them in light, dark,
  640×480 and phone width, and that the block's boxes do not change when switching Once/Repeat); Send turns into a round
  clock button "Schedule", the right-click menu then reads Schedule as important · Schedule silently · Schedule….
* **Chat header** (`chat/ChatHeader.tsx`): the chat's avatar and two fixed lines (name; who is working – `LiveLine.tsx`
  – or the resting line), then Call and "Chat tabs" (the chat's area, §10). Chat details: members, bridges, notes,
  schedules, message search. The live bar has one line per working agent with its own Stop in a fixed slot
  (`chat/LiveBar.tsx`; a split part's slot stays empty; a run on another own PC stops there, §8); the header has no Stop.
  The header's live line opens and closes every line of the live bar; the bar's ▾ box (`chat/LiveBarMore.tsx`) holds the
  run's task link and, on a split part's line, its group's rows (the separate working popover is gone, Quests-Runde
  20.11.2026).
  **Chat list** (`chat/ChatList.tsx`, `list-order.ts` `nestChats`): the person's 1:1s with agents nest under the 1:1 of
  their top-most manager in the list (one level; an explicit `parentId` wins; a person ends the chain), parents open by
  default.
* **Live work in a chat** (B-075; `chat/LiveBar.tsx`, `chat/LiveBarMore.tsx`,
  `team/run-items.tsx`): the header line, the chat list row, the live bar, the live block (the newest 6 steps,
  "+N earlier steps", the live line) and "Worked … · N steps" above an answer render only from the run's row and its
  meta (§4.2), the same in every window, on linked PCs and on the phone; where this connection may read the run's
  journal (its home PC), "+N earlier steps", a stopped run's steps and the answer's list open the journal instead
  (every step, live while the run runs). The chat does not poll runs; split groups and Team views without the runs
  stream still re-read the items when the agent's live note changes (at most every 2 s, `useRunItems`).
* **Rail** (`shell/Rail.tsx`): Tasks · Chats · Team (the phone's three tabs the same, `lib/vocab.ts DESTINATIONS`;
  the to-do badge on Tasks); from the bottom: profile (`ProfileMenu.tsx`: the
  companies, "New company", "Import a company", Settings – §3), plan quotas, update. Command palette: Ctrl/Cmd+K.
* **Team** (`ui/team`): the Team page's second line per agent is its role and "· N reports" (`model.ts`
  `structureLine`; the sidebar and the phone's Team tab keep the live line); people who never joined sit in the
  sidebar's closed "Invited (n)" fold before Archived (§8); Add › Person opens the Add person page (§8).
* **The feedback overlay's frame parts** (16.11.2026): every lib `Dialog`, once modal, draws a registered slot part
  (`lib/dialog.tsx` `setDialogSlot`/`DialogSlot`, its own top layer via `top-layer.ts`) – the feedback cell at its fixed
  spot, left out where the dialog's own box covers that spot; popovers stay open on a press at an element marked
  `data-keeps-popovers`, so the snapshot shows an open menu (§9 Feedback).
* **First run** (`ui/onboarding`, `ui/tour`): the tour (code-made, `ui/tour/timeline.ts` one tour per variant –
  `TOURS.desktop`, `TOURS.phone`: the shipped feedback flow – press to freeze, paint, talk or type, send; "Connect to my
  other PC" beside Skip opens the connect card, §8; the Android app shows the phone variant once before pairing, bundled by
  `scripts/tour-page.mjs` from `ui/tour/phone-page.tsx` into the app's `assets/tour.html`) → the AI card (the model
  setup; one usable AI is needed to continue) → About you (name and company only). `onboarding.start` then writes two
  lines into the Manager's first chat in one transaction (`prompts/onboarding.md`, fallback `onboarding/brief.ts`
  `setupLines`): the start line as the person's own ("Sent by Autark when I clicked Start: I've just set up my company
  here – let's begin.", F07, owner 15.11.; stored with `ChatService.send` `deliver: false` – no delivery, notification or
  title) and the Manager's greeting right below (a few short, optional questions – language, way of working, setting
  up, names, structure – and what it will do once the person answers). No model runs and nobody wakes at Start (B-090);
  the person's answer is the Manager's first turn and reads all three lines. No "ask me first", nothing to store as a
  permission; no technical switch stands behind any of it. A new profile's language is the PC's display language (main
  passes `app.getPreferredSystemLanguages()[0]` as `AUTARK_SYSTEM_LANGUAGE`, `settings/defaults.ts`).
* **Rich answers** (`shared/blocks`, `ui/blocks`): agents write Markdown with ```mermaid, ```ui blocks from one catalog
  (`shared/blocks/catalog.ts`; validated forgivingly) and ```app mini-tools that run in sandboxed frames
  (`wf-sandbox://`, a small live-frame budget). Ask blocks become to-dos (§4.3). An absolute path as a link target or
  code span opens on a click or Enter (`ui/workspace/path-links.ts`, B-081): on the author agent's home PC first
  (`.message-body` `data-author`), then this PC, as a folder, media (image/video/audio/PDF) or file tab where the frame
  says (the global pane; the phone: the open chat's area); on neither PC the tab of the PC asked first (its not-found
  page), and one toast when that PC is offline or not linked. It travels as `data-path`, never as an href; a Windows
  link target keeps its backslashes as written, a network path (`\\host\…`, `//host/…`) stays text, and inside a link
  label or a button/label (an option, a card) the enclosing control keeps the click; while text is selected nothing
  opens, so selecting still copies. A task result's evidence chips open their paths the same way, with the task's
  assignee as the author, and so do the Open of a file block and of a review widget on every device (16.11.; on the
  Tasks page and in a task's detail the to-do's creator is the author, `authorId`); a connection that may not read paths gets one
  toast with the reason (`NO_PATH_READ`).
* **Look**: `styles/tokens.css` defines every colour; the person's look is `theme.css` (§3).

## 12. Removed on purpose

**Principle**: a capability that was built deliberately stays, in its simplest robust form (video, media and notes
tabs, people, references, the phone, Android control, linked PCs, the week calendar, Duplicate agent – now a skill –,
Send later – now the composer's schedule mode –, splits, the emergency stop, the live view and takeover, schedules, crash
repair). What only held back, judged,
guarded, undid or duplicated is gone, and where a settings screen went, the AI does it through a file, a skill or
`wf call`. Agents may do everything; the person is asked with a to-do of theirs (`tasks.add` for the person, with an
`ask`) or a chat message.

* **Gate and judgment**: the guardian, the permission service and modes (Standard/Full autonomy), grants, rules, hard
  stops, money bands and budgets, offers, approvals and the approval park, deny memory, manager review, variant and
  split-lock gates, the remote judge (`runtime/permissions` deleted; RPC `permissions.*`, `approvals.*`); the
  quarantined reader for outside content; per-answer guard calls and the hardening prompt texts ("Do not retry it",
  "not allowed and final" …) – replaced by one self-check line.
* **Self-change machinery**: customize/overlay/Builder agent, `app.change` and change requests, overlay versions and
  revert, plugins and the plugin sandbox, protected-UI guard, safe start, preview windows, `ui.json`, the undo button,
  `settings.get/set` agent tools with approval cards, the settings table as a store, data-folder/workspace/home guards.
* **Brakes and ladders in task work**: the task center (router, route records, subscriptions), competing attempts,
  the never-give-up ladder and escalation, reopen cycles, turn guard, repeat and rate brakes, push brake, failure
  digest ("why failed"), task guards, "Did this happen?" to-dos, dependency graph, urgent-task preemption, reviewer
  variants, org change history and revert, companions, the plan reserve. (B-066: a task's plain `dependsOn` list is
  back – the task waits until those are done –, and competing attempts are a skill.)
* **Background learning layers**: lessons, follow-ups, the preference scan, playbooks, recipes, model outcome ratings,
  the gardener and the old recall/opaque query, the knowledge curator, conflict marks, lineage and freshness, site
  notes, the vocabulary learner. (The context ledger, embeddings and vector search were removed with them on 31.10. by
  mistake – the owner had built them on purpose – and came back in B-064 in simpler forms, §5.3–§5.5. Learned words
  came back in B-066 as the subconscious's `voice.words`, §5.4.)
* **Extra decision and routing layers**: local and hosted decision vendors, the Artificial Analysis and OpenRouter
  feeds, LLM routing classification, plan drain, escalation, model hints. (The engines' native rebuild layer went with
  the ledger and is back with it, §5.5; Artificial Analysis list prices come back only inside our own daily priors file,
  14.11., §6 Model catalog.)
* **Rights and duplicate stores**: the references rights matrix (grants, policies, drafts, briefs, training export,
  withdrawal), the sources corpus and areas, importer parsers (now a skill), notes history and merge, privacy
  forget/inventory/export, agent import and variants, task worktrees and git hooks, chat import.
* **Connectors and skills machinery**: REST-as-app, import ritual, connector catalog and search, `apps.suggest`, tool
  gate classification, the mail send cap, suspicious-text withholding; skill versions, audiences, sharing,
  retirement, update checks; secret access lists and trusted callers.
* **Device rituals**: QR-secret, SPAKE2 and Tailscale pairing paths, connect by name, "Which PC?", phone access requests
  and 6-digit phone invites, phone tiers, the relay phone app, remote consents, audit and remote pause, linked to-dos,
  presence, cross-PC delegation, the phone session gate and phone RPCs, computer-use step judgment. (File transfer
  is back as one tool, `devices.send_file`, B-066; a 6-digit pair code beside the phone QR, B-075, §8.)
* **Voice and media extras**: the Windows System.Speech path, recognizer choice, unsure segments, pronunciation, call
  seats/floor/history/recap, carry, shared frames and loudness lane. (Gemini Live and `media.segments` came back in
  B-066.)
* **Browser extras**: `browser.pick`, linked-PC browser views, permission categories, money/label judgment, batch and
  eval refusals, site files, region text, Select/Give and selection chips, the old toolbars. (A browser per chat,
  history, closed-tab memory, zoom, favicons, the omnibox and Mark a region came back in B-066, §10; the element pick
  came back in B-081 in a simpler form – the Pin button's in-page picker with text pins instead of pictures, §10.)
* **UI**: the composer's permission chip, the notice band, the catch-up digest, the timer chip, the schedule dialog,
  "Learned here", most Settings panels (permissions, approvals, customize, general, apps, knowledge, references,
  recipes, sources, skills, secrets, Android, relay, routing …), the separate Home view, the Plan button, the Team
  activity dashboard, the legacy task form, quick-task overlay, the onboarding Voice card and "Who uses this PC?". The
  harness mode and the 4-switch mode cap. (B-066 brought back settings pages – General, Apps, Skills & memory, Secrets
  among them, §11 – and the work index as a pane panel; the abilities list and the "Automatic" setting went.)
* **Removed by B-062 (01.11.)**: the settings file of differences only (now the whole file with comments); the decision
  model setting, the helper model, per-function models, `workPlan`, the realtime-model key, decision accounts and the
  Artificial Analysis account (one connection form and nine uses instead); the agent budget (`Agent.budget`,
  `monthlyUsd`/`warnAtRatio`, `budget` in `agents.update`) and the "copy of an agent" special cases in hiring; the RPC
  `agents.derive` and `Portability.derive` (a skill instead); the "Send later" dialog (`SendLater.tsx`, `send-later.ts`)
  and the Pause switch in schedule list rows; the setup checklist in every manager turn; the setup-guide reading of
  `workforce-guide` (now `app-guide`); the "first run just ended" onboarding note; every recipe for "set everything up".
* **Removed by B-064 (01.11.)**: the one-call automatic memory of B-062 (`subconscious/memory.ts`,
  `subconscious/memory-passes.ts`, prompt `memory.md`) – the flow of §5.4 took that work (since v1, 14.11., only when the main
  AI asks); the memory tips before a turn (one knowledge search injected as text) – the flow replaced them (since 14.11. the notes a person's lines name open before a turn as real `knowledge.open` calls, §5.2); the knowledge table as the
  store of memory (the files of §5.2 are).
* **Removed by B-072 (04.11.)**: the side pane's global/chat switch and the phone's chat workspace sheet (`SpaceCell.tsx`,
  `paneSpace`; each surface now has its own space, §10), the secret pop-ups (`settings/SecretImport.tsx`,
  `chat/composer/SecretCapture.tsx`; the inline band and the composer's secret mode instead, §7.4), the "Pay-per-use
  fallback" row, the plan role hints and "Use in rotation" (the rotation field itself went 09.11.: every plan takes turns, §6), "Auto" as a shown model,
  the tab count cell, greyed Plus/Send entries, and the dead relay phone shell (`scripts/relay-shell.mjs`/`.d.mts`).
* **Removed by B-075 (04.11.)**: the `message.delta` event (a run's text and status are updates of its row, §4.2), the
  chat UI's use of `agent.activity` and the chat's 2 s run refresh (the chat renders from rows; split groups and Team
  views keep the refresh, §11), the shared `'talk'` call id (every call has its own row and id, §9), the phone QR on a
  localhost address (no QR without an address a phone can reach, §8).
* **Removed in the feedback round (16.11.2026)**: the 0.3.8 exclusive-owner handoff of plan logins between companies
  (`accounts/home-owner.ts`, `company-transfer.ts`, `claude-quiescence.ts`, `shared/model/account-transfer.ts`, the RPC
  `accounts.transfer`, the Supervisor's home permits and `withClaudeHome`) – one shared logins folder per PC instead
  (§6); the isolated mail turn (`agents/mail-turn.ts`, `AUTARK_MAIL_ORIGIN_ISOLATION`, `mailScopeRefusal`, sender-only
  reply) – a mail-woken run is a full turn (§7.2); the feedback menu popover and its "Paint over" dialog
  (`PaintEditor.tsx`) – the snapshot overlay (§9); a seeded HUMAN.md for each hire (`seedHuman`) – "For every agent"
  (§5); `giveFullAccess` (`setPcAccess`); the separate secrets append of `knowledge.find` (`findSecrets` – kind
  `secret`, §5.2); the activity log on the agent's profile (its Work page, §4.1); the chat header's second Stop (the
  live bar's per agent, §11); the "Updates install from the first company" rule (§3).
* **Removed in the KI-Runde (B-092, 17./18.11.2026)**: the weighing of warm rebuilds for savings (`pays`, `shrinks`,
  `CACHED_PRICE_RATIO`, `overrated`, `leanRows`, `RebuildNeed.marked`, the "does not pay yet" note) and the rebuild or
  renewal for a changed prompt key (`renewSession`'s 'mode' and 'prompt' reasons) – the fold and the start record (§5.1);
  the model tier in the stable prompt; the subconscious's model choice, its tier list, model lines and switch cost
  (`switchLine`, `offeredModels`, `modelLines`) and the return rule `returnRun` – the settled model (§5.4, §6); the
  "weak for the work" step and the person's request onto the strongest tier (§6); `model` and `from` on
  `tasks.create`/`tasks.give` (`askedRoute` in `tasks/give.ts`); `EVERY_MODE` and `ToolDef.anyMode` (§7.1); the standard's
  `review` wake (§5); the call voice's one structured call per line with `relay` none/next/now (§9); the duplicate
  `leads()` in `routing/kind.ts` (one in `org/standard.ts`).
* **Removed in the Quests-Runde (20.11.2026)**: My day and Work with their side-pane copies, the task center views and
  the task filter nav (one Tasks page, §4.7); the day planner, morning planner and briefing, focus timer, learned
  estimates, "Handed off", the stale-asks tidy, the Next card, the stored to-do blocks of the calendar, the per-task looks
  (`next_at`, stall pause, 2-day nudges), routine and timer schedules and "Post as task" (§4.6); twenty task, schedule and
  calendar tools (four task commands and `calendar.list`/`connect`, §4.3); `day.add`, `todos.add`,
  `day.plan/briefing/handedOff`; the settings `day.autoPlan`, `day.agentLane`, `preferences.closeToTray`; "Only me" as a
  read exception (every agent reads every task); the second vector system (memory and catalog index, start pass, re-embed queue,
  `requires: 'embeddings'`, §5.3); the subconscious's widget-fill chain; eight `chat.*` tools (→ `chat.update`); the
  working popover; the unused voice-rtc host op and main's voice-rtc window; main's identity move; the person-scoped
  device invite; `people.directChat`; the IPC `updates.setAutoDownload`; migrations 001–090 (the baseline, §3) and every
  one-time move of data from before 0.3.9 – the JSON-store import, settings rows, app records, per-entry secret files, the
  old phone switch, the logins move, the legacy accounts, the old model keys, the knowledge-row move and chat
  observations, the 13.11. conversions, the role and standard upgraders; doubles – the calendar's own OAuth loopback, a
  second web-push request and signer, `isCeoLink`/`isCeo`, `chargeOf`; test helpers in `src` (ManualClock, MemoryLogger,
  memoryConnection, socketPair, §13).

**Leftovers still in the tree** (harmless, to remove when their callers go): compatibility stubs and legacy fields
named in their file headers (e.g. `TaskView.route`, `shared/model/browser.ts` device fields); the
device capability vocabulary (`DeviceCapability`, `ui/lib/session.ts` `can()`) although an owner's phone has full
access; the person-variant RPC handlers instead of one membership check; the emptied `settings` table; an old
`<data>/custom` folder on existing installs; the inactive Guard class in `windows-helper.ps1`/`linux_guard.py`;
a deleted agent's `agent:<id>` space
in `side-tabs.json`; some header comments that still name removed modules or only the global and chat spaces; from B-062: "Settings → Models &
accounts" in several error texts (`routing/unfit.ts` and its test, `tools/builtin/accounts.ts`, a few header comments),
`agents.derive` in the header of `patterns/tools.ts`, and the stale `test/ui/ui-tour.mjs`; from 16.11.: the field
`Origin.mailScope` and `mailReplyAttempted` in `agents/dispatch-runs.ts`, and the feedback menu and "Paint over" still
named in `ui/styles/index.css` and the header of `ui/settings/FeedbackPage.tsx`.

## 13. Code conventions

* TypeScript with **erasable syntax only** (no enums, namespaces or parameter properties), ESM, relative imports with
  `.ts`. Node 24 runs the tests directly (`node --test`); esbuild bundles for Electron (`scripts/build.mjs`).
* One concern per file, about 300 lines at most, a short header comment: what the file owns and what it never does
  (`Owns: … Never: …`) – kept current. English identifiers and UI texts.
* Simplicity first: delete before adding; no settings knob the owner did not ask for; no layer that only guards.
* Constructor injection for everything that touches processes, time, network or disk (tests use fakes); no global
  singletons except the composition roots (`runtime/main.ts`, `main/index.ts`, `ui/main.tsx`). Late binding through
  `services: () => RuntimeServices`. Test helpers live in `test/`, never in `src` (Quests-Runde 20.11.2026): ManualClock,
  MemoryLogger and nullLogger in `test/unit/fakes.ts`, memoryConnection in `test/unit/rpc/memory-connection.ts`,
  socketPair in `test/unit/devices/socket-pair.ts`.
* **Bridges** (`runtime/bridge/*`): a one-time change for older data or PCs lives only in a bridge file whose leading
  comment names its release ("bridge 0.3.16"); `scripts/check-boundaries.mjs` warns two releases later, so it goes. One
  name per thing – no alias layers. Bridges are for structural changes (schema, IDs); **what an older version left
  wrong that an AI can check and put right** goes into the **update note** instead (Fest 22.11.2026, owner: no code per
  old mistake): `resources/updates.md`, one section per version (what changed; per leftover how it shows, how I check,
  how I fix), and `runtime/system/update-note.ts` – at the first start of a newer version (kv `system/version`, read
  before `recordStart` stores the new one; semver order, a `-local.N` build before its release), the personal manager
  (`managerAgent`) gets one wake on its home PC with a lead in its own voice and every section since; fresh installs and
  folders before their first run get none. The release kit's step `update-note` (`scripts/update-note.mjs --check`)
  refuses a release without its section.
* **Contracts**: service shapes in `runtime/contracts.ts` and `runtime/contracts/*` (later additions by module
  augmentation). The RPC contract: core methods in `shared/api/methods.ts`, every other area in its own
  `shared/api/methods-<area>.ts` (augmenting `Methods`); events in `shared/api/events.ts`. A new method goes into its
  area's part; `test/unit/rpc/s1-table.test.ts` checks that the handler table registers the whole contract once.
* Errors carry codes (`shared/errors.ts`); user-facing text never leaks secrets or raw provider bodies. Secrets only
  as handles.
* UI: data in signals (`ui/lib/store.ts`, kept fresh by events), menus via `lib/context-menu.tsx`, dialogs via
  `lib/dialog.tsx`, headers via `lib/header.tsx`; the layout-stability rules of §11. Every visible change is checked
  in a real window (light, dark, 640×480, phone width) and compared with the design references.
* Import boundaries per layer: `npm run boundaries` (`scripts/check-boundaries.mjs`).
* Docs: this file is kept current with the code; the build history and the open points are internal work notes.

## 14. Where things are

All paths below `code/apps/desktop/src` unless stated.

| Area | Where |
|---|---|
| Composition roots | `runtime/main.ts`, `runtime/compose/*` (services, network, lifecycle, calendar, splits, people, decisions …), `main/desktop.ts`, `ui/main.tsx`, `ui/App.tsx` |
| Service contracts | `runtime/contracts.ts`, `runtime/contracts/*` |
| RPC | contract `shared/api/*`, server `runtime/rpc/server.ts`, scopes `rpc/scopes.ts`, handlers `rpc/handlers/*`, extras `rpc/extras.ts`; client `ui/lib/rpc.ts` |
| HTTP, PWA, push | `runtime/http/*` (`peer.ts` incl. `/peer/phone`, `static.ts` incl. `/ui-hashes.json`), `runtime/pwa/*` (`pair-code.ts` the 6-digit code, `urls.ts`), `ui/pwa/*`, `ui/hosted/*` (`ui-hashes.ts` the file check), `shared/model/ui-hashes.ts` |
| Data folder and files | `runtime/root/*`, `runtime/settings/*` (`schema.ts` is the one table; `read.ts`, `service.ts`), `runtime/system/paths.ts`, `runtime/agent-core/*`, `runtime/secrets/files.ts`, `runtime/apps/connectors.ts`, `runtime/chat-files/*`, `shared/files/{mime,serving}.ts` (content types, blob layout, Range – runtime and main) |
| Companies | `main/companies.ts`, `main/company-remove.ts` (leave, delete), `runtime/root/companies.ts`, `shared/model/companies.ts`, `runtime/tools/builtin/companies.ts` (`companies.list`, `runCompanyTool`), `runtime/rpc/handlers/companies.ts`, `runtime/portability/company.ts` (export, import), UI `ui/shell/ProfileMenu.tsx`, `ui/settings/CompaniesGroup.tsx`, `assets/installer.nsh` |
| Database | `runtime/db/*` (`migrate.ts` with `OLDEST_SCHEMA`, `upgrade.ts`, `migrations/091-baseline.ts` … `110-quests.ts`), `runtime/store/*` |
| Bridges (one-time, named by release) | `runtime/bridge/*` (`cost-1117.ts`, `sicher-1119.ts`, `quests-2011.ts` rows from older PCs, `quests-wake.ts`) |
| Chats | `runtime/chat/*` (a run's row: `streaming.ts`, `live-row.ts`, `publish-message.ts`; `live.ts` with the other PCs' live state), `runtime/notes/store.ts`, UI `ui/chat/*` (`message-tools.ts` Copy/Reply, `SelectText.tsx`, `message-keys.ts` masked keys, `LiveBar.tsx`, `list-order.ts`) |
| Quests, to-dos, threads | `runtime/tasks/*` (`quests.ts`, `thread.ts`, `quick.ts` the one intake, `watch.ts`, `morning.ts`, `related.ts`), `runtime/context/quest-text.ts`, `runtime/tools/builtin/{tasks,tasks-list,tasks-remind,tasks-util}.ts`, `shared/model/tasks.ts`, UI `ui/tasks/*`, `ui/chat/TaskThread.tsx`, `ui/chat/KeptLine.tsx` |
| Wakes, scheduler, dispatcher, turns | `runtime/wakes/queue.ts`, `runtime/schedules/*`, `runtime/agents/*`, `runtime/runs/journal.ts` |
| Fold, boundary, session start (B-092) | `runtime/agents/context-fold.ts` (causes, hold, fold turn, `FOLD_NOTE`), `agents/compaction-policy.ts` (`FOLD_STEP`, `FOLD_IDLE`, `CACHE_COLD_MS`), `agents/boundary.ts`, `agents/rebuild.ts`, `agents/session-key.ts` (start record), `agents/volatile-delta.ts` (was / now), `agents/turn-cost.ts`, `routing/kind.ts`, `bridge/cost-1117.ts`, `splits/wait.ts`, `phone/linked.ts`, `calls/{talker,voice-row,voice-text,no-lane}.ts`, `engines/claude/kept.ts` |
| Splits | `runtime/splits/*`, `runtime/git/*`, UI `ui/splits/*` |
| Tasks page, calendar, time phrases | UI `ui/tasks/*` (`TasksPage.tsx`, `TaskInput.tsx`, `TaskCalendar.tsx`, `TodoDetail.tsx`, `QuestDetail.tsx`), `ui/lib/day-store.ts`, `runtime/day/*` (`assistant.ts`, `keep-awake.ts`, `clock.ts`), `runtime/calendar/*`, `runtime/tools/builtin/calendar.ts`, `shared/text/when.ts` (the one time parser and zone math), `shared/model/day-settings.ts` |
| Org, agents, people | `runtime/org/*`, `runtime/people/*` (`access.ts` incl. the CEO layer, `rpc-ceo.ts` the co-CEO's methods), `runtime/portability/*`, `runtime/patterns/*`, UI `ui/team/*` (`PersonNew.tsx` Add person, `PersonJoin.tsx` a person's device, `AgentWork.tsx`/`WorkNow.tsx`/`agent-work.ts` the Work page, `org-state.ts`) |
| Prompt and context | `runtime/context/*`, `runtime/modes/*`, `resources/prompts` (incl. `agent-default.md`, `subconscious.md`), `resources/modes` |
| Subconscious (§5.4) | `runtime/subconscious/*` (`route-turn.ts` the one call before a turn, `look.ts` its hits and context items, `flow.ts` the asked run's loop, `tools.ts` its tools, `service.ts` which call runs when, `wake.ts` the checks, `exchange.ts`, `context-tools.ts`; `verify*.ts` the result check), `runtime/tools/builtin/subconscious.ts`, `shared/model/subconscious.ts` |
| Transcript by IDs (§5.5) | `runtime/context/ledger/*`, `runtime/contracts/ledger.ts`, `shared/model/context-ledger.ts`, `runtime/tools/builtin/context.ts`, `runtime/agents/rebuild*.ts`, `runtime/engines/{codex,claude}/rebuild*.ts`, `runtime/engines/claude/transcript.ts`, `runtime/engines/trace-text.ts` |
| Vectors (§5.3) | `runtime/vectors/*` (`meaning.ts` the blend and the one queue, `files.ts` added files, `store.ts`), `runtime/contracts/vectors.ts`, `runtime/models/embeddings.ts`, `runtime/tools/builtin/vector-{embed,search}.ts`, `shared/model/vectors.ts` |
| Memory, references, find | `runtime/knowledge/*` (the tree: `memory-tree.ts`, `memory-follow.ts`; `words.ts` the word index, `tree-words.ts` the tree's, `search.ts noteHits`), `shared/text/normalize.ts` (the one stem), `runtime/tools/builtin/memory.ts`, `shared/model/memory.ts`, `runtime/references/*`, `runtime/find/*`, `runtime/work-presence/*` |
| Engines | `runtime/engines/*`, `runtime/mcp/*` |
| Accounts, models, routing, decisions, cost | `runtime/accounts/*` (shared plan logins: `cli-homes.ts`, `adoption.ts`, `dismissed.ts`, `login-file.ts`), `runtime/models/*`, `runtime/routing/*` (`uses-settings.ts`, `person-turn.ts`), `runtime/decision/*`, `runtime/spend/*`, `shared/model/{models-uses,providers-connect}.ts`, `resources/model-priors.json` |
| Tools | `runtime/tools/*` (registry, placement incl. `placeCompany`, core sets), `runtime/tools/builtin/*` |
| Connectors, bridges | `runtime/apps/*`, `runtime/bridges/*` |
| Skills, secrets | `runtime/skills/*`, `resources/skills/*`, `runtime/secrets/*` (`export.ts`, `units.ts`, `metadata.ts` word index and ranking, `text-capture.ts` keys in chat text), `runtime/find/secrets.ts`, `shared/secrets/token-patterns.ts`, `shared/model/key-values.ts`, UI `ui/settings/SecretRows.tsx`, `ui/settings/secret-catalog.ts` |
| Devices | `runtime/devices/*` (sync: `runtime/devices/sync/*` – `logins.ts`, `blobs.ts`, `file-io.ts`, `live.ts`; `load.ts`; `rendezvous/phone.ts` and `phone-traffic.ts` the phones' paths), `runtime/remote/*` (`mirror.ts` requests on every own PC), `runtime/phone/*`, `runtime/computer/*`, `runtime/pointers/*`, `main/screen-cursor.ts` (the AI cursor on the screen), `code/services/remote-relay`, UI `ui/settings/DevicesGroup.tsx`, `connect-rows.tsx`, `devices-connection.tsx`, `device-version.ts`, `ui/onboarding/ConnectCard.tsx` |
| Voice, calls, media | `ui/lib/dictation.ts`, `ui/lib/ogg-opus.ts` (compact pieces), `ui/blocks/ui/live-words.ts` and `prompter.ts` (words while recording), `ui/chat/composer/RecordBar.tsx`, `shared/voice/*`, `runtime/voice/*`, `runtime/calls/*` (`call-log.ts` a call's row, `wiring.ts` start-up and shutdown, `ring.ts` an agent's ring), `runtime/tools/builtin/call-tool.ts` (`chat.call`), `shared/model/call.ts`, `runtime/media/*`, `main/media-*.ts` with `main/hidden-jobs.ts` (the one hidden-window runner), UI `ui/chat/composer/*`, `ui/chat/call/*` |
| Browser | `main/workspace-*.ts` (one shown tab per space `workspace-shown.ts`, preview marks `workspace-marks.ts`), `main/side-driver/*` (`cursor-script.ts` the AI cursor's drawer, `pick-script.ts` the Pin picker), `runtime/browser/*`, `shared/model/{agent-cursor,page-pick}.ts`, UI `ui/workspace/*` (`pin.ts`, `view-zoom.ts`, `browser-pad.ts`), `ui/chat/ChatArea.tsx`, `ui/team/AgentBrowser.tsx` |
| Shell, header, menus, settings | `ui/shell/*`, `ui/lib/{header,header-model,context-menu,dialog}.tsx`, `ui/lib/backdrop-dim.ts`, `ui/settings/*` (`SecurityPage.tsx`, `search-marks.ts`, `settings-words.ts`), `ui/styles/*`, `main/title-bar.ts` |
| First run, feedback, repair | `ui/onboarding/*`, `ui/tour/*` (`phone-page.tsx` the phone tour, bundled by `scripts/tour-page.mjs`), `runtime/onboarding/*`, `ui/feedback/*` (`FeedbackOverlay.tsx` the snapshot overlay, `FeedbackPanel.tsx` its dock, `outbox.ts`, `press.ts`), `runtime/feedback/*`, `runtime/repair/*`, `ui/repair/*` |
| Rich answers | `shared/blocks/*`, `ui/blocks/*`, `ui/sandbox/wf.ts`, `ui/workspace/path-links.ts` (paths in messages) |
| Updates, launcher, tray | `main/updates/*`, `main/updates-wiring.ts`, `main/launcher*.ts`, `main/tray.ts` |
| wf terminal client | `runtime/wf-cli/*`, the agents' shim `runtime/engines/wf-shim.ts` |
| Feedback mailbox and team inbox | `runtime/feedback/*` (`inbox.ts` the fetch and tombstones, `letter.ts` checks an opened letter), `runtime/wf-cli/feedback.ts` (`wf feedback list/show/mark`), `ui/feedback/FeedbackInbox.tsx`, `resources/feedback/{receiver.json,firestore.rules,firebase.json}`; `code/services/feedback` is a retired prototype |
| Release environment | `code/scripts/desktop-release/` (tools and preflight only), `apps/desktop/scripts/package-desktop.mjs`, `scripts/nsis-build.mjs` |
| Native release CI | Public binary repository workflows `release-from-compiled.yml` and `verify-mac-intel.yml`; inputs are a draft tag, compiled ZIP asset and SHA-256, never private TypeScript product sources; native evidence stays in the draft until publication |

## 15. Build, run, test

All commands run in `code/apps/desktop`.

| Goal | Command |
|---|---|
| Bundle everything into `app/` | `npm run build` |
| Start the desktop app | `npx electron .` (demo engine and an isolated profile: `WORKFORCE_FAKE_ENGINE=1 WORKFORCE_TEST_DATA=<dir>`) |
| Headless runtime | `node app/runtime-cli.mjs --data <dir> [--port n] [--fake] [--log] [--peer lan\|tailscale\|off]` – prints `{port, token}` |
| Call the running app | `node app/wf.mjs call <method> '<json>'`, or `POST /rpc` with the bearer token from `<data>/runtime.json` |
| Typecheck per layer, import rules | `npm run typecheck`, `npm run boundaries` |
| Unit tests (4,271; 666 s in the 0.2.9 snapshot, 3,608 s with 4 timing failures at the B-064 check on an overloaded machine) | `npm test`; one area: `node --test "test/unit/<area>/*.test.ts"` |
| Window tests (Electron) | `npm run test:ui` – 48 files, all current (one at a time on a fresh build; `ui-tour.mjs` and `design-tour.mjs` are stale scripts) |
| End-to-end over real WebSocket RPC | `npm run build && npm run test:e2e` – 39 files; three real-provider tests skip themselves |
| Live checks on this PC (opt-in) | `npm run test:live` with `WORKFORCE_LIVE=1` (real browser window, mouse/keyboard; own test pages) |
| Windows package | `npm run package -- --win --x64` (`scripts/package-desktop.mjs`, NSIS) |
| Electron to the newest stable | `npm run electron:latest` (`scripts/electron-latest.mjs`: exact pin + lock + binary; lists the breaking changes of a crossed major); `-- --check` exits 1 when behind – the release kit's first check step `electron-current`, so every release ships the newest stable Electron and its Chromium |

`--fake` / `WORKFORCE_FAKE_ENGINE=1` is a strict demo mode: one "Demo engine" account on the deterministic fake engine;
real CLI logins are never detected or used. Typecheck runs in four projects (`tsconfig.shared/runtime/main/ui.json`).
The meeting server
(`code/services/remote-relay`) has its own package, tests and `Dockerfile`; `node scripts/build.mjs --only meet` bundles
it into the app as `app/meet.mjs`. Feedback uses Firestore directly; its runtime, UI and
local mailbox fixture are tested under `apps/desktop/test`. `code/services/feedback` is not deployed or used.
