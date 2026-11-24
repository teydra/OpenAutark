// Owns: one dictation take of the to-do bubble (owner 20.11.2026: as good as the app's own) – the microphone (Mic) records
// 16 kHz PCM, every SpokenAudio.PIECE_MS a piece is cut at a quiet moment and goes to the PC at once, the rest when the
// take finishes; each piece is uploaded (files.upload) and heard by the PC (voice.transcribe in the person's language,
// the text so far as context) – one after another on a worker thread, so the texts join in order. The take's whole text
// (or, after a failure, what was heard plus one line why) comes back once on the main thread. A take that was pure
// digital silence says that Android kept the microphone from the bubble. A take that reaches TAKE_MAX_MS tells its owner
// (`full`, main thread), who finishes it the usual way. Used by the panel's mic and the dot's hold
// (TodoButton). STIMME 21.11.2026: a piece is first heard by the person's ChatGPT plan from the phone itself (PlanHearing,
// the plan login from the PC); only a piece that gave nothing there goes to the PC as above. 24.11.2026: a piece is
// heard from just before its first to just after its last voice, and one without voice by nobody (SpokenAudio.voicedSpan).
// Never: keeps audio beyond its request, sends a piece twice, or answers twice.
package com.teydralab.autark.android.phoneuse;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class Dictation {
    /** The take's end (main thread, once): its text ("" when nothing was heard) and a line for the person, or null. */
    interface Done { void heard(String text, String problem); }

    private static final long UPLOAD_MS = 60_000;
    /** A minute of speech heard by the PC's local model can take a while on a slow PC. */
    private static final long HEAR_MS = 120_000;
    /** The longest take: it finishes by itself (the person forgot it running). */
    static final int TAKE_MAX_MS = 15 * 60_000;

    private final Mic mic;
    private final UseLink link;
    private final String language;
    private final Done done;
    private final Runnable full;
    private final boolean german = "de".equals(Locale.getDefault().getLanguage());
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService work = Executors.newSingleThreadExecutor((job) -> {
        Thread thread = new Thread(job, "autark-dictation");
        thread.setDaemon(true);
        return thread;
    });
    /** Guarded by this: the recorded samples not sent yet, and how many of the take in all. */
    private short[] buffer = new short[SpokenAudio.samples(SpokenAudio.PIECE_MS)];
    private int length;
    private long total;
    private boolean loud;
    private boolean finished;
    // The worker's own: the text so far, a failure, how many pieces went.
    private String text = "";
    private String problem;
    private int pieces;
    private volatile boolean cancelled;

    /** `full` runs on the main thread when the take reached TAKE_MAX_MS or the microphone went; the owner then finishes it. */
    Dictation(Context context, UseLink link, String language, Done done, Runnable full) {
        this.mic = new Mic(context);
        this.link = link;
        this.language = language;
        this.done = done;
        this.full = full;
    }

    /** Starts recording (main thread); false when the microphone could not be opened. */
    boolean start() { return mic.start(this::heard, () -> main.post(() -> { if (!cancelled) full.run(); })); } // the microphone went: the owner finishes with what was heard

    /** The person ends the take (main thread): the rest goes to the PC, done hears the whole text. */
    void finish() {
        mic.stop();
        short[] rest;
        int count;
        boolean anything;
        long recorded;
        synchronized (this) {
            if (finished) return;
            finished = true;
            rest = buffer;
            count = length;
            anything = loud;
            recorded = total;
            buffer = new short[0];
            length = 0;
        }
        if (count > 0) send(rest, count);
        boolean silent = !anything;
        run(() -> {
            String line = problem;
            if (line == null && text.isEmpty() && silent && recorded > SpokenAudio.samples(500)) {
                line = german ? "Android gibt der Blase gerade kein Mikrofon – öffne die App und diktiere dort." : "Android gives the bubble no microphone right now – open the app and dictate there.";
            }
            String heard = text;
            String why = line;
            main.post(() -> { if (!cancelled) done.heard(heard, why); });
            work.shutdown();
        });
    }

    /** Drops the take (main thread): nothing more goes out, done never hears. */
    void cancel() {
        cancelled = true;
        mic.stop();
        synchronized (this) { finished = true; buffer = new short[0]; length = 0; }
        work.shutdownNow();
    }

    /** The Mic's thread: samples into the buffer; a full piece is cut at its quietest moment and goes to the PC. */
    private void heard(short[] block, int count) {
        short[] piece = null;
        int cut = 0;
        boolean limit;
        synchronized (this) {
            boolean before = total >= SpokenAudio.samples(TAKE_MAX_MS);
            if (finished) return;
            for (int i = 0; i < count && !loud; i++) if (block[i] != 0) loud = true;
            if (length + count > buffer.length) {
                cut = SpokenAudio.quietCut(buffer, length);
                piece = buffer;
                short[] next = new short[buffer.length];
                System.arraycopy(buffer, cut, next, 0, length - cut);
                length -= cut;
                buffer = next;
            }
            System.arraycopy(block, 0, buffer, length, count);
            length += count;
            total += count;
            limit = !before && total >= SpokenAudio.samples(TAKE_MAX_MS);
        }
        if (piece != null) send(piece, cut);
        if (limit) main.post(() -> { if (!cancelled) full.run(); });
    }

    /** One piece to the PC (the worker, in order): uploaded, heard, its text joined to the take's. */
    private void send(short[] pcm, int count) {
        // 24.11.2026: only the voiced part goes to a recognizer, a piece without voice to none (SpokenAudio.voicedSpan)
        int[] voiced = SpokenAudio.voicedSpan(pcm, 0, count);
        if (voiced == null) return;
        byte[] wav = SpokenAudio.wav(pcm, voiced[0], voiced[1]);
        run(() -> {
            if (problem != null || cancelled) return;
            if (link == null) { problem = german ? "Gerade nicht mit deinem PC verbunden." : UseLink.UNLINKED; return; }
            try { text = SpokenAudio.join(text, link.hearing().hear(wav, "audio/wav", language)); return; }
            catch (PlanHearing.Missed missed) { /* the PC hears it */ }
            try {
                String fileId = TodoPost.fileId(link.request("files.upload", SpokenAudio.upload(wav, ++pieces), UPLOAD_MS));
                if (fileId == null) { problem = german ? "Der PC hat die Aufnahme nicht angenommen." : "The PC did not take the recording."; return; }
                Object heard = link.request("voice.transcribe", SpokenAudio.transcribe(fileId, language, text, null), HEAR_MS);
                text = SpokenAudio.join(text, SpokenAudio.text(heard));
            } catch (UseLink.Refused refused) {
                problem = refused.late ? (german ? "Der PC hat nicht rechtzeitig zugehört." : "The PC did not answer in time.") : refused.getMessage();
            }
        });
    }

    private interface Job { void run() throws InterruptedException; }

    private void run(Job job) {
        try {
            work.execute(() -> {
                try { job.run(); } catch (InterruptedException stop) { Thread.currentThread().interrupt(); }
            });
        } catch (RuntimeException shutDown) { /* cancelled */ }
    }
}
