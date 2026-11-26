# Autark updates

One section per version, newest first. Each says what changed and, for what an older version may have left behind on a
PC, how it shows, how I check for it and how I fix it. With every new version the personal manager reads the sections
since the version its PC ran before, looks through its company and puts right what it finds. A release adds its section
here before it ships (the release check looks for it).

## 0.3.21

Tasks show when they were created and when they stopped moving. A task can carry a checklist, and creating a
similar task shows a suggestion without blocking it. Calendar and the regular Tasks view both stay. Old Android
shortcuts and notices for My Day open Tasks. The Android QR scanner opens the system image chooser instead of
requesting access to recent photos.

The chat composer shows Auto without guessing a model name. A manual pick is a hint for one outgoing message;
the next starts on Auto. Change an agent's standing model on its own page. On Android, with the matching PC
update, the Bubble sends to the last chat you opened, with the screen capture when available, instead of creating
a task. The reply appears in the chat. Earlier Bubble to-dos are not moved automatically; leave them unless you can
confirm they are finished or duplicates.

On Windows, the updater can recover once a drained app hangs on quit. The move *from* 0.3.20 can still hit the old
quit behavior. If an update seemed to finish but the app still reports 0.3.20, check its version again before
reporting success. After saving work, use the signed installer if retrying from the app does not work. Confirm the
installed version and run the bundled broker's install.ps1 with -Check; do not reinstall or restart while a turn is
using that same runtime.

A company already in Secure mode with its web switch set to all sites moves once to chosen sites. An agent may now
ask the person for a site it previously opened without asking. This is expected. Check Settings > Security > Web;
keep that setting unless the person wants a different scope. Trust AI is not changed by this migration.

## 0.3.20

What changed: the left rail's destinations follow an order the person sets (drag, Alt+Arrow or the right-click menu;
kept in settings.preferences.navOrder, so it holds on their PCs and the phone tabs follow it), and its plan badges
show every plan, scrolling with a soft edge when they do not all fit. A CSV or TSV opens in the File tab as a table
to read. Model setup shows the e-mail addresses of plan logins masked. A wait that names a colleague hands the task
back to its owner and wakes them. shell.exec ends at a total limit of 3600 s however often a review extends it, and
secrets.import takes a long client id and names every entry it leaves out with its reason. After a Codex or Claude
Code update to a version not on the verified list, the runtime log warns that sessions start anew after a restart.
Nothing of this leaves data behind on an older install that needs a check or a fix.

## 0.3.19

What changed: on Windows the desktop broker's check at each start really runs now. Up to 0.3.18 it started
Windows PowerShell without a console, which ended at once without running install.ps1, and main.log still said
"desktop broker setup: installed and running" – so a new broker that came with an update never replaced the old one and
no Windows prompt asked for it. Now the check runs hidden, an update of the broker asks Windows once at the first start
of this version, and "installed" is only written once `install.ps1 -Check` confirms the current broker is running;
otherwise the setup counts as failed with the check's exit code. A PSModulePath inherited from PowerShell 7 no longer
reaches the script, so it no longer fails with "Get-FileHash is not recognized".

**An outdated desktop broker behind "installed and running".** Shows as: after an update, main.log says the broker
setup is installed and running, but the service still runs an older image, or the secure desktop (lock screen, Windows
prompts) is out of reach. I check: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File
"%LOCALAPPDATA%\Programs\Autark\resources\app.asar.unpacked\resources\broker\install.ps1" -Check` – exit 0 is
current, exit 2 outdated or missing; main.log's line after "desktop broker reconciliation started" at this version's
first start. I fix it: at the first start of this version a Windows prompt asks once for the broker and I answer it
with Yes (or ask the person where I may not); where it got no Yes, a run of the same install.ps1 without -Check
asks again.

Wake while closed (owner 23.11.2026: Wake did nothing after Autark was ended in Task Manager): Wake from my phone or
another PC and scheduled work now reach an Autark that is closed, also after a hard end. The app keeps
<data>/wake.json current while it runs (not only at a quit), and on Windows registers its wake helper with the desktop
broker (`%LOCALAPPDATA%\AutarkDesktopBroker\wakers\<key>.json`). The broker service starts that helper – the same
Autark.exe as Node, as the person in their session – whenever neither the app nor a helper runs. The helper starts the
app on a signed wake, or for work that comes due after the app was closed (not within 5 minutes of it). It never
restarts a closed app on its own. Settings › Devices › Connection › "Wake while closed" (devices.wakeHelper, default on)
switches it off. On macOS and Linux the helper still starts only after a quit from the app.

**Wake does nothing although the app is closed.** Shows as: the PC is "Not reachable" and Wake answers that it is not
waiting at the meeting server. I check: `devices.wakeHelper` is not false; <data>\wake.json exists; a registration
file is in `%LOCALAPPDATA%\AutarkDesktopBroker\wakers`; `install.ps1 -Check` exits 0 (an old broker has no waker);
%ProgramData%\AutarkDesktopBroker\broker.log has "waker … started helper" or names why not (no_wake_file, updating,
installer, another user at the console); <data>\logs\sleeper.log says "waiting for a wake". I fix it: the broker
first (see above), then start the app once – it writes both files.

A signed-out model account (owner 23.11.2026: "Sign in to Claude Code 2 again · from Former member" on the phone, while
that plan was only at its weekly limit): the sign-in is first work for the personal manager – else any manager, a
computer-mode agent, else the first active agent –, who signs it in with the stored login and the phone's authenticator
and gives the person a to-do only for a step only they can do. Accounts at their limit or cooling count as signed in:
they no longer make "No other model account can run the team", a stale sign-out report for an account that is signed
in again creates nothing, and the work closes once the account is signed in again, also while it is at its limit. The
app's own to-dos show "from Autark".

**A sign-in to-do for the person although other accounts run.** Shows as: "Sign in to … again" on the person's My day,
"No other model account can run the team". I check: app.status for the account and the others; the to-do's notes. I fix
it: if the account is signed in, I close the to-do; if not, I sign it in myself (accounts.sign_in) and tell the person
only what only they can do.

Settings › Models names a Claude plan as Anthropic does today: Max with 20× usage is the "Ultra plan" (Claude Code reports it as
subscriptionType "max" with planTier "max_20x"). Under each Claude plan's extra-usage switch there is a second way past its
limit: "Monthly API credits of this plan" (Max, Ultra and Team include API credits every month – a Console organization
linked at claude.ai › Settings › Billing › API credits, spent with its API keys, refilled monthly, nothing billed once used
up), or "API key as reserve" for a plan without them. A key pasted there goes straight into the encrypted catalog as the
Anthropic key account "<plan> · API credits" and is never shown again; with monthly credits it runs like a plan once the
plans run out, before any paid key – the order of before, no second purse. "Let the AI set it up" gives the personal
manager a to-do to link the organization, store a key with browser.save_secret and enter it.

**A Claude plan that is out of quota although its API credits are set.** Shows as: agents wait for a plan's reset, while
Settings › Models shows "Key stored ✓". I check: the account "<plan> · API credits" is on and its plan credits are on;
whether its last turn said the credit balance is too low (then it waits a day). I fix it: if the organization was never
linked at claude.ai › Settings › Billing › API credits, I link it – else the person tops it up or waits for the month.

The Tasks page has a day line under its title (owner 23.11.2026): ‹ the days as circles ›, today marked; a tap shows
that day's lines (a past day only to read) with a "Today" button back, a button opens a small month, two symbols switch
between Tasks and Calendar, "Next" shows the coming appointments (a run of close ones all of them), and view and day
stay when you go to the chats and back. On a phone every control of the line is a full finger's size.

Claude Code and Codex agents run commands only through Autark's masked shell (owner 18.11.2026: a Stripe live key that
a command printed in Claude Code's own Bash reached the model provider). An agent turn on Claude Code no longer gets the
Bash or PowerShell tool; a Codex agent thread opens, resumes and forks with its own shells off (shell_tool, unified_exec,
shell_snapshot, shell_zsh_fork, js_repl). Commands go through shell.exec, whose output is masked before the model, the
run journal and the chat see it: a value from the secrets catalog as its secret:// handle, a key by its shape (Stripe,
GitHub, JWT, private key …) as ‹secret:…›. A command that times out, is stopped or loses a pipe returns "[command
output withheld]" instead of a part that could end in the middle of a value, and the timeout review sees only how much
it printed, no longer the output or the command. A pipe that prints more than 512 KB keeps its start and its end (where
a build's error stands), each masked whole and cut by a 48 KB margin where the middle was left out, so no piece of a
value that cut split shows; what the model sees stays within 64 KB. A rebuilt session leaves out native shell calls
and Codex script calls from before 0.3.19 with a one-line note; Codex scripts run under the masked shell carry a mark
in the journal and are replayed as before.
A native session resumes after a restart only when Autark wrote it last: at the end of each turn, fork, revert and
rebuild this PC notes the session's transcript (its exact size and the hash of its tail) with the masking and CLI
version (table managed_paths, never synced). When anything differs – the transcript grew, a restart cut a turn,
Claude Code older than 2.1.303, a Codex other than 0.167.0-alpha.3.2, 0.171.0-alpha.13, 0.171.0 or 0.172.0 – the session starts anew from the filtered
history (one cold turn, nothing lost), and a fold planned on it is dropped instead of failing.
What is not masked: Claude Code's own Read, Grep, Glob and WebSearch results and Codex's apply_patch diffs still reach
the provider as the CLI sends them and stay in the native transcript – a key in a file an agent opens with Read is
seen by the provider. A secret saved to the catalog later is not masked in transcripts written before it. The mark
says only that Autark wrote a session last, not that it holds no secret.

**A Claude or Codex session starts cold after each restart.** Shows as: the first turn after a restart rebuilds the
session (run journal: a note with sessionRenewed "managed-shell"), every time. I check: `claude --version` of the CLI
Autark runs is 2.1.303 or later, or `codex --version` is 0.167.0-alpha.3.2, 0.171.0-alpha.13, 0.171.0 or 0.172.0; the session's row in the table
managed_paths of the data database is 'ready', not 'pending' (a turn the restart cut); nothing but Autark writes to
that transcript. I fix it: a cold first turn after
an update of Claude Code or Codex is expected until Autark lists the new version; a lasting 'pending' row comes from
turns that end with the runtime – the next turn that ends normally seals the session again.

Fewer Claude Code starts in the background: while agents work, Autark reads each Claude plan's limits every minute,
and each reading started two Claude Code processes (`auth status` and a short probe) – on a PC with three plans the
most frequent program starts of the app. A reading now starts only the probe while the plan's last `auth status`
said signed in less than 10 minutes ago and the probe reads the limits through that sign-in; a probe without limits,
or one that reads another e-mail or plan (a switch to Free shows at the next reading), asks `auth status` as before; only
a switch between Max and Ultra, which the probe cannot tell apart, shows up to 10 minutes later. A sign-in, a new
connection or the quota details opened by the person always ask it. And while agents work, only the plan each engine
takes next and a plan a turn runs on are read every minute (Codex: every 15 s); plans in reserve are read every 5 minutes
and show as stale only after 7 – a plan that comes to the front because the one before it ran out is read at once. The
quota details the person opens still read every plan. Nothing to put right.

Known limitation on Linux (not new): where no Secret Service runs (no gnome-keyring or KWallet), secrets are kept
with Chromium's built-in default key instead of a key of the person's keyring, and Autark shows no repair page for it.

**Secrets on Linux without a keyring.** Shows as: nothing in the app; on Linux, `secret-tool` or a keyring app finds no
Secret Service. I check: whether gnome-keyring or KWallet runs in the person's session. I fix it: the person installs
gnome-keyring or KWallet and signs in again; secrets saved after that are kept with the keyring's key.

## 0.3.18

What changed: linked PCs and phones keep each other current by themselves – a message a shaky connection lost arrives
within two minutes, and once from the start after either PC changes version. Who works where travels as a pulse of a few
characters and leaves the live bar within seconds when it stops; a context fold shows there as "Folding its context".
Every window and phone notices a dead connection by itself and loads everything again. Settings no longer get lost
between PCs on different versions. Codex keeps itself current like Claude Code, so a provider's new models appear by
themselves. Card numbers and other secrets on web pages and in screen readings are masked by their label and their
grouping now, not only in their exact stored form. On an employee's PC the company's name and the person's name come from
the company every time the link is up. Settings › Security offers two modes: Trust AI mode – the open system of
before, which every existing PC keeps, so agents still operate the lock screen and Windows prompts themselves – and
Secure mode, which closes capabilities behind switches and asks the person; it is only ever on when the person chooses
it. After each version change the personal manager wakes with these notes and checks the company.

**Secure mode on without the person choosing it.** Shows as: Settings › Security shows Secure mode, or agents are asked
for steps they did freely before, although nobody switched it. I check: the security section of settings.json and the
chats for the person's word on it. I fix it: nothing on my own – I tell the person in one line which mode is on and
that Trust AI mode is the one this PC had before; the person switches.

**A card number in plain digits in our notes.** Shows as: before this version a card number could reach an agent in plain
digits when a page or a form showed it grouped ("4111 1111 …") or as a field's value; an agent may have written it into a
memory note, a file or a chat line, or written itself a workaround such as "no screenshot while a card form is open".
I check: memory.browse, files.search and chat.search across our company for groups of digits that form a card number,
and for such workaround notes. I fix it: the digits become the secret's ID (secrets.list names it), a line of mine I edit
with chat.edit, a note I rewrite, and a workaround note I delete – the masking does that job now.

**The newest ChatGPT models missing.** Shows as: models.list lacks the newest GPT models of a ChatGPT plan. I check:
which Codex this PC runs – a copy under %LOCALAPPDATA%\OpenAI\Codex\bin\ (or inside Codex.app on a Mac) belongs to the
Codex desktop app. I fix it: a Codex from its installer or from npm updates itself within a few hours of this start, and
the models follow; the Codex desktop app's own copy updates only when that app is opened, so there I tell the person in
one line that opening the Codex app once brings the new models.

**"company-2" or a PC's name instead of our company's name on an employee's PC.** Shows as: on a PC that joined our
company as an employee, the company menu names the company after its folder or after one of our PCs. I check:
devices.list – each employee PC's caps.version. I fix it: an employee PC on this version takes our name and its person's
name from us by itself within two minutes; to the person of one that still runs an older version I say in one line that
updating Autark there puts it right.

## 0.3.17

- Windows: Opt in to signing in after a restart using a password from the
  secrets catalog. No password is stored or used unless you enable the
  feature. The broker stops retrying after a rejected password or repeated
  failures. The screen locks by default once Autark starts.
- Development: Standard runtime tests use loopback instead of LAN
  listeners. Real WebRTC and Windows TCP checks still run explicitly in CI.
