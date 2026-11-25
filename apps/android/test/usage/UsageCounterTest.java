// Owns: executable checks of the phone's anonymous usage count (owner 25.11.2026, README › What Autark counts): at most one
// count per UTC hour however often the app comes to the front, none without use, none with the switch off (and the stored
// hour dropped), `dev` only on the first count of a UTC day, a request that carries exactly the allowed fields and no
// identifier, nothing without a counter address, and a lost count that is neither retried nor remembered.
// Never: claims how Android delivers the network or the lifecycle (a phone checks that).
package com.teydralab.autark.android.usage;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class UsageCounterTest {
    private static int assertions;
    private static final long T0 = Instant.parse("2026-11-25T15:20:00Z").toEpochMilli();

    private static final class Rig {
        final Map<String, String> prefs = new HashMap<>();
        final List<String[]> posts = new ArrayList<>();
        long now = T0;
        int status = 200;
        boolean fail;
        final UsageCounter counter;

        Rig(String project, String key) {
            UsageCounter.Store store = new UsageCounter.Store() {
                @Override public String get(String name) { return prefs.get(name); }
                @Override public void put(String name, String value) { if (value == null) prefs.remove(name); else prefs.put(name, value); }
            };
            counter = new UsageCounter(store, (url, body) -> { posts.add(new String[] { url, body }); if (fail) throw new java.io.IOException("offline"); return status; }, () -> now, Runnable::run, project, key);
        }

        Rig() { this("autark-feedback-7", "AIzaSyExampleExampleExampleExample00000"); }
    }

    public static void main(String[] args) {
        oneCountPerHour();
        noUseNoCount();
        switchOff();
        devOnlyOnTheFirstCountOfTheDay();
        theRequestIsExactlyTheInterface();
        withoutACounterNothingIsSent();
        aLostCountIsDroppedNotRetried();
        signalPieces();
        System.out.println(assertions + " usage count assertions passed.");
    }

    private static void oneCountPerHour() {
        Rig r = new Rig();
        for (int i = 0; i < 20; i++) r.counter.touch();
        same(1, r.posts.size(), "twenty comebacks to the front in one hour send one count");
        same("2026-11-25T15", r.prefs.get(UsageCounter.HOUR), "the hour is the one string kept");
        r.now = T0 + 30 * 60_000L;
        r.counter.touch();
        same(1, r.posts.size(), "still the same UTC hour (15:50)");
        r.now = T0 + 41 * 60_000L;
        r.counter.touch();
        r.counter.touch();
        same(2, r.posts.size(), "16:01 is the next hour: one more");
        check(r.posts.get(1)[1].contains("/use/2026-11-25-android-16\""), "the hour is in the counter's name");
    }

    private static void noUseNoCount() {
        Rig r = new Rig();
        r.now = T0 + 5 * 3_600_000L;
        same(0, r.posts.size(), "time passing without the app in front sends nothing");
        same(null, r.prefs.get(UsageCounter.HOUR), "and keeps nothing");
    }

    private static void switchOff() {
        Rig r = new Rig();
        check(r.counter.on(), "on by default");
        r.counter.touch();
        check(r.prefs.get(UsageCounter.HOUR) != null, "an hour is kept");
        r.counter.set(false);
        same(null, r.prefs.get(UsageCounter.HOUR), "off drops the stored hour at once");
        r.now = T0 + 2 * 3_600_000L;
        r.counter.touch();
        same(1, r.posts.size(), "off sends nothing");
        r.counter.set(true);
        r.counter.touch();
        same(2, r.posts.size(), "on again counts again");
        Rig off = new Rig();
        off.prefs.put(UsageCounter.ON, "0");
        off.counter.touch();
        same(0, off.posts.size(), "a phone that has it off never sends");
    }

    private static void devOnlyOnTheFirstCountOfTheDay() {
        Rig r = new Rig();
        r.counter.touch();
        r.now = T0 + 3_600_000L;
        r.counter.touch();
        r.now = T0 + 2 * 3_600_000L;
        r.counter.touch();
        r.now = Instant.parse("2026-11-26T08:05:00Z").toEpochMilli();
        r.counter.touch();
        List<Boolean> dev = new ArrayList<>();
        for (String[] post : r.posts) dev.add(post[1].contains("\"dev\""));
        same("[true, false, false, true]", dev.toString(), "`dev` on the first count of each UTC day only");
    }

    private static void theRequestIsExactlyTheInterface() {
        Rig r = new Rig();
        r.counter.touch();
        String[] post = r.posts.get(0);
        same("https://firestore.googleapis.com/v1/projects/autark-feedback-7/databases/(default)/documents:commit?key=AIzaSyExampleExampleExampleExample00000", post[0], "Firestore's commit with the shipped key");
        same("{\"writes\":[{\"transform\":{\"document\":\"projects/autark-feedback-7/databases/(default)/documents/use/2026-11-25-android-15\","
            + "\"fieldTransforms\":[{\"fieldPath\":\"n\",\"increment\":{\"integerValue\":\"1\"}},{\"fieldPath\":\"dev\",\"increment\":{\"integerValue\":\"1\"}}]}}]}", post[1], "n +1 and dev +1, nothing else");
        for (String forbidden : new String[] { "version", "device", "install", "locale", "language", "company", "agent", "user", "model", "manufacturer" })
            check(!post[1].toLowerCase().contains(forbidden), "the body has no \"" + forbidden + "\"");
    }

    private static void withoutACounterNothingIsSent() {
        Rig r = new Rig(null, null);
        r.counter.touch();
        same(0, r.posts.size(), "no counter address, no request");
    }

    private static void aLostCountIsDroppedNotRetried() {
        Rig r = new Rig();
        r.status = 403;
        for (int i = 0; i < 5; i++) r.counter.touch();
        same(1, r.posts.size(), "an answer other than 200: no retry in the same hour");
        same(null, r.prefs.get(UsageCounter.HOUR), "and nothing remembered");
        r.now = T0 + 3_600_000L;
        r.fail = true;
        r.counter.touch();
        same(2, r.posts.size(), "the next hour tries again; an exception is swallowed");
        same(null, r.prefs.get(UsageCounter.HOUR), "still nothing remembered");
    }

    private static void signalPieces() {
        same("2026-01-02T03", UsageSignal.hourKey(Instant.parse("2026-01-02T03:59:59Z").toEpochMilli()), "UTC hour key");
        same("2026-11-25-android-07", UsageSignal.documentId("2026-11-25T07"), "document id");
        check(UsageSignal.firstOfDay("2026-11-25T07", null), "first ever");
        check(UsageSignal.firstOfDay("2026-11-25T07", "2026-11-24T23"), "a new day");
        check(!UsageSignal.firstOfDay("2026-11-25T07", "2026-11-25T01"), "the same day");
        same("2026-11-25T07", UsageSignal.readHour(" 2026-11-25T07\n"), "a stored hour is read trimmed");
        same(null, UsageSignal.readHour("hello"), "a damaged one is nothing");
    }

    private static void same(Object expected, Object actual, String what) {
        assertions++;
        if (expected == null ? actual != null : !expected.equals(actual)) throw new AssertionError(what + ": expected <" + expected + "> but was <" + actual + ">");
    }

    private static void check(boolean condition, String what) {
        assertions++;
        if (!condition) throw new AssertionError(what);
    }
}
