// Owns: host checks of the bubble's speech on its way to the PC (SpokenAudio, owner 20.11.2026): the WAV a piece becomes
// (16 kHz mono 16 bit, header and length), where a long take is cut (the quietest moment of its last seconds), the
// files.upload and voice.transcribe frames (language only as a tag, the text before as context, at most 2000 chars),
// the text read from the answer, and the call's level turns (a click starts nothing, speech starts a line, 1.1 s of
// quiet ends it, a hum does not hold it open forever). Never: a device test (the microphone and the PC are real ones there).
package com.teydralab.autark.android.phoneuse;

import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

public final class SpokenAudioTest {
    private static int assertions;

    private static void check(boolean ok, String what) {
        assertions++;
        if (!ok) throw new AssertionError(what);
    }

    public static void main(String[] args) {
        wav();
        cut();
        frames();
        turns();
        voiced();
        System.out.println("SpokenAudioTest: " + assertions + " assertions passed");
    }

    private static void wav() {
        short[] pcm = { 1, -1, 300, 0 };
        byte[] wav = SpokenAudio.wav(pcm, 1, 3);
        check(wav.length == 44 + 4, "header plus two samples");
        check(new String(Arrays.copyOfRange(wav, 0, 4)).equals("RIFF") && new String(Arrays.copyOfRange(wav, 8, 12)).equals("WAVE"), "a RIFF WAVE file");
        check(le32(wav, 24) == 16_000 && le16(wav, 22) == 1 && le16(wav, 34) == 16, "16 kHz, mono, 16 bit");
        check(le32(wav, 40) == 4 && le32(wav, 4) == 36 + 4, "data and file lengths");
        check((short) le16(wav, 44) == -1 && (short) le16(wav, 46) == 300, "the samples, little-endian");
    }

    private static void cut() {
        int length = SpokenAudio.samples(SpokenAudio.PIECE_MS);
        short[] pcm = new short[length];
        for (int i = 0; i < length; i++) pcm[i] = (short) (i % 2 == 0 ? 8_000 : -8_000);
        int quietFrom = length - SpokenAudio.samples(3_000), quietTo = quietFrom + SpokenAudio.samples(200);
        for (int i = quietFrom; i < quietTo; i++) pcm[i] = 0;
        int at = SpokenAudio.quietCut(pcm, length);
        check(at >= quietFrom && at <= quietTo, "the cut lies in the pause: " + at);
        short[] early = new short[length];
        Arrays.fill(early, (short) 5_000);
        for (int i = 1_000; i < 5_000; i++) early[i] = 0; // a pause long before the last seconds is not looked at
        int late = SpokenAudio.quietCut(early, length);
        check(late >= length - SpokenAudio.samples(SpokenAudio.QUIET_SEARCH_MS) && late <= length, "the cut stays in the last seconds");
        check(SpokenAudio.quietCut(new short[10], 10) == 10, "a piece shorter than the window ends where it ends");
    }

    private static void frames() {
        Map<String, Object> upload = SpokenAudio.upload(new byte[] { 1, 2, 3 }, 2);
        check(upload.keySet().equals(new java.util.LinkedHashSet<>(Arrays.asList("name", "mime", "dataBase64"))), "files.upload's fields");
        check("dictation-2.wav".equals(upload.get("name")) && "audio/wav".equals(upload.get("mime")), "a WAV piece");
        check(Arrays.equals(Base64.getDecoder().decode((String) upload.get("dataBase64")), new byte[] { 1, 2, 3 }), "the bytes");
        Map<String, Object> first = SpokenAudio.transcribe("f1", "de-DE", "", null);
        check(first.equals(map("fileId", "f1", "language", "de-DE")), "the file and the language: " + first);
        check(!SpokenAudio.transcribe("f1", "Deutsch bitte", null, null).containsKey("language"), "a free text is never the language");
        String long_ = "x".repeat(2_500) + " end";
        Map<String, Object> next = SpokenAudio.transcribe("f2", "de", long_, "ch_1");
        check(((String) next.get("before")).length() == SpokenAudio.BEFORE_MAX && ((String) next.get("before")).endsWith(" end"), "the text before, its last 2000 chars");
        check("ch_1".equals(next.get("chatId")), "the call's chat as context");
        check("Wie geht es dir?".equals(SpokenAudio.text(map("text", " Wie geht es dir? ", "by", "plan"))), "the text of the answer");
        check("".equals(SpokenAudio.text(null)) && "".equals(SpokenAudio.text(map("text", 3))), "no text, nothing");
        check("wir testen das".equals(SpokenAudio.join("wir testen", "das")) && "das".equals(SpokenAudio.join("", "das")) && "wir".equals(SpokenAudio.join("wir", " ")), "pieces join");
    }

    private static void turns() {
        SpokenAudio.Turns turns = new SpokenAudio.Turns();
        check(feed(turns, quiet(1_000)) == null && !turns.speaking(), "silence starts nothing");
        short[] click = quiet(500);
        for (int i = 0; i < SpokenAudio.FRAME; i++) click[i] = (short) (i % 2 == 0 ? 20_000 : -20_000);
        check(feed(turns, click) == null && !turns.speaking(), "one loud frame (a click) starts nothing");
        check(feed(turns, voice(400)) == SpokenAudio.Turns.Edge.START && turns.speaking(), "speech starts a line");
        check(feed(turns, quiet(600)) == null && turns.speaking(), "a short pause keeps the line");
        check(feed(turns, voice(300)) == null, "speech again: the same line");
        check(feed(turns, quiet(1_300)) == SpokenAudio.Turns.Edge.END && !turns.speaking(), "1.1 s of quiet ends it");
        SpokenAudio.Turns hum = new SpokenAudio.Turns();
        SpokenAudio.Turns.Edge last = null;
        for (int second = 0; second < 130 && last != SpokenAudio.Turns.Edge.END; second++) {
            SpokenAudio.Turns.Edge edge = feed(hum, voice(1_000));
            if (edge != null) last = edge;
        }
        check(last == SpokenAudio.Turns.Edge.END, "a steady sound does not hold a line open forever");
        hum.reset();
        check(!hum.speaking(), "reset forgets the line");
    }

    /** 24.11.2026 ("Colearning Salzburg" at the end of a dictation): a piece without voice goes to no recognizer, one with
     *  voice is heard from just before its first to just after its last voiced moment – not through its pause before Stop. */
    private static void voiced() {
        short[] silence = new short[SpokenAudio.samples(8_000)];
        check(SpokenAudio.voicedSpan(silence, 0, silence.length) == null, "digital silence holds no voice");
        short[] room = quiet(8_000);
        check(SpokenAudio.voicedSpan(room, 0, room.length) == null, "room noise holds no voice");
        short[] tap = quiet(3_000);
        for (int i = 0; i < SpokenAudio.FRAME; i++) tap[SpokenAudio.samples(1_000) + i] = (short) (i % 2 == 0 ? 20_000 : -20_000);
        check(SpokenAudio.voicedSpan(tap, 0, tap.length) == null, "one tap is no voice");
        check(SpokenAudio.voicedSpan(new short[10], 0, 10) == null, "a piece shorter than a frame holds none");

        // 2 s of speech, then the 3 s pause before Stop: the piece ends half a second after the speech
        short[] spoken = concat(voice(2_000), quiet(3_000));
        int[] span = SpokenAudio.voicedSpan(spoken, 0, spoken.length);
        check(span != null && span[0] == 0, "speech at the start keeps the start");
        check(span != null && span[1] >= SpokenAudio.samples(2_000) && span[1] <= SpokenAudio.samples(2_000 + SpokenAudio.VOICE_KEEP_MS + 40),
            "the pause is cut off: ends at " + (span == null ? -1 : span[1] * 1000 / SpokenAudio.RATE) + " ms");

        // 2 s of room noise, 1.5 s of speech, 2 s of room noise: both ends are trimmed, the speech is whole inside
        short[] middle = concat(quiet(2_000), voice(1_500), quiet(2_000));
        int[] inner = SpokenAudio.voicedSpan(middle, 0, middle.length);
        check(inner != null && inner[0] >= SpokenAudio.samples(2_000 - SpokenAudio.VOICE_KEEP_MS - 40) && inner[0] <= SpokenAudio.samples(2_000)
            && inner[1] >= SpokenAudio.samples(3_500) && inner[1] <= SpokenAudio.samples(3_500 + SpokenAudio.VOICE_KEEP_MS + 40), "the speech with half a second around it");

        // a range inside a longer buffer is read as a piece of its own
        int[] ranged = SpokenAudio.voicedSpan(concat(voice(500), spoken), SpokenAudio.samples(500), SpokenAudio.samples(500) + spoken.length);
        check(ranged != null && ranged[0] == SpokenAudio.samples(500), "from/to are respected");
        byte[] wav = SpokenAudio.wav(spoken, span[0], span[1]);
        check(wav.length == 44 + 2 * (span[1] - span[0]) && wav.length < 44 + 2 * spoken.length, "the WAV holds the voiced part only");
    }

    private static short[] concat(short[]... parts) {
        int total = 0;
        for (short[] part : parts) total += part.length;
        short[] all = new short[total];
        int at = 0;
        for (short[] part : parts) { System.arraycopy(part, 0, all, at, part.length); at += part.length; }
        return all;
    }

    private static SpokenAudio.Turns.Edge feed(SpokenAudio.Turns turns, short[] pcm) {
        SpokenAudio.Turns.Edge seen = null;
        for (int at = 0; at < pcm.length; at += 1_024) {
            short[] block = Arrays.copyOfRange(pcm, at, Math.min(pcm.length, at + 1_024));
            SpokenAudio.Turns.Edge edge = turns.feed(block, block.length);
            if (edge != null) seen = edge;
        }
        return seen;
    }

    private static short[] quiet(int ms) {
        short[] pcm = new short[SpokenAudio.samples(ms)];
        for (int i = 0; i < pcm.length; i++) pcm[i] = (short) ((i * 7919) % 41 - 20); // a little room noise
        return pcm;
    }

    private static short[] voice(int ms) {
        short[] pcm = new short[SpokenAudio.samples(ms)];
        for (int i = 0; i < pcm.length; i++) pcm[i] = (short) (6_000 * Math.sin(i * 2 * Math.PI * 180 / SpokenAudio.RATE));
        return pcm;
    }

    private static int le16(byte[] b, int at) { return (b[at] & 0xFF) | ((b[at + 1] & 0xFF) << 8); }

    private static int le32(byte[] b, int at) { return le16(b, at) | (le16(b, at + 2) << 16); }

    private static Map<String, Object> map(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) map.put((String) pairs[i], pairs[i + 1]);
        return map;
    }
}
