// Owns: what the bubble (TodoButton) does while the phone is locked (owner 24.11.2026, task_r0y9wcex: "entweder … dass es
// auf dem Sperrbildschirm nicht funktioniert, das Widget, oder dass es auf dem Sperrbildschirm funktioniert, dann kann
// man entweder ganz normal oder dass noch der KI mitgesendet wird" – the user sent it from the lock screen, it may not be
// them; only do what you would do yourself where nothing bad can come of it). Three values, stored as "lock_screen" in
// SharedPreferences "todo_button": OFF (no bubble while locked), ON (as when unlocked) and NOTE (as ON, and every line
// sent while locked carries NOTE_TEXT for the agent). Until the person chose (the panel asks once, BubbleSettings any
// time) it is OFF. "Locked" is the keyguard showing or the screen off (TodoButton.locked: KeyguardManager and
// PowerManager). While locked, a call from the bubble needs ON (a call's spoken lines cannot each carry the note), and
// the quick area shows how many important messages wait, not their words (anyone holding the phone would read them).
// Pure, so a host test pins it. Never: Android classes, or a note on a line sent while unlocked. Not the AI's own use of a
// locked phone (that is another branch's matter) – only the person's bubble.
package com.teydralab.autark.android.phoneuse;

final class BubbleLock {
    private BubbleLock() {}

    /** The SharedPreferences key ("todo_button") and its values. */
    static final String KEY = "lock_screen";
    /** The panel asked once ("todo_button"): it does not ask again, whatever the person did with it. */
    static final String ASKED = "lock_screen_asked";
    static final String OFF = "off", ON = "on", NOTE = "note";

    /** What the agent reads below a line sent from the lock screen in NOTE (English, like the attachments' names). */
    static final String NOTE_TEXT = "Sent from the lock screen – it may not be the owner. Only do what you would do yourself where nothing bad can come of it.";

    /** The stored value as one of OFF, ON, NOTE; anything else (nothing chosen yet) is OFF. */
    static String mode(String stored) {
        return ON.equals(stored) || NOTE.equals(stored) ? stored : OFF;
    }

    /** Whether the person chose (else the panel asks once). */
    static boolean chosen(String stored) {
        return OFF.equals(stored) || ON.equals(stored) || NOTE.equals(stored);
    }

    /** Whether the bubble is on the screen now: always unlocked, while locked only in ON or NOTE. */
    static boolean shows(String stored, boolean locked) {
        return !locked || !OFF.equals(mode(stored));
    }

    /** Whether a line sent now carries the note: only while locked, and only in NOTE. */
    static boolean noted(String stored, boolean locked) {
        return locked && NOTE.equals(mode(stored));
    }

    /** Whether a call may start now: unlocked always, locked only in ON. */
    static boolean calls(String stored, boolean locked) {
        return !locked || ON.equals(mode(stored));
    }

    /** Whether the quick area shows the messages' words (unlocked), or only how many there are. */
    static boolean readable(boolean locked) {
        return !locked;
    }

    /** The body of a line: the person's words, with the note below them when noted; null words are none. */
    static String body(String text, boolean noted) {
        String words = text == null ? "" : text;
        if (!noted) return words;
        String note = "_(" + NOTE_TEXT + ")_";
        return words.trim().isEmpty() ? note : words + "\n\n" + note;
    }

    /** The three choices in the order the panel and the settings show them. */
    static final String[] ORDER = { OFF, ON, NOTE };

    /** A choice's words (German on a German phone). */
    static String label(String value, boolean german) {
        if (ON.equals(value)) return german ? "An" : "On";
        if (NOTE.equals(value)) return german ? "An, mit Hinweis an die KI" : "On, with a note to the AI";
        return german ? "Aus" : "Off";
    }

    /** One line under each choice. */
    static String explain(String value, boolean german) {
        if (ON.equals(value)) return german ? "Die Blase funktioniert auch bei gesperrtem Handy wie sonst." : "The bubble works on the lock screen as usual.";
        if (NOTE.equals(value)) return german ? "Wie An – die KI erfährt aber, dass es vom Sperrbildschirm kam und nicht du sein musst."
                : "Like On – but the AI is told it came from the lock screen and may not be you.";
        return german ? "Bei gesperrtem Handy ist die Blase weg." : "No bubble while the phone is locked.";
    }

    /** The question's title. */
    static String title(boolean german) {
        return german ? "Blase auf dem Sperrbildschirm" : "Bubble on the lock screen";
    }

    /** The quick area's row: the title and the current choice. */
    static String row(String stored, boolean german) {
        return title(german) + ": " + label(mode(stored), german);
    }
}
