// Owns: where a line from the bubble goes (owner 26.11.2026, task_cxs4s3pt: "Warum geht das direkt zu meinem Task? Das ist
// doch völliger Blödsinn … kein Bild"): a line in the chat the person used last – ui.state's lastConversationId, which
// only the person moves (their window or their phone; never an agent's wf, desktop rpc/handlers/system.ts) – with the
// shots as images in that line. Never a to-do and never a guess: without that chat, or when it has no agent, nothing
// goes out and the bubble says why (no fallback to another chat – a line in the wrong chat is worse than none). The
// frames: messages.send with the words, the shots and the post's client id (a retry into the same chat answers the
// first line), and a silent line with the call's shots before a call. Each shot is named for the agent, which reads
// "[Image: <name>]" with the picture: SHOT. Pure, so a host test pins it.
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
