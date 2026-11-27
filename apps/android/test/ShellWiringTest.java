// Owns: the shell's wiring for the 16.11.2026 feedback round, read from the sources (the parts need Android to run):
// the old company's link closes off the main thread with its entrance freed first (the S23 crash), the connection
// notice is fixed and never re-posted, every notification carries the Autark mark, the camera capture and its files,
// the page's 'shot'/'refused'/'crash' messages, the user agent's device group, the feedback video before pairing
// (IntroTour over the pairing screens, "How feedback works", build.ps1 bundling assets/tour.html), the volume pair
// (VolumePair in dispatchKeyEvent, the page's 'feedback') and, owner 27.11.2026, the interface in the APK (assets/ui)
// with the entrance screen as the only native screen left besides pairing.
// Never: a device test (the screen, the camera, the notices and the keys are checked on a phone).
package com.teydralab.autark.android;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.stream.Stream;

public final class ShellWiringTest {
    private static int assertions;

    public static void main(String[] args) throws Exception {
        String link = source("CompanyLink.java");
        int stop = link.indexOf("void stop(Context context)");
        check(stop > 0 && link.indexOf("connection.closeEntrance();", stop) > stop
                && link.indexOf("new Thread(", stop) > link.indexOf("connection.closeEntrance();", stop), "the entrance frees at once, the sockets close on a thread");
        check(link.contains("try { use.stop(); connection.stop(); }"), "the phone-use socket and the connection close on that thread");
        check(!link.contains("KeepAlive."), "the link no longer writes the notice");
        String keep = source("KeepAlive.java");
        check(!keep.contains("static void update("), "the notice has no changing line");
        check(keep.contains("if (running) return;"), "start() does nothing while the service runs (a swiped notice stays away)");
        check(keep.contains("VISIBILITY_SECRET") && keep.contains("\"Background connection\"") && keep.contains("CHANNEL = \"background\""), "quiet, off the lock screen, same channel id");
        check(keep.contains("ACTION_CHANNEL_NOTIFICATION_SETTINGS") && keep.contains("EXTRA_CHANNEL_ID, CHANNEL"), "a tap opens the channel's settings so the notice can be hidden (19.11.)");
        try (Stream<Path> files = Files.walk(Paths.get(System.getProperty("autark.android"), "app/src"))) {
            for (Path file : (Iterable<Path>) files.filter(p -> p.toString().endsWith(".java"))::iterator) {
                String text = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
                check(!text.contains("android.R.drawable"), "no system icon on a notification: " + file.getFileName());
                if (text.contains("new Notification.Builder(")) check(text.contains("AppNotices.branded(") || text.contains("branded(new"), "branded: " + file.getFileName());
            }
        }
        String res = new String(Files.readAllBytes(Paths.get(System.getProperty("autark.android"), "app/src/main/res/drawable/ic_stat_autark.xml")), StandardCharsets.UTF_8);
        check(res.contains("#FFFFFFFF") && !res.contains("#FF4F00"), "the status icon is one white shape");
        String launcher = new String(Files.readAllBytes(Paths.get(System.getProperty("autark.android"), "app/src/main/res/mipmap-anydpi-v26/autark_launcher.xml")), StandardCharsets.UTF_8);
        check(launcher.contains("<monochrome>") && launcher.contains("@drawable/ic_stat_autark"), "themed icons get the mark");
        String manifest = new String(Files.readAllBytes(Paths.get(System.getProperty("autark.android"), "app/src/main/AndroidManifest.xml")), StandardCharsets.UTF_8);
        check(manifest.contains("android:name=\".CaptureFiles\"") && manifest.contains("${applicationId}.capture\"\n            android:exported=\"false\" android:grantUriPermissions=\"true\""), "the capture provider is private with per-file grants");
        String chrome = source("PhoneChrome.java");
        check(chrome.contains("params.isCaptureEnabled()") && chrome.contains("Manifest.permission.CAMERA }, CAMERA_REQUEST"), "capture asks for the camera first");
        check(chrome.contains("MediaStore.ACTION_VIDEO_CAPTURE : MediaStore.ACTION_IMAGE_CAPTURE") && chrome.contains("MediaStore.EXTRA_OUTPUT, out"), "photo or video into a CaptureFiles file");
        String capture = source("CaptureFiles.java");
        check(capture.contains("name.matches(\"capture-\\\\d+\\\\.(jpg|mp4)\")"), "only capture names, never a path");
        String port = source("NativePort.java");
        check(port.contains("case \"refused\": listener.refused(); break;") && port.contains("case \"shot\": shot(); break;"), "the page's refused and shot");
        check(port.contains("PixelCopy.request(window, full,") && port.contains("compress(Bitmap.CompressFormat.JPEG, 85,") && port.contains("SHOT_SIDE = 1600"), "the window picture as agreed");
        check(port.contains("message(\"crash\", \"text\", crash)") && port.contains("CrashReport.clear(activity)"), "a reported crash goes to the page once, then its file");
        String main = source("MainActivity.java");
        check(main.contains("port.crash(crash)") && main.contains("@Override public void refused() { if (link != null) link.refused(); }"), "the activity wires Report and refused");
        // Owner 27.11.2026: no PC picker and no Try again; the page is the app's own, so the one native screen left is a
        // company port that stays taken, and the app retries by itself while it shows.
        String entrance = source("EntranceScreen.java");
        check(!entrance.contains("android.widget.Button") && !entrance.contains("setOnClickListener"), "the entrance screen has no button");
        check(!port.contains("case \"pcs\"") && !main.contains("pickPc") && !source("CompanyLink.java").contains("AlertDialog"), "no PC picker anywhere in the shell");
        check(entrance.contains("form.postDelayed(again[0], RETRY_MS);") && entrance.contains("if (form.getParent() != content || !form.isAttachedToWindow()) return;"), "the screen retries by itself while it shows, and stops once it is gone");
        check(main.contains("catch (IOException error) { entranceClosed(error.getMessage()); return; }") && main.contains("if (!paused && link == null && paired != null) open(paired);"), "a taken port shows the screen, whose retry opens the company again");
        String navigation = source("PhoneNavigation.java");
        check(!navigation.contains("offline") && !navigation.contains("onReceivedHttpError") && !main.contains("offline("), "a page load never swaps the page for a native screen");
        String reload = "optional(() -> { if (pageUp && !setup && !voiceLive && PhoneUi.store(this).reloadDue()) web.reload(); PhoneUi.resumed(this); });";
        check(!main.contains("version()") && main.indexOf("web.reload()") == main.indexOf(reload) + reload.indexOf("web.reload()") && main.indexOf("web.reload()") == main.lastIndexOf("web.reload()")
                && main.contains("@Override public void linked() { on(shown -> shown.port.resume()); }"), "another PC or its version never reloads the page (it hears resume); only a newer interface does, on return, voice not live");
        check(source("PhoneUi.java").contains("assets.open(\"ui/\" + path)") && link.contains("connection.start(port, gate, new UiFiles(PhoneUi.store(app)))"), "the entrance answers the interface from the app's store over the APK's assets/ui");
        check(main.contains("link.connection.front(true)") && main.contains("link.connection.front(false)"), "the link hears whether the app is in front");
        String web = source("PhoneWeb.java");
        check(web.contains("\" AutarkAndroid/\" + UpdateCheck.installedName(activity) + device()") && web.contains("\" (Android \" + release"), "the user agent names Android and the device");
        // The feedback video before pairing: over the pairing screens once on the first start, again from the link, Back skips.
        check(main.contains("else { showPair(null, false); if (IntroTour.due(this, preferences)) showTour(); }"), "the first start lays the video over the pairing screens");
        check(main.contains("PairScreens.tour(IntroTour.carried(this) ? this::showTour : null);"), "the pairing screen's link replays it where the build carries it");
        check(main.contains("if (tour != null && tour.shown()) { closeTour(); return; }"), "Back skips the video");
        check(main.indexOf("closeTour();", main.indexOf("private void showPair(")) < main.indexOf("leaveWeb();", main.indexOf("private void showPair(")), "a pair link closes the video first");
        String intro = source("IntroTour.java");
        check(intro.contains("\"file:///android_asset/\" + ASSET") && intro.contains("DONE = \"autark-tour:done\"") && intro.contains("host.post(tour::close)"), "the asset page, its done address, closed outside the WebView's call");
        check(intro.contains("setAllowFileAccess(false)") && intro.contains("setBlockNetworkLoads(true)") && !intro.contains("addJavascriptInterface"), "no file system, no network, no bridge");
        check(intro.contains("putBoolean(SEEN, true)") && intro.contains("!preferences.getBoolean(SEEN, false) && carried(activity)"), "once, and only where the build carries it");
        String pair = new String(Files.readAllBytes(Paths.get(System.getProperty("autark.android"), "app/src/main/java/com/teydralab/autark/android/pair/PairScreens.java")), StandardCharsets.UTF_8);
        check(pair.contains("look.quiet(\"How feedback works\", look.link, play)"), "the first level's link");
        String gradle = new String(Files.readAllBytes(Paths.get(System.getProperty("autark.android"), "app/build.gradle")), StandardCharsets.UTF_8);
        String build = new String(Files.readAllBytes(Paths.get(System.getProperty("autark.android"), "build.ps1")), StandardCharsets.UTF_8);
        check(gradle.contains("assets.srcDir('build/generated/tour')") && build.contains("'app/build/generated/tour/tour.html'") && build.contains("apps/desktop/scripts/tour-page.mjs") && build.contains("'assets/tour.html'"), "build.ps1 bundles the page into the assets and a release checks it");
        check(gradle.contains("assets.srcDir('build/generated/ui')") && build.contains("@('scripts/build.mjs', '--only', 'ui')") && build.contains("'app/build/generated/ui'")
                && build.contains("(Join-Path $uiAssets 'ui')") && build.contains("'assets/ui/index.html'"), "build.ps1 bundles the interface as assets/ui and a release checks its index.html");
        // Volume up + down together on the page: the feedback cell's press, one key alone the volume.
        check(main.contains("@Override public boolean dispatchKeyEvent(KeyEvent event)") && main.contains("volume.key(code == KeyEvent.KEYCODE_VOLUME_UP ? VolumePair.UP : VolumePair.DOWN,"), "the activity reads both volume keys first");
        check(main.contains("if (port == null || !pageUp || setup) { volumeStep(volume.reset()); return super.dispatchKeyEvent(event); }"), "only on the page; elsewhere the keys stay Android's");
        check(main.contains("adjustSuggestedStreamVolume(step.volume > 0 ? AudioManager.ADJUST_RAISE : AudioManager.ADJUST_LOWER, AudioManager.USE_DEFAULT_STREAM_TYPE, AudioManager.FLAG_SHOW_UI)"), "a single key changes the volume as Android would");
        check(main.contains("port.feedback(step.feedback > 0)") && main.contains("keys.postDelayed(() -> volumeStep(volume.expired(SystemClock.uptimeMillis())), step.waitMs)"), "the pair tells the page; the wait runs out on the main thread");
        check(main.contains("if (!focused) volumeStep(volume.reset());"), "losing the keyboard lets a held pair go");
        check(port.contains("put(\"t\", \"feedback\").put(\"down\", down)"), "the page's message {t:'feedback', down}");
        System.out.println(assertions + " shell wiring assertions passed.");
    }

    private static String source(String name) throws Exception {
        return new String(Files.readAllBytes(Paths.get(System.getProperty("autark.android"), "app/src/main/java/com/teydralab/autark/android", name)), StandardCharsets.UTF_8);
    }

    private static void check(boolean condition, String what) {
        assertions++;
        if (!condition) throw new AssertionError(what);
    }
}
