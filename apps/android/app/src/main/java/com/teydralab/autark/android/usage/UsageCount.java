// Owns: the Android side of the anonymous usage count (owner 25.11.2026, README › What Autark counts): the prefs 'usage'
// (the switch, and the last hour counted), the counter's address from assets/usage/receiver.json (the project and public web
// key of the feedback receiver – app/build.gradle copies it from apps/desktop/resources/feedback; no secret), one worker
// thread and the one POST. MainActivity calls resumed() when the app comes to the front and paused() when it leaves: in
// front, touch() runs at once and every 15 minutes (the hour is UsageCounter's); in the background nothing runs at all.
// The POST: HTTPS to firestore.googleapis.com, no redirects, 10 s timeouts, the content type as the only header of ours
// (the platform adds its default user agent), no cookie, the answer's body is never read or logged.
// Never: sends from the background, from a service or through a PC, reads an id of the phone, or keeps a log.
package com.teydralab.autark.android.usage;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public final class UsageCount {
    private static final long TICK_MS = 15 * 60 * 1000L;
    private static UsageCounter counter;
    private static final Handler HANDLER = new Handler(Looper.getMainLooper());
    private static final Runnable TICK = UsageCount::tick;

    private UsageCount() {}

    private static synchronized UsageCounter counter(Context context) {
        if (counter == null) {
            Context app = context.getApplicationContext();
            SharedPreferences prefs = app.getSharedPreferences("usage", Context.MODE_PRIVATE);
            String[] receiver = receiver(app);
            Executor worker = Executors.newSingleThreadExecutor(task -> { Thread thread = new Thread(task, "usage-count"); thread.setDaemon(true); return thread; });
            counter = new UsageCounter(new UsageCounter.Store() {
                @Override public String get(String key) { return prefs.getString(key, null); }
                @Override public void put(String key, String value) { if (value == null) prefs.edit().remove(key).apply(); else prefs.edit().putString(key, value).apply(); }
            }, UsageCount::post, System::currentTimeMillis, worker, receiver[0], receiver[1]);
        }
        return counter;
    }

    /** {project, apiKey} from assets/usage/receiver.json, both null where the build carries none or a malformed one. */
    private static String[] receiver(Context app) {
        try (InputStream in = app.getAssets().open("usage/receiver.json")) {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[1024];
            for (int n; (n = in.read(chunk)) > 0 && bytes.size() < 4096; ) bytes.write(chunk, 0, n); // the file is a few hundred bytes
            JSONObject json = new JSONObject(bytes.toString("UTF-8"));
            String project = json.optString("project", ""), key = json.optString("apiKey", "");
            if (project.matches("[a-z][a-z0-9-]{4,28}[a-z0-9]") && key.matches("[A-Za-z0-9_-]{20,100}")) return new String[] { project, key };
        } catch (Exception none) { /* no receiver: nothing is counted */ }
        return new String[] { null, null };
    }

    private static int post(String address, String body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(10_000);
            connection.setUseCaches(false);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = connection.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
            return connection.getResponseCode(); // the answer's body is never read
        } finally {
            connection.disconnect();
        }
    }

    /** The switch (settings: Anonymous usage count); on unless the person turned it off. */
    public static boolean on(Context context) { return counter(context).on(); }

    /** The switch changes: off sends nothing from now on and drops the stored hour at once. */
    public static void set(Context context, boolean on) {
        counter(context).set(on);
        if (!on) HANDLER.removeCallbacks(TICK);
    }

    /** The app came to the front: counts this hour once, and again each new hour while it stays there. Main thread. */
    public static void resumed(Context context) {
        counter(context).touch();
        HANDLER.removeCallbacks(TICK);
        HANDLER.postDelayed(TICK, TICK_MS);
    }

    /** The app left the front: nothing runs any more until it is back. Main thread. */
    public static void paused() {
        HANDLER.removeCallbacks(TICK);
    }

    private static void tick() {
        UsageCounter current;
        synchronized (UsageCount.class) { current = counter; }
        if (current == null) return;
        current.touch();
        HANDLER.postDelayed(TICK, TICK_MS);
    }
}
