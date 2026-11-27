// Owns: which language the app's own words (notices, bubble lines, the disclosure) are in – English, German only when the
// Autark profile says German (owner 18.11.2026: "Generell nichts in der App … standardmäßig nirgendwo"): the phone's own
// language never switches them. The profile language is the one TodoButton receives from the PC (todos.speechLanguage)
// and keeps in its preferences; a phone not linked yet, or linked to a PC without one, stays English. The rule itself is
// SpeechLang.german (pure, host-tested).
// Never: the language speech is heard in (SpeechLang.tag), or translations beyond German.
package com.teydralab.autark.android.phoneuse;

import android.content.Context;

public final class UiLang {
    private UiLang() {}

    /** Where TodoButton keeps the profile language it last received from the PC. */
    static final String PLACE = "todo_button", KEY = "speech_lang";

    /** Whether the profile language is German; anything else or nothing is English. */
    public static boolean german(String profileLanguage) { return SpeechLang.german(profileLanguage); }

    /** The same from the stored profile language; English when there is none or the preferences cannot be read. */
    public static boolean german(Context context) {
        try {
            Context app = context.getApplicationContext() != null ? context.getApplicationContext() : context;
            return german(app.getSharedPreferences(PLACE, Context.MODE_PRIVATE).getString(KEY, null));
        } catch (RuntimeException unreadable) {
            return false;
        }
    }
}
