// Owns: host checks of EndSignal – the PC's end of a run shows the short "done" line in the bubble (task_wz8y4krs; S9
// check 27.11.2026: the bubble went, no "done" came), not for another job, not while a question waits, nothing when the
// bubble is already gone (✕); its German and English line with and without a name; and UseBubble's wiring to it (the
// done and the 2-minute end take the same way, ✕ stays silent, the done line has no buttons). Never: a device test.
package com.teydralab.autark.android.phoneuse;

public final class EndSignalTest {
    private static int assertions;

    private static void check(boolean ok, String what) {
        assertions++;
        if (!ok) throw new AssertionError(what);
    }

    private static String source(String path) throws java.io.IOException {
        return new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(System.getProperty("autark.android"), path)), java.nio.charset.StandardCharsets.UTF_8).replace("\r\n", "\n");
    }

    public static void main(String[] args) throws Exception {
        check(EndSignal.on("j1", "j1", false, true) == EndSignal.Outcome.DONE, "its own job's end says done");
        check(EndSignal.on(null, "j1", false, true) == EndSignal.Outcome.DONE, "the 2-minute end (no job) says done too");
        check(EndSignal.on("j1", null, false, true) == EndSignal.Outcome.DONE, "a bubble without a job says done");
        check(EndSignal.on("j2", "j1", false, true) == EndSignal.Outcome.IGNORE, "another job's end changes nothing");
        check(EndSignal.on("j1", "j1", true, true) == EndSignal.Outcome.IGNORE, "a waiting question stays");
        check(EndSignal.on(null, "j1", true, true) == EndSignal.Outcome.IGNORE, "a waiting question stays on the 2-minute end");
        check(EndSignal.on("j1", "j1", false, false) == EndSignal.Outcome.GONE, "closed by ✕ (not shown): no done");
        check(EndSignal.SHOW_MS >= 1_500 && EndSignal.SHOW_MS <= 3_000, "about 2 s");

        check("✓ Mika ist fertig mit dem Handy".equals(EndSignal.line(true, "Mika")), "German with the name");
        check("✓ Mika is done with your phone".equals(EndSignal.line(false, "Mika")), "English with the name");
        check("✓ Die KI ist fertig mit dem Handy".equals(EndSignal.line(true, null)), "German without a name");
        check("✓ Die KI ist fertig mit dem Handy".equals(EndSignal.line(true, "  ")), "a blank name is no name");
        check("✓ The AI is done with your phone".equals(EndSignal.line(false, null)), "English without a name");

        String bubble = source("app/src/main/java/com/teydralab/autark/android/phoneuse/UseBubble.java");
        check(bubble.contains("void finished(String forJob) { main.post(() -> end(forJob)); }"), "the PC's end goes the done way");
        check(bubble.contains("private final Runnable hide = () -> end(null);"), "the 2-minute end goes the same way");
        check(bubble.contains("void close() { main.post(() -> { main.removeCallbacks(hide); remove(); }); }"), "✕ closes at once, silently");
        check(bubble.contains("EndSignal.on(forJob, job, question != null, view != null)"), "UseBubble asks EndSignal");
        check(bubble.contains("main.postDelayed(gone, EndSignal.SHOW_MS)"), "the done line goes after SHOW_MS");
        int done = bubble.indexOf("if (look == Look.DONE) { // only the line");
        check(done > 0 && bubble.indexOf("close.setVisibility(View.GONE)", done) > done
                && bubble.indexOf("primary.setVisibility(View.GONE)", done) > done, "the done line has no Pause and no ✕");
        check(bubble.contains("if (look == Look.DONE) leaveDone(next);"), "a new step in the 2 s brings the active look back");
        System.out.println("EndSignalTest: " + assertions + " assertions passed");
    }
}
