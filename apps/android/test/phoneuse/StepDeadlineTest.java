// Owns: host checks of StepDeadline – a phone-use step that does not finish in time is answered "late" before the PC's
// 20 s, the stuck worker is interrupted and the next step runs on a fresh one at once (27.11.2026: phone.open SimplySign,
// then a second open that ran into the PC's timeout); results and a step's own error pass through unchanged; the limits
// of a question and a long swipe. Never: a device test (Android's accessibility calls themselves).
package com.teydralab.autark.android.phoneuse;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public final class StepDeadlineTest {
    private static int assertions;

    private static void check(boolean ok, String what) {
        assertions++;
        if (!ok) throw new AssertionError(what);
    }

    private static String source(String path) throws java.io.IOException {
        return new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(System.getProperty("autark.android"), path)), java.nio.charset.StandardCharsets.UTF_8).replace("\r\n", "\n");
    }

    public static void main(String[] args) throws Exception {
        StepDeadline deadline = new StepDeadline();
        check("done".equals(deadline.run(() -> "done", 1_000)), "a quick step's result passes through");
        try { deadline.run(() -> { throw new IllegalStateException("own"); }, 1_000); check(false, "the step's own error"); }
        catch (IllegalStateException own) { check("own".equals(own.getMessage()), "its own error, unchanged"); }

        CountDownLatch never = new CountDownLatch(1);
        AtomicBoolean interrupted = new AtomicBoolean(false);
        CountDownLatch gone = new CountDownLatch(1);
        long started = System.nanoTime();
        try {
            deadline.run(() -> {
                try { never.await(); } catch (InterruptedException stop) { interrupted.set(true); gone.countDown(); }
                return "late";
            }, 300);
            check(false, "a stuck step is late");
        } catch (StepDeadline.Late late) {
            check(late.ms == 300, "late after its limit");
        }
        long tookMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        check(tookMs >= 280 && tookMs < 3_000, "answered at its limit, not later: " + tookMs + " ms");
        check(gone.await(2, TimeUnit.SECONDS) && interrupted.get(), "the stuck worker is interrupted");
        long next = System.nanoTime();
        check("next".equals(deadline.run(() -> "next", 1_000)), "the next step runs");
        check(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - next) < 1_000, "at once, on a fresh worker");

        // a step stuck where an interrupt does not reach (a blocked call): the next one still does not wait behind it
        CountDownLatch release = new CountDownLatch(1);
        try {
            deadline.run(() -> { while (release.getCount() > 0) { try { release.await(); } catch (InterruptedException ignored) { /* keeps blocking */ } } return "x"; }, 200);
            check(false, "late");
        } catch (StepDeadline.Late late) { check(true, "late"); }
        check("after".equals(deadline.run(() -> "after", 1_000)), "the next step does not wait behind an uninterruptible one");
        release.countDown();

        check(StepDeadline.limitMs("open", false, 60_000, 0) == StepDeadline.STEP_MS && StepDeadline.STEP_MS < 20_000, "an ordinary step: under the PC's 20 s");
        check(StepDeadline.limitMs("say", true, 60_000, 0) == 65_000 && StepDeadline.limitMs("say", false, 60_000, 0) == StepDeadline.STEP_MS, "a question waits for the person (the PC waits 75 s)");
        check(StepDeadline.limitMs("swipe", false, 60_000, 400) == StepDeadline.STEP_MS && StepDeadline.limitMs("swipe", false, 60_000, 30_000) == 19_000, "a long swipe: its length, still under 20 s");
        String said = StepDeadline.lateMessage("open", 15_000);
        check(said.contains("open did not finish on the phone within 15 s") && said.contains("nothing else waits behind it") && said.contains("phone.key home"), said);
        deadline.stop();

        // the wiring: every phone-use step runs through the deadline, and phone.open checks its app came to the front
        String java = "app/src/main/java/com/teydralab/autark/android/phoneuse/";
        String link = source(java + "UseLink.java"), service = source(java + "UseService.java");
        check(link.contains("deadline.run(() -> service.run(op, params") && link.contains("catch (StepDeadline.Late late)") && link.contains("deadline.stop();"), "UseLink runs each step within its limit");
        check(service.contains("if (watchingFront) awaitFront(pkg, app);") && service.contains("AppNames.notInFront(") && !service.contains("return \"opened\""), "phone.open waits for its app in front");
        check(service.indexOf("notLate();") > 0 && service.indexOf("notLate();", service.indexOf("notLate();") + 1) > 0, "a late step does no tap, text or app start afterwards");
        System.out.println("StepDeadlineTest: " + assertions + " assertions passed");
    }
}
