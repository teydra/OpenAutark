// Owns: how long phone use keeps the processor awake with the screen off, so the PC's next step still reaches the phone:
// ten minutes from the screen going off or from the AI's last step, twelve hours while the phone charges. Pure Java
// (host-tested). Never: holds a lock itself.
package com.teydralab.autark.android.phoneuse;

public final class AwakeRule {
    static final long REACH_MS = 10 * 60_000L;
    static final long CHARGING_MS = 12 * 60 * 60_000L;
    /** How long a screen the AI woke stays on after its last step. */
    static final long LIT_MS = 30_000L;

    private AwakeRule() {}

    /** The processor's hold from now, in milliseconds. */
    public static long reach(boolean charging) { return charging ? CHARGING_MS : REACH_MS; }
}
