// Owns: an agent's ring on this phone (KI-Runde 17.11.2026: a WebView has no web push, so a ring never reached the app).
// The PC's 'notify' of kind 'call' ({title, body, conversationId, call: {id, until}}, calls/ring.ts) becomes an incoming
// call notice on the channel "Calls": the phone's ring tone, repeating until it is touched, the call category, Accept and
// Decline, gone when the ring's time is over. The PC sends the same event once more with the time up when the ring ends
// anywhere – answered, declined or missed on another device – and the notice goes then. Accept opens the app on the
// call's chat, where the ringing call's own Accept starts it (the page starts its microphone and audio inside a tap);
// Decline is calls.decline over the app's own socket (phoneuse/UseLink) and takes the notice with it only once that
// went out. Opening the app clears it (AppNotices.clear). Nothing while the app is on screen: the page shows its own
// call notice and ring tone then. Its header line says "AI voice (machine-generated)" (CallVoiceNote, Konrad 27.11.2026).
// Never: answers or declines by itself, or rings past the ring's time.
package com.teydralab.autark.android;

import com.teydralab.autark.android.phoneuse.UiLang;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import com.teydralab.autark.android.phoneuse.UseLink;
import com.teydralab.autark.android.relay.Json;
import java.util.Locale;
import java.util.Map;

public final class CallNotice extends BroadcastReceiver {
    private static final String CHANNEL = "calls";
    private static final int ID = 4130;
    private static final String CALL_ID = "callId";
    /** A ring lasts RING_MS (45 s) on the PC; a notice never rings longer than this, whatever the clocks say. */
    private static final long RING_MAX_MS = 60_000;

    /** One 'notify' event of kind 'call' from the PC. */
    static void show(Context context, Map<String, Object> data) {
        Object call = data.get("call");
        if (!(call instanceof Map) || AppNotices.onScreen()) return;
        @SuppressWarnings("unchecked") Map<String, Object> ring = (Map<String, Object>) call;
        String callId = Json.str(ring, "id");
        String route = PhoneRoutes.chat(Json.str(data, "conversationId"));
        if (callId == null || callId.isEmpty() || route == null) return;
        long left = Math.min(RING_MAX_MS, Json.num(ring, "until", 0) - System.currentTimeMillis());
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (left <= 0) { manager.cancel(callId, ID); return; } // the ring is over (answered, declined or missed on a PC): the notice goes
        Context app = context.getApplicationContext();
        boolean german = UiLang.german(app);
        NotificationChannel channel = new NotificationChannel(CHANNEL, german ? "Anrufe" : "Calls", NotificationManager.IMPORTANCE_HIGH);
        channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        channel.enableVibration(true);
        manager.createNotificationChannel(channel);
        Intent openIntent = new Intent(app, MainActivity.class).putExtra(PhoneRoutes.EXTRA, route).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent open = PendingIntent.getActivity(app, callId.hashCode(), openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent declineIntent = new Intent(app, CallNotice.class).putExtra(CALL_ID, callId);
        PendingIntent decline = PendingIntent.getBroadcast(app, callId.hashCode(), declineIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String title = Json.str(data, "title");
        String why = Json.str(data, "body");
        Notification.Builder builder = AppNotices.branded(new Notification.Builder(app, CHANNEL));
        builder.setContentTitle(title == null || title.isEmpty() ? (german ? "Anruf" : "Call") : title).setContentText(why == null ? "" : why)
                .setSubText(CallVoiceNote.TEXT) // Konrad 27.11.2026: the call's voice is machine-generated, said in the notice's header line
                .setCategory(Notification.CATEGORY_CALL).setOngoing(true).setShowWhen(true).setTimeoutAfter(left)
                .setContentIntent(open).setAutoCancel(true)
                .addAction(new Notification.Action.Builder(null, german ? "Annehmen" : "Accept", open).build())
                .addAction(new Notification.Action.Builder(null, german ? "Ablehnen" : "Decline", decline).build());
        Notification notice = builder.build();
        notice.flags |= Notification.FLAG_INSISTENT; // the ring tone repeats until the notice is touched or its time is over
        try { manager.notify(callId, ID, notice); } catch (RuntimeException error) { /* notifications not allowed: the page rings when opened */ }
    }

    /** The app came on screen: the page shows the ringing call itself. */
    static void clear(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        for (android.service.notification.StatusBarNotification shown : manager.getActiveNotifications()) {
            if (shown.getId() == ID) manager.cancel(shown.getTag(), ID);
        }
    }

    /** Decline: calls.decline for this call, and the notice goes once the decline is on its way. */
    @Override public void onReceive(Context context, Intent intent) {
        String callId = intent.getStringExtra(CALL_ID);
        if (callId == null) return;
        if (!UseLink.call("calls.decline", Json.map(CALL_ID, callId))) return; // no link right now: it keeps ringing, and Accept opens the app where the page declines
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(callId, ID);
    }
}
