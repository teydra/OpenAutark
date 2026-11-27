// Owns: executable checks of the bubble call's reading rules (SpokenPieces), the same cases as the page's
// (desktop test/unit/voice/first-clause.test.ts): call speed 27.11.2026, the first piece from the first comma while no
// sentence is finished, a short clause or a decimal comma waits, later pieces at sentence ends, and the part only grows.
// Never: speaks or claims what a phone hears.
package com.teydralab.autark.android.phoneuse;

public final class SpokenPiecesTest {
    private static int assertions;

    public static void main(String[] args) {
        equal(SpokenPieces.sentencesDone("Gute Frage, die Fahrt"), "Gute Frage,");
        equal(SpokenPieces.sentencesDone("Gute Frage,"), "Gute Frage,");
        equal(SpokenPieces.sentencesDone("Mit dem Zug, je nach Verbindung, etwa"), "Mit dem Zug,");
        equal(SpokenPieces.sentencesDone("Ja, das"), "");
        equal(SpokenPieces.sentencesDone("Ja, klar, die Fahrt"), "Ja, klar,");
        equal(SpokenPieces.sentencesDone("Das kostet 3,"), "");
        equal(SpokenPieces.sentencesDone("Das kostet 3,5 Euro"), "");
        equal(SpokenPieces.sentencesDone("Das kostet 3,5 Euro, also"), "Das kostet 3,5 Euro,");
        equal(SpokenPieces.sentencesDone("Der Build läuft noch durch. Danach, wenn"), "Der Build läuft noch durch.");
        equal(SpokenPieces.sentencesDone("Gute Frage, die Fahrt dauert drei Stunden. Und dann, wenn"), "Gute Frage, die Fahrt dauert drei Stunden.");
        equal(SpokenPieces.sentencesDone("Das dauert noch ca. zehn Minuten. Und"), "Das dauert noch ca. zehn Minuten.");
        equal(SpokenPieces.sentencesDone("Der Build läuft"), "");
        String answer = "Gute Frage, mit dem Zug dauert es ungefähr zwei Stunden und zwanzig Minuten. Der Railjet fährt, soweit ich weiß, jede Stunde.";
        String before = "";
        StringBuilder pieces = new StringBuilder();
        for (int at = 1; at <= answer.length(); at++) {
            String done = SpokenPieces.sentencesDone(SpokenPieces.speakable(answer.substring(0, at)));
            check(done.startsWith(before));
            if (done.length() > before.length()) pieces.append('|').append(done.substring(before.length()).trim());
            before = done;
        }
        equal(pieces.toString(), "|Gute Frage,|mit dem Zug dauert es ungefähr zwei Stunden und zwanzig Minuten.|Der Railjet fährt, soweit ich weiß, jede Stunde.");
        System.out.println(assertions + " spoken piece assertions passed.");
    }

    private static void equal(String actual, String expected) {
        assertions++;
        if (!expected.equals(actual)) throw new AssertionError("Assertion " + assertions + ": expected \"" + expected + "\", got \"" + actual + "\"");
    }

    private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("Unexpected result " + assertions); }
}
