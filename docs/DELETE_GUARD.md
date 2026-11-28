# Delete guard: files.delete and the shell.exec check

Why: on 24.11. and 27.11.2026 an agent ran `cmd /c "rd /s /q C:\Users\…\AppData\Roaming\Autark Companies\…"` on Windows.
cmd split the unquoted path at its space, and `rd` deleted `…\Roaming\Autark`, the first company's data folder. A rule in
a prompt did not stop it twice, so the product now refuses such deletes by itself.

## What is protected (files/delete-zones.ts)

**Kept folders.** Nothing may delete such a folder, a folder that holds one (an ancestor such as AppData, the home folder or
a drive), or anything inside one:

- every company's data folder: the first one (`<appData>/Autark`), `<appData>/Autark Companies` with every other company
  and this PC's plan logins, and this company's own data folder and accounts folder;
- the app's installation and resources (packaged builds; on macOS the `.app` bundle);
- the person's browser profiles: Chrome, Edge, Brave, Chromium, Vivaldi, Opera and Firefox (Windows, macOS, Linux), plus Safari on macOS.

**Open folders** are workspaces and scratch folders, some of them inside a kept folder (`<data>/workspace`, `<data>/tmp`).
Anything inside one may be deleted, one entry at a time. The folder itself stays. A wildcard at a workspace's top is refused.
At a scratch folder's top it is allowed. The home folder and `~/Workforce` count as open: their contents may go, the
folders themselves may not.

The innermost zone around a path decides. A filesystem root never goes. Paths are compared after resolving (`..` folded)
and, where they exist, as real paths too (links followed). On Windows and macOS the comparison ignores case.

**Data marks.** A folder anywhere that holds `workforce.db`, `Local State` or `profiles.ini` counts as a company or a
browser profile, even when it is a copy or a backup. files.delete refuses the whole folder before anything goes, unless
the call sets `dataCopy: true` for a throwaway copy inside the temp folder or a workspace (below).

## The structured way: files.delete (tools/builtin/files-delete.ts)

- `path` or `paths` (up to 20) takes literal absolute paths as JSON strings. No shell is in between, so spaces need no
  quotes. Relative paths, wildcards and leading or trailing spaces are refused.
- `dryRun: true` answers `WOULD DELETE <path> – N files in M folders, size, K links removed as links` and deletes nothing.
- Links: a link inside the target (a junction or symlink) is removed as the link alone and is never entered. A target
  that is itself a link loses only the link, even when it points to a kept folder. A path that passes a link on its way is refused, so the agent has to name
  the real path. Links above the home folder, temp, the workspace or the data folder are allowed, such as macOS `/var`.
- `dataCopy: true` lets a folder with a data mark go when it lies inside the temp folder or a workspace or scratch folder
  (a test's `workforce.db`, a copied browser profile). The refusal and the dry run name the switch. It never lifts a kept
  folder, a subfolder of one, the app, a real browser profile, or anything outside temp and the workspaces.
- A `\\?\` or `\\.\` prefix is taken off first: the same file, no wildcard.
- Each path gets its own result line: `DELETED`, `WOULD DELETE`, `REFUSED <why>` or `FAILED`. The call is an error when
  any path did not go.
- Category `delete`. Secure mode asks the `write` switch for each path (security/tool-gate.ts).
- Agents learn about it in three places: the More tools line (its description), tools.find keywords, and one fact line
  in "My environment" (context/environment.ts deleteLine).

## The layer in front of shell.exec (files/shell-deletes.ts, files/shell-words.ts)

Before a command starts, the guard reads its recognizable recursive deletes the way the shell would:

- **PowerShell** (shell.exec's shell on Windows): Remove-Item and its aliases (`rm ri rmdir rd del erase`) with
  `-Recurse` or any prefix of it. `rm -rf` and `rd /s` count too.
- **PowerShell pipelines:** Remove-Item after Get-ChildItem or Get-Item in a pipeline, also through `Where-Object { … }`, `Select-Object` or `Sort-Object`.
- **.NET:** `[IO.Directory]::Delete(…, $true)`.
- **cmd.exe** (`cmd /c` or `cmd /k`): `rd`/`rmdir /s` and `del`/`erase /s`. The line cmd receives is rebuilt the way
  PowerShell passes it, cmd's outer quotes are stripped, then the line is split at spaces, `, ; =` and `& && || |`.
  This is how the incident line becomes the targets `…\Roaming\Autark`, `Companies\…` and so on. Glued switches
  (`rd /s/q X`, `rd/s/q X`) and a leading `if [/i] [not] exist|defined|errorlevel …`, `else`, `do`, `call` or
  `for … %i in (…) do rd /s /q %i` are read too. A cmd line whose unquoted path with spaces would split into wrong targets
  (the words joined with spaces name an existing path or folder, or a relative word follows an absolute one) is blocked
  whatever it reaches; the answer says to put the path in quotes.
- **sh** (macOS, Linux): `rm` with `-r`, `-R` or `--recursive`, and `find … -delete`. Prefixes such as `sudo` and
  `command` and variable assignments are skipped.
- **Nested shells:** `pwsh -Command`, `-EncodedCommand`, `cmd /c` inside cmd, and `sh`/`bash -c`.
- **Paths:** targets resolve from the command's folder. `cd`, `Set-Location`, `pushd` and `cd /d` with a literal path
  move that folder. `$env:X`, `%X%`, `$HOME`, `~` and variables assigned literally earlier in the same command are
  expanded. A wildcard means "the contents of the folder before it".

If a target is a kept folder, holds one, lies inside one or reaches one through a link, the command does not start. The
answer is `BLOCKED – not executed. …` with the reason. When one statement had several targets, the answer also notes
that an unquoted path splits at its spaces, and it points to files.delete.

Everyday cleanups still run unchanged: deleting `node_modules`, `dist` or a worktree inside the workspace, quoted
`rd /s /q "…"`, `Remove-Item -Recurse -LiteralPath "…"`, `git worktree remove`, and the scratch and temp folders.

### Limits: this is a layer, not a sandbox

The guard sees only what it recognizes in the command text. It does **not** stop:

- bracket classes (`a[1]`, `[a-z]*`): read as a wildcard, so a workspace's whole contents count – a false alarm for a
  name with brackets, kept on purpose because `Auta[r]k` would match a kept folder;
- more than 64 targets in one command: only the first 64 are followed through links, the rest are compared as written;
- deletes through values the command computes (`Join-Path`, `$(…)`, loop variables, script blocks passed around);
- script files (`pwsh -File x.ps1`, `bash x.sh`) and aliases or functions defined along the way;
- other programs: python `shutil.rmtree`, node `fs.rm`, `robocopy /mir`, `git clean -fdx`, `Start-Process`, `bash -c`
  run from Windows (Git Bash paths);
- the engines' own shell tools (Claude Code Bash/PowerShell, Codex). They do not pass through shell.exec. In Trust mode
  Autark does not see their commands before they run. Covering them needs a separate step, for example a Claude Code
  PreToolUse hook and Codex's approval path calling the same check.

The real protection is the path check against the kept folders. The recognition only feeds targets into it, and it
fails open: a command it cannot read runs as before. Wiping one company's data folder on purpose is admin work and
stays possible through the product's own paths. `companies.remove` sends a company to the recycle bin. The updater and
`app.install` replace the installation. The person can also do it by hand. The guard offers no override argument, so
an agent cannot simply switch it off.
