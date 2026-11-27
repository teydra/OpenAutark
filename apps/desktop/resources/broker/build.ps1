# Builds AutarkDesktopBroker.exe next to this script with the csc.exe of .NET Framework 4.x (no SDK).
# The computer-use part is cut out of ../computer/windows-helper.ps1 (between "$source = @'" and "'@"), so the
# broker and the PowerShell helper answer every op from one source. Same inputs give the same exe behaviour; the
# script prints the SHA-256 of the inputs and of the exe. B-080: the exe ships unpacked (package.json asarUnpack) and the
# service runs it from here (install.ps1 beside it), so every app update brings the new broker along.
#   powershell -NoProfile -ExecutionPolicy Bypass -File resources\broker\build.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $framework 'csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe of .NET Framework 4.x not found at $csc" }

$helper = Join-Path $here '..\computer\windows-helper.ps1'
$text = [IO.File]::ReadAllText($helper)
$start = $text.IndexOf("`$source = @'")
$end = $text.IndexOf("`n'@", $start)
if ($start -lt 0 -or $end -lt 0) { throw 'The C# block of windows-helper.ps1 was not found.' }
$body = $text.Substring($start, $end - $start)
$body = $body.Substring($body.IndexOf("`n") + 1)

$obj = Join-Path ([IO.Path]::GetTempPath()) ('autark-broker-build-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $obj | Out-Null
$helperCs = Join-Path $obj 'Helper.cs'
[IO.File]::WriteAllText($helperCs, $body, (New-Object Text.UTF8Encoding($false)))

$out = Join-Path $here 'AutarkDesktopBroker.exe'
$wpf = Join-Path $framework 'WPF'
$references = @(
  (Join-Path $framework 'System.dll'), (Join-Path $framework 'System.Core.dll'), (Join-Path $framework 'System.Drawing.dll'),
  (Join-Path $framework 'System.ServiceProcess.dll'),
  (Join-Path $wpf 'UIAutomationClient.dll'), (Join-Path $wpf 'UIAutomationTypes.dll'), (Join-Path $wpf 'WindowsBase.dll')
) | ForEach-Object { "/reference:$_" }
$sources = @((Join-Path $here 'Broker.cs'), (Join-Path $here 'Worker.cs'), (Join-Path $here 'SignIn.cs'), (Join-Path $here 'Waker.cs'), (Join-Path $here 'ShellJob.cs'), $helperCs)

& $csc /nologo /target:exe /platform:anycpu /optimize+ /unsafe /warn:4 "/out:$out" $references $sources
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
Remove-Item -Recurse -Force $obj

# The slim wake helper (0.3.22): AutarkWakeHelper.exe from WakeHelper.cs alone – it replaces the Node helper (113 MB) for "Wake while
# closed" on Windows; the broker starts it for the signed-in person and falls back to the Node helper when it is missing. It needs
# System.Numerics (BigInteger: the .NET Framework has no Ed25519/X25519) and nothing else. winexe: no console window.
$wakeOut = Join-Path $here 'AutarkWakeHelper.exe'
$wakeSource = Join-Path $here 'WakeHelper.cs'
$wakeReferences = @('System.dll', 'System.Core.dll', 'System.Numerics.dll') | ForEach-Object { '/reference:' + (Join-Path $framework $_) }
& $csc /nologo /target:winexe /platform:anycpu /optimize+ /warn:4 "/out:$wakeOut" $wakeReferences $wakeSource
if ($LASTEXITCODE -ne 0) { throw "csc failed for AutarkWakeHelper.exe with exit code $LASTEXITCODE" }

foreach ($file in @($helper, (Join-Path $here 'Broker.cs'), (Join-Path $here 'Worker.cs'), (Join-Path $here 'SignIn.cs'), (Join-Path $here 'Waker.cs'), (Join-Path $here 'ShellJob.cs'), $out, $wakeSource, $wakeOut)) {
  '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 $file).Hash.ToLowerInvariant(), (Split-Path -Leaf $file)
}
