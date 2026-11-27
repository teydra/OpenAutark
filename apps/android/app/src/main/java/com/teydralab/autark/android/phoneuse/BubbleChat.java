// Owns: where a line from the bubble goes (owner 26.11.2026, task_cxs4s3pt: "Warum geht das direkt zu meinem Task? Das ist
// doch völliger Blödsinn … kein Bild"): a line in the chat the person used last – ui.state's lastConversationId, which
// only the person moves (their window or their phone; never an agent's wf, desktop rpc/handlers/system.ts) – with the
// shots as images in that line. Never a to-do and never a guess: without that chat, or when it has no agent, nothing
// goes out and the bubble says why (no fallback to another chat – a line in the wrong chat is worse than none). The
// frames: messages.send with the words, the shots and the post's client id (a retry into the same chat answers the
// first line), and a silent line with the call's shots before a call. Each shot is named for the agent, which reads
// "[Image: <name>]" with the picture: SHOT. The plus menu's files (task_r0y9wcex) stand in the same line after the shots,
// named for the agent too: a photo as PHOTO, a recording as "Audio recording, <length>.m4a" (sound, not words), a picked
// file by its own name. Pure, so a host test pins it.
// Never: Android classes, tasks.quickCreate, or the person's text anywhere but the messages.send frame.
package com.teydralab.autark.android.phoneuse;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class BubbleChat {
    private BubbleChat() {}

    /** The image name the agent reads (Konrad 26.11.: the hint is this sentence, not "a line on the Tasks page"). */
    static final String SHOT = "Screenshot of the page the person was on when asking";

    /** The name of shot `index` (1 …): the sentence, a number from the second on. */
    static String shotName(int index) {
        return index <= 1 ? SHOT + ".jpg" : SHOT + " (" + index + ").jpg";
    }

    /** The plus menu's photo, named for the agent like the shots (owner 24.11.2026, task_r0y9wcex). */
    static final String PHOTO = "Photo taken with the phone camera";

    /** The name of photo `index` (1 …). */
    static String photoName(int index) {
        return index <= 1 ? PHOTO + ".jpg" : PHOTO + " (" + index + ").jpg";
    }

    /** The name of audio recording `index` (1 …) of `ms`: the agent reads that it is a recording, sent as sound – not words. */
    static String audioName(long ms, int index) {
        return "Audio recording" + (index <= 1 ? "" : " (" + index + ")") + ", " + spoken(ms) + ".m4a";
    }

    /** A picked file keeps its own name (no folder, no control characters, at most 120 characters with its extension); without one "File (n)". */
    static String fileName(String original, int index) {
        String name = original == null ? "" : original;
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (slash >= 0) name = name.substring(slash + 1);
        name = name.replaceAll("[\\u0000-\\u001f]", "_").trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) return index <= 1 ? "File" : "File (" + index + ")";
        if (name.length() <= 120) return name;
        int dot = name.lastIndexOf('.');
        String extension = dot > 0 && name.length() - dot <= 10 ? name.substring(dot) : "";
        return name.substring(0, 120 - extension.length()) + extension;
    }

    /** A length as people say it: "12 s", "1 min 5 s", "3 min". */
    static String spoken(long ms) {
        long seconds = Math.max(1, Math.round(ms / 1000.0));
        long minutes = seconds / 60;
        seconds %= 60;
        if (minutes == 0) return seconds + " s";
        return seconds == 0 ? minutes + " min" : minutes + " min " + seconds + " s";
    }

    /** A running or recorded length on the chip and the status line: "0:07", "12:30". */
    static String clock(long ms) {
        long seconds = Math.max(0, ms / 1000);
        long rest = seconds % 60;
        return (seconds / 60) + ":" + (rest < 10 ? "0" : "") + rest;
    }

    /** ui.state's lastConversationId, or null. */
    static String lastChatId(Object uiState) {
        if (!(uiState instanceof Map)) return null;
        Object id = ((Map<?, ?>) uiState).get("lastConversationId");
        return id instanceof String && !((String) id).isEmpty() ? (String) id : null;
    }

    /**
     * The target from chats.get's summary of `chatId`: {chatId, agentId} – the chat's lead agent, else its first agent
     * that has not left – or null when the summary is another chat, archived, or has no agent.
     */
    static String[] target(String chatId, Object summary) {
        if (chatId == null || !(summary instanceof Map)) return null;
        Map<?, ?> chat = (Map<?, ?>) summary;
        if (!chatId.equals(chat.get("id")) || chat.get("archivedAt") != null) return null;
        Object members = chat.get("members");
        if (!(members instanceof List)) return null;
        String first = null;
        for (Object entry : (List<?>) members) {
            if (!(entry instanceof Map)) continue;
            Map<?, ?> member = (Map<?, ?>) entry;
            if (!"agent".equals(member.get("kind")) || member.get("leftAt") != null || !(member.get("memberId") instanceof String)) continue;
            String id = (String) member.get("memberId");
            if (id.isEmpty()) continue;
            if ("lead".equals(member.get("role"))) return new String[] { chatId, id };
            if (first == null) first = id;
        }
        return first == null ? null : new String[] { chatId, first };
    }

    /** The agent's name in agents.get's answer, or null. */
    static String agentName(Object agent) {
        if (!(agent instanceof Map)) return null;
        Object name = ((Map<?, ?>) agent).get("name");
        return name instanceof String && !((String) name).trim().isEmpty() ? ((String) name).trim() : null;
    }

    /** messages.send's params: the person's words, the uploaded shots {fileId, name}, the client id; silent for a call's shots. */
    static Map<String, Object> send(String chatId, String text, List<String[]> attachments, String clientId, boolean silent) {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("conversationId", chatId);
        params.put("body", text == null ? "" : text);
        List<Map<String, Object>> files = new ArrayList<>();
        for (String[] file : attachments) {
            Map<String, Object> one = new LinkedHashMap<>();
            one.put("fileId", file[0]);
            one.put("name", file[1]);
            files.add(one);
        }
        if (!files.isEmpty()) params.put("attachments", files);
        if (clientId != null) params.put("clientId", "bubble:" + clientId);
        if (silent) params.put("silent", true);
        return params;
    }

    /** The message id in messages.send's answer, or null (nothing stood in the chat). */
    static String messageId(Object result) {
        if (!(result instanceof Map)) return null;
        Object id = ((Map<?, ?>) result).get("id");
        return id instanceof String && !((String) id).isEmpty() ? (String) id : null;
    }
}
