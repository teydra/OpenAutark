// Owns: the interface file by file on a host JVM (owner 27.11.2026) – relay/UiUpdate over a temporary folder, a map for
// the APK's assets/ui with its ui.json and a published place in memory: a list is taken only under the key's signature,
// with n above the newest list and shell not above the app's; only files the app lacks are fetched; a cut fetch and a
// wrong hash leave everything as it was (and the next look fetches only the rest); a running page keeps its list while a
// new page gets the newest ready one (through UiFiles' document request); files and lists no longer named go, and a list
// left as .part is not ready; no key,
// no look; at most one look a minute.
// Never: the network or a phone.
package com.teydralab.autark.android.relay;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;

public final class UiUpdateTest {
    private static int assertions;
    private static final byte[] SEED = new byte[32];
    private static final byte[] KEY;
    static { for (int i = 0; i < 32; i++) SEED[i] = (byte) (i * 7 + 1); KEY = Crypto.ed25519Public(SEED); }

    /** The published place: name → bytes; `cutAfter` ends a file's stream early, `asked` counts what was fetched. */
    private static final class Place implements UiUpdate.Net {
        final Map<String, byte[]> files = new HashMap<>();
        final List<String> asked = new ArrayList<>(), all = new ArrayList<>();
        String cut;
        @Override public InputStream open(String name) throws IOException {
            asked.add(name);
            all.add(name);
            byte[] bytes = files.get(name);
            if (bytes == null) throw new IOException("404 " + name);
            if (name.equals(cut)) return new InputStream() { // half the file, then the link dies
                int at;
                @Override public int read() throws IOException { if (at >= bytes.length / 2) throw new IOException("cut"); return bytes[at++] & 0xff; }
            };
            return new ByteArrayInputStream(bytes);
        }
        void publish(long n, int shell, Map<String, String> content, byte[] seed) {
            byte[] list = list(n, shell, content);
            files.put(UiUpdate.LIST, list);
            files.put(UiUpdate.SIGNATURE, Crypto.sign(seed, list));
            for (String text : content.values()) files.put(sha(text), utf8(text));
        }
    }

    public static void main(String[] args) throws Exception {
        rules();
        File dir = Files.createTempDirectory("ui-update").toFile();
        try { flow(dir); } finally { delete(dir); }
        File none = Files.createTempDirectory("ui-nokey").toFile();
        try { noKey(none); } finally { delete(none); }
        System.out.println(assertions + " interface update assertions passed.");
    }

    /** Taking and refusing a list: signature, n, shell, and a malformed one. */
    private static void rules() {
        Map<String, String> content = Map.of("index.html", "<html>2", "main.js", "two");
        byte[] list = list(20, 1, content);
        check(UiUpdate.accept(list, Crypto.sign(SEED, list), KEY, 10, UiUpdate.SHELL) != null, "a signed list above n with a shell the app has is taken");
        byte[] other = SEED.clone();
        other[0] ^= 1;
        check(UiUpdate.accept(list, Crypto.sign(other, list), KEY, 10, 1) == null, "another key's signature is refused");
        byte[] changed = list.clone();
        changed[changed.length - 3] ^= 1;
        check(UiUpdate.accept(changed, Crypto.sign(SEED, list), KEY, 10, 1) == null, "one changed byte is refused");
        check(UiUpdate.accept(list, new byte[63], KEY, 10, 1) == null && UiUpdate.accept(list, Crypto.sign(SEED, list), null, 10, 1) == null, "no signature or no key: refused");
        check(UiUpdate.accept(list, Crypto.sign(SEED, list), KEY, 20, 1) == null, "n not above the newest list: refused");
        byte[] needs2 = list(30, 2, content);
        check(UiUpdate.accept(needs2, Crypto.sign(SEED, needs2), KEY, 10, 1) == null, "a list that needs a newer app (shell 2) is refused");
        for (String bad : new String[] { "{\"n\":5,\"shell\":1,\"files\":{\"../x\":{\"sha256\":\"" + "a".repeat(64) + "\",\"bytes\":1},\"index.html\":{\"sha256\":\"" + "a".repeat(64) + "\",\"bytes\":1}}}",
                "{\"n\":5,\"shell\":1,\"files\":{\"main.js\":{\"sha256\":\"" + "a".repeat(64) + "\",\"bytes\":1}}}",
                "{\"n\":5,\"shell\":1,\"files\":{\"index.html\":{\"sha256\":\"" + "A".repeat(64) + "\",\"bytes\":1}}}", "[1]", "not json" }) {
            byte[] raw = utf8(bad);
            check(UiUpdate.accept(raw, Crypto.sign(SEED, raw), KEY, 0, 1) == null, "a malformed list is refused: " + bad.substring(0, Math.min(bad.length(), 40)));
        }
    }

    private static void flow(File dir) throws Exception {
        Map<String, byte[]> assets = new HashMap<>();
        Map<String, String> shipped = new TreeMap<>(Map.of("index.html", "<html>1", "main.js", "one", "chunks/a-AAAAAAAA.js", "a", "icon.png", "png"));
        for (Map.Entry<String, String> file : shipped.entrySet()) assets.put(file.getKey(), utf8(file.getValue()));
        assets.put(UiUpdate.LIST, list(10, 1, shipped));
        Place place = new Place();
        UiUpdate store = new UiUpdate(dir, assets::get, KEY);
        UiFiles ui = new UiFiles(store);
        check(text(get(ui, "/", true)).endsWith("<html>1") && store.ns()[0] == 10, "the APK's list runs first");
        long now = 1_000_000;

        // The published list changes main.js and index.html and adds a chunk; chunks/a and icon.png stay.
        Map<String, String> second = new TreeMap<>(Map.of("index.html", "<html>2", "main.js", "two", "chunks/a-AAAAAAAA.js", "a", "chunks/b-BBBBBBBB.js", "b", "icon.png", "png"));
        place.publish(20, 1, second, SEED);
        place.files.put(sha("two"), utf8("tw0")); // a wrong file under main.js's sha256
        check(!store.check(place, now), "a wrong hash: no list");
        check(store.ns()[1] == 10 && !new File(dir, "blobs/" + sha("two")).exists() && !new File(dir, "blobs/" + sha("two") + ".part").exists() && !store.reloadDue(), "a wrong hash changes nothing and leaves no file");
        check(!store.check(place, now + 30_000), "no second look within a minute");
        place.files.put(sha("two"), utf8("two"));
        place.cut = sha("two");
        place.asked.clear();
        check(!store.check(place, now + 60_000), "a cut fetch: no list");
        check(store.ns()[1] == 10 && !store.reloadDue() && text(get(ui, "/main.js", false)).equals("one"), "a cut fetch changes nothing; the page still gets its files");
        place.cut = null;
        place.asked.clear();
        check(store.check(place, now + 120_000), "the next look makes the list ready");
        List<String> fetched = new ArrayList<>(place.asked);
        fetched.removeAll(List.of(UiUpdate.LIST, UiUpdate.SIGNATURE));
        check(!place.all.contains(sha("a")) && !place.all.contains(sha("png")) && fetched.contains(sha("two")), "only the files the app lacks are fetched: " + fetched);
        check(count(place.all, sha("<html>2")) == 1 && count(place.all, sha("b")) == 1 && count(place.all, sha("two")) == 3, "a file checked once is kept across failed looks; only the rest is fetched again: " + place.all);
        check(store.ns()[0] == 10 && store.ns()[1] == 20 && store.reloadDue(), "the running page keeps the APK's list; a newer one is ready");
        check(text(get(ui, "/main.js", false)).equals("one") && get(ui, "/chunks/b-BBBBBBBB.js", false).startsWith("HTTP/1.1 404"), "a running page keeps getting its own list's files");

        // A new page (its document request) gets the newest list; the old blobs of a list no longer named go.
        check(text(get(ui, "/chats/c1", true)).equals("<html>2") && store.ns()[0] == 20 && !store.reloadDue(), "a new page gets the newest ready list");
        check(text(get(ui, "/main.js", false)).equals("two") && text(get(ui, "/chunks/a-AAAAAAAA.js", false)).equals("a") && text(get(ui, "/chunks/b-BBBBBBBB.js", false)).equals("b"), "its files: fetched ones and the APK's unchanged ones");
        check(get(ui, "/main.js", false).contains("Cache-Control: no-cache") && get(ui, "/chunks/b-BBBBBBBB.js", false).contains("immutable"), "the same cache rules for fetched files");

        // A third list; the page on the second keeps it until it starts anew, then the second's own files go.
        Map<String, String> third = new TreeMap<>(second);
        third.put("main.js", "three");
        third.remove("chunks/b-BBBBBBBB.js");
        place.publish(30, 1, third, SEED);
        check(store.check(place, now + 180_000) && store.reloadDue(), "a third list is ready");
        check(new File(dir, "blobs/" + sha("two")).exists() && new File(dir, "lists/20.json").exists(), "the running page's files stay");
        place.publish(25, 1, second, SEED);
        check(!store.check(place, now + 240_000) && store.ns()[1] == 30, "a list not above the newest is refused");
        get(ui, "/", true);
        check(store.ns()[0] == 30 && !new File(dir, "blobs/" + sha("two")).exists() && !new File(dir, "blobs/" + sha("b")).exists() && !new File(dir, "lists/20.json").exists()
                && new File(dir, "blobs/" + sha("three")).exists() && new File(dir, "blobs/" + sha("<html>2")).exists(), "files no ready list names go: " + names(new File(dir, "blobs")));

        // A new process: the ready list is the newest, a page starts on it; a list whose shell is above the app's waits.
        File killed = new File(dir, "lists/35.json.part"); // the app was killed between writing a list and its rename
        Files.write(killed.toPath(), list(35, 1, third));
        UiUpdate again = new UiUpdate(dir, assets::get, KEY);
        check(again.ns()[0] == 30 && text(get(new UiFiles(again), "/main.js", false)).equals("three"), "after a restart the newest ready list runs");
        check(!killed.exists() && new File(dir, "lists/30.json").exists(), "a list left as .part is not ready and goes: " + names(new File(dir, "lists")));
        Map<String, String> fourth = new TreeMap<>(third);
        fourth.put("main.js", "four");
        place.publish(40, UiUpdate.SHELL + 1, fourth, SEED);
        place.asked.clear();
        check(!again.check(place, now + 300_000) && !place.asked.contains(sha("four")), "a list for a newer app fetches nothing");
        // A newer APK whose own list is above the fetched ones: they go.
        assets.put(UiUpdate.LIST, list(50, 1, shipped));
        UiUpdate newer = new UiUpdate(dir, assets::get, KEY);
        check(newer.ns()[0] == 50 && names(new File(dir, "lists")).isEmpty() && names(new File(dir, "blobs")).isEmpty(), "a newer APK's own list wins and the fetched files go");
    }

    private static void noKey(File dir) throws Exception {
        Map<String, byte[]> assets = new HashMap<>(Map.of("index.html", utf8("<html>1")));
        assets.put(UiUpdate.LIST, list(10, 1, Map.of("index.html", "<html>1")));
        Place place = new Place();
        place.publish(20, 1, Map.of("index.html", "<html>2"), SEED);
        UiUpdate store = new UiUpdate(dir, assets::get, null);
        check(!store.due(0) && !store.check(place, 0) && place.asked.isEmpty(), "no public key: no look at all");
        check(UiUpdate.publicKey() == null || UiUpdate.publicKey().length == 32, "PUBLIC_KEY is empty or 32 bytes");
        Map<String, byte[]> bare = new HashMap<>(Map.of("index.html", utf8("<html>0"), "x.js", utf8("x")));
        UiUpdate plain = new UiUpdate(dir, bare::get, KEY);
        check(!plain.due(0) && text(get(new UiFiles(plain), "/x.js", false)).equals("x"), "a build without ui.json answers by path and never looks");
    }

    private static byte[] list(long n, int shell, Map<String, String> content) {
        StringBuilder files = new StringBuilder();
        for (Map.Entry<String, String> file : new TreeMap<>(content).entrySet())
            files.append(files.length() == 0 ? "" : ",").append(Json.write(file.getKey())).append(":{\"sha256\":\"").append(sha(file.getValue())).append("\",\"bytes\":").append(utf8(file.getValue()).length).append('}');
        return utf8("{\"n\":" + n + ",\"shell\":" + shell + ",\"needs\":\"0.3.21\",\"files\":{" + files + "}}");
    }

    /** One request through UiFiles (a document request when `page`). */
    private static String get(UiFiles ui, String target, boolean page) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ui.answer("GET " + target + " HTTP/1.1\r\nHost: 127.0.0.1\r\nSec-Fetch-Dest: " + (page ? "document" : "script") + "\r\n\r\n", out);
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static long count(List<String> names, String name) { return names.stream().filter(name::equals).count(); }
    private static String text(String reply) { return reply.substring(reply.indexOf("\r\n\r\n") + 4); }
    private static String sha(String text) { return Crypto.hex(Crypto.sha256(utf8(text))); }
    private static byte[] utf8(String text) { return text.getBytes(StandardCharsets.UTF_8); }

    private static List<String> names(File folder) {
        String[] names = folder.list();
        return names == null ? List.of() : List.of(names);
    }

    private static void delete(File dir) throws IOException {
        try (Stream<java.nio.file.Path> walk = Files.walk(dir.toPath())) { walk.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete()); }
    }

    private static void check(boolean condition, String what) {
        assertions++;
        if (!condition) throw new AssertionError(what);
    }
}
