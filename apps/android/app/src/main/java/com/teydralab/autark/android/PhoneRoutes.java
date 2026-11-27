// Owns: the few places of the phone UI that a notification, a home-screen shortcut or a share may open (#/chats,
// #/tasks, #/chat/<id>, #/settings/<page>, the router's own hashes; the to-do button's call #/chat/<id>?call=1 and
// its task #/tasks?task=<id>, phoneuse/TodoButton), and which 'notify' event becomes a phone
// notification (every kind but 'info', unless its chat is quiet: toast false) with its route (the notice's own place,
// e.g. a connect request's #/settings/devices, else its chat, else #/tasks), tag and count (chat messages accumulate;
// a task remains one outstanding notice; a notice's own route never carries a query). A task's own tag takes precedence
// over the chat it belongs to.
// Pure, so a host test pins it. Never: Android classes, or a route with characters a script string could break out of.
package com.teydralab.autark.android;

public final class PhoneRoutes {
    /** The intent extra that carries a route (notifications, shortcuts in res/xml/shortcuts.xml). */
    public static final String EXTRA = "route";

    private PhoneRoutes() {}

    /** The route when it is one of the phone UI's places, else null. */
    static String valid(String route) {
        if (route == null) return null;
        if (route.equals("#/chats") || route.equals("#/tasks")) return route;
        return route.matches("#/chat/[A-Za-z0-9._~-]{1,200}(\\?call=1)?") || route.matches("#/tasks\\?task=[A-Za-z0-9._~-]{1,200}")
                || route.matches("#/settings/[a-z-]{1,40}") ? route : null;
    }

    /** A route an older app version put into a notification or shortcut that is still on screen: "#/day" (gone since 0.3.21) opens Tasks. Only the intent coming in uses this, never valid(). */
    static String migrate(String route) {
        return "#/day".equals(route) ? "#/tasks" : route;
    }

    /** The to-do button's call: the chat with `conversationId` whose page starts a call (null for an id the route cannot carry). */
    public static String call(String conversationId) {
        return conversationId == null ? null : valid("#/chat/" + conversationId + "?call=1");
    }

    /** The to-do button's task when no agent took it: the task list with `taskId` open (null for an id the route cannot carry). */
    public static String task(String taskId) {
        return taskId == null ? null : valid("#/tasks?task=" + taskId);
    }

    /** The place a page address shows ("#/…" of plain characters, e.g. to restore it after the activity was recreated), or null. */
    static String place(String url) {
        int at = url == null ? -1 : url.indexOf('#');
        String hash = at < 0 ? null : url.substring(at);
        return hash != null && hash.matches("#/[A-Za-z0-9._~/-]{1,300}") ? hash : null;
    }

    /** A chat's route, or null for an id the route cannot carry as it is (also the bubble's quick area, phoneuse/TodoButton). */
    public static String chat(String conversationId) {
        return conversationId == null ? null : valid("#/chat/" + conversationId);
    }

    /** The one tag every "Due: …" notice shares, and how long it stays (17.11.2026, the owner: three stacked cards that stay far too long). */
    static final String DUE_TAG = "due";
    static final long DUE_SHOW_MS = 6_000;
    private static final String DUE_PREFIX = "Due: ";
    private static final int DUE_ITEMS = 5;

    /** True for the notice of a to-do that fell due (the PC's "Due: <title>", kind todo). */
    static boolean isDue(String kind, String title) {
        return "todo".equals(kind) && title != null && title.startsWith(DUE_PREFIX);
    }

    /**
     * The grouped Due notice: `open` holds the titles of the one already shown (newline-separated, oldest first; null for none), this title joins them (each once,
     * the newest five). Returns {notice title, notice text, the titles to keep}: one title keeps its own text, more say how many.
     */
    static String[] dueGroup(String open, String title, String body) {
        String name = title == null ? "" : title.startsWith(DUE_PREFIX) ? title.substring(DUE_PREFIX.length()).trim() : title.trim();
        java.util.ArrayList<String> items = new java.util.ArrayList<>();
        if (open != null) for (String item : open.split("\\n")) if (!item.isEmpty() && !item.equals(name)) items.add(item);
        if (!name.isEmpty()) items.add(name);
        while (items.size() > DUE_ITEMS) items.remove(0);
        String keep = String.join("\n", items);
        if (items.size() <= 1) return new String[] {title == null || title.isEmpty() ? DUE_PREFIX.trim() : title, body == null ? "" : body, keep};
        return new String[] {items.size() + " to-dos due", String.join(" · ", items), keep};
    }

    /** A 'notify' event's route (its own `route` when that is a phone UI place), or null when the phone shows nothing for it. */
    static String forNotice(String kind, Object toast, String conversationId, String route) {
        if (kind == null || kind.equals("info") || Boolean.FALSE.equals(toast)) return null;
        if (valid(route) != null && route.indexOf('?') < 0) return route; // a notice's tap never starts a call by itself
        String chat = chat(conversationId);
        return chat != null ? chat : "#/tasks";
    }

    /** One notification per chat (or task); a newer one replaces it. */
    static String tag(String conversationId, String taskId) {
        if (taskId != null && !taskId.isEmpty()) return "task:" + taskId;
        if (conversationId != null && !conversationId.isEmpty()) return "chat:" + conversationId;
        return "notice";
    }

    /** Number represented by one bundled notification; null is a newly opened notice, zero an older uncounted one. */
    static int noticeCount(String tag, Integer previous) {
        return tag != null && tag.startsWith("chat:") && previous != null
                ? (int) Math.min(Integer.MAX_VALUE, Math.max(1L, previous.longValue()) + 1) : 1;
    }
}
