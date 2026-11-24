// Owns: host checks of Lite/full update separation, which installs read the feed at all (never a Play install or the
// Play build, whose line is the neutral "Check in Google Play"), when the feed is due, the feed URL contract of 0.3.6 Lite clients, the download's progress and integrity
// rules, and the wiring in UpdateCheck/SelfUpdate those rules depend on (read from the sources). Never: claims
// real-device installation, Play Protect or a Google Play update.
package com.teydralab.autark.android;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

public final class UpdateReleaseTest {
    private static int checks;

    public static void main(String[] args) throws IOException {
        String full = "{\"versionCode\":6,\"url\":\"https://github.com/teydra/OpenAutark/releases/download/v0.3.6/autark-android.apk\"}";
        String lite = full.replace("autark-android.apk", "autark-android-lite.apk").replace("{", "{\"channel\":\"lite\",");
        check(!UpdateRelease.feed(true).equals(UpdateRelease.feed(false)));
        check(UpdateRelease.feed(true).endsWith("latest-android-lite.json"));
        check(UpdateRelease.feed(false).endsWith("latest-android.json"));
        check(UpdateRelease.newer(full, 5, false) != null);
        check(UpdateRelease.newer(full, 5, true) == null);
        check(UpdateRelease.newer(lite, 5, true) != null);
        check(UpdateRelease.newer(lite, 5, false) == null);
        check(UpdateRelease.newer(lite, 6, true) == null);
        check(UpdateRelease.newer(lite, 7, true) == null);
        check(UpdateRelease.newer(lite.replace("\"channel\":\"lite\",", ""), 5, true) == null);
        check(UpdateRelease.newer(lite.replace("-lite.apk", ".apk"), 5, true) == null);
        check(UpdateRelease.newer(lite.replace("github.com/", "github.com.evil/"), 5, true) == null);
        check(UpdateRelease.newer("not JSON", 5, true) == null);
        check(UpdateRelease.newer("{}", 5, true) == null);

        // The feed URL contract of the published 0.3.6 Lite clients: a tag-fixed address with the stable file name passes,
        // a versioned file name does not (publisher: .local/android-release/publish.py).
        check(UpdateRelease.newer(liteAt("download/android-v0.3.7/autark-android-lite.apk", 7), 6, true) != null);
        check(UpdateRelease.newer(liteAt("download/v0.3.7/autark-android-lite.apk", 7), 6, true) != null);
        check(UpdateRelease.newer(liteAt("download/android-v0.3.7/autark-android-lite-0.3.7.apk", 7), 6, true) == null);

        // Which installs read the GitHub feed: only a website APK that Google Play did not install.
        check(UpdateRelease.source(null, true) == UpdateRelease.Source.FEED);
        check(UpdateRelease.source("com.sec.android.app.myfiles", true) == UpdateRelease.Source.FEED);
        check(UpdateRelease.source("com.google.android.packageinstaller", true) == UpdateRelease.Source.FEED);
        check(UpdateRelease.source("com.android.vending", true) == UpdateRelease.Source.PLAY);
        check(UpdateRelease.source(null, false) == UpdateRelease.Source.PLAY);              // the Play build, sideloaded too
        check(UpdateRelease.source("com.android.vending", false) == UpdateRelease.Source.PLAY);
        check(UpdateRelease.Route.values().length == 2);                                  // no "in Google Play" route left

        // When the feed is read again: at every opening, once a minute at most (owner 10.11.2026: a fix reaches the phone the
        // next time it opens Autark; 19.11.2026: not half an hour later), and at once when the clock went back.
        long hour = 60 * 60_000L, t = 1_762_600_000_000L;
        check(UpdateRelease.INTERVAL_MS == 60_000L); // every opening, once a minute at most
        check(UpdateRelease.due(0, t));
        check(!UpdateRelease.due(t, t) && !UpdateRelease.due(t, t + 59_999));
        check(UpdateRelease.due(t, t + 60_000) && UpdateRelease.due(t, t + hour));
        check(UpdateRelease.due(t, t - 1));

        String sha = "34452b5a09639e0be244bfd5581d600aab01fe63e61cf8f8c0e5666d40e3463f";
        java.util.Map<String, Object> signed = UpdateRelease.newer(lite.replace("{", "{\"sha256\":\"" + sha.toUpperCase() + "\",\"bytes\":3715286,"), 5, true);
        java.util.Map<String, Object> bare = UpdateRelease.newer(lite, 5, true);
        check(signed != null && bare != null);
        check(UpdateRelease.route(signed) == UpdateRelease.Route.DOWNLOAD);
        check(UpdateRelease.route(bare) == UpdateRelease.Route.BROWSER);
        check(sha.equals(UpdateRelease.sha256(signed)));
        check(UpdateRelease.bytes(signed) == 3715286);
        check(UpdateRelease.bytes(bare) == -1);
        check(UpdateRelease.verified(signed, sha, 3715286));
        check(!UpdateRelease.verified(signed, sha, 3715285));
        check(!UpdateRelease.verified(signed, sha.replace('3', '4'), 3715286));
        check(!UpdateRelease.verified(bare, sha, 3715286));
        java.util.Map<String, Object> huge = UpdateRelease.newer(lite.replace("{", "{\"sha256\":\"" + sha + "\",\"bytes\":999999999,"), 5, true);
        check(UpdateRelease.route(huge) == UpdateRelease.Route.BROWSER);
        check(UpdateRelease.percent(0, 100) == 0 && UpdateRelease.percent(42, 100) == 42 && UpdateRelease.percent(100, 100) == 100);
        check(UpdateRelease.percent(150, 100) == 100 && UpdateRelease.percent(5, -1) == 0);
        check(UpdateRelease.hex(new byte[] { 0, 15, (byte) 255 }).equals("000fff"));

        // An update downloads by itself when Android already lets Autark install and the release is checkable; one failed
        // or cancelled automatic try of a version waits AUTO_RETRY_MS (a clock set back allows it again).
        check(UpdateRelease.automatic(signed, true, -1, 0, t));
        check(!UpdateRelease.automatic(signed, false, -1, 0, t));                            // "Install unknown apps" not allowed yet
        check(!UpdateRelease.automatic(bare, true, -1, 0, t));                               // no SHA-256/size: the browser route
        check(!UpdateRelease.automatic(null, true, -1, 0, t));
        check(UpdateRelease.automatic(signed, true, 5, t, t));                               // another version tried before
        check(!UpdateRelease.automatic(signed, true, 6, t, t + 1));                          // this version tried just now
        check(!UpdateRelease.automatic(signed, true, 6, t, t + UpdateRelease.AUTO_RETRY_MS - 1));
        check(UpdateRelease.automatic(signed, true, 6, t, t + UpdateRelease.AUTO_RETRY_MS));
        check(UpdateRelease.automatic(signed, true, 6, t, t - 1));

        wiring();
        System.out.println(checks + " update channel, source, feed URL, route, download and wiring checks passed.");
    }

    /** The Android-side flow these rules feed, read from the sources (no Android runtime on the host). */
    private static void wiring() throws IOException {
        String root = System.getProperty("autark.android");
        check(root != null);
        String updateCheck = read(root, "app/src/main/java/com/teydralab/autark/android/UpdateCheck.java");
        String site = read(root, "app/src/site/java/com/teydralab/autark/android/SelfUpdate.java");
        String start = body(updateCheck, "static void start(");
        // A Play install and the Play build return before anything from the feed is shown or read; their line is the
        // neutral way into Google Play: no release, no version, no "available".
        int play = start.indexOf("== UpdateRelease.Source.PLAY");
        check(play > 0);
        String playBranch = start.substring(play, start.indexOf("return;", play));
        check(playBranch.contains("remove(\"release\")"));                                  // forget what the feed said before
        check(playBranch.contains("UpdateRelease.PLAY_LINE") && playBranch.contains("UpdateRelease.PLAY_ACTION") && playBranch.contains("openPlay(activity)"));
        for (String feedOnly : new String[] {"offer(", "look(", "SelfUpdate.", "getString(", "versionName", "Json."}) check(!playBranch.contains(feedOnly));
        for (String later : new String[] {"present(", "look(", "SelfUpdate.attach(", "getString(\"release\""}) check(start.indexOf(later) > play + playBranch.length());
        check(playBranch.contains("UpdateRelease.due("));                                   // not on every return to the app
        check(count(updateCheck, "UpdateRelease.feed(") == 1 && body(updateCheck, "private static void look(").contains("UpdateRelease.feed("));
        check(count(updateCheck, "openPlay(") == 2 && !updateCheck.contains("in Google Play\""));
        String playOpen = body(updateCheck, "private static void openPlay(");
        check(playOpen.contains("market://details?id=") && playOpen.contains("InstallSource.PLAY_STORE") && playOpen.contains("https://play.google.com/store/apps/details?id="));
        check(!UpdateRelease.PLAY_LINE.contains("available") && !UpdateRelease.PLAY_ACTION.contains("Update") && !UpdateRelease.PLAY_LINE.matches(".*\\d.*"));
        // The background answer goes to the screen shown when it arrives, not to the activity that asked.
        String look = body(updateCheck, "private static void look(");
        check(!look.contains("activity") && look.contains("MAIN.post("));
        String deliver = body(updateCheck, "private static void deliver(");
        check(deliver.contains("MainActivity.shown()") && deliver.contains("isDestroyed()"));
        check(!updateCheck.contains("runOnUiThread"));
        check(start.contains("UpdateRelease.due("));
        // A failed download forgets the remembered release; "Try again" reads the feed anew instead of the stale SHA-256.
        String download = body(site, "private static void download(");
        check(download.indexOf("UpdateCheck.forget(context)") > 0 && download.indexOf("UpdateCheck.forget(context)") < download.lastIndexOf("failed("));
        check(!site.contains("Map<String, Object> current") && body(site, "static void failed(").contains("again"));
        // Owner 10.11.2026: a newer release goes through present(), which downloads by itself when automatic() allows it,
        // remembers the try per version, and otherwise shows the line; Play installs never get there.
        String present = body(updateCheck, "private static void present(");
        check(present.contains("UpdateRelease.automatic(") && present.contains("canInstall(activity)") && present.contains("offer(activity, bar, release)"));
        check(present.indexOf("putLong(\"autoCode\"") > 0 && present.indexOf("putLong(\"autoCode\"") < present.indexOf("SelfUpdate.start("));
        check(start.contains("present(activity, bar, known)") && deliver.contains("present(shown, shown.updates(), release)"));
        check(!playBranch.contains("present("));
        check(body(updateCheck, "static boolean canInstall(").contains("canRequestPackageInstalls()"));
        String upgrade = read(root, "app/src/main/java/com/teydralab/autark/android/PhoneUseUpgrade.java");
        // Owner/Konrad 24.11.2026 (#821): the request is an ongoing notification on every AI ask (no throttle, nothing downloads
        // silently) and, with the app in front, the large card; the card's button and the tap go through begin().
        String prompt = body(upgrade, "public static void prompt(");
        check(prompt.contains("PhoneUseAsk.builder(app)") && prompt.contains("PhoneUseAsk.post(app, ID, notification)") && prompt.contains("PhoneUseAsk.card(app, PhoneUseAskRule.Kind.LITE)"));
        check(!prompt.contains("install(") && !prompt.contains("start(") && !upgrade.contains("AGAIN_MS") && !upgrade.contains("shownAt"));
        String begin = body(upgrade, "static void begin(");
        check(begin.contains("ACTION_MANAGE_UNKNOWN_APP_SOURCES") && begin.contains("allowInstallFirst(UpdateCheck.canInstall(activity))") && body(upgrade, "private static void start(").contains("install(activity, progress)"));
        check(body(upgrade, "static void resumed(").contains("UpdateCheck.canInstall(activity)"));
        String main = read(root, "app/src/main/java/com/teydralab/autark/android/MainActivity.java");
        check(main.contains("PhoneUseUpgrade.begin(this, updates::step)") && main.contains("PhoneUseUpgrade.resumed(this, updates::step)") && main.contains("PhoneUseAsk.settle(this)") && main.contains("PhoneUseCard.close()"));
        String ask = read(root, "app/src/main/java/com/teydralab/autark/android/PhoneUseAsk.java");
        check(ask.contains("\"phone-use-ask\"") && ask.contains("IMPORTANCE_HIGH") && ask.contains(".setOngoing(true)") && ask.contains(".setOnlyAlertOnce(true)") && !ask.contains("CATEGORY_CALL"));
        String full = read(root, "app/src/main/java/com/teydralab/autark/android/phoneuse/EnablePrompt.java");
        check(full.contains("PhoneUseAsk.builder(app)") && full.contains("PhoneUseAsk.card(app, PhoneUseAskRule.Kind.FULL)") && !full.contains("AGAIN_MS") && !full.contains("shownAt"));
        String card = read(root, "app/src/main/java/com/teydralab/autark/android/PhoneUseCard.java");
        check(card.contains("new Intent(activity, UseDisclosure.class)") && !card.contains("ACTION_ACCESSIBILITY_SETTINGS") && card.contains("PhoneUseUpgrade.begin(activity"));
        String again = body(updateCheck, "static void again(");
        check(again.contains("forget(") && again.contains("look("));
    }

    private static String liteAt(String path, int code) {
        return "{\"channel\":\"lite\",\"versionCode\":" + code + ",\"url\":\"https://github.com/teydra/OpenAutark/releases/" + path + "\"}";
    }

    private static String read(String root, String file) throws IOException {
        Path path = Paths.get(root, file);
        return new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
    }

    /** The method from `signature` to its closing brace at the same depth. */
    private static String body(String source, String signature) {
        int from = source.indexOf(signature);
        check(from >= 0);
        int open = source.indexOf('{', from), depth = 0;
        for (int i = open; i < source.length(); i++) {
            char c = source.charAt(i);
            if (c == '{') depth++;
            else if (c == '}' && --depth == 0) return source.substring(from, i + 1);
        }
        throw new AssertionError("Unbalanced " + signature);
    }

    private static int count(String source, String needle) {
        int n = 0;
        for (int i = source.indexOf(needle); i >= 0; i = source.indexOf(needle, i + 1)) n++;
        return n;
    }

    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Unexpected update result at check " + checks); }
}
