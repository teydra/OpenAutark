// Owns: executable checks of the places a notification, shortcut or share may open (PhoneRoutes) and of which PC
// 'notify' event becomes a phone notification, without a device. Never: claims a notification shows (that needs a phone).
package com.teydralab.autark.android;

public final class PhoneRoutesTest {
    private static int assertions;

    public static void main(String[] args) {
        for (String route : new String[] {"#/chats", "#/tasks", "#/chat/c_1-a.B~2", "#/settings/devices", "#/settings/general"}) check(route.equals(PhoneRoutes.valid(route)));
        for (String route : new String[] {null, "", "#/", "#/settings", "#/settings/", "#/settings/Devices", "#/settings/a/b", "#/settings/a'b",
                "#/settings/" + "x".repeat(41), "#/chat/", "#/chat/a'b", "#/chat/a\"b", "#/chat/a b", "#/chat/a/b",
                "javascript:alert(1)", "#/chats'", "#/chat/" + "x".repeat(201)}) check(PhoneRoutes.valid(route) == null);
        check("#/tasks".equals(PhoneRoutes.migrate("#/day")) && PhoneRoutes.valid("#/day") == null);
        check("#/chats".equals(PhoneRoutes.migrate("#/chats")) && PhoneRoutes.migrate(null) == null);
        check("#/chat/abc".equals(PhoneRoutes.forNotice("reply", null, "abc", null)));
        check("#/chat/abc".equals(PhoneRoutes.forNotice("todo", Boolean.TRUE, "abc", null)));
        check("#/tasks".equals(PhoneRoutes.forNotice("todo", null, null, null)));
        check("#/tasks".equals(PhoneRoutes.forNotice("blocker", null, "has space", null)));
        check(PhoneRoutes.forNotice("info", null, "abc", null) == null);
        check(PhoneRoutes.forNotice("reply", Boolean.FALSE, "abc", null) == null);
        check(PhoneRoutes.forNotice(null, null, "abc", null) == null);
        check("#/settings/devices".equals(PhoneRoutes.forNotice("important", null, null, "#/settings/devices")));
        check("#/settings/devices".equals(PhoneRoutes.forNotice("important", null, "abc", "#/settings/devices")));
        check("#/chat/abc".equals(PhoneRoutes.forNotice("important", null, "abc", "javascript:alert(1)")));
        check("#/tasks".equals(PhoneRoutes.forNotice("important", null, null, "#/settings/a'b")));
        check(PhoneRoutes.forNotice("info", null, null, "#/settings/devices") == null);
        check(PhoneRoutes.forNotice("important", Boolean.FALSE, null, "#/settings/devices") == null);
        check("task:t1".equals(PhoneRoutes.tag("abc", "t1")));
        check("chat:abc".equals(PhoneRoutes.tag("abc", null)));
        check("task:t1".equals(PhoneRoutes.tag(null, "t1")) && "task:t1".equals(PhoneRoutes.tag("", "t1")));
        check("notice".equals(PhoneRoutes.tag(null, null)));
        check("route".equals(PhoneRoutes.EXTRA));
        check("#/settings/devices".equals(PhoneRoutes.place("http://127.0.0.1:47921/#/settings/devices")));
        check("#/chat/abc".equals(PhoneRoutes.place("#/chat/abc")));
        for (String url : new String[] {null, "", "http://127.0.0.1:47920/", "http://127.0.0.1:47920/#", "http://127.0.0.1:47920/#/",
                "http://127.0.0.1:47920/#token=abc", "#/chat/a'b", "#/a b", "#/x?y=1", "#/" + "x".repeat(301)}) check(PhoneRoutes.place(url) == null);
        todoRoutes();
        dueNotices();
        noticeCounts();
        System.out.println(assertions + " phone route, notice and badge assertions passed.");
    }

    /** 18.11.2026: the to-do button opens exactly two more forms – a chat that starts a call, and one task – and a notice never does. */
    private static void todoRoutes() {
        check("#/chat/c_1-a.B~2?call=1".equals(PhoneRoutes.valid("#/chat/c_1-a.B~2?call=1")));
        check("#/tasks?task=t_9".equals(PhoneRoutes.valid("#/tasks?task=t_9")));
        check("#/chat/abc?call=1".equals(PhoneRoutes.call("abc")) && "#/tasks?task=t1".equals(PhoneRoutes.task("t1")));
        for (String route : new String[] {"#/chat/abc?call=0", "#/chat/abc?call=1&x=2", "#/chat/abc?call=1'", "#/chat/?call=1", "#/chat/a b?call=1",
                "#/tasks?task=", "#/tasks?task=a'b", "#/tasks?task=a/b", "#/tasks?task=a&b", "#/tasks?id=1", "#/tasks?task=" + "x".repeat(201),
                "#/chats?call=1", "#/settings/devices?call=1"}) check(PhoneRoutes.valid(route) == null);
        check(PhoneRoutes.call(null) == null && PhoneRoutes.call("a'b") == null && PhoneRoutes.call("a\\b") == null);
        check(PhoneRoutes.task(null) == null && PhoneRoutes.task("x');alert(1)//") == null);
        check("#/chat/abc".equals(PhoneRoutes.forNotice("important", null, "abc", "#/chat/abc?call=1"))); // a notice's tap never calls
        check("#/tasks".equals(PhoneRoutes.forNotice("important", null, null, "#/tasks?task=t1")));
        check(PhoneRoutes.place("http://127.0.0.1:47920/#/chat/abc?call=1") == null); // a recreated activity never calls again
    }

    /** 17.11.2026: Due notices share one tag and group: one title keeps its text, more say how many (each title once, the newest five). */
    private static void dueNotices() {
        check(PhoneRoutes.isDue("todo", "Due: Call the tax office") && !PhoneRoutes.isDue("todo", "Ida: Check") && !PhoneRoutes.isDue("reply", "Due: x") && !PhoneRoutes.isDue("todo", null));
        check("due".equals(PhoneRoutes.DUE_TAG) && PhoneRoutes.DUE_SHOW_MS == 6_000);
        String[] one = PhoneRoutes.dueGroup(null, "Due: Call the tax office", "notes");
        check("Due: Call the tax office".equals(one[0]) && "notes".equals(one[1]) && "Call the tax office".equals(one[2]));
        String[] two = PhoneRoutes.dueGroup(one[2], "Due: Recording", "");
        check("2 to-dos due".equals(two[0]) && "Call the tax office · Recording".equals(two[1]));
        check("2 to-dos due".equals(PhoneRoutes.dueGroup(two[2], "Due: Recording", "")[0]));
        String keep = null;
        for (String name : new String[] {"a", "b", "c", "d", "e", "f"}) keep = PhoneRoutes.dueGroup(keep, "Due: " + name, "")[2];
        check("b\nc\nd\ne\nf".equals(keep));
    }

    /** Several chats plus task notices: the launcher's sum represents messages, not just the number of chat cards. */
    private static void noticeCounts() {
        java.util.Map<String, Integer> active = new java.util.HashMap<>();
        for (String tag : new String[] { "chat:a", "chat:b", "chat:a", "task:t1", "task:t1", "notice" }) {
            active.put(tag, PhoneRoutes.noticeCount(tag, active.get(tag)));
        }
        check(active.get("chat:a") == 2 && active.get("chat:b") == 1);
        check(active.get("task:t1") == 1 && active.get("notice") == 1);
        check(active.values().stream().mapToInt(Integer::intValue).sum() == 5);
        active.remove("chat:a"); // dismissed: all its messages leave the icon together
        check(active.values().stream().mapToInt(Integer::intValue).sum() == 3);
        active.put("chat:a", PhoneRoutes.noticeCount("chat:a", active.get("chat:a")));
        check(active.get("chat:a") == 1);
        active.clear(); // opening the app clears AppNotices' own active notifications
        check(active.values().stream().mapToInt(Integer::intValue).sum() == 0);
        check(PhoneRoutes.noticeCount("chat:old", 0) == 2); // a notice from a build before counting represented one message
        check(PhoneRoutes.noticeCount("chat:many", Integer.MAX_VALUE) == Integer.MAX_VALUE);
        check(PhoneRoutes.noticeCount("task:t1", Integer.MAX_VALUE) == 1);
    }

    private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("Unexpected result " + assertions); }
}
