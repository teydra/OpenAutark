// Owns: the small foreground service while this phone is paired (B-084, decision 8; type remoteMessaging) and its one
// notice (owner 15.11.2026: only what matters belongs in the shade): title "Autark" and one fixed line, the Autark mark,
// silent, not on the lock screen, on the minimal channel "Background connection" (id "background"; owner 21.11.2026:
// the notice made the launcher icon show a "1" that looked like a message – it never counts on the badge, has no
// status-bar icon and sits folded at the bottom of the shade; the badge counts only messages, AppNotices). Feedback adeb22d4 (16.11.2026): the line read like a question to accept, and a tap only opened
// the app – the line now says what it is and what a tap does, and a tap opens Android's settings of exactly this
// channel, where the person can hide the notice (the service keeps running; below Android 13 Android may then show its
// own "running in the background" notice instead). The connection's state shows in the app's own status line, never here. It
// holds no socket of its own – it only keeps the app's process alive with the screen off, so the connection
// (relay/PhoneConnection) and the background socket with its notifications (phoneuse/UseLink, AppNotices) go on.
// MainActivity starts it once paired (a plain start while on screen, which then goes foreground); while it runs, start()
// does nothing, so a notice the person swiped away (Android 13+) stays away. "Forget this phone" stops it.
// Owner 19.11.2026 ("der Call soll weitergehen", the same for dictation): while the page's voice is live (NativePort
// 'voice.live', MainActivity → voice()) the service is also of type microphone – the page starts its voice while on
// screen, which is when Android 14+ lets a service take the microphone into the background – and its notice becomes
// "Call running" (its line "AI voice (machine-generated)", CallVoiceNote) / "Recording" with the time and End on the channel "voice" (End asks the page through
// MainActivity.voiceStop → {t:'voice.stop'}; with no page to ask the notice goes by itself). Meanwhile it holds a
// partial wake lock (when the manifest grants WAKE_LOCK) and, for a call, the audio focus; when the voice ends it is the
// plain service again. The to-do bubble's call (phoneuse/BubbleCall, bubbleCall()) gets the same hold, "Call running"
// notice and – since 20.11.2026, when the bubble records the call itself (phoneuse/Mic) – the microphone type too, so the
// call keeps hearing with the screen off; where Android refuses that type, the plain type stays (foreground()) and the
// call says so once the microphone goes silent. End ends it. What the page and the bubble want is kept in static fields that
// voice() and bubbleCall() always set and the created service follows (apply), so an 'off' that comes before the
// service exists is never lost.
// Never: connects, reads or sends anything, records itself, or posts its plain notice again while nothing changed.
package com.teydralab.autark.android;

import com.teydralab.autark.android.phoneuse.UiLang;
import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.provider.Settings;
import java.util.Locale;
import java.util.Objects;

public final class KeepAlive extends Service {
    private static final String CHANNEL = "background";
    private static final String VOICE_CHANNEL = "voice";
    private static final int ID = 4121;
    private static final String LINE = "Running in the background · tap to hide this notice";
    private static final String END = "com.teydralab.autark.android.VOICE_END";
    private static final String LIVE = "live";
    /** The wake lock lets go by itself after this long, should the page's 'off' never come. */
    private static final long HOLD_MAX_MS = 4 * 60 * 60_000L;
    private static volatile boolean running;
    /** The created service (main thread), so voice() reaches it without an intent. */
    private static KeepAlive service;
    /** What is wanted now (main thread): the page's voice and its kind, and the bubble's call (its End) – set even while
     *  no service exists yet; the service follows it in apply(). */
    private static boolean pageVoice;
    private static String pageKind;
    private static Runnable bubbleEnd;
    private boolean live;
    private String kind;
    /** The foreground type includes the microphone (the page's voice and the bubble's call). */
    private boolean mic;
    private long since;
    private PowerManager.WakeLock awake;
    private AudioFocusRequest focus;

    /** Starts the service (from the app on screen); nothing while it runs already. */
    public static void start(Context context) {
        if (running) return;
        Context app = context.getApplicationContext();
        // A plain start from the app on screen: a refused startForeground below then only ends the service. After
        // startForegroundService the same refusal would be a crash nothing can catch ("did not then call startForeground").
        try { app.startService(new Intent(app, KeepAlive.class)); }
        catch (RuntimeException refused) { /* started from the background: the next time the app is open starts it */ }
    }

    /** "Forget this phone": no connection is left to keep. */
    public static void stop(Context context) {
        Context app = context.getApplicationContext();
        app.stopService(new Intent(app, KeepAlive.class));
    }

    /** The page's voice went live or ended (main thread); kind 'call' takes the audio focus, any other is a recording. */
    static void voice(Context context, boolean on, String kind) {
        pageVoice = on;
        pageKind = on ? kind : null;
        follow(context);
    }

    /** The to-do bubble's call runs (`end`: what the notice's End does) or ended (null). Main thread. */
    public static void bubbleCall(Context context, Runnable end) {
        bubbleEnd = end;
        follow(context);
    }

    private static void follow(Context context) {
        KeepAlive created = service;
        if (created != null) { created.apply(); return; }
        if (!pageVoice && bubbleEnd == null) return;
        Context app = context.getApplicationContext();
        try { app.startService(new Intent(app, KeepAlive.class).putExtra(LIVE, true)); }
        catch (RuntimeException refused) { /* not allowed from here: the voice runs as long as the app (or the bubble) stays */ }
    }

    @Override public void onCreate() { super.onCreate(); service = this; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && END.equals(intent.getAction())) {
            Runnable bubble = bubbleEnd;
            if (bubble != null) bubble.run(); // the bubble's call ends (and says so through bubbleCall)
            MainActivity shown = MainActivity.shown();
            if (pageVoice && (shown == null || !shown.voiceStop())) { pageVoice = false; pageKind = null; } // no page to ask: the notice goes by itself
            apply();
            if (!running) stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null && intent.hasExtra(LIVE)) apply(); // what is wanted now – an 'off' that came meanwhile included
        else if (!running) foreground(); // already in the foreground: its notice is not posted again
        // A killed process starts fresh from the launcher; the service then comes back with the connection.
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        hold(false);
        live = false;
        mic = false;
        running = false;
        if (service == this) service = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    /** Follows what is wanted: voice live while the page's voice or the bubble's call runs (a call when the page has
     *  none); the microphone type for both. */
    private void apply() {
        boolean on = pageVoice || bubbleEnd != null;
        String what = pageVoice ? pageKind : on ? "call" : null;
        if (on == live && Objects.equals(what, kind) && on == mic) return;
        if (on && !live) since = System.currentTimeMillis();
        live = on;
        kind = what;
        mic = on;
        hold(on);
        foreground();
    }

    /** Into the foreground with the notice and type of now; a refused microphone type keeps the plain type. */
    private void foreground() {
        Notification notice = live ? voiceNotice() : notification(this);
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING | (live && mic ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0));
            else startForeground(ID, notice); // below 14: the manifest's types, microphone included
            running = true;
        } catch (RuntimeException refused) {
            // Android 14+ refuses the microphone type without the microphone permission or from the background.
            if (live && mic && Build.VERSION.SDK_INT >= 34) {
                try { startForeground(ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING); running = true; return; }
                catch (RuntimeException alsoRefused) { /* below */ }
            }
            if (!running) stopSelf();
        }
    }

    /** While voice is live: the CPU stays awake, and a call has the audio focus (other sound pauses). */
    private void hold(boolean on) {
        if (awake != null && awake.isHeld()) awake.release();
        awake = null;
        AudioManager audio = getSystemService(AudioManager.class);
        if (focus != null && audio != null) audio.abandonAudioFocusRequest(focus);
        focus = null;
        if (!on) return;
        PowerManager power = getSystemService(PowerManager.class);
        if (power != null && checkSelfPermission(Manifest.permission.WAKE_LOCK) == PackageManager.PERMISSION_GRANTED) {
            awake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "autark:voice");
            awake.setReferenceCounted(false);
            awake.acquire(HOLD_MAX_MS);
        }
        if ("call".equals(kind) && audio != null) {
            focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()).build();
            audio.requestAudioFocus(focus);
        }
    }

    /** Android's settings screen of this notice's channel (API 26+), where it can be hidden. */
    static Intent channelSettings(Context context) {
        return new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName())
                .putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    private static Notification notification(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) {
            // Android never changes a created channel's badge or importance: the old "connection" (badged on the launcher
            // icon) goes, so the "1" there only ever means messages.
            manager.deleteNotificationChannel("connection");
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Background connection", NotificationManager.IMPORTANCE_MIN);
            channel.setShowBadge(false);
            channel.setSound(null, null);
            channel.enableVibration(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
            manager.createNotificationChannel(channel);
        }
        PendingIntent tap = PendingIntent.getActivity(context, ID, channelSettings(context), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        // Silent: a low-importance channel without sound or vibration, and the notice alerts at most once anyway.
        return AppNotices.branded(new Notification.Builder(context, CHANNEL))
                .setContentTitle("Autark").setContentText(LINE).setContentIntent(tap).setOngoing(true).setShowWhen(false)
                .setVisibility(Notification.VISIBILITY_SECRET).setCategory(Notification.CATEGORY_SERVICE).setOnlyAlertOnce(true).build();
    }

    /** "Call running" / "Recording" with its running time; a tap opens the app, End asks the page to end its voice. */
    private Notification voiceNotice() {
        boolean german = UiLang.german(this);
        boolean call = "call".equals(kind);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            NotificationChannel channel = new NotificationChannel(VOICE_CHANNEL, german ? "Anruf und Aufnahme" : "Call and recording", NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            channel.setSound(null, null);
            channel.enableVibration(false);
            manager.createNotificationChannel(channel);
        }
        Intent app = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent open = PendingIntent.getActivity(this, ID + 1, app, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent end = PendingIntent.getService(this, ID + 2, new Intent(this, KeepAlive.class).setAction(END), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String title = call ? (german ? "Anruf läuft" : "Call running") : (german ? "Aufnahme läuft" : "Recording");
        Notification.Builder builder = AppNotices.branded(new Notification.Builder(this, VOICE_CHANNEL)).setContentTitle(title);
        if (call) builder.setContentText(CallVoiceNote.TEXT); // Konrad 27.11.2026: the call's voice is machine-generated, said for as long as the call runs
        return builder.setContentIntent(open).setOngoing(true).setShowWhen(true).setWhen(since).setUsesChronometer(true)
                .setVisibility(Notification.VISIBILITY_PUBLIC).setCategory(call ? Notification.CATEGORY_CALL : Notification.CATEGORY_SERVICE).setOnlyAlertOnce(true)
                .addAction(new Notification.Action.Builder(null, german ? "Beenden" : "End", end).build()).build();
    }
}
