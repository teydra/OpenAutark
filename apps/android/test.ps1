# Owns: small host-side Java tests. Never: substitutes for a real Android device test.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$java = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin' } else { '' }
$javac = if ($java) { Join-Path $java 'javac.exe' } else { 'javac' }
$runtime = if ($java) { Join-Path $java 'java.exe' } else { 'java' }
# The same BouncyCastle the app bundles (app/build.gradle), from Gradle's cache after the first build resolved it, else
# the identical 1.79 jar the Android SDK's command-line tools carry (a cleaned Gradle cache, 16.11.2026).
$bc = Get-ChildItem -Path (Join-Path $env:USERPROFILE '.gradle/caches/modules-2/files-2.1/org.bouncycastle/bcprov-jdk18on/1.79') -Recurse -Filter 'bcprov-jdk18on-1.79.jar' -ErrorAction SilentlyContinue | Select-Object -First 1
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
if (-not $bc -and $sdk) { $bc = Get-Item (Join-Path $sdk 'cmdline-tools/latest/lib/external/org/bouncycastle/bcprov-jdk18on/1.79/bcprov-jdk18on-1.79.jar') -ErrorAction SilentlyContinue }
if (-not $bc) { throw 'bcprov-jdk18on-1.79.jar is neither in the Gradle cache nor in the Android SDK''s cmdline-tools; run the Gradle build once.' }
# ZXing core for pair/QrDecode (app/build.gradle): Gradle's cache after a build, else build/test-libs/core-3.5.3.jar
# (fetched once from https://repo1.maven.org/maven2/com/google/zxing/core/3.5.3/core-3.5.3.jar, sha1 ca1349214a356cd7958651b2d5a0e1f3811a9c4b).
$zx = Get-ChildItem -Path (Join-Path $env:USERPROFILE '.gradle/caches/modules-2/files-2.1/com.google.zxing/core/3.5.3') -Recurse -Filter 'core-3.5.3.jar' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $zx) { $zx = Get-Item (Join-Path $root 'build/test-libs/core-3.5.3.jar') -ErrorAction SilentlyContinue }
if (-not $zx) { throw 'core-3.5.3.jar (ZXing) is neither in the Gradle cache nor in apps/android/build/test-libs; run the Gradle build once.' }
$out = Join-Path $root 'app/build/host-tests'
New-Item -ItemType Directory -Force $out | Out-Null
# F25: libwebrtc's Java classes (relay/WebRtcConfig: the RTCConfiguration and the silent logger run on a host JVM, the
# native library never does) from the AAR of app/build.gradle in Gradle's cache, else build/test-libs (fetched once from
# https://repo1.maven.org/maven2/ch/threema/webrtc-android/149.0.0/webrtc-android-149.0.0.aar, sha1 e344229582383d9745b88a67df03faf749b70136).
$rtcJar = Join-Path $out '../host-test-libs/libwebrtc-149.0.0.jar'
if (-not (Test-Path -LiteralPath $rtcJar -PathType Leaf)) {
    $aar = Get-ChildItem -Path (Join-Path $env:USERPROFILE '.gradle/caches/modules-2/files-2.1/ch.threema/webrtc-android/149.0.0') -Recurse -Filter 'webrtc-android-149.0.0.aar' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $aar) { $aar = Get-Item (Join-Path $root 'build/test-libs/webrtc-android-149.0.0.aar') -ErrorAction SilentlyContinue }
    if (-not $aar) { throw 'webrtc-android-149.0.0.aar is neither in the Gradle cache nor in apps/android/build/test-libs; run the Gradle build once.' }
    New-Item -ItemType Directory -Force (Split-Path $rtcJar) | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($aar.FullName)
    try { [IO.Compression.ZipFileExtensions]::ExtractToFile(($zip.Entries | Where-Object FullName -eq 'libs/libwebrtc.jar'), $rtcJar, $true) } finally { $zip.Dispose() }
}
$libs = "$($bc.FullName);$($zx.FullName);$((Resolve-Path $rtcJar).Path)"
# relay/ is pure Java except NetworkWake (Android's network callback) and WebRtc (libwebrtc's native side), which a phone exercises.
$sources = @(Get-ChildItem (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/relay') -Filter '*.java' | Where-Object Name -notin 'NetworkWake.java', 'WebRtc.java' | ForEach-Object FullName) +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/ConnectionAddress.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/Companies.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/CssColor.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/VolumePair.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/PhoneUseAskRule.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/PhoneRoutes.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/ScreenTree.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/Gestures.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/DisclosureText.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/StepThread.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/TypedText.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/UseState.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/SayChoices.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/TypeTarget.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/TodoPlace.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/TodoHold.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/SpeechLang.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/Resend.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/TodoPost.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/BubbleChat.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/BubbleLock.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/BubbleQuick.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/AppNames.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/StepDeadline.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/EndSignal.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/DotDodge.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/SpokenAudio.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/SpokenPieces.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/phoneuse/PlanHearing.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/InstallSource.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/UpdateRelease.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/pair/QrDecode.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/usage/UsageSignal.java') +
    (Join-Path $root 'app/src/main/java/com/teydralab/autark/android/usage/UsageCounter.java') +
    @(Get-ChildItem (Join-Path $root 'test') -Filter '*.java' | ForEach-Object FullName) +
    @(Get-ChildItem (Join-Path $root 'test/phoneuse') -Filter '*.java' | ForEach-Object FullName) +
    @(Get-ChildItem (Join-Path $root 'test/pair') -Filter '*.java' | ForEach-Object FullName) +
    @(Get-ChildItem (Join-Path $root 'test/usage') -Filter '*.java' | ForEach-Object FullName) +
    @(Get-ChildItem (Join-Path $root 'test/routes') -Filter '*.java' | ForEach-Object FullName) +
    @(Get-ChildItem (Join-Path $root 'test/relay') -Filter '*.java' -ErrorAction SilentlyContinue | ForEach-Object FullName)
& $javac -encoding UTF-8 -Xlint:all -cp $libs -d $out @sources
if ($LASTEXITCODE -ne 0) { throw 'Host test compilation failed.' }
$classpath = "$out;$libs"
# B-078: the SAS interop vectors (desktop remote/sas.ts) and phone use's screen tree and gestures run here too.
foreach ($test in 'ConnectionAddressTest', 'RelayCryptoTest', 'relay.RemotePairTest', 'phoneuse.ScreenTreeTest', 'phoneuse.DisclosureTest', 'phoneuse.UseLinkThreadTest', 'phoneuse.TypedTextTest', 'phoneuse.UseStateTest', 'phoneuse.SayChoicesTest', 'phoneuse.TypeTargetTest', 'phoneuse.TodoTest', 'phoneuse.AppNamesTest', 'phoneuse.StepDeadlineTest', 'phoneuse.EndSignalTest', 'phoneuse.DotDodgeTest', 'phoneuse.SpokenAudioTest', 'phoneuse.SpokenPiecesTest', 'phoneuse.PlanHearingTest', 'UpdateReleaseTest', 'pair.QrDecodeTest', 'CompaniesTest', 'CssColorTest', 'relay.ReconnectTest', 'relay.CodeChainTest', 'relay.LinksTest', 'relay.OwnUiTest', 'relay.UiUpdateTest', 'relay.DirectRouteTest', 'relay.RtcSignalTest', 'relay.RtcWayTest', 'relay.WakeTest', 'PhoneRoutesTest', 'ShellWiringTest', 'VolumePairTest', 'PhoneUseAskRuleTest', 'usage.UsageCounterTest') {
    # autark.android: UpdateReleaseTest reads UpdateCheck/SelfUpdate's wiring from the sources.
    & $runtime "-Dautark.android=$root" -cp $classpath "com.teydralab.autark.android.$test"
    if ($LASTEXITCODE -ne 0) { throw "Host test $test failed." }
}
