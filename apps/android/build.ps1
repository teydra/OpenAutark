# Owns: one bounded build on the shared PC: the preview (debug) build by default; with -Release the APK signed with the
# release key from outside the repo (new-release-key.ps1 made it), checked with apksigner, copied to
# app/build/outputs/apk/release/autark-android.apk with its record autark-android.json (version, SHA-256, signer), which
# the release PC's publish scripts take; with -Lite also autark-android-lite.apk (no AccessibilityService) for the website.
# APKs are the site flavor (they download and install their own update: REQUEST_INSTALL_PACKAGES, UpdateReceiver); Play
# bundles are the play flavor (neither – Play updates them). Every build first bundles the feedback video page
# (16.11.2026 F15: apps/desktop/scripts/tour-page.mjs, esbuild as the desktop build) into app/build/generated/tour/tour.html,
# which the APK carries as assets/tour.html (app/build.gradle), and the interface (owner 27.11.2026: apps/desktop's
# `node scripts/build.mjs --only ui`, its app/ui copied to app/build/generated/ui/ui with its list ui.json from
# scripts/ui-list.mjs, carried as assets/ui/); a release APK without either fails. A newer interface is published apart,
# file by file into the versioned release, with apps/desktop's `node scripts/ui-publish.mjs --tag vX.Y.Z --key-env AUTARK_UI_KEY` (README). Never: installs,
# publishes or restarts Autark, or prints or stores the key's password.
param(
    [switch]$Release,
    # With -Release: also the Play bundles (AAB) – autark-android-play.aab (full, with the in-app disclosure) and
    # autark-android-play-lite.aab (buildType playLite: no AccessibilityService) – jarsigner-checked against the APK's signer.
    [switch]$Bundle,
    # With -Release: also the website APK without phone use (buildType playLite) – autark-android-lite.apk with its record
    # autark-android-lite.json; the build fails if its manifest still names an AccessibilityService. Play Protect blocks
    # sideloaded apps that ask for accessibility (08.11.2026, Samsung: "App blocked to protect your device").
    [switch]$Lite,
    # Where new-release-key.ps1 put the key; the default is the same folder.
    [string]$KeyFolder = (Join-Path $env:USERPROFILE '.autark-release/android')
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$repository = [IO.Path]::GetFullPath((Join-Path $root '../..'))
$lock = Join-Path $repository '.local/einfach/tc.lock'
$debugSigner = '97630dc5'  # start of the preview's debug certificate SHA-256 (README): a release APK must not carry it

function Invoke-Native([string]$file, [string[]]$arguments) {
    # Windows PowerShell otherwise treats a tool's stderr notes as terminating errors, even on exit 0.
    $ErrorActionPreference = 'Continue'
    $output = & $file @arguments 2>&1 | ForEach-Object { $_.ToString() }
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    return @{ code = $code; output = @($output) }
}

[IO.Directory]::CreateDirectory((Split-Path $lock)) | Out-Null
try { New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null }
catch { throw "Another heavy check owns $lock. Run this build after that check finishes." }
try {
    & (Join-Path $root 'test.ps1')
    # The feedback video before pairing (IntroTour.java): the PC tour's phone variant as one page, from apps/desktop.
    $tourPage = Join-Path $root 'app/build/generated/tour/tour.html'
    $tour = Invoke-Native 'node' @((Join-Path $repository 'apps/desktop/scripts/tour-page.mjs'), $tourPage)
    $tour.output | ForEach-Object { $_ }
    if ($tour.code -ne 0 -or -not (Test-Path -LiteralPath $tourPage -PathType Leaf)) { throw 'The feedback video page (tour.html) was not built; run npm install in apps/desktop once.' }
    # The app's own interface (owner 27.11.2026; relay/UiFiles answers it on the company's origin): the desktop's UI build,
    # copied whole to app/build/generated/ui/ui, which the APK carries as assets/ui/.
    $desktop = Join-Path $repository 'apps/desktop'
    Push-Location $desktop
    try { $ui = Invoke-Native 'node' @('scripts/build.mjs', '--only', 'ui') } finally { Pop-Location }
    $ui.output | ForEach-Object { $_ }
    $uiBuilt = Join-Path $desktop 'app/ui'
    if ($ui.code -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $uiBuilt 'index.html') -PathType Leaf)) { throw 'The interface (apps/desktop/app/ui) was not built; run npm install in apps/desktop once.' }
    $uiAssets = Join-Path $root 'app/build/generated/ui'
    if (Test-Path -LiteralPath $uiAssets) { Remove-Item -LiteralPath $uiAssets -Recurse -Force }
    [IO.Directory]::CreateDirectory($uiAssets) | Out-Null
    Copy-Item -LiteralPath $uiBuilt -Destination (Join-Path $uiAssets 'ui') -Recurse
    # Its list (owner 27.11.2026, relay/UiUpdate): ui.json with every file's sha256, so a later interface is fetched file by
    # file and only what changed; the APK's own list needs no signature (the APK's is enough).
    $list = Invoke-Native 'node' @((Join-Path $desktop 'scripts/ui-list.mjs'), (Join-Path $uiAssets 'ui'))
    $list.output | ForEach-Object { $_ }
    if ($list.code -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $uiAssets 'ui/ui.json') -PathType Leaf)) { throw 'The interface list (assets/ui/ui.json) was not written.' }
    $gradle = Join-Path $root 'gradlew.bat'
    if (-not (Test-Path -LiteralPath $gradle -PathType Leaf)) { throw 'Gradle wrapper is missing.' }
    $signer = Join-Path $env:ANDROID_HOME 'build-tools/36.0.0/apksigner.bat'
    if (-not (Test-Path -LiteralPath $signer -PathType Leaf)) { throw 'Android Build Tools 36.0.0 apksigner is missing.' }

    if ($Release) {
        $keystore = Join-Path $KeyFolder 'autark-release.jks'
        $secret = Join-Path $KeyFolder 'autark-release.password'
        if (-not (Test-Path -LiteralPath $keystore -PathType Leaf) -or -not (Test-Path -LiteralPath $secret -PathType Leaf)) {
            throw "No release key in $KeyFolder. Make it once with new-release-key.ps1 (and keep a backup: without it no later APK updates the installed app)."
        }
        if ($KeyFolder.StartsWith($repository, [StringComparison]::OrdinalIgnoreCase)) { throw 'The release key belongs outside the repository.' }
        # The password is stored DPAPI-protected for this Windows user (new-release-key.ps1).
        $secure = Get-Content -LiteralPath $secret | ConvertTo-SecureString
        $env:AUTARK_ANDROID_KEYSTORE = $keystore
        $env:AUTARK_ANDROID_KEYSTORE_PASSWORD = [Net.NetworkCredential]::new('', $secure).Password
        $env:AUTARK_ANDROID_KEY_ALIAS = 'autark'
        try {
            $tasks = @(':app:assembleSiteRelease', ':app:lintSiteRelease')
            if ($Bundle) { $tasks += ':app:bundlePlayRelease', ':app:bundlePlayPlayLite' }
            if ($Lite) { $tasks += ':app:assembleSitePlayLite', ':app:lintSitePlayLite' }
            $run = Invoke-Native $gradle (@('-p', $root) + $tasks + @('--no-daemon', '--max-workers=1'))
        } finally {
            Remove-Item Env:AUTARK_ANDROID_KEYSTORE_PASSWORD, Env:AUTARK_ANDROID_KEYSTORE, Env:AUTARK_ANDROID_KEY_ALIAS -ErrorAction SilentlyContinue
        }
        $run.output | ForEach-Object { $_ }
        if ($run.code -ne 0) { throw "Android release build failed (exit $($run.code))." }
        $outputs = Join-Path $root 'app/build/outputs/apk/release'
        [IO.Directory]::CreateDirectory($outputs) | Out-Null
        $built = Join-Path $root 'app/build/outputs/apk/site/release/app-site-release.apk'
        if (-not (Test-Path -LiteralPath $built -PathType Leaf)) { throw 'No signed app-site-release.apk (an unsigned build means the key was not passed in).' }
        $aapt = Join-Path $env:ANDROID_HOME 'build-tools/36.0.0/aapt2.exe'
        # A website APK carries its own updater; without it, the installed app could never update in place again.
        foreach ($apkFile in @($built) + $(if ($Lite) { @(Join-Path $root 'app/build/outputs/apk/site/playLite/app-site-playLite.apk') } else { @() })) {
            $siteTree = Invoke-Native $aapt @('dump', 'xmltree', '--file', 'AndroidManifest.xml', $apkFile)
            if ($siteTree.code -ne 0) { throw "aapt2 could not read the manifest of $apkFile." }
            if (-not ($siteTree.output -match 'REQUEST_INSTALL_PACKAGES') -or -not ($siteTree.output -match 'UpdateReceiver')) { throw "$apkFile lacks its own updater (REQUEST_INSTALL_PACKAGES, UpdateReceiver)." }
            # The feedback video before pairing travels in the APK (IntroTour shows none without it).
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $zip = [IO.Compression.ZipFile]::OpenRead($apkFile)
            try {
                $hasTour = @($zip.Entries | Where-Object { $_.FullName -eq 'assets/tour.html' }).Count -gt 0
                $hasUi = @($zip.Entries | Where-Object { $_.FullName -eq 'assets/ui/index.html' -or $_.FullName -eq 'assets/ui/ui.json' }).Count -eq 2
            } finally { $zip.Dispose() }
            if (-not $hasTour) { throw "$apkFile lacks assets/tour.html (the feedback video)." }
            if (-not $hasUi) { throw "$apkFile lacks assets/ui/index.html or its list ui.json (the app's own interface)." }
        }
        $check = Invoke-Native $signer @('verify', '--verbose', '--print-certs', $built)
        $check.output | ForEach-Object { $_ }
        if ($check.code -ne 0) { throw 'APK signature verification failed.' }
        $line = $check.output | Where-Object { $_ -match 'certificate SHA-256 digest: ([0-9a-f]{64})' } | Select-Object -First 1
        if (-not $line -or $line -notmatch 'certificate SHA-256 digest: ([0-9a-f]{64})') { throw 'apksigner printed no certificate digest.' }
        $certificate = $Matches[1]
        if ($certificate.StartsWith($debugSigner)) { throw 'The release APK carries the debug key.' }
        $gradleText = Get-Content -LiteralPath (Join-Path $root 'app/build.gradle') -Raw
        if ($gradleText -notmatch "(?m)^\s*versionCode = (\d+)\s*$") { throw 'versionCode not found in build.gradle.' }
        $versionCode = [int]$Matches[1]
        if ($gradleText -notmatch "(?m)^\s*versionName = '([^']+)'\s*$") { throw 'versionName not found in build.gradle.' }
        $versionName = $Matches[1]
        $apk = Join-Path $outputs 'autark-android.apk'
        Copy-Item -LiteralPath $built -Destination $apk -Force
        $sha = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
        $record = [ordered]@{
            versionCode = $versionCode; versionName = $versionName; sha256 = $sha; bytes = (Get-Item -LiteralPath $apk).Length
            signer = $certificate; debugSigner = $debugSigner; signatureVerified = $true; builtAt = (Get-Date).ToUniversalTime().ToString('o')
        }
        # UTF-8 without BOM and LF: python's json reads it either way, the repo keeps LF.
        [IO.File]::WriteAllText((Join-Path $outputs 'autark-android.json'), (($record | ConvertTo-Json) -replace "`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
        Write-Output "autark-android.apk $versionName (versionCode $versionCode) sha256 $sha signer $certificate"
        if ($Lite) {
            $liteBuilt = Join-Path $root 'app/build/outputs/apk/site/playLite/app-site-playLite.apk'
            if (-not (Test-Path -LiteralPath $liteBuilt -PathType Leaf)) { throw 'No signed app-site-playLite.apk.' }
            $liteCheck = Invoke-Native $signer @('verify', '--verbose', '--print-certs', $liteBuilt)
            if ($liteCheck.code -ne 0) { throw 'Lite APK signature verification failed.' }
            if (-not ($liteCheck.output -match "certificate SHA-256 digest: $certificate")) { throw 'The lite APK carries another certificate than the full APK.' }
            $tree = Invoke-Native $aapt @('dump', 'xmltree', '--file', 'AndroidManifest.xml', $liteBuilt)
            if ($tree.code -ne 0) { throw 'aapt2 could not read the lite manifest.' }
            if ($tree.output -match 'BIND_ACCESSIBILITY_SERVICE|accessibilityservice|UseService|UseDisclosure') { throw 'The lite APK still declares phone use (AccessibilityService).' }
            $liteApk = Join-Path $outputs 'autark-android-lite.apk'
            Copy-Item -LiteralPath $liteBuilt -Destination $liteApk -Force
            $liteSha = (Get-FileHash -LiteralPath $liteApk -Algorithm SHA256).Hash.ToLowerInvariant()
            $liteRecord = [ordered]@{
                versionCode = $versionCode; versionName = $versionName; channel = 'lite'; buildType = 'playLite'; accessibilityService = $false
                sha256 = $liteSha; bytes = (Get-Item -LiteralPath $liteApk).Length; signer = $certificate; signatureVerified = $true
                builtAt = (Get-Date).ToUniversalTime().ToString('o')
            }
            [IO.File]::WriteAllText((Join-Path $outputs 'autark-android-lite.json'), (($liteRecord | ConvertTo-Json) -replace "`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
            Write-Output "autark-android-lite.apk $versionName (versionCode $versionCode) sha256 $liteSha signer $certificate (no AccessibilityService)"
        }
        if ($Bundle) {
            $jarsigner = Join-Path $env:JAVA_HOME 'bin/jarsigner.exe'
            $keytool = Join-Path $env:JAVA_HOME 'bin/keytool.exe'
            $bundles = [ordered]@{}
            foreach ($entry in @(@('full', 'bundle/playRelease/app-play-release.aab', 'autark-android-play.aab'), @('lite', 'bundle/playPlayLite/app-play-playLite.aab', 'autark-android-play-lite.aab'))) {
                $source = Join-Path $root ('app/build/outputs/' + $entry[1])
                if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "No bundle $($entry[1])." }
                $verify = Invoke-Native $jarsigner @('-verify', $source)
                if ($verify.code -ne 0 -or -not ($verify.output -match 'jar verified')) { throw "Bundle $($entry[2]) is not signed or fails jarsigner." }
                $print = Invoke-Native $keytool @('-printcert', '-jarfile', $source)
                $fingerprint = ($print.output | Where-Object { $_ -match 'SHA256:\s*([0-9A-F:]{95})' } | Select-Object -First 1)
                if (-not $fingerprint -or $fingerprint -notmatch 'SHA256:\s*([0-9A-F:]{95})') { throw "keytool printed no certificate digest for $($entry[2])." }
                $bundleSigner = ($Matches[1] -replace ':', '').ToLowerInvariant()
                if ($bundleSigner -ne $certificate) { throw "Bundle $($entry[2]) carries another certificate than the APK." }
                $target = Join-Path $outputs $entry[2]
                Copy-Item -LiteralPath $source -Destination $target -Force
                $bundles[$entry[0]] = [ordered]@{ file = $entry[2]; sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = (Get-Item -LiteralPath $target).Length; signer = $bundleSigner; jarsignerVerified = $true }
            }
            $bundleRecord = [ordered]@{ versionCode = $versionCode; versionName = $versionName; bundles = $bundles; builtAt = (Get-Date).ToUniversalTime().ToString('o') }
            [IO.File]::WriteAllText((Join-Path $outputs 'autark-android-play.json'), (($bundleRecord | ConvertTo-Json -Depth 4) -replace "`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
            foreach ($name in $bundles.Keys) { Write-Output "$($bundles[$name].file) sha256 $($bundles[$name].sha256) signer $($bundles[$name].signer)" }
        }
    } else {
        $run = Invoke-Native $gradle @('-p', $root, ':app:assembleSiteDebug', ':app:lintSiteDebug', '--no-daemon', '--max-workers=1')
        $run.output | ForEach-Object { $_ }
        if ($run.code -ne 0) { throw "Android build or lint failed (exit $($run.code))." }
        $apk = Join-Path $root 'app/build/outputs/apk/site/debug/app-site-debug.apk'
        $check = Invoke-Native $signer @('verify', '--verbose', '--print-certs', $apk)
        $check.output | ForEach-Object { $_ }
        if ($check.code -ne 0) { throw 'APK signature verification failed.' }
        Get-FileHash -LiteralPath $apk -Algorithm SHA256
    }
} finally {
    # This lock is the exact directory created above; it contains no files.
    Remove-Item -LiteralPath $lock -ErrorAction Stop
}
