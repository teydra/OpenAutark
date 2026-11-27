# Owns: making the interface key once (owner 27.11.2026: a phone app takes a fetched interface only under this key's
# signature – apps/desktop/scripts/ui-list.mjs signs ui.json, ui-publish.mjs publishes it): an Ed25519 pair made with
# Node's crypto; the private half as ui-key.pem (PKCS8) beside the release key, in %USERPROFILE%\.autark-release\ui,
# readable by this Windows user only; the public half printed as base64url of its raw 32 bytes, for the apps' constant
# (Android relay/UiUpdate.PUBLIC_KEY, the iPhone app's own – docs/ARCHITECTURE.md §8). Run it once by hand, then keep
# the file in a safe second place (a password manager). Never: overwrites an existing key (every app built with the
# public half would refuse lists signed by a new one until it is updated), prints the private half, or writes into the
# repository.
param([string]$KeyFolder = (Join-Path $env:USERPROFILE '.autark-release/ui'))
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$KeyFolder = [IO.Path]::GetFullPath($KeyFolder)
if ($KeyFolder.StartsWith($repository, [StringComparison]::OrdinalIgnoreCase)) { throw 'The interface key belongs outside the repository.' }
$key = Join-Path $KeyFolder 'ui-key.pem'
if (Test-Path -LiteralPath $key) { throw "An interface key already exists: $key. It stays: the apps carry its public half." }
New-Item -ItemType Directory -Force -Path $KeyFolder | Out-Null
# Only this user reads the folder, before the key is in it.
& icacls $KeyFolder /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'icacls could not limit the key folder to this user.' }
# Node writes the private half straight to the file (it never passes through this script) and prints the public half.
$script = @'
const { generateKeyPairSync } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const pair = generateKeyPairSync('ed25519');
writeFileSync(process.argv[1], pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx' });
process.stdout.write(pair.publicKey.export({ format: 'jwk' }).x);
'@
$public = & node -e $script $key
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $key)) { throw 'node could not make the key.' }
Write-Output "Interface key made: $key. Back it up now: without it no later list reaches the phones that carry its public half."
Write-Output "Public half for the apps' constant (Android relay/UiUpdate.PUBLIC_KEY, the iPhone app's own): $public"
