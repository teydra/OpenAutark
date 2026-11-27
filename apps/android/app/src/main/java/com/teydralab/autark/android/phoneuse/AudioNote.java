// Owns: the plus menu's audio recording (owner 24.11.2026, task_r0y9wcex: "Ton aufnehmen und das direkt mitschicken,
// also nicht transkribieren, sondern wirklich Audio mitschicken") – Android's MediaRecorder from the plain microphone
// (the room as it sounds, not the speech-tuned source of Mic) into an AAC file (.m4a, mono, 44.1 kHz, 96 kbit/s, about
// 0.7 MB a minute) in cache/bubble/ (BubblePick.newFile), at most MAX_MS (then `full` runs and the owner stops it).
// level() is polled by the owner while it records; a take that never had a level above zero is reported silent (Android
// kept the microphone from the bubble), so it is not sent as an empty file. The file is the take; TodoButton attaches it
// as an audio file – no recognizer ever hears it.
// Never: records without the microphone right, sends anything itself, or keeps a file after cancel().
package com.teydralab.autark.android.phoneuse;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.SystemClock;
import java.io.File;
import java.io.IOException;

final class AudioNote {
    /** One finished take: its file, its length and whether it was all silence. */
    static final class Take {
        final File file;
        final long ms;
        final boolean silent;
        Take(File file, long ms, boolean silent) { this.file = file; this.ms = ms; this.silent = silent; }
    }

    /** The longest recording: it finishes by itself (the person forgot it running). */
    static final int MAX_MS = 15 * 60_000;
    /** A take shorter than this is never called silent (no level was polled yet). */
    private static final long SILENT_AFTER_MS = 1_500;
    private final Context context;
    private final Runnable full;
    private MediaRecorder recorder;
    private File file;
    private long startedAt;
    private boolean loud;

    AudioNote(Context context, Runnable full) {
        this.context = context;
        this.full = full;
    }

    /** Starts recording (main thread); false when the microphone could not be opened. */
    boolean start() {
        // The check stands here so lint sees it before MediaRecorder records.
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false;
        try {
            file = BubblePick.newFile(context, "audio", "m4a");
            recorder = recorder(context);
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioChannels(1);
            recorder.setAudioSamplingRate(44_100);
            recorder.setAudioEncodingBitRate(96_000);
            recorder.setMaxDuration(MAX_MS);
            recorder.setOutputFile(file.getAbsolutePath());
            recorder.setOnInfoListener((which, what, extra) -> { if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) full.run(); });
            recorder.prepare();
            recorder.start();
            startedAt = SystemClock.elapsedRealtime();
            return true;
        } catch (IOException | RuntimeException failed) { // another app holds the microphone, the right went
            release();
            if (file != null) file.delete();
            file = null;
            return false;
        }
    }

    @SuppressWarnings("deprecation")
    private static MediaRecorder recorder(Context context) {
        return Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(context) : new MediaRecorder();
    }

    /** How long it records now (ms). */
    long elapsed() { return recorder == null ? 0 : SystemClock.elapsedRealtime() - startedAt; }

    /** The loudest level since the last call (0 … 32767); remembers that there was sound. */
    int level() {
        if (recorder == null) return 0;
        try {
            int level = recorder.getMaxAmplitude();
            if (level > 0) loud = true;
            return level;
        } catch (RuntimeException stopped) { return 0; }
    }

    /** Ends the take (main thread): the file, or null when nothing was recorded (the file is gone then). */
    Take stop() {
        if (recorder == null) return null;
        long ms = elapsed();
        level();
        boolean ok;
        try { recorder.stop(); ok = true; } catch (RuntimeException nothing) { ok = false; } // stop() right after start() records nothing
        release();
        File take = file;
        file = null;
        if (!ok || take == null || take.length() == 0) { if (take != null) take.delete(); return null; }
        return new Take(take, ms, !loud && ms >= SILENT_AFTER_MS);
    }

    /** Drops the take: nothing is kept. */
    void cancel() {
        if (recorder != null) { try { recorder.stop(); } catch (RuntimeException ignored) { /* nothing recorded */ } }
        release();
        if (file != null) file.delete();
        file = null;
    }

    private void release() {
        if (recorder != null) { try { recorder.release(); } catch (RuntimeException ignored) { /* already released */ } }
        recorder = null;
    }
}
