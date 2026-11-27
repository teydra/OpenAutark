// Owns: one line the person is putting together in the bubble (TodoButton) – its screenshots (JPEG bytes, at most MAX,
// each with the file id once files.upload took it, so a second Send uploads nothing twice), the client id of this post
// (made once, the same on every retry until it went through: messages.send then answers the first line in that chat,
// never a second one – BubbleChat) and the upload frame. Since the plus menu (owner 24.11.2026, task_r0y9wcex: "Foto
// aufnehmen … Ton aufnehmen und das direkt mitschicken, also nicht transkribieren … Dateien vom Handy anhängen") also its
// files – a photo from the camera app, an audio recording sent as audio (never heard by a recognizer) and files from the
// phone's picker – each a file in the app's cache (BubblePick, AudioNote) with its name for the agent; they go up in
// files.uploadChunk pieces of CHUNK bytes (a whole file never sits in memory or in one socket frame).
// Pure, so a host test pins it.
// Never: Android classes, or the person's text (that goes only in BubbleChat's messages.send frame).
package com.teydralab.autark.android.phoneuse;

import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

final class TodoPost {
    static final int MAX = 6;
    /** Files besides the screenshots: at most this many, each at most FILE_MAX_BYTES, together at most FILES_MAX_BYTES. */
    static final int FILES_MAX = 8;
    static final long FILE_MAX_BYTES = 50L * 1024 * 1024;
    static final long FILES_MAX_BYTES = 100L * 1024 * 1024;
    /** One files.uploadChunk piece (the PC takes up to 4 MB; one minute of dictation WAV, 1.9 MB, is one frame today). */
    static final int CHUNK = 1024 * 1024;
    /** Why attach refused a file. */
    static final String TOO_MANY = "too many", TOO_BIG = "too big", TOO_MUCH = "too much";

    /** One screenshot: its JPEG, and its file id on the PC once uploaded. */
    static final class Shot {
        final byte[] jpeg;
        volatile String fileId;
        Shot(byte[] jpeg) { this.jpeg = jpeg; }
    }

    /** One file of the plus menu: what it is, where the phone keeps it, its name for the agent, its type and size; its file id once uploaded. */
    static final class Item {
        static final String PHOTO = "photo", AUDIO = "audio", FILE = "file";
        final String kind;
        final String path;
        final String name;
        final String mime;
        final long bytes;
        /** An audio recording's length (ms), else 0. */
        final long durationMs;
        volatile String fileId;
        Item(String kind, String path, String name, String mime, long bytes, long durationMs) {
            this.kind = kind;
            this.path = path;
            this.name = name;
            this.mime = mime == null || mime.isEmpty() ? "application/octet-stream" : mime;
            this.bytes = bytes;
            this.durationMs = durationMs;
        }
    }

    private final List<Shot> shots = new ArrayList<>();
    private final List<Item> files = new ArrayList<>();
    private String clientId;
    private String sentKey; // what the id was last used for: the text, the shots and the files

    /** Adds a shot; false when MAX are there already. */
    synchronized boolean add(byte[] jpeg) {
        if (shots.size() >= MAX) return false;
        shots.add(new Shot(jpeg));
        return true;
    }

    synchronized boolean full() { return shots.size() >= MAX; }

    synchronized void remove(Shot shot) { shots.remove(shot); }

    synchronized List<Shot> shots() { return Collections.unmodifiableList(new ArrayList<>(shots)); }

    /** Adds a file of the plus menu: null, or why not (TOO_MANY, TOO_BIG, TOO_MUCH) – then nothing changed. */
    synchronized String attach(Item item) {
        if (files.size() >= FILES_MAX) return TOO_MANY;
        if (item.bytes > FILE_MAX_BYTES) return TOO_BIG;
        long total = item.bytes;
        for (Item file : files) total += file.bytes;
        if (total > FILES_MAX_BYTES) return TOO_MUCH;
        files.add(item);
        return null;
    }

    synchronized void detach(Item item) { files.remove(item); }

    synchronized List<Item> files() { return Collections.unmodifiableList(new ArrayList<>(files)); }

    /** How many files of this kind are there (the next one's number in its name). */
    synchronized int count(String kind) {
        int count = 0;
        for (Item file : files) if (file.kind.equals(kind)) count++;
        return count;
    }

    /** Whether nothing goes with the words: no shot and no file. */
    synchronized boolean bare() { return shots.isEmpty() && files.isEmpty(); }

    /** Fresh Send image is not draft state: don't change the draft's retry id or show a stale automatic shot. */
    synchronized List<Shot> shotsWith(Shot currentPage) {
        List<Shot> result = new ArrayList<>(shots);
        if (currentPage != null) result.add(currentPage);
        return result;
    }

    /** This post's client id: made at the first Send, the same on every retry until clear(). */
    synchronized String clientId() {
        if (clientId == null) clientId = UUID.randomUUID().toString();
        return clientId;
    }

    /**
     * The id for a Send of `text` with the shots now: the same as the last Send when nothing changed (a late first send and the
     * retry make one task), a new one when the person changed the text or the shots (20.11., Lukas #30: a changed draft must
     * not vanish into the first task; a double task is visible and deletable, a lost change is not).
     */
    synchronized String clientIdFor(String text) {
        StringBuilder key = new StringBuilder(text == null ? "" : text.trim());
        for (Shot shot : shots) key.append('\0').append(System.identityHashCode(shot));
        for (Item file : files) key.append('\1').append(System.identityHashCode(file));
        String now = key.toString();
        if (clientId != null && sentKey != null && !sentKey.equals(now)) clientId = null;
        sentKey = now;
        return clientId();
    }

    /** Takes over a quick task's client id whose post failed when this post has none yet (it may have arrived after all: a retry then answers that task). */
    synchronized void adopt(String id) { if (clientId == null) clientId = id; }

    /** The post went through: no shots, no files, the next Send makes a new line. */
    synchronized void clear() { shots.clear(); files.clear(); clientId = null; sentKey = null; }

    /** The upload's file name: screen-1.jpg, screen-2.jpg … in the order they go up. */
    synchronized String name(Shot shot) { return "screen-" + (shots.indexOf(shot) + 1) + ".jpg"; }

    static Map<String, Object> upload(String name, byte[] jpeg) {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("name", name);
        params.put("mime", "image/jpeg");
        params.put("dataBase64", Base64.getEncoder().encodeToString(jpeg));
        return params;
    }

    /** A new upload id for files.uploadChunk (the PC's id form: "up_" and 8–40 of [0-9a-z]). */
    static String uploadId() { return "up_" + UUID.randomUUID().toString().replace("-", ""); }

    /** How many files.uploadChunk calls a file of `bytes` takes (an empty file: one, the final). */
    static int chunks(long bytes) { return (int) Math.max(1, (bytes + CHUNK - 1) / CHUNK); }

    /** One files.uploadChunk frame: `length` bytes of `data` as piece `index`; the last one stores the file (its answer: the FileRef). */
    static Map<String, Object> chunk(String uploadId, int index, byte[] data, int length, boolean last, Item item) {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("uploadId", uploadId);
        params.put("index", index);
        params.put("dataBase64", Base64.getEncoder().encodeToString(length == data.length ? data : java.util.Arrays.copyOf(data, length)));
        if (last) params.put("final", true);
        params.put("name", item.name);
        params.put("mime", item.mime);
        return params;
    }

    /** The file id in files.upload's answer – the stored file's `id` (FileRef), or `fileId`; null when neither is there. */
    static String fileId(Object result) {
        if (!(result instanceof Map)) return null;
        Object id = ((Map<?, ?>) result).get("id");
        if (!(id instanceof String)) id = ((Map<?, ?>) result).get("fileId");
        return id instanceof String && !((String) id).isEmpty() ? (String) id : null;
    }
}
