// Owns: how long one phone-use step may run on the phone, and running it within that time (owner 19.11.2026 "Du bleibst
// die ganze Zeit hier hängen", 27.11.2026: phone.open SimplySign stayed on its start screen and the next open ran into
// the PC's 20 s timeout). A step runs on a worker thread; when it is not done in time the phone answers "timeout" with
// what to do instead of staying silent, the stuck worker is interrupted and left behind, and the next step gets a fresh
// worker – one app that does not answer Android's accessibility queries never holds every later step. The limit stays
// under the PC's own step limit (desktop phone/app-driver.ts APP_PHONE_TIMEOUT_MS, 20 s), so the phone's answer arrives
// first. Pure Java, so a host test pins it.
// Never: runs two steps at once on purpose (UseLink waits for each), or retries a step.
package com.teydralab.autark.android.phoneuse;

import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

final class StepDeadline {
    /** An ordinary step's limit on the phone: under the PC's 20 s, so a clear answer comes before the PC gives up. */
    static final long STEP_MS = 15_000;

    /** A step that did not finish in time. */
    static final class Late extends Exception {
        private static final long serialVersionUID = 1L;
        final long ms;
        Late(long ms) { super("late"); this.ms = ms; }
    }

    private ExecutorService worker = fresh();

    /**
     * The limit of one step: phone.say with a question waits for the person (`askMs` and a little more – the PC waits 75 s),
     * a long swipe its own length and a little more (still under the PC's 20 s); everything else STEP_MS.
     */
    static long limitMs(String op, boolean ask, long askMs, long durationMs) {
        if ("say".equals(op) && ask) return askMs + 5_000;
        if ("swipe".equals(op)) return Math.min(19_000, Math.max(STEP_MS, durationMs + 5_000));
        return STEP_MS;
    }

    /** What the AI reads when a step ran out of time: what it means and the way out. */
    static String lateMessage(String op, long ms) {
        return "The step " + op + " did not finish on the phone within " + (ms / 1000) + " s: the app in front does not answer Android "
                + "(it hangs, for example on its start screen). I stopped it there; nothing else waits behind it. phone.screenshot shows the "
                + "screen; phone.key home or back leaves the app, and phone.open starts it again.";
    }

    /** Runs `step` on the worker and returns its result within `ms`; Late after that (the worker is replaced), the step's own error as it is. */
    synchronized <T> T run(Callable<T> step, long ms) throws Exception {
        Future<T> running = worker.submit(step);
        try {
            return running.get(ms, TimeUnit.MILLISECONDS);
        } catch (TimeoutException late) {
            running.cancel(true);
            worker.shutdownNow();
            worker = fresh();
            throw new Late(ms);
        } catch (ExecutionException failed) {
            Throwable cause = failed.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            if (cause instanceof Error) throw (Error) cause;
            throw failed;
        } catch (InterruptedException stop) {
            running.cancel(true);
            Thread.currentThread().interrupt();
            throw stop;
        }
    }

    synchronized void stop() { worker.shutdownNow(); }

    private static ExecutorService fresh() {
        return Executors.newSingleThreadExecutor((work) -> {
            Thread thread = new Thread(work, "autark-phone-use-step");
            thread.setDaemon(true);
            return thread;
        });
    }
}
