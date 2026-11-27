// Owns: the reading rules of the call voice's row on this phone, the same as the page's (desktop
// shared/voice/conversation-parts.ts speakable and sentencesDone): a Markdown answer as speakable text, and the part of a
// row still being written that can be read already – its finished sentences, and (call speed 27.11.2026, Konrad: the first
// piece from the first comma) while no sentence is finished yet the part up to the first comma. Pure Java, so the host
// tests run it (test/phoneuse/SpokenPiecesTest). Never: reads, speaks or sends anything (BubbleCall does).
package com.teydralab.autark.android.phoneuse;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class SpokenPieces {
    private SpokenPieces() {}

    private static final Pattern SENTENCE_END = Pattern.compile("[.!?…][\"'”’)\\]]*(?=\\s|$)|\\n");
    private static final Pattern ABBREVIATION = Pattern.compile("(?:^|\\s)(?:[\\p{L}\\d]|[\\p{L}\\d]+\\.[\\p{L}\\d.]*|ca|bzw|usw|etc|vgl|ggf|evtl|inkl|zzgl|bspw|Nr|Dr|Prof|Hr|Fr|St|Str|Tel|Mio|Mrd|Mr|Mrs|Ms|Jr|vs|approx)\\.$",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    private static final Pattern GOES_ON = Pattern.compile("^[\"'”’)\\]]*\\s+\\p{Ll}");
    private static final Pattern CLAUSE_END = Pattern.compile(",(?=\\s|$)");
    private static final int PIECE_MIN = 15;
    /** The first piece cut at a comma is at least this long, so "Ja," alone waits (conversation-parts.ts FIRST_CLAUSE_MIN). */
    static final int FIRST_CLAUSE_MIN = 8;

    /** A Markdown answer as speakable text: no fences, markup or bullets, a link as its words, a line without a stop ends as a sentence. */
    static String speakable(String markdown) {
        if (markdown == null) return "";
        String text = markdown
                .replaceAll("```[\\s\\S]*?(```|$)", " ")
                .replaceAll("!\\[[^\\]]*\\]\\([^)]*\\)", " ")
                .replaceAll("\\[([^\\]]+)\\]\\([^)]*\\)", "$1")
                .replaceAll("(?m)^[ \\t]*[-+•][ \\t]+", "")
                .replaceAll("[`*_#>|~]+", " ")
                .replaceAll("([^\\s.!?:;,])[ \\t]*\\n\\s*(?=\\S)", "$1. ")
                .replaceAll("\\s+", " ")
                .trim();
        return text.length() > 4000 ? text.substring(0, 4000) : text;
    }

    /** The finished sentences at the start of a text still being written (a piece at least PIECE_MIN long), before the first one the part up to the first comma, or "". */
    static String sentencesDone(String text) {
        int at = 0;
        Matcher match = SENTENCE_END.matcher(text);
        while (match.find()) {
            int end = match.end();
            if (".".equals(match.group()) && (ABBREVIATION.matcher(text.substring(Math.max(0, match.start() - 40), end)).find() || GOES_ON.matcher(text.substring(end)).find())) continue;
            if (end - at >= PIECE_MIN) at = end;
        }
        if (at == 0) at = firstClause(text);
        return at > 0 ? text.substring(0, at).trim() : "";
    }

    /** Where the first comma ends the first piece (at least FIRST_CLAUSE_MIN long), else 0; "3," at the very end may still become "3,5". */
    private static int firstClause(String text) {
        Matcher match = CLAUSE_END.matcher(text);
        while (match.find()) {
            int end = match.start() + 1;
            if (end == text.length() && match.start() > 0 && Character.isDigit(text.charAt(match.start() - 1))) return 0;
            if (end >= FIRST_CLAUSE_MIN) return end;
        }
        return 0;
    }
}
