# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: **Security → Report a vulnerability** in this repository
(a private advisory that only the maintainers see). Do not open a public issue for them.

Helpful in a report: the Autark version (Settings → About), the operating system, what an attacker can reach or do, and
the steps to see it. You get an answer within a few days; a fix ships as a normal update, which installed apps pick up
by themselves.

## What is in scope

- The desktop app and its downloads in this repository's releases (Windows, Mac, Linux), the Android app and the web app
  a PC serves to a phone.
- The connection between your own devices (end-to-end encrypted; the meeting point only forwards encrypted bytes).
- The release workflows in `.github/workflows/` and the automatic merge of `library/` pull requests.
- Anything in `library/` that exposes a secret or personal data: report it the same way, and it is removed at once.

## How Autark handles secrets

- Sign-ins to AI plans go through the providers' own command-line tools; Autark does not read their tokens. Between your
  own PCs they travel only inside the encrypted device link.
- Stored secrets are encrypted with the system keychain (Windows DPAPI, macOS Keychain, the Linux secret service).
  Agents see a secret's ID, never its value; logs and prompts carry no secret values.
- Every download is listed with its SHA-256 in `SHA256SUMS.txt`, and the updater checks the SHA-512 of each update file
  before it installs it.
- Autark's own access values are masked like stored secrets (see "Masking what a tool prints" below): the owner token of
  the running app, the owner tokens in the `runtime.json` of every company on the PC and the wake key in `wake.json`.

## Masking what a tool prints

Everything an agent's tool prints – `shell.exec` (stdout and stderr), `files.read`, every other tool result – passes one
redactor (`SecretVault.redact`) before it goes to the model provider, the run journal, a chat or the log. The redactor
knows the stored secrets (shown as `secret://<id>`), the shape of common API keys (`‹secret:stripe-live›` …) and, since
0.3.23, Autark's own access values:

| Value | Where it comes from | Shown as |
| --- | --- | --- |
| Owner token of this app (launch token) | known at start | `‹secret:runtime-token›` |
| Owner token of every company on this PC | `token` in each `runtime.json` (this company, the first one and every `<first> Companies/<id>`) | `‹secret:runtime-token›` |
| Wake helper's private key | `key.pkcs8` in each `wake.json` | `‹secret:wake-key›` |

`runtime.json` and `wake.json` themselves are not changed: the `wf` command line, the app and the wake helper read them as
before; only what leaves through a tool or into a journal row is masked, so a printed `runtime.json` reads
`{"port":…,"token":"‹secret:runtime-token›","pid":…}`. The marks are no handles – nothing can resolve them. A restarted
company writes a new token; the files are looked at again at most once a second (a stat per file, a read only when it
changed), and the last three values per file stay masked, because an old one may still stand in a note.

Known limits – the masking finds a value, not an intention:

- **Split or re-encoded values.** The raw value and its base64, base64url, URL-encoded, hex and spaced/grouped spellings
  are found. A value cut over lines (more than a few separator characters in a row, or a line break inside), written
  in another encoding (gzip, XOR, rot13, reversed, one character per output line) or computed from the value is not.
- **Values shorter than 8 characters** are not masked (they would match ordinary text).
- **About one second.** A token written less than a second before a tool prints it is not yet known; a company that
  starts and whose file is printed within the same second can show its new token once.
- **Other places.** Only Autark's own tool and chat paths are masked. A shell, an editor or a script outside Autark, a
  command that sends the file somewhere without printing it (`curl --data @runtime.json`), and the person's own tools
  see the files as before; the file permissions of `runtime.json` (owner only) are the protection there. A token that
  was printed before this masking existed stays in the transcripts it was printed in; restarting the app issues a new one.
- **The in-memory person token** (`personToken`, never written to a file) and device keys are not part of this list.

## Secure mode: known limits

Secure mode makes agents ask before they reach something new. With the web on **Chosen sites** an agent opens a new
site only after you allow it, and the browsers it drives (its own and the tabs it drives in your side pane) hold back
any move of the page to a site that is not open yet – a link, a form, the page's own script and every hop of a
redirect. "Allow once" opens a site for that one call. Some ways out remain, and you should know them:

- **Content inside a page.** The guard watches where the page itself goes, not what an allowed page loads or sends:
  frames, images, scripts and the page's own requests (fetch, XHR, WebSocket) go wherever that page wants. A site you
  allow is trusted with whatever the agent types into it – including sites that host anyone's content (code hosts,
  paste sites, file shares, forms).
- **Search text.** A web search is always open, so the words of a search reach the search provider without asking.
- **Subdomains on "Always".** Allowing a site for good also opens all its subdomains, and `www.` counts as the site
  itself: allowing `www.example.com` opens `*.example.com`.
- **Codex with files open everywhere.** With Files set to all folders, Codex turns run without its sandbox (full
  access): a command that runs reaches the network without the per-site question. Keep Files on chosen folders to keep the sandbox.
- **Your own Chrome.** An agent that works in your own Chrome or Edge window does so through the screen (the Computer
  switch). The web guard does not see that window; what an agent does there is limited only by the Computer switch.

## Signing

The Windows installer is not yet signed with a publisher certificate, and the Mac app is ad-hoc signed without Apple
notarization. The checksums above are the way to verify a download until then.
