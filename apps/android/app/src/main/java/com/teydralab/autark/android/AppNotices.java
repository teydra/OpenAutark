// Owns: the app's own message notifications (B-084, decision 9; a WebView has no Web Push): the PC's 'notify' events that
// the app's background socket (phoneuse/UseLink) hears become one notification per chat or task on the channel
// "Messages" – only while the app is not on screen (MainActivity reports that through resumed()); while it is, the web
// UI shows its own toast. A tap opens MainActivity with the place as the extra "route" (PhoneRoutes), and opening the
// app clears them. Each bundled chat carries its number of messages for the launcher's icon badge; a task is one
// outstanding notice. Asks once for the notification permission on Android 13+. Also the look every notification of the
// app shares (branded: the Autark mark res/drawable/ic_stat_autark, which Android tints for light and dark bars, and the
// Autark orange in the shade). A ring ('notify' of kind 'call') is CallNotice's. Never: shows anything while the app is
// open, or a route that is not one of the phone UI's places.
package com.teydralab.autark.android;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;
import com.teydralab.autark.android.relay.Json;
import java.util.Map;

public final class AppNotices {
    private static final String CHANNEL = "messages";
    private static final int ID = 4120;
    private static volatile boolean resumed;

    /** The Autark orange (the mark's dot in autark_icon.png). */
    private static final int ORANGE = 0xFFFF4F00;

    private AppNotices() {}

    /** Every notification of the app: the Autark mark as its small icon and the Autark orange. */
    public static Notification.Builder branded(Notification.Builder builder) {
        return builder.setSmallIcon(R.drawable.ic_stat_autark).setColor(ORANGE);
    }

    /** MainActivity: true in onResume, false in onPause. */
    public static void resumed(boolean value) { resumed = value; }

    /** The app is on screen now (phoneuse/AskNotice: a question then needs no notification). */
    public static boolean onScreen() { return resumed; }

    /** One 'notify' event's data ({kind, title, body, conversationId?, taskId?, toast?, route?}) from the PC. */
    public static void event(Context context, Map<String, Object> data) {
        if ("call".equals(Json.str(data, "kind"))) { CallNotice.show(context, data); return; }
        String route = PhoneRoutes.forNotice(Json.str(data, "kind"), data.get("toast"), Json.str(data, "conversationId"), Json.str(data, "route"));
        if (route == null) return;
        if (PhoneRoutes.isDue(Json.str(data, "kind"), Json.str(data, "title"))) { notifyDue(context, Json.str(data, "title"), Json.str(data, "body")); return; }
        notify(context, Json.str(data, "title"), Json.str(data, "body"), route, PhoneRoutes.tag(Json.str(data, "conversationId"), Json.str(data, "taskId")));
    }

    /** Shows (or replaces) the notification with this tag; nothing while the app is on screen. */
    public static void notify(Context context, String title, String text, String route, String tag) {
        if (resumed || PhoneRoutes.valid(route) == null) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        Context app = context.getApplicationContext();
        String line = text == null ? "" : text.length() > 600 ? text.substring(0, 600) + "…" : text;
        Intent open = new Intent(app, MainActivity.class).putExtra(PhoneRoutes.EXTRA, route).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(app, tag.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Messages", NotificationManager.IMPORTANCE_HIGH);
        channel.setShowBadge(true);
        manager.createNotificationChannel(channel);
        Notification.Builder builder = branded(new Notification.Builder(app, CHANNEL)); // minSdk 26: channels always exist
        builder.setContentTitle(title == null || title.isEmpty() ? "Autark" : title)
                .setContentText(line).setStyle(new Notification.BigTextStyle().bigText(line)).setContentIntent(tap).setAutoCancel(true)
                .setCategory(Notification.CATEGORY_MESSAGE).setShowWhen(true).setNumber(count(manager, tag));
        try { manager.notify(tag, ID, builder.build()); } catch (RuntimeException error) { /* notifications not allowed */ }
    }

    /**
     * A to-do that fell due: ONE notification for all of them (tag "due", a newer replaces the older and names what is due now – "3 to-dos due" with their titles),
     * opening the Tasks page, removed by Android itself after PhoneRoutes.DUE_SHOW_MS (17.11.2026, the owner: three stacked cards that stay far too long).
     */
    static void notifyDue(Context context, String title, String text) {
        if (resumed) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        Context app = context.getApplicationContext();
        String open = null;
        for (StatusBarNotification shown : manager.getActiveNotifications()) {
            if (shown.getId() == ID && PhoneRoutes.DUE_TAG.equals(shown.getTag())) open = shown.getNotification().extras.getString("autark.due");
        }
        String[] group = PhoneRoutes.dueGroup(open, title, text);
        Intent tapIntent = new Intent(app, MainActivity.class).putExtra(PhoneRoutes.EXTRA, "#/tasks").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(app, PhoneRoutes.DUE_TAG.hashCode(), tapIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Messages", NotificationManager.IMPORTANCE_HIGH);
        channel.setShowBadge(true);
        manager.createNotificationChannel(channel);
        Notification.Builder builder = branded(new Notification.Builder(app, CHANNEL));
        Bundle extras = new Bundle();
        extras.putString("autark.due", group[2]);
        builder.setContentTitle(group[0]).setContentText(group[1]).setStyle(new Notification.BigTextStyle().bigText(group[1])).setContentIntent(tap).setAutoCancel(true)
                .setCategory(Notification.CATEGORY_REMINDER).setShowWhen(true).setTimeoutAfter(PhoneRoutes.DUE_SHOW_MS).addExtras(extras);
        try { manager.notify(PhoneRoutes.DUE_TAG, ID, builder.build()); } catch (RuntimeException error) { /* notifications not allowed */ }
    }

    /** Active notifications are the count's source: a dismissed or read chat starts again at one. */
    private static int count(NotificationManager manager, String tag) {
        for (StatusBarNotification shown : manager.getActiveNotifications()) {
            if (shown.getId() == ID && tag.equals(shown.getTag())) return PhoneRoutes.noticeCount(tag, shown.getNotification().number);
        }
        return PhoneRoutes.noticeCount(tag, null);
    }

    /** Android 13+: asks once for notifications (messages, the connection line, phone use); request 43. */
    public static void askOnce(Activity activity, SharedPreferences pairing) {
        if (Build.VERSION.SDK_INT < 33 || pairing.getBoolean("askedNotifications", false)
                || activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        pairing.edit().putBoolean("askedNotifications", true).apply();
        activity.requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 43);
    }

    /** The route a tapped notification or shortcut carries, or null. */
    public static String route(Intent intent) {
        return intent == null ? null : PhoneRoutes.valid(PhoneRoutes.migrate(intent.getStringExtra(PhoneRoutes.EXTRA)));
    }

    /** The app came on screen: its message notifications and a ringing call's notice have done their job. */
    public static void clear(Context context) {
        CallNotice.clear(context);
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        for (StatusBarNotification shown : manager.getActiveNotifications()) {
            if (shown.getId() == ID) manager.cancel(shown.getTag(), ID);
        }
    }
}
