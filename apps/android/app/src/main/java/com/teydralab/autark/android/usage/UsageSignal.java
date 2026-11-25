// Owns: what one anonymous usage count is (owner 25.11.2026, README › What Autark counts), as pure functions – the same
// request as the desktop's runtime/usage/signal.ts: one Firestore REST commit that raises `n` of the document
// use/<UTC day>-android-<UTC hour> by 1 and, on the first count of a UTC day, `dev` by 1. The rules
// (apps/desktop/resources/feedback/firestore.rules) accept no other field, no value but +1 and no other hour or day than
// the one the request arrives in. This file is the whole request: no device or install id, no version, no language.
// Never: reads settings or files, or touches the network.
package com.teydralab.autark.android.usage;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;

public final class UsageSignal {
    static final String PLATFORM = "android";
    private static final DateTimeFormatter HOUR = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH").withZone(ZoneOffset.UTC);

    private UsageSignal() {}

    /** The UTC hour of a time as "YYYY-MM-DDTHH" – the only state that is kept (and, by its first ten characters, the day). */
    public static String hourKey(long millis) {
        return HOUR.format(Instant.ofEpochMilli(millis));
    }

    /** The Firestore document of a count: "<day>-android-<HH>" in the collection use. */
    static String documentId(String hour) {
        return hour.substring(0, 10) + "-" + PLATFORM + "-" + hour.substring(11, 13);
    }

    /** Whether `hour` is the first count of its UTC day on this install, given the last hour that was counted (null: none). */
    static boolean firstOfDay(String hour, String lastHour) {
        return lastHour == null || !lastHour.startsWith(hour.substring(0, 10));
    }

    /** The commit body: `n` +1, and `dev` +1 on the first count of the day. These two fields are all there is. */
    static String body(String project, String hour, boolean first) {
        return "{\"writes\":[{\"transform\":{\"document\":\"projects/" + project + "/databases/(default)/documents/use/" + documentId(hour)
            + "\",\"fieldTransforms\":[{\"fieldPath\":\"n\",\"increment\":{\"integerValue\":\"1\"}}"
            + (first ? ",{\"fieldPath\":\"dev\",\"increment\":{\"integerValue\":\"1\"}}" : "") + "]}}]}";
    }

    /** The commit URL for a project and its public web key (the key of the feedback receiver, restricted to Firestore). */
    static String url(String project, String apiKey) {
        return "https://firestore.googleapis.com/v1/projects/" + project + "/databases/(default)/documents:commit?key=" + apiKey;
    }

    /** A stored hour with the shape of hourKey, else null (a damaged value counts as "nothing counted yet"). */
    static String readHour(String text) {
        if (text == null) return null;
        String hour = text.trim();
        return hour.matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}") ? hour : null;
    }
}
