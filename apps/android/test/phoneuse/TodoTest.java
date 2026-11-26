// Owns: executable checks of the to-do button's pure parts without a device – where it sits (TodoPlace: drag or tap,
// whole on the screen, the tab's side, the panel beside the dot and above the keyboard, the screenshot's size), what one
// post sends (TodoPost: at most six shots, one client id per post until it went through, the files.upload frame;
// BubbleChat: the chat line with the picture in the chat the person used last, never a to-do – task_cxs4s3pt) and the overlay's wiring read from its source (the AI's screenshot leaves
// the button out, the window never takes key focus – typing goes through BubbleTyping –, dictation is heard by the PC).
// Never: claims the overlay shows or a task arrives – that
// needs a phone and a PC.
package com.teydralab.autark.android.phoneuse;

import com.teydralab.autark.android.relay.Json;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class TodoTest {
    private static int assertions;

    public static void main(String[] args) throws Exception {
        holdAndSend();
        place();
        post();
        chatLine();
        speech();
        resend();
        wiring(source("app/src/main/java/com/teydralab/autark/android/phoneuse/TodoButton.java"),
                source("app/src/main/java/com/teydralab/autark/android/phoneuse/UseService.java"),
                source("app/src/main/java/com/teydralab/autark/android/phoneuse/UseLink.java"));
        System.out.println(assertions + " to-do button place, post and wiring assertions passed.");
    }

    private static void holdAndSend() {
        TodoHold hold = new TodoHold();
        List<String> events = new ArrayList<>();
        check(hold.begin(() -> events.add("record")));
        check(hold.active() && !hold.released() && events.equals(Arrays.asList("record")));
        check(!hold.begin(() -> events.add("unexpected second recorder")));
        hold.release(() -> events.add("capture"));
        hold.release(() -> events.add("unexpected second capture"));
        check(hold.released() && events.equals(Arrays.asList("record", "capture")));
        hold.reset();
        check(hold.begin(() -> events.add("record again")));
        hold.reset(); // ACTION_CANCEL, not ACTION_UP
        hold.release(() -> events.add("unexpected capture after cancel"));
        check(!hold.active() && events.equals(Arrays.asList("record", "capture", "record again")));

        TodoPost draft = new TodoPost();
        draft.add(new byte[] {1}); // explicitly tapped the camera before changing pages
        String first = draft.clientIdFor("send");
        TodoPost.Shot firstTap = new TodoPost.Shot(new byte[] {2});
        TodoPost.Shot retryTap = new TodoPost.Shot(new byte[] {3});
        check(draft.shotsWith(firstTap).get(1) == firstTap);
        check(draft.shotsWith(retryTap).get(1) == retryTap && draft.shots().size() == 1);
        check(first.equals(draft.clientIdFor("send")));
    }

    private static void speech() {
        // the language: the profile's before the phone's (bubble bug 19.11.2026: a German speaker, a phone set to English)
        check("de-DE".equals(SpeechLang.tag("de", "en-US")) && "en-US".equals(SpeechLang.tag("en", "de-DE")));
        check("de-AT".equals(SpeechLang.tag("de-AT", "en-US")) && "de-DE".equals(SpeechLang.tag("de_DE", "en-US")));
        check("en-US".equals(SpeechLang.tag(null, "en-US")) && "de-DE".equals(SpeechLang.tag("  ", "de-DE")) && "en-US".equals(SpeechLang.tag(null, null)));
        check("de".equals(SpeechLang.profileLanguage(Json.map("language", "de"))) && "de-AT".equals(SpeechLang.profileLanguage(Json.map("language", "de-AT"))));
        check(SpeechLang.profileLanguage(Json.map("language", " ")) == null && SpeechLang.profileLanguage(null) == null
                && SpeechLang.profileLanguage(Json.map("language", null)) == null && SpeechLang.profileLanguage(Json.map()) == null && SpeechLang.profileLanguage("de") == null);
        // only a tag reaches the PC as the language: the profile's free text, an empty or a long value never does
        check("de".equals(SpeechLang.valid(" de ")) && "de-AT".equals(SpeechLang.valid("de-AT")) && "en_US".equals(SpeechLang.valid("en_US")));
        check(SpeechLang.valid(null) == null && SpeechLang.valid("") == null && SpeechLang.valid("Deutsch bitte") == null
                && SpeechLang.valid("d") == null && SpeechLang.valid("de-") == null && SpeechLang.valid("x".repeat(30)) == null
                && SpeechLang.valid("de;rm -rf") == null);
        check(SpeechLang.profileLanguage(Json.map("language", "Deutsch bitte")) == null
                && "de-DE".equals(SpeechLang.tag("Deutsch bitte", "de-DE")) && "en-US".equals(SpeechLang.tag("???", "??")));
        // the settings object's other fields are never read: a name or a key in the answer changes nothing
        check("de".equals(SpeechLang.profileLanguage(Json.map("language", "de", "profile", Json.map("name", "x"), "keys", Json.map("a", "b")))));
        // a link change A -> B: A's late answer (de) must change neither the language nor the kept one that B's answer set
        Object linkA = new Object(), linkB = new Object();
        Object asked = linkA; // sync asked for A
        String kept = null;
        asked = linkB; // the link changed: sync asks for B
        if (SpeechLang.isActive(asked, linkB)) kept = "en-GB"; // B answers
        if (SpeechLang.isActive(asked, linkA)) kept = "de"; // A's late answer
        check("en-GB".equals(kept) && !SpeechLang.isActive(asked, linkA) && !SpeechLang.isActive(null, linkA) && SpeechLang.isActive(linkA, linkA));
        asked = null; // the link is gone: nothing late changes anything
        check(!SpeechLang.isActive(asked, linkB));
        // disconnected while the ask was out: sync forgets the ask, and the connected link is none - B's answer after that changes nothing
        Object connected = null;
        check(!SpeechLang.isActive(connected, linkB) && SpeechLang.isActive(linkB, linkB));
        // the panel that the lock screen laid out too far right moves left until it is whole; never past the left edge
        check(SpeechLang.shiftInto(763, 690, 1080) == 390 && SpeechLang.shiftInto(100, 690, 1080) == 100 && SpeechLang.shiftInto(-40, 690, 1080) == 0
                && SpeechLang.shiftInto(500, 1200, 1080) == 0);
    }

    private static void resend() {
        // a refusal of the PC shows a living socket; no answer in time, or no socket, does not
        check(Resend.provesAlive(false, "unknown method") && Resend.provesAlive(false, null) && !Resend.provesAlive(true, null) && !Resend.provesAlive(false, "Not connected to your PC right now."));
    }

    private static void place() {
        check(!TodoPlace.dragged(3, 4, 8) && TodoPlace.dragged(6, 7, 8) && !TodoPlace.dragged(0, 8, 8)); // the slop is a tap
        check(TodoPlace.clamp(-20, 100, 1080) == 0 && TodoPlace.clamp(1000, 100, 1080) == 980 && TodoPlace.clamp(500, 100, 1080) == 500);
        check(TodoPlace.clamp(10, 2000, 1080) == 0); // wider than the screen: at its start
        check(TodoPlace.droppedAtEdge(10, 1080, 42) && TodoPlace.droppedAtEdge(1050, 1080, 42) && !TodoPlace.droppedAtEdge(540, 1080, 42) && !TodoPlace.droppedAtEdge(43, 1080, 42));
        check(TodoPlace.left(100, 120, 1080) && !TodoPlace.left(900, 120, 1080) && !TodoPlace.left(480, 120, 1080));
        check(TodoPlace.sideX(true, 30, 1080) == 0 && TodoPlace.sideX(false, 30, 1080) == 1050);
        int[] right = TodoPlace.panel(20, 300, 120, 700, 400, 1080, 2400); // dot on the left: the panel opens to its right
        check(right[0] == 20 && right[1] == 300);
        int[] left = TodoPlace.panel(940, 300, 120, 700, 400, 1080, 2400); // dot on the right: the panel ends at its right edge
        check(left[0] == 360 && left[1] == 300);
        int[] low = TodoPlace.panel(940, 2300, 120, 700, 400, 1080, 2400); // near the bottom: whole on the screen
        check(low[1] == 2000);
        check(TodoPlace.aboveKeyboard(100, 400, 2400) == 100); // already above the keyboard
        check(TodoPlace.aboveKeyboard(1500, 400, 2400) == Math.round(2400 * TodoPlace.ABOVE_KEYBOARD) - 400);
        check(TodoPlace.aboveKeyboard(1500, 2000, 2400) == 0);
        check(Arrays.equals(TodoPlace.shotSize(1080, 2400), new int[] {720, 1600}));
        check(Arrays.equals(TodoPlace.shotSize(2400, 1080), new int[] {1600, 720}));
        check(Arrays.equals(TodoPlace.shotSize(720, 1600), new int[] {720, 1600}) && Arrays.equals(TodoPlace.shotSize(800, 600), new int[] {800, 600}));
        check(Arrays.equals(TodoPlace.binCorner(1080, 2400, 168, 216), new int[] {456, 2016})); // the hide target: bottom centre
        check(TodoPlace.near(540, 2100, 540, 2100, 10) && TodoPlace.near(540, 1910, 540, 2100, 192) && !TodoPlace.near(540, 1900, 540, 2100, 192));
    }

    private static void post() {
        TodoPost post = new TodoPost();
        for (int i = 0; i < TodoPost.MAX; i++) check(post.add(new byte[] {(byte) i}));
        check(post.full() && !post.add(new byte[] {9}) && post.shots().size() == TodoPost.MAX);
        List<TodoPost.Shot> shots = post.shots();
        post.remove(shots.get(0));
        check(!post.full() && post.shots().size() == TodoPost.MAX - 1);
        check("screen-1.jpg".equals(post.name(shots.get(1))) && "screen-5.jpg".equals(post.name(shots.get(5))));
        String id = post.clientId();
        check(id.equals(post.clientId()) && id.length() == 36); // a retry keeps it
        post.clear();
        check(post.shots().isEmpty() && !id.equals(post.clientId())); // the next post is a new task
        TodoPost fresh = new TodoPost();
        fresh.adopt("quick-1");
        check("quick-1".equals(fresh.clientId())); // a failed quick task hands its id to the panel
        fresh.adopt("quick-2");
        check("quick-1".equals(fresh.clientId())); // never over an id of its own

        Map<String, Object> upload = TodoPost.upload("screen-1.jpg", new byte[] {1, 2, 3});
        check(upload.keySet().equals(new java.util.LinkedHashSet<>(Arrays.asList("name", "mime", "dataBase64"))));
        check("image/jpeg".equals(upload.get("mime")) && Arrays.equals(Base64.getDecoder().decode((String) upload.get("dataBase64")), new byte[] {1, 2, 3}));
        check("abc".equals(TodoPost.fileId(map("id", "abc", "name", "x"))) && "f1".equals(TodoPost.fileId(map("fileId", "f1"))));
        check(TodoPost.fileId(null) == null && TodoPost.fileId(map("id", "")) == null && TodoPost.fileId("x") == null);

    }

    /**
     * task_cxs4s3pt (owner 26.11.2026): a bubble line with a picture is one line with the image in the chat the person used
     * last – never a to-do, never a guessed chat. The frames and the choice of the chat, without a device.
     */
    private static void chatLine() {
        // the image is named for the agent: it reads "[Image: <name>]" with the picture
        check(BubbleChat.shotName(1).equals("Screenshot of the page the person was on when asking.jpg"));
        check(BubbleChat.shotName(2).equals("Screenshot of the page the person was on when asking (2).jpg"));
        check(!BubbleChat.shotName(1).contains("Tasks"));

        List<String[]> files = new ArrayList<>();
        files.add(new String[] {"abc", BubbleChat.shotName(1)});
        Map<String, Object> line = BubbleChat.send("ch_1", "Was steht auf dieser Seite?", files, "cid", false);
        check(line.keySet().equals(new java.util.LinkedHashSet<>(Arrays.asList("conversationId", "body", "attachments", "clientId"))));
        check("ch_1".equals(line.get("conversationId")) && "Was steht auf dieser Seite?".equals(line.get("body")) && "bubble:cid".equals(line.get("clientId")));
        check(line.get("attachments").equals(Arrays.asList(map("fileId", "abc", "name", BubbleChat.shotName(1)))));
        check(!line.containsKey("silent") && !line.containsKey("text") && !line.containsKey("target")); // a chat line, not tasks.quickCreate's frame
        check(!BubbleChat.send("ch_1", "Nur Text", new ArrayList<>(), "c", false).containsKey("attachments"));
        Map<String, Object> callShots = BubbleChat.send("ch_1", "", files, "cid", true);
        check(Boolean.TRUE.equals(callShots.get("silent")) && "".equals(callShots.get("body"))); // a call's shots: one silent line before it
        check("m1".equals(BubbleChat.messageId(map("id", "m1", "body", "x"))) && BubbleChat.messageId(map("task", map("id", "t1"))) == null && BubbleChat.messageId(null) == null);

        // which chat: the one ui.state names, with its lead agent, else its first agent that has not left
        check("ch_1".equals(BubbleChat.lastChatId(map("drafts", map(), "lastConversationId", "ch_1"))));
        check(BubbleChat.lastChatId(map("drafts", map())) == null && BubbleChat.lastChatId(map("lastConversationId", "")) == null && BubbleChat.lastChatId(null) == null);
        Object oneToOne = map("id", "ch_1", "members", Arrays.asList(
                map("memberId", "human", "kind", "human", "role", "owner"),
                map("memberId", "ag_lukas", "kind", "agent", "role", "member")));
        check(Arrays.equals(BubbleChat.target("ch_1", oneToOne), new String[] {"ch_1", "ag_lukas"}));
        Object group = map("id", "ch_2", "members", Arrays.asList(
                map("memberId", "ag_left", "kind", "agent", "role", "member", "leftAt", 5),
                map("memberId", "ag_mika", "kind", "agent", "role", "member"),
                map("memberId", "ag_konrad", "kind", "agent", "role", "lead")));
        check(Arrays.equals(BubbleChat.target("ch_2", group), new String[] {"ch_2", "ag_konrad"}));
        // no guess: no chat, another chat's summary, an archived chat or one without an agent – nothing goes out
        check(BubbleChat.target(null, oneToOne) == null && BubbleChat.target("ch_9", oneToOne) == null);
        check(BubbleChat.target("ch_1", map("id", "ch_1", "archivedAt", 7, "members", Arrays.asList(map("memberId", "ag_lukas", "kind", "agent", "role", "member")))) == null);
        check(BubbleChat.target("ch_3", map("id", "ch_3", "members", Arrays.asList(map("memberId", "per_ana", "kind", "human", "role", "member")))) == null);
        check("Lukas".equals(BubbleChat.agentName(map("id", "ag_lukas", "name", " Lukas "))) && BubbleChat.agentName(map("name", " ")) == null);
    }

    private static void wiring(String button, String service, String link) {
        String pressStart = button.substring(button.indexOf(" holdStart() {"), button.indexOf("void holdRelease()"));
        if (!pressStart.contains("take.start()") || pressStart.contains("captureAtSend()") || pressStart.contains("shot(jpeg)")) {
            throw new AssertionError("Hold must start the recorder without taking a screenshot.");
        }
        check(pressStart.contains("take.start()"));
        String pressEnd = button.substring(button.indexOf("void holdRelease()"), button.indexOf("void finishHoldTake()"));
        check(pressEnd.contains("captureAtSend()") && pressEnd.indexOf("captureAtSend()") < pressEnd.indexOf("finishHoldTake()"));
        check(button.contains("if (held && !hold.released()) dropHold();"));
        String panelOpen = button.substring(button.indexOf("private void open()"), button.indexOf("private void collapse()"));
        check(!panelOpen.contains("shoot()") && !panelOpen.contains("captureAtSend()"));
        String sendTap = button.substring(button.indexOf("private void submit()"), button.indexOf("private void submit(String"));
        check(sendTap.contains("captureAtSend()") && sendTap.indexOf("captureAtSend()") < sendTap.indexOf("finishDictation()"));
        check(button.contains("deliver(link, text, post, requiredPicture(picture))")
                && button.contains("deliver(link, text, quick, requiredPicture(picture))")
                && button.contains("Nicht gesendet – kein Screenshot möglich."));
        check(button.contains("sendCapture.execute(picture)") && button.contains("service.capture(deadline, keyboardWasOurs)")
                && service.contains("elapsedRealtime() >= deadline ||") && service.indexOf("elapsedRealtime() >= deadline ||") < service.indexOf("takeScreenshot("));
        // The AI's screenshot and the button's both go through capture(), which hides the bubble and the button for the frame.
        check(service.contains("if (!bubble.hideForShot() || (button != null && !button.hideForShot())) return null;"));
        check(service.contains("full = capture();") && service.split("takeScreenshot\\(", -1).length == 2); // one screenshot path
        // Collapsed it never takes key focus or touches outside itself.
        check(button.contains("FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL"));
        check(button.contains("if (next != Look.PANEL) endTyping();"));
        // Owner 20.11.2026 (Home and Back vanished with the keyboard): the overlay never takes key focus; the words come
        // through BubbleTyping, an app window, so the keyboard stays below the navigation bar.
        check(!button.contains("&= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE") && button.contains("BubbleTyping.begin(service, now, now.length(),"));
        check(button.contains("TYPE_ACCESSIBILITY_OVERLAY"));
        // JPEG 85, the post's client id reused, the text only in the RPC (no log of it, no preference of it).
        check(button.contains("CompressFormat.JPEG, 85"));
        check(button.contains("String[] chat = deliver(link, text, post, requiredPicture(picture));") && button.contains("BubbleChat.send(target[0], text, attachments, from.clientId(), false)"));
        // task_cxs4s3pt: the bubble never makes a to-do – no tasks.quickCreate, the line goes to the chat ui.state names, no other is guessed
        check(!button.contains("tasks.quickCreate\"") && !button.contains("\"chats.direct\"") && !button.contains("chats.list"));
        String target = button.substring(button.indexOf("private String[] chatTarget("), button.indexOf("private List<String[]> upload("));
        check(target.contains("answer(link, \"ui.state\"") && target.contains("answer(link, \"chats.get\"") && target.contains("throw new Failed(") && target.contains("Nicht gesendet – kein offener Chat"));
        String route = button.substring(button.indexOf("private String[] route("), button.indexOf("private void keepSaid("));
        check(route.contains("chatTarget(link)") && route.contains("BubbleChat.send(target[0], \"\", shots, post.clientId(), true)") && !route.contains("deliver("));
        check(button.contains("sentTo(chat)") && button.contains("BubbleChat.shotName(attachments.size() + 1)"));
        check(button.contains("HOLD_MS = 350") && button.contains("if (held) { holdRelease(); return true; }")); // the hold is the quick task
        // the only strings kept: the profile's language tag and the PC it came from (a value read from the PC belongs to that PC)
        check(!button.replace("putString(\"speech_lang\", found).putString(\"speech_lang_origin\", origin)", "").contains("putString(")
                && !button.matches("(?s).*Log\\.[a-z]\\([^;]*text[^;]*\\);.*"));
        // Owner 20.11.2026 ("We got to steer" for "Wie geht es dir?"): the panel's mic and the hold record, and the PC hears
        // the take in the profile's language – the phone's SpeechRecognizer is gone from the bubble.
        check(button.contains("new Dictation(service, link, language(),") && button.contains("new Dictation(service, link, language(), this::holdHeard,")
                && button.contains("SpeechLang.tag(profileLanguage, Locale.getDefault().toLanguageTag())") && !button.contains("SpeechRecognizer"));
        // Review 20.11.2026: phone use reads the app under the person's typing window, never the draft; the AI's gestures
        // pass through the dot too; a hold ends with its window; dictated words reach the typing field.
        check(service.contains("AccessibilityNodeInfo root = front();") && service.contains("AccessibilityNodeInfo front = front();") && service.split("getRootInActiveWindow", -1).length == 2);
        check(service.contains("if (button != null) button.passThrough(true);") && service.contains("BubbleTyping.aiGesture("));
        check(button.contains("dropHold(); // a hold whose window went") && button.contains("if (typing) BubbleTyping.set(text);"));
        // Send while recording: the words first, then it sends
        check(button.contains("sendAfter = picture;") && button.contains("submit(words, link, picture);"));
        // one ask of the PC per link, only the language field is read, the kept one belongs to its PC
        check(button.contains("link == languageFor") && button.contains("link.origin()") && button.contains("link.request(\"todos.speechLanguage\"") && button.contains("if (!SpeechLang.isActive(languageFor, link) || !SpeechLang.isActive(UseLink.linked(), link)) return;") && button.contains("{ languageFor = null; dropDictation(); remove(); }") && !button.contains("settings.get"));
        // A call's answer is matched by id; a socket that ends fails every call still waiting.
        check(link.contains("calls.remove(((Number) frame.get(\"id\")).intValue())") && link.contains("failCalls();"));
        check(button.contains("UseLink.linked() != null && !place.getBoolean(HIDDEN, false)"));
        // 20.11.: a dead socket carried six recordings for 14 hours - ping before sending, drop it and connect anew, keep the draft, send again with the same id
        check(button.contains("if (!reachable(link)) throw new Unreachable(") && button.contains("link.alive(Resend.PING_MS)") && button.contains("link.reconnect();"));
        check(button.contains("catch (Unreachable error) {") && button.contains("waitForPc(text, link)") && button.contains("Nicht gesendet – dein PC ist nicht erreichbar.") && button.contains("Not sent – your PC is not reachable."));
        // no automatic retry: the link address does not name the PC (same origin, other PC behind the company proxy)
        check(!button.contains("resendNow") && !button.contains("resend.") && !button.contains("postDelayed(resend"));
        check(!button.contains("RECONNECT_MS") && !button.contains("Thread.sleep(1000)") && button.contains("link.reconnect();") && button.contains("private boolean reachable(UseLink link) throws InterruptedException {"));
        check(button.contains("post.clientIdFor(text);"));
        // 20.11. (Lukas #27): tapping send again after "not sent" carries the SAME client id, so a late buffered first send and the retry make one task
        TodoPost chg = new TodoPost();
        String c1 = chg.clientIdFor("Rufe Anna an");
        check(c1.equals(chg.clientIdFor(" Rufe Anna an ")) && c1.equals(chg.clientId())); // unchanged (spaces aside): the same id
        String c2 = chg.clientIdFor("Rufe Anna und Ben an");
        check(!c2.equals(c1) && c2.equals(chg.clientIdFor("Rufe Anna und Ben an")) && c2.equals(chg.clientId())); // changed text: a new id, then stable
        chg.add(new byte[] {1});
        String c3 = chg.clientIdFor("Rufe Anna und Ben an");
        check(!c3.equals(c2) && c3.equals(chg.clientIdFor("Rufe Anna und Ben an"))); // a new shot counts as a change
        chg.clear();
        check(!c3.equals(chg.clientIdFor("Rufe Anna und Ben an")));
        TodoPost adopted = new TodoPost();
        adopted.adopt("quick-9");
        check("quick-9".equals(adopted.clientIdFor("Hallo"))); // an adopted id survives its first Send
        TodoPost twice = new TodoPost();
        String first = (String) BubbleChat.send("ch_1", "Rufe Anna an", new java.util.ArrayList<>(), twice.clientId(), false).get("clientId");
        String again = (String) BubbleChat.send("ch_1", "Rufe Anna an", new java.util.ArrayList<>(), twice.clientId(), false).get("clientId");
        check(first.equals(again) && first.length() == "bubble:".length() + 36);
        // the id is dropped only when the task came back (draftSent), never in the failure branches of submit()
        int fail = button.indexOf("catch (Unreachable error) {");
        String failures = button.substring(fail, button.indexOf("private String[] deliver(") > fail ? button.indexOf("private String[] deliver(") : fail + 600);
        check(!failures.contains("post.clear()") && !failures.contains("clientId = null") && button.indexOf("post.clear();") > 0);
        check(link.contains("boolean alive(long ms)") && link.contains("void reconnect()") && link.contains("ws.close();"));
        check(!button.contains("PhoneRoutes") && button.contains("calling = new BubbleCall("));
    }

    private static Map<String, Object> map(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) map.put((String) pairs[i], pairs[i + 1]);
        return map;
    }

    private static String source(String path) throws Exception {
        return new String(Files.readAllBytes(Paths.get(System.getProperty("autark.android"), path)), StandardCharsets.UTF_8).replace("\r\n", "\n");
    }

    private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("Unexpected result " + assertions); }
}

