// Owns: what the bubble's quick area (TodoButton: the small arrow at the top of the panel; owner 24.11.2026,
// task_r0y9wcex: "eine komplette Kontrollzentrale mit nur den wichtigsten Dingen … die wichtigsten Nachrichten … wenn
// irgendwas als Important gekennzeichnet ist oder man kann auf Tasks gehen") shows from the PC's answers – only calls the
// phone already holds with 'chat': chats.list (each summary's importantUnread: unread messages with priority
// 'important', B-041) and messages.list of the few chats that have some (the newest such message there, its words in
// one line). The chats with the newest important news first, at most MAX; a chat whose list shows no such message
// (older than the page asked for) falls back to its last preview. A tap opens that chat in the app; "Tasks" opens the
// Tasks page (PhoneRoutes). Read messages drop out – the area is for what still waits.
// Pure, so a host test pins it. Never: Android classes, a call the phone does not hold, or a silent or status line.
package com.teydralab.autark.android.phoneuse;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

final class BubbleQuick {
    private BubbleQuick() {}

    /** At most this many important lines. */
    static final int MAX = 3;
    /** How many of a chat's newest messages messages.list is asked for. */
    static final int PAGE = 40;
    /** One line's length at most. */
    static final int LINE_MAX = 140;

    /** One chat with important news: its id, title, how many important unread, when it last moved. */
    static final class Chat {
        final String id;
        final String title;
        final int important;
        final long at;
        final String preview;
        Chat(String id, String title, int important, long at, String preview) {
            this.id = id;
            this.title = title;
            this.important = important;
            this.at = at;
            this.preview = preview;
        }
    }

    /** chats.list's answer: the chats with importantUnread > 0, not archived, newest first, at most MAX. */
    static List<Chat> chats(Object list) {
        List<Chat> found = new ArrayList<>();
        if (!(list instanceof List)) return found;
        for (Object entry : (List<?>) list) {
            if (!(entry instanceof Map)) continue;
            Map<?, ?> chat = (Map<?, ?>) entry;
            Object id = chat.get("id");
            if (!(id instanceof String) || ((String) id).isEmpty() || chat.get("archivedAt") != null) continue;
            int important = (int) number(chat.get("importantUnread"));
            if (important <= 0) continue;
            Object title = chat.get("title");
            Object last = chat.get("lastPreview");
            long at = number(chat.get("lastMessageAt"));
            String preview = null;
            if (last instanceof Map) {
                at = Math.max(at, number(((Map<?, ?>) last).get("at")));
                Object text = ((Map<?, ?>) last).get("text");
                preview = text instanceof String ? (String) text : null;
            }
            found.add(new Chat((String) id, title instanceof String ? ((String) title).trim() : "", important, at, preview));
        }
        found.sort((a, b) -> Long.compare(b.at, a.at));
        return found.size() > MAX ? new ArrayList<>(found.subList(0, MAX)) : found;
    }

    /** The sum of importantUnread over all chats of chats.list's answer (what the lock screen shows instead of words). */
    static int count(Object list) {
        int count = 0;
        if (!(list instanceof List)) return 0;
        for (Object entry : (List<?>) list) {
            if (!(entry instanceof Map) || ((Map<?, ?>) entry).get("archivedAt") != null) continue;
            count += Math.max(0, (int) number(((Map<?, ?>) entry).get("importantUnread")));
        }
        return count;
    }

    /** messages.list's answer: the words of the newest important message someone else wrote (no silent, status or streaming line), or null. */
    static String newest(Object messages) {
        if (!(messages instanceof List)) return null;
        Map<?, ?> best = null;
        for (Object entry : (List<?>) messages) {
            if (!(entry instanceof Map)) continue;
            Map<?, ?> message = (Map<?, ?>) entry;
            if (!"important".equals(message.get("priority")) || Boolean.TRUE.equals(message.get("silent"))) continue;
            if ("status".equals(message.get("kind")) || "human".equals(message.get("authorKind")) || "streaming".equals(message.get("state"))) continue;
            if (best == null || number(message.get("seq")) > number(best.get("seq"))) best = message;
        }
        if (best == null) return null;
        Object body = best.get("body");
        return body instanceof String ? (String) body : null;
    }

    /** A message's words as one short line: no code or block fences, no Markdown marks, one space between words. */
    static String line(String body) {
        if (body == null) return "";
        String text = body.replaceAll("(?s)```.*?(```|$)", " ");
        text = text.replaceAll("!?\\[([^\\]]*)\\]\\([^)]*\\)", "$1"); // a link or picture: its words
        text = text.replaceAll("(?m)^\\s{0,3}(#{1,6}|>|[-*+]|\\d+\\.)\\s+", "");
        text = text.replaceAll("[*_`~]+", "");
        text = text.replaceAll("\\s+", " ").trim();
        return text.length() <= LINE_MAX ? text : text.substring(0, LINE_MAX - 1).trim() + "…";
    }

    /** The row's text: the chat's title, then the words. */
    static String row(Chat chat, String words) {
        String text = line(words != null ? words : chat.preview);
        if (chat.title.isEmpty()) return text;
        return text.isEmpty() ? chat.title : chat.title + " · " + text;
    }

    /** The lock screen's line: how many important messages wait (no words). */
    static String waiting(int count, boolean german) {
        if (count <= 0) return german ? "Nichts Wichtiges ungelesen." : "Nothing important unread.";
        if (count == 1) return german ? "1 wichtige Nachricht – entsperren zum Lesen." : "1 important message – unlock to read it.";
        return german ? count + " wichtige Nachrichten – entsperren zum Lesen." : count + " important messages – unlock to read them.";
    }

    private static long number(Object value) {
        return value instanceof Number ? ((Number) value).longValue() : 0;
    }
}
