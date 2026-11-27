// Owns: which language the PC hears the to-do bubble's speech in (Dictation, BubbleCall: voice.transcribe's hint) – the
// language of the Autark profile (the person's own, one validated field of the PC's answer) before the phone's – and
// where the panel sits when the lock screen laid it out too far right; whether the app's own words are German (UiLang). Pure, so a host test pins it. Never: Android
// classes, or a profile's free text as the language.
package com.teydralab.autark.android.phoneuse;

import java.util.Map;
import java.util.regex.Pattern;

final class SpeechLang {
    private SpeechLang() {}

    /** A BCP 47 tag as the profile keeps it ("de", "de-AT", "en_US"): a language of 2–3 letters, then up to three parts of 2–8. */
    private static final Pattern LANGUAGE = Pattern.compile("[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8}){0,3}");

    /** Whether the answering link is still the one the language was asked for (a late answer of an earlier link is not). */
    static boolean isActive(Object asked, Object answering) { return asked != null && asked == answering; }

    /** The language as written, trimmed, when it has the shape of a tag; else null (a profile's free text never reaches the recognizer). */
    static String valid(String language) {
        if (language == null) return null;
        String trimmed = language.trim();
        return trimmed.length() <= 24 && LANGUAGE.matcher(trimmed).matches() ? trimmed : null;
    }

    /** The `language` of todos.speechLanguage's answer ({"language":"de-AT"} or {"language":null}), or null when it is not there or not a tag; nothing else of the answer is read. */
    static String profileLanguage(Object answer) {
        if (!(answer instanceof Map)) return null;
        Object language = ((Map<?, ?>) answer).get("language");
        return language instanceof String ? valid((String) language) : null;
    }

    /**
     * Whether the app's own words are German (UiLang): only when the profile language is German ("de", "de-AT", "de_DE");
     * anything else, nothing or a non-tag is English – the phone's own language never counts (owner 18.11.2026).
     */
    static boolean german(String profileLanguage) {
        String language = valid(profileLanguage);
        if (language == null) return false;
        String base = language.replace('_', '-');
        int dash = base.indexOf('-');
        return (dash < 0 ? base : base.substring(0, dash)).equalsIgnoreCase("de");
    }

    /**
     * The BCP 47 tag the PC hears the person in: the profile's language (a bare "de" or "en" with its usual region), else the
     * phone's own.
     */
    static String tag(String profile, String device) {
        String language = valid(profile);
        if (language == null) language = valid(device);
        if (language == null) return "en-US";
        language = language.replace('_', '-');
        if (language.equalsIgnoreCase("de")) return "de-DE";
        if (language.equalsIgnoreCase("en")) return "en-US";
        return language;
    }

    /**
     * The window's left edge after the layout: when the panel's right edge ends past the screen's, the window moves left by
     * the overflow (never past the screen's left edge). `left` is where the window really is (not where we asked for it).
     */
    static int shiftInto(int left, int width, int screenWidth) {
        if (left < 0) return 0;
        int overflow = left + width - screenWidth;
        return overflow > 0 ? Math.max(0, left - overflow) : left;
    }
}
