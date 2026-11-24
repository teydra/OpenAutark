$ErrorActionPreference='Stop'
if ($env:USERNAME -ne 'dnpro') { exit 0 }
$root='C:\dnpro'; $out="$root\out"
New-Item -ItemType Directory -Path $out -Force | Out-Null
$log="$out\session.log"
function Log([string]$m){ ('{0:HH:mm:ss} {1}' -f (Get-Date),$m) | Add-Content -LiteralPath $log -Encoding UTF8 }
function Stage([string]$s){ Set-Content -LiteralPath "$out\stage.txt" -Value $s; Log "== $s" }
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent,IntPtr child);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
  private delegate bool EnumProc(IntPtr hwnd, IntPtr arg);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr arg);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr h, EnumProc callback, IntPtr arg);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode)]
  private static extern IntPtr ReadButton(IntPtr h,uint m,IntPtr n,StringBuilder s,uint flags,uint ms,out IntPtr result);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW")]
  private static extern IntPtr SendButton(IntPtr h,uint m,IntPtr w,IntPtr l,uint flags,uint ms,out IntPtr result);
  [DllImport("user32.dll", EntryPoint="PostMessageW", SetLastError=true)]
  private static extern bool PostButton(IntPtr h,uint m,IntPtr w,IntPtr l);
  public static IntPtr[] VisibleWindows(uint expectedPid) {
    var windows = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr unused) {
      uint pid;
      if (IsWindowVisible(h) && !IsIconic(h) && GetWindowThreadProcessId(h, out pid)!=0 && pid==expectedPid) windows.Add(h);
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
  public static string Title(IntPtr h){ var s=new StringBuilder(256); GetWindowText(h,s,256); return s.ToString(); }
  public static bool QueueFinish(IntPtr parent,IntPtr button,uint expectedPid) {
    uint pp,bp;
    return GetForegroundWindow()==parent && IsChild(parent,button)
      && GetWindowThreadProcessId(parent,out pp)!=0 && pp==expectedPid
      && GetWindowThreadProcessId(button,out bp)!=0 && bp==expectedPid
      && IsWindowVisible(button) && IsWindowEnabled(button)
      && PostButton(button,0x00F5,IntPtr.Zero,IntPtr.Zero);
  }
  public class Button { public IntPtr Handle; public string Caption; }
  public static Button[] Buttons(IntPtr parent) {
    var buttons=new List<Button>();
    EnumChildWindows(parent,delegate(IntPtr hwnd, IntPtr unused) {
      if (!IsWindowVisible(hwnd) || !IsWindowEnabled(hwnd)) return true;
      var name=new StringBuilder(32);
      if (GetClassName(hwnd,name,name.Capacity)==0 || !String.Equals(name.ToString(),"Button",StringComparison.OrdinalIgnoreCase)) return true;
      var text=new StringBuilder(256);
      IntPtr result;
      if (ReadButton(hwnd,0x000D,(IntPtr)text.Capacity,text,2,500,out result)!=IntPtr.Zero && result!=IntPtr.Zero)
        buttons.Add(new Button { Handle=hwnd, Caption=text.ToString().Replace("&","").Trim() });
      return true;
    }, IntPtr.Zero);
    return buttons.ToArray();
  }
  public static bool Checked(IntPtr h) {
    IntPtr result;
    return SendButton(h,0x00F0,IntPtr.Zero,IntPtr.Zero,2,700,out result)!=IntPtr.Zero && result==(IntPtr)1;
  }
  public static bool Click(IntPtr h) {
    IntPtr result;
    return IsWindowVisible(h) && IsWindowEnabled(h) && SendButton(h,0x00F5,IntPtr.Zero,IntPtr.Zero,2,1200,out result)!=IntPtr.Zero;
  }
}
"@
[void][W]::SetProcessDPIAware()
$sid=(Get-Process -Id $PID).SessionId
$phases=[ordered]@{}
$script:shots=0; $script:uacShots=0
$minW=1920; $minH=1024

function Shot([string]$name,[switch]$Print){
  $b=[Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp=[Drawing.Bitmap]::new($b.Width,$b.Height); $g=[Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($b.Left,$b.Top,0,0,$b.Size)
    $sample=@(foreach($x in 1..7){foreach($y in 1..7){$bmp.GetPixel([int](($b.Width-1)*$x/8),[int](($b.Height-1)*$y/8)).ToArgb()}})
    $blank=(@($sample | Sort-Object -Unique).Count -le 1)
    $bmp.Save((Join-Path $out $name),[Drawing.Imaging.ImageFormat]::Png)
  } finally { $g.Dispose(); $bmp.Dispose() }
  Log "shot $name $($b.Width)x$($b.Height) blank=$blank"
  if ($Print) {
    if ($b.Width -lt $minW -or $b.Height -lt $minH) { throw "Native desktop $($b.Width)x$($b.Height) is below print size." }
    if ($blank) { throw "Capture appears blank: $name" }
  }
}
function Dbg([string]$label){ $script:shots++; try { Shot ("dbg-{0:00}-{1}.png" -f $script:shots,$label) } catch { Log "dbg shot failed: $($_.Exception.Message)" } }

# ---------- Chrome DevTools protocol (driving the app's own UI) ----------
$script:ws=$null; $script:cid=0
function CdpConnect([string]$url){
  $w=[Net.WebSockets.ClientWebSocket]::new()
  $w.ConnectAsync([Uri]$url,[Threading.CancellationToken]::None).Wait()
  $script:ws=$w
}
function Cdp([string]$method,$params=@{}){
  $script:cid++; $my=$script:cid
  $msg=(@{id=$my;method=$method;params=$params} | ConvertTo-Json -Depth 20 -Compress)
  $bytes=[Text.Encoding]::UTF8.GetBytes($msg)
  $script:ws.SendAsync([ArraySegment[byte]]::new($bytes),[Net.WebSockets.WebSocketMessageType]::Text,$true,[Threading.CancellationToken]::None).Wait()
  $cts=[Threading.CancellationTokenSource]::new(60000)
  while($true){
    $sb=[Text.StringBuilder]::new(); $buf=New-Object byte[] 65536
    do {
      $t=$script:ws.ReceiveAsync([ArraySegment[byte]]::new($buf),$cts.Token); $t.Wait()
      [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf,0,$t.Result.Count))
    } while(-not $t.Result.EndOfMessage)
    $text=$sb.ToString()
    if ($text -notmatch ('"id":'+$my+'[,}]')) { continue }
    $o=$text | ConvertFrom-Json
    if ($o.error) { throw "CDP $method failed: $($o.error.message)" }
    return $o.result
  }
}
function Js([string]$expr){
  $r=Cdp 'Runtime.evaluate' @{expression=$expr;returnByValue=$true;awaitPromise=$true}
  if ($r.exceptionDetails) { throw "JS error: $($r.exceptionDetails.text) $($r.exceptionDetails.exception.description)" }
  return $r.result.value
}
$findJs=@'
(() => {
  const want = __TEXT__, mode = __MODE__;
  const norm = s => (s||'').replace(/\s+/g,' ').trim();
  const vis = e => { const r=e.getBoundingClientRect(); if(r.width<2||r.height<2) return false; const st=getComputedStyle(e); if(st.visibility==='hidden'||st.display==='none'||st.opacity==='0') return false; return r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth; };
  const sel='button,[role=button],[role=option],[role=menuitem],[role=tab],a,label,summary,li,[role=radio],[role=checkbox]';
  const all=[...document.querySelectorAll(sel)].filter(vis);
  const text=e=>norm(e.innerText||e.textContent);
  let m=all.filter(e=>text(e)===want||norm(e.getAttribute('aria-label'))===want);
  if(!m.length) m=all.filter(e=>text(e).startsWith(want));
  if(!m.length&&mode==='contains') m=all.filter(e=>text(e).includes(want));
  if(!m.length) return null;
  m.sort((a,b)=>text(a).length-text(b).length);
  const e=m[0]; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect();
  return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,disabled:!!e.disabled||e.getAttribute('aria-disabled')==='true',tag:e.tagName};
})()
'@
function Find([string]$text,[string]$mode='start'){
  $js=$findJs.Replace('__TEXT__',(ConvertTo-Json $text -Compress)).Replace('__MODE__',(ConvertTo-Json $mode -Compress))
  return (Js $js)
}
function MouseClick($x,$y){
  [void](Cdp 'Input.dispatchMouseEvent' @{type='mouseMoved';x=$x;y=$y})
  [void](Cdp 'Input.dispatchMouseEvent' @{type='mousePressed';x=$x;y=$y;button='left';clickCount=1})
  [void](Cdp 'Input.dispatchMouseEvent' @{type='mouseReleased';x=$x;y=$y;button='left';clickCount=1})
}
function ClickText([string]$text,[int]$timeout=40,[string]$mode='start'){
  $until=(Get-Date).AddSeconds($timeout)
  do {
    $f=Find $text $mode
    if ($f -and -not $f.disabled) { MouseClick $f.x $f.y; Log "clicked '$text'"; return $true }
    Start-Sleep -Milliseconds 700
  } while((Get-Date) -lt $until)
  Log "NOT clickable: '$text' ($(if($f){'disabled'}else{'absent'}))"
  return $false
}
function Key([string]$key,[int]$vk){
  [void](Cdp 'Input.dispatchKeyEvent' @{type='rawKeyDown';key=$key;code=$key;windowsVirtualKeyCode=$vk})
  [void](Cdp 'Input.dispatchKeyEvent' @{type='keyUp';key=$key;code=$key;windowsVirtualKeyCode=$vk})
}
function PageText { return [string](Js 'document.body ? document.body.innerText : ""') }
function WaitText([string]$needle,[int]$timeout=40){
  $until=(Get-Date).AddSeconds($timeout)
  do { if ((PageText).Contains($needle)) { return $true }; Start-Sleep -Milliseconds 800 } while((Get-Date) -lt $until)
  return $false
}
$dumpJs=@'
(() => {
  const vis=e=>{const r=e.getBoundingClientRect();return r.width>1&&r.height>1};
  const norm=s=>(s||'').replace(/\s+/g,' ').trim().slice(0,90);
  return JSON.stringify({
    title:document.title, url:location.href.slice(0,80), w:innerWidth, h:innerHeight,
    buttons:[...document.querySelectorAll('button,[role=button],[role=option],[role=menuitem],[role=tab]')].filter(vis).map(e=>norm(e.innerText||e.getAttribute('aria-label'))).filter(Boolean).slice(0,60),
    inputs:[...document.querySelectorAll('input,textarea,[contenteditable=true],[role=textbox]')].filter(vis).map(e=>[e.tagName,e.type||'',norm(e.getAttribute('placeholder')),norm(e.getAttribute('aria-label')),(e.value||'').length].join('|')).slice(0,20),
    dialogs:[...document.querySelectorAll('[role=dialog],dialog,[aria-modal=true]')].filter(vis).map(e=>norm(e.innerText)).slice(0,5),
    text:(document.body?document.body.innerText:'').replace(/\s+/g,' ').slice(0,2500)
  });
})()
'@
function Dump([string]$label){ try { Log ("DOM[$label] " + (Js $dumpJs)) } catch { Log "DOM dump failed: $($_.Exception.Message)" } }
function TypeInto([string]$labelText,[string]$value){
  $js=@'
(() => { const norm=s=>(s||'').replace(/\s+/g,' ').trim(); const want=__L__;
 const lab=[...document.querySelectorAll('label')].find(l=>norm(l.innerText).startsWith(want)); if(!lab) return null;
 const i=lab.querySelector('input,textarea')||document.getElementById(lab.htmlFor); if(!i) return null;
 i.scrollIntoView({block:'center'}); const r=i.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()
'@.Replace('__L__',(ConvertTo-Json $labelText -Compress))
  $f=Js $js
  if (!$f) { Log "field not found: $labelText"; return $false }
  MouseClick $f.x $f.y
  [void](Cdp 'Input.insertText' @{text=$value})
  Log "typed into '$labelText'"
  return $true
}


# ---------- the model of this run: Work and Decisions use the hosted model ----------
$script:wantModel='deepseek/deepseek-v4.1-flash'
function FindWf {
  foreach($base in @("$env:APPDATA\Autark Companies","$env:APPDATA","$env:LOCALAPPDATA\Programs\Autark")) {
    $f=Get-ChildItem -Path $base -Recurse -Depth 4 -Filter wf.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($f) { return $f.FullName }
  }
  return $null
}
function EnsureModel {
  $want=$script:wantModel
  $tree=@(Get-ChildItem -Path "$env:APPDATA\Autark Companies" -Recurse -Depth 2 -Directory -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch 'Cache|Partitions|Storage|blob|GPU|Shader|DIPS|Network|Dictionary' } | ForEach-Object { $_.FullName.Replace("$env:APPDATA\",'') })
  Log "data folders: $($tree -join ' | ')"
  $wf=FindWf
  Log "wf: $wf"
  $modelId="openrouter:$want"
  if ($wf) {
    $ml=(& $wf call models.list 2>&1 | Out-String)
    try {
      $parsed=$ml | ConvertFrom-Json
      $items=@(if($parsed.models){$parsed.models}else{$parsed})
      $hit=@($items | Where-Object { $_.id -like "*$want" })
      Log "models.list: $($items.Count) models; matching: $((@($hit | ForEach-Object id)) -join ', ')"
      if ($hit.Count) { $modelId=[string]$hit[0].id }
    } catch { Log "models.list not parsed: $($ml.Substring(0,[Math]::Min(300,$ml.Length)))" }
    foreach($u in 'work','decision'){
      $r=(& $wf call models.setUse (@{use=$u;value=$modelId} | ConvertTo-Json -Compress) 2>&1 | Out-String)
      Log "setUse $u -> $modelId : $($r.Substring(0,[Math]::Min(500,$r.Length)).Replace("`n",' '))"
    }
    $phases['model-set']="wf $modelId"
    return
  }
  $files=@(Get-ChildItem -Path "$env:APPDATA\Autark Companies" -Recurse -Depth 3 -Filter settings.json -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch 'Cache|Partitions|Storage' })
  Log "settings.json: $(($files | ForEach-Object FullName) -join ' | ')"
  if (!$files.Count) { throw 'Neither wf nor settings.json found.' }
  foreach($f in $files) {
    $t=[IO.File]::ReadAllText($f.FullName)
    $n=[regex]::Replace($t,'("(?:work|decision)"\s*:\s*)"auto"',('$1"'+$modelId+'"'))
    if ($n -ne $t) { [IO.File]::WriteAllText($f.FullName,$n); Log "patched routing in $($f.FullName)" } else { Log "no auto routing in $($f.FullName)" }
  }
  $phases['model-set']="settings.json $modelId"
}

# ---------- installer ----------
function WindowFor([string]$name) {
  foreach($p in (Get-Process -Name $name -ErrorAction SilentlyContinue)) { if ($p.MainWindowHandle -ne [IntPtr]::Zero) { return $p.MainWindowHandle } }
  [IntPtr]::Zero
}
function AppLogs {
  $n=0
  foreach($root in @("$env:APPDATA","$env:LOCALAPPDATA")) {
    foreach($f in (Get-ChildItem -Path $root -Recurse -Include *.log -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'Autark' -and $_.Length -lt 8MB } | Sort-Object LastWriteTime -Descending | Select-Object -First 4)) {
      $n++; try { Get-Content -LiteralPath $f.FullName -Tail 250 | Set-Content -LiteralPath "$outpp-$n.log" -Encoding UTF8; Log "app log $n = $($f.Name) ($($f.Length) bytes)" } catch {}
    }
  }
}
function Step([string]$name,[scriptblock]$body){
  Stage $name
  try { . $body; if (-not $phases.Contains($name)) { $phases[$name]='PASS' } }
  catch { Log "STEP $name FAILED: $($_.Exception.Message)"; $phases[$name]="FAIL: $($_.Exception.Message)"; try { Dump "$name-fail"; Dbg "$name-fail" } catch {} }
}
function FinishAll([string]$result){ Set-Content -LiteralPath "$out\phases.json" -Value ($phases | ConvertTo-Json); Set-Content -LiteralPath "$out\session.done" -Value $result; exit 0 }

try {
  Stage 'session-start'
  Log "session id $sid, user $env:USERNAME"
  $until=(Get-Date).AddSeconds(90)
  while((Get-Date) -lt $until -and !(Get-Process explorer -ErrorAction SilentlyContinue | Where-Object SessionId -eq $sid)) { Start-Sleep -Seconds 2 }
  Start-Sleep -Seconds 12
  $sizes=@([Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.Bounds.Width)x$($_.Bounds.Height)" })
  Log "Session desktop sizes: $($sizes -join ', ')"
  Set-Content "$out\session-environment.json" (@{sessionDesktopSizes=$sizes;sessionId=$sid} | ConvertTo-Json)
  Dbg 'desktop-before'

  $installer="$root\autark-windows-x64.exe"
  $exe="$env:LOCALAPPDATA\Programs\Autark\Autark.exe"
  $expected='A5DF9BE7632EF95488FD477E00E3777547F0C24B56332069C557AD12E8FC8081'
  $sig=Get-AuthenticodeSignature -FilePath $installer
  if ((Get-FileHash -LiteralPath $installer).Hash -cne $expected -or $sig.Status -ne 'Valid') { throw 'Installer integrity check failed in session.' }
  $phases['installer-verified']='PASS'

  Stage 'installer'
  $setup=Start-Process -FilePath $installer -PassThru
  $shown=$false; $scope=$false; $began=$false; $finished=$false; $next=0
  $deadline=[DateTime]::UtcNow.AddMinutes(8); $lastProgress=[DateTime]::UtcNow
  do {
    $hwnd=WindowFor 'autark-windows-x64'
    if ($hwnd -ne [IntPtr]::Zero -and !$finished) {
      $windowPid=[uint32]0
      [void][W]::GetWindowThreadProcessId($hwnd,[ref]$windowPid)
      if ($windowPid -ne $setup.Id) { throw 'Wizard is not owned by the verified installer process.' }
      if ([W]::GetForegroundWindow() -ne $hwnd) { [void][W]::SetForegroundWindow($hwnd); Start-Sleep -Milliseconds 600 }
      if (!$shown) {
        Start-Sleep -Milliseconds 1500
        Log "wizard title: $([W]::Title($hwnd))"
        Shot '01-installer-setup.png' -Print; $shown=$true
      }
      $buttons=@([W]::Buttons($hwnd))
      $choice=@($buttons | Where-Object Caption -Match '^(?:Only for me|Install for me)(?:$|\s|\()')
      $all=@($buttons | Where-Object Caption -Match '(?i)anyone|all users')
      if ($choice.Count -or $all.Count) {
        if ($choice.Count -ne 1 -or $all.Count -ne 1) { throw 'Cannot identify both install scopes.' }
        if (![W]::Checked($choice[0].Handle) -or [W]::Checked($all[0].Handle)) { throw 'Default per-user scope was not confirmed; do not proceed.' }
        $scope=$true
      }
      $action=@($buttons | Where-Object Caption -Match '^(Finish|Install|Next(?:\s*>){0,2})$')
      if ($action.Count -gt 1) { throw 'Ambiguous wizard buttons.' }
      if ($action.Count -eq 1) {
        if ([W]::GetForegroundWindow() -ne $hwnd) { throw 'Installer lost foreground; do not click.' }
        $label=$action[0].Caption
        if (!$scope) { throw 'Cannot proceed without explicit per-user scope.' }
        if ($label -eq 'Finish') {
          if (!$began -and $next -lt 2) { throw 'Unexpected finish state.' }
          if (!(Test-Path -LiteralPath $exe) -or (Test-Path "$env:ProgramFiles\Autark\Autark.exe")) { throw 'Finish page has no confirmed per-user program.' }
          $v=[Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion
          if ($v -notmatch '^0\.3\.18(?:\.0)?$' -or (Get-AuthenticodeSignature -LiteralPath $exe).Status -ne 'Valid') { throw 'Finish page has no verified installed 0.3.18.' }
          $began=$true
          Start-Sleep -Milliseconds 800
          Shot '02-installer-fertig.png' -Print
          Log "finish page buttons: $(($buttons | ForEach-Object Caption) -join ' / ')"
          $run=@($buttons | Where-Object Caption -Match '^Run Autark')
          if ($run.Count -eq 1) {
            Log "Run Autark checked on finish page: $([W]::Checked($run[0].Handle))"
            if ([W]::Checked($run[0].Handle)) { [void][W]::Click($run[0].Handle); Start-Sleep -Milliseconds 800 }
            Log "Run Autark checked after click: $([W]::Checked($run[0].Handle))"
          }
          if (![W]::QueueFinish($hwnd,$action[0].Handle,[uint32]$setup.Id)) { throw 'Could not queue Finish on the verified foreground wizard.' }
          $finished=$true
          if (!$setup.WaitForExit(75000)) { throw 'Verified installer did not exit after Finish.' }
          break
        } elseif ($label -eq 'Install') {
          if ($began) { throw 'Second Install action.' }; $began=$true
        } else {
          $next++; if ($began -or $next -gt 4) { throw 'Unexpected navigation state.' }
        }
        if (![W]::Click($action[0].Handle)) { throw 'Confirmed wizard action did not respond.' }
        Log "Wizard action: $label"
        $lastProgress=[DateTime]::UtcNow
        Start-Sleep -Seconds 2
      }
    }
    if (!$began -and ([DateTime]::UtcNow-$lastProgress).TotalSeconds -gt 240) { throw "No recognized wizard action. shown=$shown scope=$scope next=$next." }
    $consent=@(Get-Process consent -ErrorAction SilentlyContinue)
    if ($consent.Count -and $script:uacShots -lt 3) {
      $script:uacShots++
      Log "UAC consent prompt visible (consent.exe x$($consent.Count))"
      try { Start-Sleep -Milliseconds 800; Shot ("uac-{0:00}-prompt.png" -f $script:uacShots) } catch { Log "uac shot failed: $($_.Exception.Message)" }
      [Windows.Forms.SendKeys]::SendWait('%y'); Log 'sent Alt+Y to the consent prompt'
      Start-Sleep -Seconds 3
    }
    if (!$began -and ([DateTime]::UtcNow-$lastProgress).TotalSeconds -gt 8 -and (([int]([DateTime]::UtcNow-$lastProgress).TotalSeconds) % 10) -lt 1) { if (!$script:progressShot) { $script:progressShot=$true; try { Shot '02-installation-laeuft.png' -Print } catch { Log "progress shot failed: $($_.Exception.Message)" } } else { Dbg 'wizard-wait' }; Log "foreground: $([W]::Title([W]::GetForegroundWindow()))" }
    Start-Sleep -Milliseconds 500
    $setup.Refresh()
  } while (!$setup.HasExited -and [DateTime]::UtcNow -lt $deadline)
  if (!$setup.HasExited -or $setup.ExitCode -ne 0 -or !$finished) { throw "Interactive setup did not finish successfully. Install=$began; Finish=$finished; Exited=$($setup.HasExited)." }
  $info=[Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
  $exeSign=Get-AuthenticodeSignature -FilePath $exe
  if ($info.ProductVersion -notmatch '^0\.3\.18(?:\.0)?$' -or $exeSign.Status -ne 'Valid') { throw 'Unexpected app version or signature.' }
  $phases['installer-ui']='PASS'; $phases['installed-version']=$info.ProductVersion; $phases['installed-signature']=[string]$exeSign.Status
  Log "installed $($info.ProductVersion) signature $($exeSign.Status)"

  # ---------- first start ----------
  Stage 'first-start'
  Start-Sleep -Seconds 6
  $auto=@(Get-Process Autark -ErrorAction SilentlyContinue)
  Log "Autark processes started by the installer: $($auto.Count)"
  if ($auto.Count) { Log 'installer started the app anyway: restarting it with the debugging port'; $auto | Stop-Process -Force; Start-Sleep -Seconds 4 }
  $app=Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222' -PassThru
  $target=$null
  $until=(Get-Date).AddSeconds(120)
  do {
    Start-Sleep -Seconds 2
    try {
      $list=Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/list' -TimeoutSec 3
      $target=@($list | Where-Object { $_.type -eq 'page' -and $_.webSocketDebuggerUrl -and $_.url -notmatch '^devtools:' -and $_.url -notmatch '/float' }) | Select-Object -First 1
    } catch { $target=$null }
  } while(!$target -and (Get-Date) -lt $until)
  if (!$target) { Dbg 'no-cdp'; throw 'App UI not reachable through the debugging port.' }
  Log "page target: title='$($target.title)' url=$($target.url) all=$((@($list | ForEach-Object { $_.type + ':' + $_.url }) -join ' ; '))"
  Log ("prompt umlaut check: " + ('Prioritätenliste').Contains([string][char]0xE4))
  CdpConnect $target.webSocketDebuggerUrl
  [void](Cdp 'Runtime.enable')
  # Maximize the verified app window
  $found=$null
  foreach($p in (Get-Process -Name Autark -ErrorAction SilentlyContinue)) {
    if ($p.Path -ine $exe -or $p.SessionId -ne $sid) { continue }
    foreach($h in [W]::VisibleWindows([uint32]$p.Id)) {
      $r=New-Object W+Rect; if (![W]::GetWindowRect($h,[ref]$r)) { continue }
      if (($r.Right-$r.Left) -ge 400 -and ($r.Bottom-$r.Top) -ge 300) { $found=$h }
    }
  }
  if (!$found) { Dbg 'no-window'; throw 'No visible Autark window of the verified installation.' }
  [void][W]::ShowWindow($found,3); [void][W]::SetForegroundWindow($found)
  Start-Sleep -Seconds 3
  if ((WaitText 'stopped while starting' 15)) { Log 'app reports a start failure'; Dump 'start-failure'; AppLogs; [void](ClickText 'Try again' 5); Start-Sleep -Seconds 20 }
  if (!(WaitText 'Set up a new company' 90)) { AppLogs; Dump 'first-start-missing'; Dbg 'first-start-missing'; throw 'First-start card not shown.' }
  Start-Sleep -Seconds 2
  Dump 'first-start'
  Shot '03-erststart.png' -Print
  $phases['first-start']='PASS'

  # ---------- AI choice ----------
  Step 'ai' {
  [void](ClickText 'Set up a new company')
  Start-Sleep -Seconds 3
  Dbg 'after-setup-click'
  Dump 'after-setup-click'
  # the intro video plays over the AI card: close it
  foreach($i in 1..4) {
    $d=Js '[...document.querySelectorAll("[role=dialog],dialog,[aria-modal=true]")].filter(e=>e.getBoundingClientRect().width>1).length'
    if (!$d) { break }
    Key 'Escape' 27; Start-Sleep -Seconds 2
  }
  if (!(WaitText 'Local server' 40)) { Dump 'ai-missing'; Dbg 'ai-missing'; throw 'AI card not shown.' }
  Start-Sleep -Seconds 2
  Dump 'ai-card'
  Dbg 'ai-card'
  if (!(ClickText 'API key' 20 'exact')) { throw 'API key button not clickable.' }
  Start-Sleep -Seconds 2
  Dump 'api-form'
  # the form starts on OpenAI: pick OpenRouter (fills its own address)
  if (!(ClickText 'OpenAI' 10 'exact')) { throw 'Provider list not clickable.' }
  Start-Sleep -Seconds 1
  Dump 'provider-list'
  if (!(ClickText 'OpenRouter' 10 'start')) { throw 'OpenRouter not in the provider list.' }
  Start-Sleep -Seconds 1
  Log ('form url now: ' + (Js '(document.querySelector("input[type=url]")||{}).value'))
  # the key comes from a one-time file the host wrote for this user; it is typed, never logged
  $keyFile="$root\or.key"
  if (!(Test-Path -LiteralPath $keyFile)) { throw 'No key file for this session.' }
  $orKey=(Get-Content -LiteralPath $keyFile -Raw).Trim()
  Remove-Item -LiteralPath $keyFile -Force
  if ($orKey.Length -lt 20) { throw 'Key file is empty.' }
  if (!(TypeInto 'API key' $orKey)) { throw 'API key field not found.' }
  $orKey=$null
  Start-Sleep -Seconds 1
  Log ('key field length: ' + (Js '(document.querySelector("input[type=password]")||{}).value.length'))
  if (!(ClickText 'Test')) { throw 'Test button not clickable.' }
  $ok=WaitText ' models' 60
  Log "test found model list: $ok"
  Start-Sleep -Seconds 1
  Dump 'api-form-tested'
  Shot '04-ki-auswahl.png' -Print
  $phases['ai-api-key-test']=$(if($ok){'PASS'}else{'FAIL'})
  if (!(ClickText 'Add' 10 'exact')) { throw 'Add button not clickable.' }
  Start-Sleep -Seconds 3
  Dump 'api-added'
  Dbg 'api-added'
  Shot '04b-ki-verbunden.png' -Print
  $phases['ai-api-key-added']='PASS'
  EnsureModel
  }
  # ---------- About you -> Start ----------
  Step 'about' {
  if (!(ClickText 'Continue' 40)) { throw 'Continue not clickable.' }
  Start-Sleep -Seconds 3
  [void](TypeInto 'Your name' 'Testperson')
  [void](TypeInto 'Company' 'Demo GmbH')
  Dump 'about'
  # keep this invented test company out of the public library
  [void](ClickText 'Public library' 5 'start')
  Start-Sleep -Milliseconds 800
  Dbg 'about-filled'
  if (!(ClickText 'Start' 20 'exact')) { throw 'Start not clickable.' }
  }
  Step 'manager' {
  Start-Sleep -Seconds 8
  Dump 'after-start'
  Dbg 'after-start'

  # spotlight tour and other overlays: dismiss with Escape up to 3 times, then look at the page
  foreach($i in 1..3) { Key 'Escape' 27; Start-Sleep -Seconds 1 }
  Dump 'after-escape'
  # wait until the Manager's own answer to the start text is done (text stops changing)
  $prev=''; $stable=0; $until=(Get-Date).AddMinutes(6)
  while((Get-Date) -lt $until -and $stable -lt 4) {
    Start-Sleep -Seconds 6
    $t=PageText
    if ($t -eq $prev) { $stable++ } else { $stable=0; $prev=$t }
  }
  Dump 'manager-settled'
  Dbg 'manager-settled'

  }
  # ---------- first task ----------
  Step 'task' {
  $label=[string](Js '(()=>{const e=[...document.querySelectorAll("button")].find(b=>/^Auto /.test((b.innerText||"").trim())||/deepseek/i.test(b.innerText||""));return e?e.innerText:""})()')
  Log "composer model label: $label"
  if ($label -notmatch 'deepseek') { try { EnsureModel; Start-Sleep -Seconds 4; Log ('composer model label after: ' + [string](Js '(()=>{const e=[...document.querySelectorAll("button")].find(b=>/deepseek|Auto /.test(b.innerText||""));return e?e.innerText:""})()')) } catch { Log "EnsureModel failed: $($_.Exception.Message)" } }
  $prompt='Erstelle aus diesen drei frei erfundenen Arbeitsständen eine kurze Prioritätenliste mit Begründung: Anleitung fertig; Testexport blockiert durch fehlende Beispieldatei; Farben fürs Demo-Dashboard noch offen. Arbeite nur mit diesen Angaben, ohne Werkzeuge oder Internet.'
  $box=Js @'
(() => { const vis=e=>{const r=e.getBoundingClientRect();return r.width>40&&r.height>10};
  const c=[...document.querySelectorAll('textarea,[contenteditable=true],[role=textbox]')].filter(vis); if(!c.length) return null;
  const e=c[c.length-1]; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()
'@
  if (!$box) { Dump 'no-composer'; Dbg 'no-composer'; throw 'No chat input found.' }
  MouseClick $box.x $box.y
  [void](Cdp 'Input.insertText' @{text=$prompt})
  Start-Sleep -Seconds 1
  Dbg 'prompt-typed'
  Key 'Enter' 13
  Log 'prompt sent'
  $sentAt=Get-Date
  Start-Sleep -Seconds 4
  $lenAtSend=(PageText).Length
  $prev=''; $stable=0; $answered=$false; $tick=0; $sawWorking=$false
  while(((Get-Date)-$sentAt).TotalMinutes -lt 40) {
    Start-Sleep -Seconds 6
    $t=PageText
    $busy=[bool](Js '[...document.querySelectorAll("button")].some(b=>(b.innerText||"").trim()==="Stop")') -or $t.Contains('Working')
    if ($busy) { $sawWorking=$true }
    if ($t -eq $prev) { $stable++ } else { $stable=0; $prev=$t }
    $tick++; if (($tick % 10) -eq 0) { Dbg 'task-progress' }
    if (-not $busy -and $stable -ge 3 -and $t.Length -gt ($lenAtSend + 300) -and ($sawWorking -or ((Get-Date)-$sentAt).TotalSeconds -gt 90)) { $answered=$true; break }
  }
  Dump 'task-end'
  if (!$answered) { throw 'No settled answer to the first task.' }
  Start-Sleep -Seconds 2
  Shot '05-erster-auftrag.png' -Print
  }
  Stage 'done'
  $bad=@($phases.Keys | Where-Object { [string]$phases[$_] -like 'FAIL*' })
  if ($bad.Count) { FinishAll ('FAIL steps: ' + ($bad -join ',')) } else { FinishAll 'OK' }
} catch {
  Log "SESSION FAILED: $($_.Exception.Message)"
  Log ($_.ScriptStackTrace)
  try { Dbg 'failure' } catch {}
  FinishAll "FAIL $($_.Exception.Message)"
}
