// Owns: host checks of the AI's buttons in the phone bubble (SayChoices, owner 19.11.2026): any number up to MAX, small
// labels beside the line (at most ROW_MAX), the rest under it in order; ✕ is the bubble's own cell; ✓ answers yes, ✕ no,
// any other label itself; `ask` alone is ✓; long labels are cut. Also that a finished run leaves the person's Pause
// (UseState.finished), and that the bubble and the service are wired for it (read from the sources). Never: a device test (the bubble's look is checked on a phone).
package com.teydralab.autark.android.phoneuse;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public final class SayChoicesTest {
    private static int assertions;

    private static void check(boolean ok, String what) {
        assertions++;
        if (!ok) throw new AssertionError(what);
    }

    public static void main(String[] args) throws Exception {
        labels();
        layout();
        answers();
        finished();
        wiring();
        System.out.println("SayChoicesTest: " + assertions + " assertions passed");
    }

    private static void labels() {
        check(SayChoices.of(null, false).isEmpty(), "a plain line has no buttons");
        check(SayChoices.of(null, true).equals(Collections.singletonList("✓")), "ask alone is ✓ (and the ✕ cell)");
        check(SayChoices.of(Arrays.asList("✓", "✕"), false).equals(Collections.singletonList("✓")), "✕ is the bubble's own cell");
        check(SayChoices.of(Collections.singletonList("✕"), false).isEmpty() && SayChoices.asks(Collections.singletonList("✕"), false), "only ✕ still asks");
        check(!SayChoices.asks(null, false) && !SayChoices.asks(Collections.emptyList(), false), "no buttons, no ask: a line");
        check(SayChoices.of(Arrays.asList("  Ja,  mach  ", "Ja, mach", 3, ""), false).equals(Collections.singletonList("Ja, mach")), "folded, distinct, strings only");
        List<String> many = SayChoices.of(Arrays.asList("1", "2", "3", "4", "5", "6", "7", "8", "9", "10"), false);
        check(many.size() == SayChoices.MAX && many.get(7).equals("8"), "up to MAX in their order");
        String longLabel = SayChoices.of(Collections.singletonList("x".repeat(60)), false).get(0);
        check(longLabel.codePointCount(0, longLabel.length()) == SayChoices.LABEL_MAX && longLabel.endsWith("…"), "a long label is cut");
    }

    private static void layout() {
        List<String> labels = Arrays.asList("✓", "Später", "OK", "👍", "Nein", "Rechnung zuerst senden");
        check(SayChoices.row(labels).equals(Arrays.asList("✓", "OK", "👍")), "the first small ones sit beside the line");
        check(SayChoices.below(labels).equals(Arrays.asList("Später", "Nein", "Rechnung zuerst senden")), "the rest go under it, in order");
        check(SayChoices.small("Nein") && !SayChoices.small("Später"), "four characters are small, more are not");
    }

    private static void answers() {
        check(SayChoices.answer("✓").equals("yes") && SayChoices.answer("✕").equals("no"), "✓ yes, ✕ no");
        check(SayChoices.answer("Später").equals("Später"), "any other label answers itself");
    }

    private static void finished() {
        UseState s = new UseState();
        check(s.step("run_a", 1_000) == null, "a first step runs");
        s.finished("run_b");
        s.finished("run_a");
        check(s.mode() == UseState.Mode.ACTIVE, "a run's end leaves phone use active");
        UseState held = new UseState();
        held.step("run_a", 1_000);
        held.pause();
        held.finished("run_a");
        check(held.mode() == UseState.Mode.PAUSED, "the person's Pause stays");
    }

    private static void wiring() throws Exception {
        String service = source("UseService.java");
        String bubble = source("UseBubble.java");
        check(service.contains("\"done\".equals(op)") && service.indexOf("\"done\".equals(op)") < service.indexOf("state.step(job"), "done is no step: it comes before the step check");
        check(service.contains("bubble.finished(job)"), "done takes the bubble away");
        check(bubble.contains("EndSignal.on(forJob, job, question != null, view != null)")
                && EndSignal.on("run_a", "run_a", true, true) == EndSignal.Outcome.IGNORE, "a waiting question keeps the bubble");
        check(bubble.contains("setMaxLines(3)"), "the line grows to three lines");
        check(bubble.contains("HIDE_AFTER_MS = 2 * 60_000"), "without the PC's word the bubble goes within two minutes");
    }

    private static String source(String name) throws Exception {
        String root = System.getProperty("autark.android", ".");
        return new String(Files.readAllBytes(Paths.get(root, "app/src/main/java/com/teydralab/autark/android/phoneuse", name)), StandardCharsets.UTF_8);
    }
}
