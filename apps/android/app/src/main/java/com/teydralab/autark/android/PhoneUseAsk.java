// Owns: how the request "Let the AI use this phone" reaches the person (owner/Konrad 24.11.2026, #821: "bleibende
// Benachrichtigung bis zum Antippen, bei offener App zusätzlich groß in der App"): one ongoing notification per build
// (4108 Lite, 4107 full) on its own heads-up channel – a swipe does not remove it, a tap does – re-posted on every AI
// request (same id, alerts once), and with Autark open in front the large card (PhoneUseCard) besides. Gone once phone use
// is there and agreed (settle). Without the notification permission the card is the way; nothing throws.
// Never: turns phone use on, opens Accessibility settings before the disclosure, or hides a request behind a timer.
package com.teydralab.autark.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.teydralab.autark.android.phoneuse.UseConsent;
import com.teydralab.autark.android.phoneuse.UseService;

public final class PhoneUseAsk {
    /** A new channel: an install that has the old "phone-use" one keeps its quiet importance there. */
    static final String CHANNEL = "phone-use-ask";
    public static final int ID_FULL = 4107, ID_LITE = 4108;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private PhoneUseAsk() {}

    /** The ongoing, heads-up notification builder of this request (callers set text, intent and actions). */
    public static Notification.Builder builder(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            if (manager != null) manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Phone use requests", NotificationManager.IMPORTANCE_HIGH));
            builder = new Notification.Builder(context, CHANNEL);
        } else {
            builder = new Notification.Builder(context).setPriority(Notification.PRIORITY_HIGH);
        }
        return AppNotices.branded(builder).setOngoing(true).setAutoCancel(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_REMINDER);
    }

    /** Posts (or re-posts) the notification; not allowed to notify is not an error – the card shows in the open app. */
    public static void post(Context context, int id, Notification notification) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        try { manager.notify(id, notification); } catch (RuntimeException error) { /* notifications not allowed */ }
    }

    /** The tap, or phone use there: both notifications go. */
    public static void cancel(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        try { manager.cancel(ID_FULL); manager.cancel(ID_LITE); } catch (RuntimeException error) { /* nothing to cancel */ }
    }

    /** Phone use is on and agreed (full build, service connected), or this build is the full one and an old Lite
     * notification is left over from before the upgrade: what no longer applies goes. */
    public static void settle(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        try {
            if (UseConsent.available(context)) manager.cancel(ID_LITE);
            if (UseConsent.available(context) && UseConsent.agreed(context) && UseService.current() != null) manager.cancel(ID_FULL);
        } catch (RuntimeException error) { /* nothing to cancel */ }
    }

    /** With Autark open in front (any thread): the large card besides the notification. */
    public static void card(Context context, PhoneUseAskRule.Kind kind) {
        MAIN.post(() -> {
            MainActivity shown = MainActivity.shown();
            if (shown != null && shown.inFront()) PhoneUseCard.show(shown, kind);
        });
    }
}
