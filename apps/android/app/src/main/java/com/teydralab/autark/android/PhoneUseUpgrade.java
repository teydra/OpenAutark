// Owns: getting the phone-use build into the website build without phone use (B-084, decision 1; owner 10.11.2026: "die
// Vollversion … wenn man die haben muss … automatisch downloaden", no searching for the right file). Owner/Konrad
// 24.11.2026 (#821; the AI asked three times on the S9 and the person saw nothing): every time the AI asks for a phone step
// the ongoing notification "Let the AI use this phone" (PhoneUseAsk, ID 4108, own heads-up channel, stays until tapped,
// re-posted on every request – no ten-minute throttle) and, with Autark open in front, the large card (PhoneUseCard); the
// card's button or the notification's tap is begin(): the download starts there and only there (nothing starts silently any
// more), after Android's "install unknown apps" switch for this app when it is off (Settings, then on return the flow goes
// on). It reads the full feed latest-android.json (never the lite one), takes its release when it is the phone-use build of at
// least this version with SHA-256 and size, and hands it to the app's own installer (SelfUpdate's install session, which
// checks size and SHA-256 before it commits and shows its steps in the update line) – not a browser or file-manager
// sideload. Once installed, phone use still waits for the disclosure and Android's Accessibility switch (EnablePrompt).
// In the Play build (SelfUpdate.BUILT false) and in the build with phone use it offers nothing.
// Never: turns phone use on (the disclosure and Android's switch stay the person's), downloads before the person's tap, or
// installs a file whose bytes differ from the release.
package com.teydralab.autark.android;

import android.app.Activity;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import com.teydralab.autark.android.phoneuse.UseConsent;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

public final class PhoneUseUpgrade {
    /** The intent extra of the notification's tap; MainActivity then calls confirm(). */
    static final String EXTRA = "phoneUseUpgrade";
    private static final int ID = PhoneUseAsk.ID_LITE;
    /** The person went to Android's "install unknown apps" switch from the card or the tap: on return the flow goes on. */
    private static volatile boolean allowing;

    private PhoneUseUpgrade() {}

    /** True when this install can add phone use through its own installer (the website build without it). */
    public static boolean offered(Context context) {
        return SelfUpdate.BUILT && !UseConsent.available(context);
    }

    /** The AI asked for a phone step (any thread; every time): the ongoing notification "Let the AI use this phone" – the
     * same id again changes nothing and alerts once – and, with Autark open in front, the large card. Nothing downloads here. */
    public static void prompt(Context context) {
        if (!offered(context)) return;
        Context app = context.getApplicationContext();
        Intent open = new Intent(app, MainActivity.class).putExtra(EXTRA, true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(app, ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String text = PhoneUseAskRule.line(PhoneUseAskRule.Kind.LITE);
        Notification notification = PhoneUseAsk.builder(app).setContentTitle(PhoneUseAskRule.TITLE).setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text)).setContentIntent(tap).build();
        PhoneUseAsk.post(app, ID, notification);
        PhoneUseAsk.card(app, PhoneUseAskRule.Kind.LITE);
    }

    /** True when this intent is the notification's tap. */
    static boolean wanted(Intent intent) {
        return intent != null && intent.getBooleanExtra(EXTRA, false);
    }

    /** The notification's tap or the card's button: the person said yes. With the app allowed to install it fetches the
     * phone-use build and installs it through SelfUpdate; otherwise Android's "install unknown apps" switch for this app
     * opens first and resumed() goes on when the person is back. What phone use reads is shown before it is switched on
     * (UseDisclosure). */
    static void begin(Activity activity, UpdateBar.Progress progress) {
        if (!offered(activity) || activity.isFinishing()) return;
        PhoneUseAsk.cancel(activity);
        if (!PhoneUseAskRule.allowInstallFirst(UpdateCheck.canInstall(activity))) { start(activity, progress); return; }
        try {
            allowing = true;
            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.fromParts("package", activity.getPackageName(), null)));
        } catch (RuntimeException error) { allowing = false; start(activity, progress); } // no such screen: the installer asks itself
    }

    /** Back in the app after Android's switch: allowed now, the download starts; not allowed, the notification (posted
     * again with the next request) is still the way. */
    static void resumed(Activity activity, UpdateBar.Progress progress) {
        if (!allowing) return;
        allowing = false;
        if (UpdateCheck.canInstall(activity)) start(activity, progress);
    }

    private static void start(Activity activity, UpdateBar.Progress progress) {
        if (!offered(activity) || activity.isFinishing()) return;
        install(activity, progress);
    }

    private static void install(Activity activity, UpdateBar.Progress progress) {
        if (SelfUpdate.busy()) { SelfUpdate.attach(activity, progress); return; }
        progress.step("Looking for the phone-use version…", -1, null, null);
        long installed = UpdateCheck.installedCode(activity);
        String installer = UpdateCheck.installer(activity);
        new Thread(() -> {
            Map<String, Object> release = null;
            String why = "The phone-use version could not be loaded right now.";
            try {
                release = release(fetch(UpdateRelease.feed(false)), installed, installer);
                why = "The phone-use version of this Autark is not out yet.";
            } catch (IOException | RuntimeException error) { /* offline: `why` says so */ }
            Map<String, Object> found = release;
            String line = why;
            activity.runOnUiThread(() -> {
                if (activity.isFinishing()) return;
                if (found != null) SelfUpdate.start(activity, found, progress, PhoneUseUpgrade::again);
                else progress.step(line, -1, "Try again", () -> install(activity, progress));
            });
        }, "autark-phone-use-upgrade").start();
    }

    /** "Try again" after a failed install: the full feed is read anew, on the screen shown then. */
    private static void again() {
        MainActivity shown = MainActivity.shown();
        if (shown != null && !shown.isDestroyed()) install(shown, shown.updates()::step);
    }

    /** The full feed's release when it is the phone-use build of at least this version that the app installs itself. */
    private static Map<String, Object> release(String json, long installed, String installer) {
        Map<String, Object> release = UpdateRelease.newer(json, installed - 1, false);
        if (release == null || Boolean.FALSE.equals(release.get("accessibilityService"))) return null;
        boolean own = UpdateRelease.source(installer, SelfUpdate.BUILT) == UpdateRelease.Source.FEED;
        return own && UpdateRelease.route(release) == UpdateRelease.Route.DOWNLOAD ? release : null;
    }

    private static String fetch(String feed) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(feed).openConnection();
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(10_000);
        connection.setInstanceFollowRedirects(true);
        try (InputStream in = connection.getInputStream()) {
            if (connection.getResponseCode() != 200) throw new IOException("HTTP " + connection.getResponseCode());
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
                if (out.size() > 16 * 1024) throw new IOException("too large");
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            connection.disconnect();
        }
    }
}
