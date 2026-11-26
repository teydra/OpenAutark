// Owns: one line the person is putting together in the bubble (TodoButton) – its screenshots (JPEG bytes, at most MAX,
// each with the file id once files.upload took it, so a second Send uploads nothing twice), the client id of this post
// (made once, the same on every retry until it went through: messages.send then answers the first line in that chat,
// never a second one – BubbleChat) and the upload frame. Pure, so a host test pins it.
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

    /** One screenshot: its JPEG, and its file id on the PC once uploaded. */
    static final class Shot {
        final byte[] jpeg;
        volatile String fileId;
        Shot(byte[] jpeg) { this.jpeg = jpeg; }
    }

    private final List<Shot> shots = new ArrayList<>();
    private String clientId;
    private String sentKey; // what the id was last used for: the text and the shots

    /** Adds a shot; false when MAX are there already. */
    synchronized boolean add(byte[] jpeg) {
        if (shots.size() >= MAX) return false;
        shots.add(new Shot(jpeg));
        return true;
    }

    synchronized boolean full() { return shots.size() >= MAX; }

    synchronized void remove(Shot shot) { shots.remove(shot); }

    synchronized List<Shot> shots() { return Collections.unmodifiableList(new ArrayList<>(shots)); }

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
        String now = key.toString();
        if (clientId != null && sentKey != null && !sentKey.equals(now)) clientId = null;
        sentKey = now;
        return clientId();
    }

    /** Takes over a quick task's client id whose post failed when this post has none yet (it may have arrived after all: a retry then answers that task). */
    synchronized void adopt(String id) { if (clientId == null) clientId = id; }

    /** The post went through: no shots, the next Send makes a new task. */
    synchronized void clear() { shots.clear(); clientId = null; sentKey = null; }

    /** The upload's file name: screen-1.jpg, screen-2.jpg … in the order they go up. */
    synchronized String name(Shot shot) { return "screen-" + (shots.indexOf(shot) + 1) + ".jpg"; }

    static Map<String, Object> upload(String name, byte[] jpeg) {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("name", name);
        params.put("mime", "image/jpeg");
        params.put("dataBase64", Base64.getEncoder().encodeToString(jpeg));
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
