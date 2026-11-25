// Owns: when this phone's anonymous usage count is due (owner 25.11.2026: "Pro Endgerät, vom Handy direkt … vielleicht
// jede Stunde"). While the app is in front (MainActivity.onResume, and every 15 minutes while it stays there) it asks
// touch(): the first ask of a UTC hour sends one count – at most once an hour, never from the background – by the phone
// itself, never through a PC. Off sends nothing and drops the one string that is kept, the last UTC hour counted. A failed
// count is dropped: no retry in the same hour, nothing queued, never awaited by the screen, nothing logged.
// The request is UsageSignal's: the platform word, the UTC hour and day inside the counter's name, `n` +1 and `dev` +1 on
// the first count of the day. Nothing else leaves the phone: no id, no version, no language, no company.
// Never: depends on Android (the glue in UsageCount hands it a store, a sender, a clock and a worker), blocks the caller,
// retries, or logs a request or an answer.
package com.teydralab.autark.android.usage;

import java.util.concurrent.Executor;
import java.util.function.LongSupplier;

public final class UsageCounter {
    /** A string store (SharedPreferences in the app, a map in host tests); put(key, null) removes the key. */
    public interface Store {
        String get(String key);
        void put(String key, String value);
    }

    /** One POST with a JSON body and no headers but the content type; returns the HTTP status, throws on any failure. */
    public interface Sender {
        int post(String url, String body) throws Exception;
    }

    public static final String ON = "on";
    public static final String HOUR = "hour";

    private final Store store;
    private final Sender sender;
    private final LongSupplier clock;
    private final Executor worker;
    private final String project, apiKey;
    /** The hour this process already tried (counted or not): one try per hour, never a retry loop. */
    private String tried;

    /** `project` and `apiKey` null: the build has no counter to send to, and nothing is ever sent. */
    public UsageCounter(Store store, Sender sender, LongSupplier clock, Executor worker, String project, String apiKey) {
        this.store = store;
        this.sender = sender;
        this.clock = clock;
        this.worker = worker;
        this.project = project;
        this.apiKey = apiKey;
    }

    /** The switch: on unless the person turned it off (the default is on). */
    public boolean on() {
        return !"0".equals(store.get(ON));
    }

    /** The switch. Off drops the stored hour at once. */
    public void set(boolean on) {
        store.put(ON, on ? null : "0");
        if (!on) store.put(HOUR, null);
    }

    /** The app is in use now: counts this hour once if the switch is on. Never throws, never waits. */
    public void touch() {
        try {
            String hour = UsageSignal.hourKey(clock.getAsLong());
            if (hour.equals(tried)) return;
            if (!on()) { store.put(HOUR, null); return; }
            if (project == null || apiKey == null) return;
            tried = hour;
            String last = UsageSignal.readHour(store.get(HOUR));
            if (hour.equals(last)) return;
            String body = UsageSignal.body(project, hour, UsageSignal.firstOfDay(hour, last));
            String url = UsageSignal.url(project, apiKey);
            worker.execute(() -> {
                try { if (sender.post(url, body) == 200) store.put(HOUR, hour); } catch (Exception dropped) { /* a lost count is fine */ }
            });
        } catch (RuntimeException ignored) { /* a count never disturbs the app */ }
    }
}
