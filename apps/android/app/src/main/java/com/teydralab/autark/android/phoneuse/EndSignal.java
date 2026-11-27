// Owns: the short "done" at the end of the AI's phone use (task_wz8y4krs, owner wish; S9 check 27.11.2026: the bubble
// went, but no "done" came) – whether an end shows it, its line in German or English, and how long it stays. Pure Java,
// so a host test pins it; UseBubble draws it.
// Never: shows "done" for another job, while the AI's question waits, after the person's ✕ (the bubble is already gone),
// or offers buttons.
package com.teydralab.autark.android.phoneuse;

final class EndSignal {
    /** How long the "done" line stays before the bubble goes. */
    static final long SHOW_MS = 2_000;

    /** What an end does to the bubble. */
    enum Outcome { IGNORE, DONE, GONE }

    private EndSignal() {}

    /** The PC's end of run `forJob` (or the quiet HIDE_AFTER_MS end, forJob null) against what the bubble shows:
     *  IGNORE – another job's run, or a question still waits; GONE – nothing on screen (closed by ✕ or never shown),
     *  so nothing to say; DONE – the short "done" line, then gone. */
    static Outcome on(String forJob, String job, boolean asking, boolean visible) {
        if (forJob != null && job != null && !forJob.equals(job)) return Outcome.IGNORE;
        if (asking) return Outcome.IGNORE;
        return visible ? Outcome.DONE : Outcome.GONE;
    }

    /** "✓ Mika ist fertig mit dem Handy" / "✓ Mika is done with your phone"; without a name the AI. */
    static String line(boolean german, String by) {
        String name = by == null || by.trim().isEmpty() ? null : by.trim();
        if (german) return "✓ " + (name == null ? "Die KI" : name) + " ist fertig mit dem Handy";
        return "✓ " + (name == null ? "The AI" : name) + " is done with your phone";
    }
}
