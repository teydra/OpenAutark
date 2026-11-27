// Owns: the app's interface file by file (owner 27.11.2026: an update of the interface fetches only the files that
// changed, the others stay) – the lists it has (the one the APK carries, assets/ui/ui.json, and the ready ones it fetched,
// files/ui/lists/<n>.json), which list a page gets, and the look for a newer one. A list is apps/desktop/scripts/ui-list.mjs's
// ui.json {n, shell, needs, files: {<path>: {sha256, bytes}}}; a fetched one counts only when ui.json.sig (raw 64 bytes)
// verifies under one of PUBLIC_KEYS (Ed25519, as Crypto; Konrad 27.11.2026: the active key and a reserve, so a lost
// active key is replaced without a new APK), its n is above the newest list here and its shell is not above SHELL.
// Where (Konrad 27.11.2026: ui.json belongs in the versioned GitHub release beside the APK): BASE is the repository's
// latest release, so every app reads the newest interface whose shell it has; one whose shell is too low keeps its own.
// Then only the files whose sha256 is in neither the APK nor files/ui/blobs are fetched, each to <sha256>.part, checked
// for size and sha256 and kept as blobs/<sha256>; with every file there the list is written and ready. A page gets the
// newest ready list when it starts (UiFiles calls pageStarts) and keeps its list while it runs; reloadDue says a newer
// one with other files is ready (MainActivity reloads at the next return, not while voice is live). A cut fetch, no
// network, a wrong signature or hash change nothing; lists other than the running and the newest one go, and so do the
// blobs neither names. At most one look a minute; with no key none at all (the APK's own interface runs). The
// same rules for the iPhone app: docs/ARCHITECTURE.md §8, "The interface updates file by file".
// Never: serves a file of a list it did not verify, writes outside its folder, or depends on Android.
package com.teydralab.autark.android.relay;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

public final class UiUpdate implements UiFiles.Source {
    /** This app's bridge number: a list whose shell is above it needs a newer app (the page's SHELL, native-port.ts). */
    public static final int SHELL = 1;
    /** The interface keys' public halves, base64url of their raw 32 bytes: the active one first, then the reserve (Konrad
     *  27.11.2026; private halves in the secrets catalog, sec_autark-ui-key-active / -reserve). A list counts when one fits. */
    public static final String[] PUBLIC_KEYS = { "LdtLJGLSC54dj8bVrHxKxe4KCkYKofJMu5FvHjPfbnw", "Haes-56_0BQE7NuBsZqlQVqkRObOjRWv34weAzbuGuc" };
    /** Where ui.json, ui.json.sig and the files by sha256 are published: assets of the latest versioned release, beside its
     *  APK (apps/desktop/scripts/ui-publish.mjs --tag vX.Y.Z). */
    public static final String BASE = "https://github.com/teydra/OpenAutark/releases/latest/download/";
    public static final String LIST = "ui.json", SIGNATURE = "ui.json.sig";
    static final long INTERVAL_MS = 60_000L;
    static final int MAX_LIST = 1 << 20;
    static final long MAX_FILE = 32L << 20, MAX_TOTAL = 128L << 20;
    private static final Pattern SHA = Pattern.compile("[0-9a-f]{64}");

    /** The published file `name` (ui.json, ui.json.sig or a sha256); an IOException when it cannot be read. */
    public interface Net { InputStream open(String name) throws IOException; }

    static final class Entry {
        final String sha; final long bytes;
        Entry(String sha, long bytes) { this.sha = sha; this.bytes = bytes; }
        @Override public boolean equals(Object other) { return other instanceof Entry && ((Entry) other).sha.equals(sha) && ((Entry) other).bytes == bytes; }
        @Override public int hashCode() { return Objects.hash(sha, bytes); }
    }

    static final class Listing {
        final long n; final int shell; final Map<String, Entry> files; final byte[] raw;
        Listing(long n, int shell, Map<String, Entry> files, byte[] raw) { this.n = n; this.shell = shell; this.files = files; this.raw = raw; }
    }

    private final File blobs, lists;
    private final UiFiles.Source shipped;
    private final List<byte[]> publicKeys;
    /** The APK's list (null in a build without ui.json: then its files answer by path and nothing is fetched). */
    private final Listing packaged;
    private final Map<String, String> packagedBySha = new HashMap<>();
    private final AtomicBoolean fetching = new AtomicBoolean();
    private Listing current, newest; // guarded by this
    private long checkedAt;
    private boolean checked;

    /** The store in `dir` (files/ui) over the APK's interface `shipped`; `publicKeys` are PUBLIC_KEYS' bytes (none: no look). */
    public UiUpdate(File dir, UiFiles.Source shipped, List<byte[]> publicKeys) {
        this.shipped = shipped;
        this.publicKeys = publicKeys == null ? new ArrayList<>() : new ArrayList<>(publicKeys); // no List.copyOf: API 26
        blobs = new File(dir, "blobs");
        lists = new File(dir, "lists");
        Listing own = null;
        try { byte[] raw = shipped.read(LIST); own = raw == null ? null : parse(raw); } catch (IOException ignored) { /* none */ }
        packaged = own;
        if (own != null) for (Map.Entry<String, Entry> file : own.files.entrySet()) packagedBySha.put(file.getValue().sha, file.getKey());
        newest = own;
        File[] saved = own == null ? null : lists.listFiles();
        if (saved != null) for (File file : saved) {
            if (!file.getName().endsWith(".json")) continue; // a <n>.json.part the app was killed on is not ready; it goes
            Listing list = null;
            try { list = parse(Files.readAllBytes(file.toPath())); } catch (IOException ignored) { /* unreadable: it goes */ }
            if (list != null && list.n > newest.n && list.shell <= SHELL && complete(list)) newest = list;
        }
        current = newest;
        synchronized (this) { prune(true); }
    }

    /** PUBLIC_KEYS' bytes in their order; an entry that is not 32 bytes of base64url is left out. */
    public static List<byte[]> publicKeys() { return keys(PUBLIC_KEYS); }

    static List<byte[]> keys(String... encoded) {
        List<byte[]> out = new ArrayList<>();
        for (String text : encoded) {
            try { byte[] key = Crypto.fromB64url(text); if (key.length == 32) out.add(key); }
            catch (IllegalArgumentException | NullPointerException error) { /* not a key */ }
        }
        return out;
    }

    /** A file of the running page's list (UiFiles.Source); null when the list has no such path. */
    @Override public byte[] read(String path) throws IOException {
        Listing page;
        synchronized (this) { page = current; }
        if (page == null) return shipped.read(path);
        Entry entry = page.files.get(path);
        return entry == null ? null : bytes(entry);
    }

    /** A page starts: from now on it gets the newest ready list (UiFiles, on a document request). */
    @Override public synchronized void pageStarts() {
        if (current == newest) return;
        current = newest;
        prune(!fetching.get());
    }

    /** True when a newer list with other files is ready than the one the running page started with. */
    public synchronized boolean reloadDue() {
        return newest != null && current != null && newest != current && !newest.files.equals(current.files);
    }

    /** True when a look is due: a key, a list in the APK, and a minute since the last look (or the clock went back). */
    public synchronized boolean due(long now) {
        return !publicKeys.isEmpty() && packaged != null && (!checked || now < checkedAt || now - checkedAt >= INTERVAL_MS);
    }

    /** Looks for a newer list and fetches what it lacks (call it off the main thread); true when a new list is ready. */
    public boolean check(Net net, long now) {
        synchronized (this) { if (!due(now)) return false; checked = true; checkedAt = now; }
        if (!fetching.compareAndSet(false, true)) return false;
        try {
            byte[] raw = get(net, LIST, MAX_LIST), signature = get(net, SIGNATURE, 64);
            long above;
            synchronized (this) { above = newest.n; }
            Listing list = accept(raw, signature, publicKeys, above, SHELL);
            if (list == null) return false;
            Set<String> wanted = new HashSet<>();
            for (Entry entry : list.files.values()) if (!has(entry.sha) && wanted.add(entry.sha)) fetch(net, entry);
            synchronized (this) {
                if (!complete(list) || list.n <= newest.n) return false; // a file went meanwhile, or another look won
                if (!lists.isDirectory() && !lists.mkdirs()) return false;
                File part = new File(lists, list.n + ".json.part"), ready = new File(lists, list.n + ".json");
                try (FileOutputStream out = new FileOutputStream(part)) { out.write(list.raw); out.getFD().sync(); }
                if (!part.renameTo(ready)) { part.delete(); return false; }
                newest = list;
                prune(true);
                return true;
            }
        } catch (IOException | RuntimeException error) {
            return false; // the app keeps what it has; the next look tries again
        } finally {
            fetching.set(false);
        }
    }

    /** The list `raw` when `signature` verifies under one of `keys`, its n is above `above` and its shell at most `shell`; else null. */
    static Listing accept(byte[] raw, byte[] signature, List<byte[]> keys, long above, int shell) {
        if (raw == null || keys == null) return null;
        boolean signed = false;
        for (byte[] key : keys) if (key != null && Crypto.verify(key, raw, signature)) { signed = true; break; }
        if (!signed) return null;
        Listing list = parse(raw);
        return list == null || list.n <= above || list.shell > shell ? null : list;
    }

    /** A well-formed list (index.html among safe paths, lower-case sha256, sizes in bounds), else null. */
    @SuppressWarnings("unchecked")
    static Listing parse(byte[] raw) {
        try {
            Map<String, Object> list = Json.object(new String(raw, StandardCharsets.UTF_8));
            long n = Json.num(list, "n", -1), shell = Json.num(list, "shell", -1), total = 0;
            if (n <= 0 || shell < 1 || shell > Integer.MAX_VALUE || !(list.get("files") instanceof Map)) return null;
            Map<String, Entry> files = new HashMap<>();
            for (Map.Entry<String, Object> file : ((Map<String, Object>) list.get("files")).entrySet()) {
                if (!UiFiles.safe(file.getKey()) || !(file.getValue() instanceof Map)) return null;
                Map<String, Object> about = (Map<String, Object>) file.getValue();
                String sha = Json.str(about, "sha256");
                long bytes = Json.num(about, "bytes", -1);
                if (sha == null || !SHA.matcher(sha).matches() || bytes < 0 || bytes > MAX_FILE || (total += bytes) > MAX_TOTAL) return null;
                files.put(file.getKey(), new Entry(sha, bytes));
            }
            return files.containsKey("index.html") ? new Listing(n, (int) shell, files, raw) : null;
        } catch (IllegalArgumentException | ClassCastException error) {
            return null;
        }
    }

    private boolean has(String sha) { return packagedBySha.containsKey(sha) || new File(blobs, sha).isFile(); }

    private boolean complete(Listing list) {
        for (Entry entry : list.files.values()) if (!has(entry.sha)) return false;
        return true;
    }

    private byte[] bytes(Entry entry) throws IOException {
        File blob = new File(blobs, entry.sha);
        if (blob.isFile()) return Files.readAllBytes(blob.toPath());
        String path = packagedBySha.get(entry.sha);
        return path == null ? null : shipped.read(path);
    }

    /** One file to blobs/<sha256>.part, then – exactly its size and sha256 – blobs/<sha256>; otherwise an IOException. */
    private void fetch(Net net, Entry entry) throws IOException {
        if (!blobs.isDirectory() && !blobs.mkdirs()) throw new IOException("no folder");
        File part = new File(blobs, entry.sha + ".part");
        MessageDigest digest = sha256();
        long read = 0;
        try (InputStream in = net.open(entry.sha); FileOutputStream out = new FileOutputStream(part)) {
            byte[] buffer = new byte[64 * 1024];
            for (int got; (got = in.read(buffer)) > 0; ) {
                read += got;
                if (read > entry.bytes) break;
                digest.update(buffer, 0, got);
                out.write(buffer, 0, got);
            }
            out.getFD().sync(); // on the disk before the rename: a power cut never leaves a checked name over unwritten bytes
        } catch (IOException | RuntimeException error) {
            part.delete();
            throw error instanceof IOException ? (IOException) error : new IOException(error);
        }
        if (read != entry.bytes || !Crypto.hex(digest.digest()).equals(entry.sha) || !part.renameTo(new File(blobs, entry.sha))) {
            part.delete();
            throw new IOException("file " + entry.sha + " is not what the list names");
        }
    }

    /** A small published file, at most `max` bytes. */
    private static byte[] get(Net net, String name, int max) throws IOException {
        try (InputStream in = net.open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[16 * 1024];
            for (int got; (got = in.read(buffer)) > 0; ) {
                out.write(buffer, 0, got);
                if (out.size() > max) throw new IOException(name + " is too large");
            }
            return out.toByteArray();
        }
    }

    /** Lists other than the running and the newest go; with `files`, every blob (and .part) neither of them names. */
    private void prune(boolean files) {
        Set<String> keepLists = new HashSet<>(), keepFiles = new HashSet<>();
        for (Listing list : new Listing[] { current, newest }) {
            if (list == null || list == packaged) continue;
            keepLists.add(list.n + ".json");
            for (Entry entry : list.files.values()) keepFiles.add(entry.sha);
        }
        File[] saved = lists.listFiles();
        if (saved != null) for (File file : saved) if (!keepLists.contains(file.getName())) file.delete();
        File[] kept = files ? blobs.listFiles() : null;
        if (kept != null) for (File file : kept) if (!keepFiles.contains(file.getName())) file.delete();
    }

    private static MessageDigest sha256() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }

    /** For a test: the n of the running page's list and of the newest ready one (0: none). */
    synchronized long[] ns() { return new long[] { current == null ? 0 : current.n, newest == null ? 0 : newest.n }; }
}
