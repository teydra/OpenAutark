$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or $env:GITHUB_REPOSITORY -ne 'teydra/OpenAutark') { throw 'Hosted Windows fixture only.' }
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
$root='C:\dnpro'; $out="$root\out"
$screens=Join-Path $env:RUNNER_TEMP 'dotnetpro-first-install/screens'
New-Item -ItemType Directory -Path $root,$out,$screens -Force | Out-Null
$hostLog="$out\host.log"
function Log([string]$m){ ('{0:HH:mm:ss} {1}' -f (Get-Date),$m) | Add-Content -LiteralPath $hostLog }
function Say([string]$m){ Write-Host $m; Log $m }
function ConsoleShot([string]$name){
  try {
    $b=[Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp=[Drawing.Bitmap]::new($b.Width,$b.Height); $g=[Drawing.Graphics]::FromImage($bmp)
    try { $g.CopyFromScreen($b.Left,$b.Top,0,0,$b.Size); $bmp.Save("$out\$name",[Drawing.Imaging.ImageFormat]::Png) } finally { $g.Dispose(); $bmp.Dispose() }
  } catch { Log "console shot failed: $($_.Exception.Message)" }
}
$failed=$false
try {
  $os=Get-CimInstance Win32_OperatingSystem
  $sizes=@([Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.Bounds.Width)x$($_.Bounds.Height)" })
  @{edition=$os.Caption;version=$os.Version;build=$os.BuildNumber;consoleDesktopSizes=$sizes;image=$env:ImageVersion} | ConvertTo-Json | Set-Content "$out\environment.json"
  Say "Console desktop: $($sizes -join ', ')"
  # Fresh target and public installer
  $locations=@("$env:ProgramFiles\Autark","$env:APPDATA\Autark","$env:APPDATA\Autark Companies","$env:LOCALAPPDATA\Programs\Autark")
  if (@($locations | Where-Object {Test-Path -LiteralPath $_}).Count -ne 0 -or (Get-Process Autark -ErrorAction SilentlyContinue) -or (Get-Service AutarkDesktopBroker -ErrorAction SilentlyContinue)) { throw 'Runner is not a fresh Autark target.' }
  $installer="$root\autark-windows-x64.exe"
  $uri='https://github.com/teydra/OpenAutark/releases/download/v0.3.18/autark-windows-x64.exe'
  $expected='A5DF9BE7632EF95488FD477E00E3777547F0C24B56332069C557AD12E8FC8081'
  curl.exe --fail --silent --show-error --location $uri --output $installer
  if ($LASTEXITCODE) { throw 'Public download failed.' }
  $hash=(Get-FileHash -LiteralPath $installer).Hash
  $sig=Get-AuthenticodeSignature -FilePath $installer
  if ($hash -cne $expected -or $sig.Status -ne 'Valid' -or $sig.SignerCertificate.Issuer -notmatch 'Certum') { throw 'Public installer failed integrity or publisher check.' }
  @{url=$uri;sha256=$hash;authenticode=[string]$sig.Status;issuer=$sig.SignerCertificate.Issuer;timestamped=[bool]$sig.TimeStamperCertificate;length=(Get-Item $installer).Length} | ConvertTo-Json | Set-Content "$out\installer-verification.json"
  Say 'Public 0.3.18 digest and Authenticode: PASS.'

  # Small local model server (llama.cpp, CPU) on 127.0.0.1:8080 - no key, no account
  $tag='b12669'
  $llamaZip="$root\llama.zip"
  curl.exe --fail --silent --show-error --location "https://github.com/ggml-org/llama.cpp/releases/download/$tag/llama-$tag-bin-win-cpu-x64.zip" --output $llamaZip
  if ($LASTEXITCODE) { throw 'llama.cpp download failed.' }
  Expand-Archive -LiteralPath $llamaZip -DestinationPath "$root\llama" -Force
  $model="$root\model.gguf"
  curl.exe --fail --silent --show-error --location --retry 3 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf' --output $model
  if ($LASTEXITCODE) { throw 'Model download failed.' }
  $server=(Get-ChildItem "$root\llama" -Recurse -Filter llama-server.exe | Select-Object -First 1).FullName
  if (!$server) { throw 'llama-server.exe missing.' }
  $srv=Start-Process -FilePath $server -ArgumentList @('-m',$model,'--alias','qwen2.5-1.5b-instruct','--host','127.0.0.1','--port','8080','-c','32768','-np','1','--jinja','-t','4') -WindowStyle Hidden -PassThru -RedirectStandardOutput "$out\llama-out.log" -RedirectStandardError "$out\llama-err.log"
  $ready=$false
  foreach($i in 1..90){ Start-Sleep -Seconds 2; try { if ((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/health -TimeoutSec 3).StatusCode -eq 200) { $ready=$true; break } } catch {} }
  if (!$ready) { throw 'Local model server did not become ready.' }
  Say 'Local model server ready on 127.0.0.1:8080.'

  # Remote Desktop loopback: a 1920x1080 session for a local test user
  Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
  Enable-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue
  Set-Service TermService -StartupType Manual -ErrorAction SilentlyContinue
  Start-Service TermService -ErrorAction SilentlyContinue
  try { reg add 'HKLM\SOFTWARE\Microsoft\ServerManager' /v DoNotOpenServerManagerAtLogon /t REG_DWORD /d 1 /f 2>&1 | ForEach-Object { Log "reg: $_" } } catch { Log "ServerManager flag not set: $($_.Exception.Message)" }
  $pw='Aa1!'+(([guid]::NewGuid().ToString('N')).Substring(0,20))
  Write-Host "::add-mask::$pw"
  $secure=ConvertTo-SecureString $pw -AsPlainText -Force
  $user='dnpro'
  New-LocalUser -Name $user -Password $secure -PasswordNeverExpires -AccountNeverExpires -FullName 'Testnutzer' | Out-Null
  Add-LocalGroupMember -Group 'Remote Desktop Users' -Member $user
  Add-LocalGroupMember -Group 'Administrators' -Member $user
  $pol='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
  $uac=Get-ItemProperty $pol
  Log "UAC policy before: EnableLUA=$($uac.EnableLUA) ConsentPromptBehaviorAdmin=$($uac.ConsentPromptBehaviorAdmin) ConsentPromptBehaviorUser=$($uac.ConsentPromptBehaviorUser) PromptOnSecureDesktop=$($uac.PromptOnSecureDesktop) FilterAdministratorToken=$($uac.FilterAdministratorToken)"
  icacls $root /grant 'Users:(OI)(CI)M' /T /Q | Out-Null
  Copy-Item "$PSScriptRoot\session.ps1" "$root\session.ps1" -Force
  Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -Name DnproSession -Value 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\dnpro\session.ps1'
  $tsk='HKCU:\Software\Microsoft\Terminal Server Client'
  New-Item $tsk -Force | Out-Null
  Set-ItemProperty $tsk -Name AuthenticationLevelOverride -Value 0 -Type DWord
  cmdkey /generic:TERMSRV/127.0.0.2 /user:$user /pass:$pw | Out-Null
  $mstsc=Start-Process mstsc.exe -ArgumentList '/v:127.0.0.2','/w:1920','/h:1080' -PassThru
  Say 'Remote Desktop client started (1920x1080 requested).'
  $deadline=(Get-Date).AddMinutes(45); $shot=0; $lastStage=''
  while ((Get-Date) -lt $deadline -and !(Test-Path "$out\session.done")) {
    Start-Sleep -Seconds 10
    if (Test-Path "$out\stage.txt") { $s=(Get-Content "$out\stage.txt" -Raw).Trim(); if ($s -ne $lastStage) { Say "stage: $s"; $lastStage=$s } }
    if ((++$shot % 12) -eq 0 -and $shot -le 36) { ConsoleShot ("console-{0:00}.png" -f $shot) }
    if ($mstsc.HasExited) { Say 'mstsc exited'; break }
  }
  quser 2>&1 | Out-File "$out\quser.txt"
  if (!(Test-Path "$out\session.done")) { throw 'Session script did not finish.' }
  $res=(Get-Content "$out\session.done" -Raw).Trim()
  Say "session result: $res"
  if ($res -notmatch '^OK') { $failed=$true }
} catch {
  $failed=$true
  Say "HOST FAILED: $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber): $($_.InvocationInfo.Line.Trim())"
  ConsoleShot 'console-fail.png'
} finally {
  Get-ChildItem $out -File | Copy-Item -Destination $screens -Force
}
if ($failed) { exit 1 }
