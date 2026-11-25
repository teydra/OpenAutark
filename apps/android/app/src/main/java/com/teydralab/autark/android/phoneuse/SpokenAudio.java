// Owns: what the bubble's speech is on its way to the PC (owner 20.11.2026: "so gut wie in einer normalen App" – the phone's
// own recognizer heard "We got to steer" for "Wie geht es dir?") – the same path as the app's composer (ui/lib/dictation.ts):
// 16 kHz mono PCM16 as WAV pieces (files.upload) that the PC hears (voice.transcribe, the person's language as the hint,
// the text heard so far as context); a long take is cut into pieces of at most PIECE_MS at the quietest 50 ms of their
// last QUIET_SEARCH_MS, so no word is cut in half. For the call, Turns finds the end of a spoken line by level, the rule of
// the page's fallback (ui/lib/turn-detect.ts): a frame is speech when it is louder than both THRESHOLD and three times the
// learned noise floor, a line starts after 3 of 4 speech frames and ends after LINE_SILENCE_MS without speech (at most
// LINE_MAX_MS). Pure Java, so a host test pins it (test/phoneuse/SpokenAudioTest.java); Mic records, Dictation and
// BubbleCall send. Never: Android classes, keeps audio anywhere but the request, or decides what was said.
package com.teydralab.autark.android.phoneuse;

import java.io.ByteArrayOutputStream;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

final class SpokenAudio {
    static final int RATE = 16_000;
    /** A piece of a long take: at most one minute (1.9 MB of WAV, well under one socket frame). */
    static final int PIECE_MS = 60_000;
    /** A piece ends at the quietest 50 ms of its last this-many ms. */
    static final int QUIET_SEARCH_MS = 8_000;
    private static final int WINDOW = RATE / 20;
    /** The text heard before a piece goes along as context, at most this long (voice.transcribe takes 2000). */
    static final int BEFORE_MAX = 2_000;

    /** Turns: one frame (32 ms), the minimum speech level (RMS of PCM16; 0.018 of full scale), the floor ratio. */
    static final int FRAME = 512;
    static final double THRESHOLD = 0.018 * 32768;
    private static final double FLOOR_RATIO = 3;
    private static final double FLOOR_RISE = 1.005;
    static final int LINE_SILENCE_MS = 1_100;
    static final int LINE_MAX_MS = 120_000;
    /** Audio kept from before a line started, so its first word is in it. */
    static final int PRE_ROLL_MS = 300;

    private SpokenAudio() {}

    /** Voice in a piece (24.11.2026, owner: "Colearning Salzburg" stood at the end of a dictation he never said – the plan
     *  login's name, written by the ChatGPT recognizer for the pause before Stop): the rule of shared/voice/voiced.ts with
     *  the same numbers – high-passed at VOICE_HIGH_PASS_HZ, 32 ms frames, a frame is voice at VOICE_MIN_LEVEL and
     *  VOICE_FLOOR_RATIO over the piece's floor (its 20th percentile) or VOICE_LOUD outright; VOICE_MIN_MS of it is voice. */
    static final int VOICE_HIGH_PASS_HZ = 100;
    static final double VOICE_MIN_LEVEL = 0.004;
    static final double VOICE_FLOOR_RATIO = 1.8;
    static final double VOICE_LOUD = 0.05;
    static final int VOICE_MIN_MS = 160;
    /** What a heard piece keeps before its first and after its last voiced frame (a word's soft start and end). */
    static final int VOICE_KEEP_MS = 500;


    static int samples(int ms) { return (int) ((long) RATE * ms / 1000); }

    /** pcm[from, to) as a WAV file (16 kHz, mono, 16 bit). */
    static byte[] wav(short[] pcm, int from, int to) {
        int count = Math.max(0, to - from);
        ByteArrayOutputStream out = new ByteArrayOutputStream(44 + count * 2);
        int bytes = count * 2;
        ascii(out, "RIFF"); le32(out, 36 + bytes); ascii(out, "WAVE");
        ascii(out, "fmt "); le32(out, 16); le16(out, 1); le16(out, 1); le32(out, RATE); le32(out, RATE * 2); le16(out, 2); le16(out, 16);
        ascii(out, "data"); le32(out, bytes);
        for (int i = from; i < to; i++) le16(out, pcm[i]);
        return out.toByteArray();
    }

    /** Where a piece of pcm[0, length) ends: the middle of the quietest 50 ms window in its last QUIET_SEARCH_MS. */
    static int quietCut(short[] pcm, int length) {
        int start = Math.max(0, length - samples(QUIET_SEARCH_MS));
        if (length - start < WINDOW) return length;
        long best = Long.MAX_VALUE;
        int at = length;
        for (int w = start; w + WINDOW <= length; w += WINDOW / 2) {
            long energy = 0;
            for (int i = w; i < w + WINDOW; i++) energy += (long) pcm[i] * pcm[i];
            if (energy < best) { best = energy; at = w + WINDOW / 2; }
        }
        return at;
    }

    /** The part of pcm[from, to) a recognizer hears: from VOICE_KEEP_MS before its first voiced frame to VOICE_KEEP_MS after
     *  its last, as {start, end}; null when it holds no voice (then no recognizer hears it: silence and room noise are
     *  where one writes words of its own). */
    static int[] voicedSpan(short[] pcm, int from, int to) {
        int count = Math.max(0, to - from);
        int frames = count / FRAME;
        if (frames == 0) return null;
        double[] filtered = new double[count];
        for (int i = 0; i < count; i++) filtered[i] = pcm[from + i] / 32768.0;
        double rc = 1 / (2 * Math.PI * VOICE_HIGH_PASS_HZ);
        double a = rc / (rc + 1.0 / RATE);
        for (int pass = 0; pass < 2; pass++) {
            double previousIn = filtered[0];
            double previousOut = 0;
            for (int i = 0; i < count; i++) {
                double input = filtered[i];
                previousOut = a * (previousOut + input - previousIn);
                previousIn = input;
                filtered[i] = previousOut;
            }
        }
        double[] levels = new double[frames];
        boolean[] loud = new boolean[frames];
        for (int f = 0; f < frames; f++) {
            double sum = 0;
            double raw = 0;
            for (int i = f * FRAME; i < (f + 1) * FRAME; i++) {
                sum += filtered[i] * filtered[i];
                double sample = pcm[from + i] / 32768.0;
                raw += sample * sample;
            }
            levels[f] = Math.sqrt(sum / FRAME);
            loud[f] = Math.sqrt(raw / FRAME) >= VOICE_LOUD;
        }
        double[] sorted = levels.clone();
        java.util.Arrays.sort(sorted);
        double bar = Math.max(VOICE_MIN_LEVEL, sorted[(int) Math.floor((frames - 1) * 0.2)] * VOICE_FLOOR_RATIO);
        int first = -1;
        int last = -1;
        int voiced = 0;
        for (int f = 0; f < frames; f++) {
            if (!loud[f] && levels[f] < bar) continue;
            voiced++;
            if (first < 0) first = f;
            last = f;
        }
        if ((long) voiced * FRAME * 1000 / RATE < VOICE_MIN_MS) return null;
        int keep = samples(VOICE_KEEP_MS);
        return new int[] { Math.max(from, from + first * FRAME - keep), Math.min(to, from + (last + 1) * FRAME + keep) };
    }

    /** files.upload's params for one WAV piece. */
    static Map<String, Object> upload(byte[] wav, int piece) {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("name", "dictation-" + piece + ".wav");
        params.put("mime", "audio/wav");
        params.put("dataBase64", Base64.getEncoder().encodeToString(wav));
        return params;
    }

    /** voice.transcribe's params: the file, the language hint (a tag), the text heard before it, the chat as context. */
    static Map<String, Object> transcribe(String fileId, String language, String before, String chatId) {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("fileId", fileId);
        String tag = SpeechLang.valid(language);
        if (tag != null) params.put("language", tag);
        String context = before == null ? "" : before.trim();
        if (context.length() > BEFORE_MAX) context = context.substring(context.length() - BEFORE_MAX);
        if (!context.isEmpty()) params.put("before", context);
        if (chatId != null && !chatId.isEmpty()) params.put("chatId", chatId);
        return params;
    }

    /** The text of voice.transcribe's answer ({text, …}); "" when there is none. */
    static String text(Object answer) {
        if (!(answer instanceof Map)) return "";
        Object text = ((Map<?, ?>) answer).get("text");
        return text instanceof String ? ((String) text).trim() : "";
    }

    /** Two texts of one take, one space between; blank parts drop out. */
    static String join(String head, String tail) {
        String a = head == null ? "" : head.trim();
        String b = tail == null ? "" : tail.trim();
        return a.isEmpty() ? b : b.isEmpty() ? a : a + " " + b;
    }

    /** The end of a spoken line, by level: feed 16 kHz PCM16 in any block size; START when a line begins, END when it is
     *  over, else null. Not thread-safe: one reader feeds it. */
    static final class Turns {
        enum Edge { START, END }

        private final short[] frame = new short[FRAME];
        private int filled;
        private double floor = 0.004 * 32768;
        private int recent; // speech bits of the last 4 frames before a line
        private boolean speaking;
        private int quietFrames;
        private int lineFrames;
        private Edge pending;

        boolean speaking() { return speaking; }

        /** Forget the running line (the phone is about to speak, or the line went out). */
        void reset() { speaking = false; recent = 0; quietFrames = 0; lineFrames = 0; filled = 0; pending = null; }

        Edge feed(short[] block, int count) {
            for (int i = 0; i < count; i++) {
                frame[filled++] = block[i];
                if (filled == FRAME) { filled = 0; step(rms(frame)); }
            }
            Edge edge = pending;
            pending = null;
            return edge;
        }

        private void step(double level) {
            boolean speech = level > THRESHOLD && level > FLOOR_RATIO * floor;
            if (!speech) floor = floor * 0.95 + level * 0.05;
            else if (speaking) floor = Math.min(level, floor * FLOOR_RISE); // a steady hum becomes the floor
            if (!speaking) {
                recent = ((recent << 1) | (speech ? 1 : 0)) & 0xF;
                if (Integer.bitCount(recent) >= 3) { speaking = true; quietFrames = 0; lineFrames = 4; pending = Edge.START; }
                return;
            }
            lineFrames++;
            quietFrames = speech ? 0 : quietFrames + 1;
            if (quietFrames * FRAME * 1000L / RATE >= LINE_SILENCE_MS || lineFrames * FRAME * 1000L / RATE >= LINE_MAX_MS) {
                speaking = false;
                recent = 0;
                pending = Edge.END;
            }
        }

        private static double rms(short[] frame) {
            double sum = 0;
            for (short value : frame) sum += (double) value * value;
            return Math.sqrt(sum / frame.length);
        }
    }

    private static void ascii(ByteArrayOutputStream out, String text) { for (int i = 0; i < text.length(); i++) out.write(text.charAt(i)); }

    private static void le16(ByteArrayOutputStream out, int value) { out.write(value & 0xFF); out.write((value >> 8) & 0xFF); }

    private static void le32(ByteArrayOutputStream out, int value) { le16(out, value & 0xFFFF); le16(out, (value >>> 16) & 0xFFFF); }
}
