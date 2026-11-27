// Owns: executable checks of the to-do button's pure parts without a device – where it sits (TodoPlace: drag or tap,
// whole on the screen, the tab's side, the panel beside the dot and above the keyboard, the screenshot's size), what one
// post sends (TodoPost: at most six shots, one client id per post until it went through, the files.upload frame;
// BubbleChat: the chat line with the picture in the chat the person used last, never a to-do – task_cxs4s3pt) and the overlay's wiring read from its source (the AI's screenshot leaves
// the button out, the window never takes key focus – typing goes through BubbleTyping –, dictation is heard by the PC),
// and the plus menu (task_r0y9wcex: the input line [+] [text] [mic] [send], photo, audio sent as audio – never heard by a
// recognizer –, files from the phone within their limits, uploaded in pieces into the same chat line).
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
        uiLanguage();
        resend();
        wiring(source("app/src/main/java/com/teydralab/autark/android/phoneuse/TodoButton.java"),
                source("app/src/main/java/com/teydralab/autark/android/phoneuse/UseService.java"),
                source("app/src/main/java/com/teydralab/autark/android/phoneuse/UseLink.java"));
        attachments();
        plusWiring(source("app/src/main/java/com/teydralab/autark/android/phoneuse/TodoButton.java"),
                source("app/src/main/java/com/teydralab/autark/android/phoneuse/AudioNote.java"),
                source("app/src/main/java/com/teydralab/autark/android/phoneuse/BubblePick.java"),
                source("app/src/main/AndroidManifest.xml"));
        lockScreen();
        quickArea();
        controlWiring(source("app/src/main/java/com/teydralab/autark/android/phoneuse/TodoButton.java"),
                source("app/src/main/java/com/teydralab/autark/android/phoneuse/BubbleSettings.java"),
                source("app/src/main/AndroidManifest.xml"));
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

    private static void uiLanguage() throws Exception {
        // Owner 18.11.2026 ("Generell nichts in der App … standardmäßig nirgendwo"): the app's own words are German only
        // when the Autark profile says German – never because the phone is set to German
        check(SpeechLang.german("de") && SpeechLang.german("de-AT") && SpeechLang.german("de_DE") && SpeechLang.german(" DE "));
        check(!SpeechLang.german(null) && !SpeechLang.german("") && !SpeechLang.german("en") && !SpeechLang.german("en-DE")
                && !SpeechLang.german("Deutsch") && !SpeechLang.german("dex") && !SpeechLang.german("fr-CH"));
        String base = "app/src/main/java/com/teydralab/autark/android/";
        for (String file : new String[] {"CallNotice.java", "KeepAlive.java", "phoneuse/AskNotice.java", "phoneuse/BubbleCall.java",
                "phoneuse/BubblePick.java", "phoneuse/BubbleSettings.java", "phoneuse/Dictation.java", "phoneuse/TodoButton.java",
                "phoneuse/UseBubble.java", "phoneuse/UseDisclosure.java"}) {
            String text = source(base + file);
            check(text.contains("UiLang.german(") && !text.contains("Locale.getDefault().getLanguage()"));
        }
        String ui = source(base + "phoneuse/UiLang.java"), button = source(base + "phoneuse/TodoButton.java");
        // the stored profile language TodoButton keeps is the one UiLang reads; a fresh answer switches the bubble's words
        check(ui.contains("PLACE = \"todo_button\", KEY = \"speech_lang\"") && button.contains("getSharedPreferences(\"todo_button\"")
                && button.contains("putString(\"speech_lang\", found)") && button.contains("german = UiLang.german(found);"));
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
        check(button.contains("deliver(link, text, post, requiredPicture(picture), choice, wasLocked)")
                && button.contains("deliver(link, text, quick, requiredPicture(picture), choice, wasLocked)")
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
        check(button.contains("String[] chat = deliver(link, text, post, requiredPicture(picture), choice, wasLocked);") && button.contains("BubbleChat.send(target[0], body, attachments, from.clientId(), false)"));
        // task_cxs4s3pt: the bubble never makes a to-do – no tasks.quickCreate, the line goes to the chat ui.state names, no other is guessed
        check(!button.contains("tasks.quickCreate\"") && !button.contains("\"chats.direct\""));
        // chats.list only feeds the quick area (BubbleQuick), never the choice of the chat a line goes to
        String sendPath = button.substring(button.indexOf("private String[] deliver("), button.indexOf("private List<String[]> upload("));
        check(!sendPath.contains("chats.list") && button.split("\"chats.list\"", -1).length == 2 && button.substring(button.indexOf("private void loadQuick()"), button.indexOf("private void renderQuickLater()")).contains("\"chats.list\""));
        String target = button.substring(button.indexOf("private String[] chatTarget("), button.indexOf("private List<String[]> upload("));
        check(target.contains("answer(link, \"ui.state\"") && target.contains("answer(link, \"chats.get\"") && target.contains("throw new Failed(") && target.contains("Nicht gesendet – kein offener Chat"));
        String route = button.substring(button.indexOf("private String[] route("), button.indexOf("private void keepSaid("));
        check(route.contains("chatTarget(link)") && route.contains("BubbleChat.send(target[0], \"\", shots, post.clientId(), true)") && !route.contains("deliver("));
        check(button.contains("sentTo(chat)") && button.contains("BubbleChat.shotName(attachments.size() + 1)"));
        check(button.contains("HOLD_MS = 350") && button.contains("if (held) { holdRelease(); return true; }")); // the hold is the quick task
        // the only strings kept: the profile's language tag and the PC it came from (a value read from the PC belongs to that PC)
        check(!button.replace("putString(\"speech_lang\", found).putString(\"speech_lang_origin\", origin)", "").replace("putString(BubbleLock.KEY, value)", "").contains("putString(")
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
        check(!button.contains("PhoneRoutes.call(") && !button.contains("PhoneRoutes.task(") && button.contains("calling = new BubbleCall(")); // the call stays in the bubble; only the quick area opens the app
    }

    /**
     * task_r0y9wcex (owner 24.11.2026): the plus menu's files – a photo, an audio recording sent as audio and files from the
     * phone – join the draft within their limits, go up in pieces and stand in the same chat line as the shots.
     */
    private static void attachments() {
        TodoPost post = new TodoPost();
        check(post.bare() && post.files().isEmpty());
        TodoPost.Item photo = new TodoPost.Item(TodoPost.Item.PHOTO, "/c/photo-1.jpg", BubbleChat.photoName(1), "image/jpeg", 400_000, 0);
        TodoPost.Item audio = new TodoPost.Item(TodoPost.Item.AUDIO, "/c/audio-1.m4a", BubbleChat.audioName(12_000, 1), "audio/mp4", 140_000, 12_000);
        TodoPost.Item file = new TodoPost.Item(TodoPost.Item.FILE, "/c/file-1.bin", BubbleChat.fileName("Rechnung März.pdf", 1), null, 2_000_000, 0);
        String before = post.clientIdFor("Schau mal");
        check(post.attach(photo) == null && post.attach(audio) == null && post.attach(file) == null);
        check(!post.bare() && post.files().equals(Arrays.asList(photo, audio, file)) && post.shots().isEmpty()); // files are not shots: the six-shot limit stays theirs
        check("application/octet-stream".equals(file.mime) && post.count(TodoPost.Item.AUDIO) == 1 && post.count(TodoPost.Item.FILE) == 1);
        check(!before.equals(post.clientIdFor("Schau mal"))); // a new file is a changed draft: a new line, not the first one's answer
        post.detach(audio);
        check(post.files().equals(Arrays.asList(photo, file)) && post.count(TodoPost.Item.AUDIO) == 0);
        // the limits: a file at most 50 MB, at most 100 MB together, at most FILES_MAX – a refused one changes nothing
        check(TodoPost.TOO_BIG.equals(post.attach(new TodoPost.Item(TodoPost.Item.FILE, "/c/big", "big.mp4", "video/mp4", TodoPost.FILE_MAX_BYTES + 1, 0))));
        check(post.attach(new TodoPost.Item(TodoPost.Item.FILE, "/c/a", "a.mp4", "video/mp4", TodoPost.FILE_MAX_BYTES, 0)) == null);
        check(TodoPost.TOO_MUCH.equals(post.attach(new TodoPost.Item(TodoPost.Item.FILE, "/c/b", "b.mp4", "video/mp4", TodoPost.FILE_MAX_BYTES, 0))));
        TodoPost many = new TodoPost();
        for (int i = 0; i < TodoPost.FILES_MAX; i++) check(many.attach(new TodoPost.Item(TodoPost.Item.FILE, "/c/" + i, "f" + i, "text/plain", 10, 0)) == null);
        check(TodoPost.TOO_MANY.equals(many.attach(new TodoPost.Item(TodoPost.Item.FILE, "/c/x", "x", "text/plain", 10, 0))) && many.files().size() == TodoPost.FILES_MAX);
        check(many.add(new byte[] {1})); // shots keep their own room
        many.clear();
        check(many.bare() && many.files().isEmpty() && many.shots().isEmpty()); // sent: the next line starts empty

        // the names the agent reads
        check("Photo taken with the phone camera.jpg".equals(BubbleChat.photoName(1)) && "Photo taken with the phone camera (2).jpg".equals(BubbleChat.photoName(2)));
        check("Audio recording, 12 s.m4a".equals(BubbleChat.audioName(12_000, 1)) && "Audio recording (2), 1 min 5 s.m4a".equals(BubbleChat.audioName(65_000, 2)));
        check("Audio recording, 3 min.m4a".equals(BubbleChat.audioName(180_000, 1)) && "Audio recording, 1 s.m4a".equals(BubbleChat.audioName(200, 1)));
        check("Rechnung März.pdf".equals(BubbleChat.fileName("Rechnung März.pdf", 1)) && "File".equals(BubbleChat.fileName(null, 1)) && "File (3)".equals(BubbleChat.fileName("  ", 3)));
        check("b_c.txt".equals(BubbleChat.fileName("a/b\u0001c.txt", 1)) && "passwd".equals(BubbleChat.fileName("../../etc/passwd", 1)) && "b".equals(BubbleChat.fileName("a\\b", 1))
                && "File".equals(BubbleChat.fileName("x/..", 1)));
        String longName = BubbleChat.fileName("x".repeat(300) + ".pdf", 1);
        check(longName.length() == 120 && longName.endsWith(".pdf"));
        check("0:07".equals(BubbleChat.clock(7_400)) && "12:30".equals(BubbleChat.clock(750_000)) && "0:00".equals(BubbleChat.clock(-5)));

        // the pieces: files.uploadChunk frames of CHUNK bytes, the last one final; the id in the PC's form
        check(TodoPost.chunks(0) == 1 && TodoPost.chunks(1) == 1 && TodoPost.chunks(TodoPost.CHUNK) == 1 && TodoPost.chunks(TodoPost.CHUNK + 1L) == 2 && TodoPost.chunks(TodoPost.FILE_MAX_BYTES) == 50);
        String uploadId = TodoPost.uploadId();
        check(uploadId.matches("up_[0-9a-z]{8,40}") && !uploadId.equals(TodoPost.uploadId()));
        Map<String, Object> first = TodoPost.chunk(uploadId, 0, new byte[] {1, 2, 3, 4}, 4, false, audio);
        check(first.keySet().equals(new java.util.LinkedHashSet<>(Arrays.asList("uploadId", "index", "dataBase64", "name", "mime"))));
        check(uploadId.equals(first.get("uploadId")) && Integer.valueOf(0).equals(first.get("index")) && "audio/mp4".equals(first.get("mime")) && audio.name.equals(first.get("name")));
        Map<String, Object> last = TodoPost.chunk(uploadId, 1, new byte[] {9, 8, 7, 6}, 2, true, audio);
        check(Boolean.TRUE.equals(last.get("final")) && Arrays.equals(Base64.getDecoder().decode((String) last.get("dataBase64")), new byte[] {9, 8}));
        check("".equals(TodoPost.chunk(uploadId, 0, new byte[1], 0, true, file).get("dataBase64"))); // an empty file: one empty final piece
        // the recording is sent as sound: its frame names no language, no transcription, no text
        check(!first.containsKey("language") && !first.containsKey("transcribe") && !first.containsKey("text"));

        // Send: the words, the shots, then the files – one line in the chat, in that order
        List<String[]> files = new ArrayList<>();
        files.add(new String[] {"f_shot", BubbleChat.shotName(1)});
        files.add(new String[] {"f_audio", audio.name});
        files.add(new String[] {"f_doc", file.name});
        Map<String, Object> line = BubbleChat.send("ch_1", "", files, "cid", false);
        check(line.get("attachments").equals(Arrays.asList(map("fileId", "f_shot", "name", BubbleChat.shotName(1)),
                map("fileId", "f_audio", "name", "Audio recording, 12 s.m4a"), map("fileId", "f_doc", "name", "Rechnung März.pdf"))));
        check("".equals(line.get("body")) && !line.containsKey("silent")); // files alone are a line too
    }

    /** The plus menu's wiring, read from the sources: the input line, audio never heard by a recognizer, Send while dictating or recording. */
    private static void plusWiring(String button, String note, String pick, String manifest) {
        String panel = button.substring(button.indexOf("private LinearLayout makePanel()"), button.indexOf("private ImageView icon("));
        // the input line as in a chat: [+] [text] [mic] [send], send on the right; call and collapse above it
        int plusAt = panel.indexOf("R.drawable.ic_todo_plus"), fieldAt = panel.indexOf("input.addView(field"), micAt = panel.indexOf("R.drawable.ic_todo_mic"), sendAt = panel.indexOf("R.drawable.ic_todo_send");
        check(plusAt > 0 && plusAt < fieldAt && fieldAt < micAt && micAt < sendAt && panel.indexOf("menu = makeMenu()") < plusAt);
        check(panel.indexOf("R.drawable.ic_todo_call") < plusAt && !panel.contains("R.drawable.ic_todo_camera")); // the screenshot moved into the menu
        String menu = button.substring(button.indexOf("private LinearLayout makeMenu()"), button.indexOf("private View menuItem("));
        check(menu.contains("R.drawable.ic_todo_camera, \"Screenshot\"") && menu.contains("this::shoot") && menu.contains("this::takePhoto")
                && menu.contains("this::recordAudio") && menu.contains("this::pickFiles") && menu.contains("Build.VERSION.SDK_INT >= 30"));
        // audio is sent as audio: neither the recorder nor its path in the button transcribes
        String audio = button.substring(button.indexOf("private void recordAudio()"), button.indexOf("/** Open the draft without"));
        check(audio.contains("new AudioNote(service,") && audio.contains("post.attach(item)") && audio.contains("TodoPost.Item.AUDIO"));
        check(!audio.contains("new Dictation(") && !audio.contains("voice.transcribe") && !audio.contains("hearing()") && !audio.contains("SpokenAudio.transcribe"));
        check(!note.contains("voice.transcribe") && !note.contains("Dictation") && !note.contains("hearing") && note.contains("AudioSource.MIC") && note.contains("checkSelfPermission(Manifest.permission.RECORD_AUDIO)"));
        String upload = button.substring(button.indexOf("private List<String[]> uploadFiles("), button.indexOf("private static int readFully("));
        check(upload.contains("\"files.uploadChunk\"") && upload.contains("TodoPost.chunk(uploadId, index, piece, length, index == count - 1, item)") && !upload.contains("voice.transcribe"));
        // the files go with the words into the same chat line (and with a call's shots), and go from the phone once sent
        check(button.contains("attachments.addAll(uploadFiles(link, from.files()));") && button.contains("shots.addAll(uploadFiles(link, post.files()));"));
        String sent = button.substring(button.indexOf("private void draftSent()"), button.indexOf("// ------------------------------------------------------------------ the call in the bubble"));
        check(sent.contains("new File(item.path).delete()") && sent.indexOf("new File(item.path).delete()") < sent.indexOf("post.clear()"));
        // Send while audio records attaches it first; Send while dictating still waits for the words
        String sendTap = button.substring(button.indexOf("private void submit()"), button.indexOf("private void submit(String"));
        check(sendTap.indexOf("stopAudio(true)") < sendTap.indexOf("captureAtSend()") && sendTap.contains("post.bare()") && sendTap.contains("sendAfter = picture;"));
        check(button.contains("(words.isEmpty() && post.bare())"));
        // one microphone at a time: dictation and the call end a recording first; collapsing attaches it
        check(button.substring(button.indexOf("private void dictate()"), button.indexOf("private void finishDictation()")).contains("stopAudio(true)"));
        check(button.substring(button.indexOf("private void collapse()"), button.indexOf("private void say(")).contains("stopAudio(true)"));
        check(button.substring(button.indexOf("private void call()"), button.indexOf("private String[] route(")).contains("stopAudio(true)"));
        // the hold stays the quick task (Felix' fix, task_sxq1nz2b): it records with Dictation and takes the page on release
        String hold = button.substring(button.indexOf(" holdStart() {"), button.indexOf("void holdRelease()"));
        check(hold.contains("look != Look.DOT") && !hold.contains("AudioNote") && !hold.contains("BubblePick"));
        // the photo and the files come through the invisible activity, which phone use passes over like the typing window
        check(button.contains("BubblePick.photo(service, dp(THUMB_DP), this::picked)") && button.contains("BubblePick.files(service, dp(THUMB_DP), this::picked)"));
        check(pick.contains("at.width = BubbleTyping.SIZE;") && pick.contains("MediaStore.ACTION_IMAGE_CAPTURE") && pick.contains("Intent.ACTION_OPEN_DOCUMENT")
                && pick.contains("requestPermissions(new String[] { Manifest.permission.CAMERA }") && pick.contains("TodoPost.FILE_MAX_BYTES"));
        check(manifest.contains("android:name=\".phoneuse.BubblePick\" android:exported=\"false\"") && !manifest.contains("READ_EXTERNAL_STORAGE") && !manifest.contains("READ_MEDIA_"));
    }

    /**
     * task_r0y9wcex, stage 3 (owner 24.11.2026): the bubble on the lock screen – Off, On, or On with a note to the AI
     * ("theoretisch könnte das nicht der User sein"); Off until the person chose.
     */
    private static void lockScreen() {
        // the stored values; anything else is not chosen and counts as Off
        check(BubbleLock.OFF.equals(BubbleLock.mode(null)) && BubbleLock.OFF.equals(BubbleLock.mode("")) && BubbleLock.OFF.equals(BubbleLock.mode("ON")));
        check(BubbleLock.ON.equals(BubbleLock.mode("on")) && BubbleLock.NOTE.equals(BubbleLock.mode("note")) && BubbleLock.OFF.equals(BubbleLock.mode("off")));
        check(!BubbleLock.chosen(null) && !BubbleLock.chosen("maybe") && BubbleLock.chosen("off") && BubbleLock.chosen("on") && BubbleLock.chosen("note"));
        // unlocked the bubble is always there, whatever the choice; locked only in On and On with a note
        for (String any : new String[] {null, "off", "on", "note", "x"}) check(BubbleLock.shows(any, false) && !BubbleLock.noted(any, false) && BubbleLock.calls(any, false));
        check(!BubbleLock.shows(null, true) && !BubbleLock.shows("off", true) && BubbleLock.shows("on", true) && BubbleLock.shows("note", true));
        // the note only while locked and only in On with a note; a call from the lock screen needs plain On
        check(BubbleLock.noted("note", true) && !BubbleLock.noted("on", true) && !BubbleLock.noted("off", true) && !BubbleLock.noted(null, true));
        check(BubbleLock.calls("on", true) && !BubbleLock.calls("note", true) && !BubbleLock.calls("off", true) && !BubbleLock.calls(null, true));
        // the body: the words unchanged without the note; with it the note below them, for the agent
        check("Ruf Anna an".equals(BubbleLock.body("Ruf Anna an", false)) && "".equals(BubbleLock.body(null, false)));
        String noted = BubbleLock.body("Ruf Anna an", true);
        check(noted.startsWith("Ruf Anna an\n\n") && noted.endsWith("_(" + BubbleLock.NOTE_TEXT + ")_"));
        check(BubbleLock.body("  ", true).equals("_(" + BubbleLock.NOTE_TEXT + ")_") && BubbleLock.body(null, true).equals("_(" + BubbleLock.NOTE_TEXT + ")_")); // only shots: the note alone
        check(BubbleLock.NOTE_TEXT.contains("lock screen") && BubbleLock.NOTE_TEXT.contains("may not be the owner") && BubbleLock.NOTE_TEXT.contains("nothing bad can come of it"));
        // the line a noted send makes: the note in the body, the frame otherwise the same
        Map<String, Object> line = BubbleChat.send("ch_1", BubbleLock.body("Wie spät?", BubbleLock.noted("note", true)), new ArrayList<>(), "cid", false);
        check(((String) line.get("body")).contains(BubbleLock.NOTE_TEXT) && line.keySet().equals(new java.util.LinkedHashSet<>(Arrays.asList("conversationId", "body", "clientId"))));
        check(!((String) BubbleChat.send("ch_1", BubbleLock.body("Wie spät?", BubbleLock.noted("note", false)), new ArrayList<>(), "cid", false).get("body")).contains("lock screen"));
        // the words, both languages, in the order shown; the quick area's row names the choice
        check(Arrays.equals(BubbleLock.ORDER, new String[] {"off", "on", "note"}));
        check("Aus".equals(BubbleLock.label("off", true)) && "On".equals(BubbleLock.label("on", false)) && BubbleLock.label("note", true).contains("Hinweis an die KI")
                && BubbleLock.label("note", false).contains("note to the AI") && "Off".equals(BubbleLock.label(null, false)));
        check(BubbleLock.row(null, true).equals("Sperrbildschirm: Aus") && BubbleLock.row("note", false).equals("Lock screen: On + note")
                && BubbleLock.row("note", true).equals("Sperrbildschirm: An + Hinweis") && BubbleLock.row("on", true).equals("Sperrbildschirm: An"));
        // S9 check 27.11.2026: the row fits the 264 dp panel (its › cut off with the long label) – every row short
        for (String value : BubbleLock.ORDER) for (boolean german : new boolean[] {true, false}) check(BubbleLock.row(value, german).length() <= 30);
        check(BubbleLock.brief("note", true).equals("An + Hinweis") && BubbleLock.brief("off", false).equals(BubbleLock.label("off", false)));
        for (String value : BubbleLock.ORDER) check(!BubbleLock.explain(value, true).isEmpty() && !BubbleLock.explain(value, false).isEmpty() && !BubbleLock.explain(value, true).equals(BubbleLock.explain(value, false)));
        check(!BubbleLock.readable(true) && BubbleLock.readable(false)); // a locked phone shows no message words
    }

    /** task_r0y9wcex, stage 2: the quick area's choice from chats.list and messages.list, without a device. */
    private static void quickArea() {
        List<Object> list = Arrays.asList(
                map("id", "ch_old", "title", "Rechnungen", "importantUnread", 1.0, "lastMessageAt", 100.0, "lastPreview", map("authorId", "ag_a", "text", "alt", "at", 100.0)),
                map("id", "ch_none", "title", "Ruhig", "unread", 4.0, "lastMessageAt", 900.0),
                map("id", "ch_new", "title", "Felix", "importantUnread", 2.0, "lastMessageAt", 500.0, "lastPreview", map("authorId", "ag_f", "text", "neu", "at", 800.0)),
                map("id", "ch_arch", "title", "Archiv", "importantUnread", 3.0, "archivedAt", 5.0, "lastMessageAt", 999.0),
                map("id", "ch_mid", "title", "", "importantUnread", 1.0, "lastMessageAt", 300.0),
                map("id", "ch_low", "title", "Lena", "importantUnread", 1.0, "lastMessageAt", 50.0),
                "kaputt", map("title", "ohne id", "importantUnread", 1.0));
        List<BubbleQuick.Chat> chats = BubbleQuick.chats(list);
        // only chats with important unread lines, not archived, newest first (the preview's time counts), at most MAX
        check(chats.size() == BubbleQuick.MAX && "ch_new".equals(chats.get(0).id) && "ch_mid".equals(chats.get(1).id) && "ch_old".equals(chats.get(2).id));
        check(chats.get(0).important == 2 && "Felix".equals(chats.get(0).title) && "neu".equals(chats.get(0).preview));
        check(BubbleQuick.count(list) == 6); // every chat's important unread lines (1 + 2 + 1 + 1 + 1), the archived one's not
        check(BubbleQuick.chats(null).isEmpty() && BubbleQuick.chats(map("x", 1)).isEmpty() && BubbleQuick.count("x") == 0);
        // the newest important line someone else wrote: not the person's own, no silent, status or streaming line
        List<Object> messages = Arrays.asList(
                map("seq", 10.0, "priority", "important", "authorKind", "agent", "kind", "text", "state", "final", "silent", false, "body", "Älter **wichtig**"),
                map("seq", 12.0, "priority", "important", "authorKind", "agent", "kind", "text", "state", "final", "silent", false, "body", "Neuer: [Bericht](https://x.y) ist da"),
                map("seq", 13.0, "priority", "important", "authorKind", "human", "kind", "text", "state", "final", "body", "meins"),
                map("seq", 14.0, "priority", "important", "authorKind", "agent", "kind", "status", "state", "final", "body", "Status"),
                map("seq", 15.0, "priority", "important", "authorKind", "agent", "kind", "text", "state", "streaming", "body", "schreibt"),
                map("seq", 16.0, "priority", "normal", "authorKind", "agent", "kind", "text", "state", "final", "body", "normal"),
                map("seq", 17.0, "priority", "important", "authorKind", "agent", "kind", "text", "state", "final", "silent", true, "body", "leise"));
        check("Neuer: [Bericht](https://x.y) ist da".equals(BubbleQuick.newest(messages)) && BubbleQuick.newest(Arrays.asList(messages.get(5))) == null && BubbleQuick.newest(null) == null);
        // one line: no Markdown, no code blocks, no line breaks, cut at LINE_MAX
        check("Neuer: Bericht ist da".equals(BubbleQuick.line(BubbleQuick.newest(messages))));
        check("Titel Punkt eins fett".equals(BubbleQuick.line("# Titel\n- Punkt eins\n\n**fett**")));
        check("Vorher nachher".equals(BubbleQuick.line("Vorher\n```ui\n{\"type\":\"table\"}\n```\nnachher")) && "".equals(BubbleQuick.line(null)));
        String longLine = BubbleQuick.line("wort ".repeat(100));
        check(longLine.length() == BubbleQuick.LINE_MAX && longLine.endsWith("…"));
        // the row: title · words; without words the preview; without a title the words alone
        check("Felix · Neuer: Bericht ist da".equals(BubbleQuick.row(chats.get(0), BubbleQuick.newest(messages))));
        check("Felix · neu".equals(BubbleQuick.row(chats.get(0), null)) && "Ruhig".equals(BubbleQuick.row(new BubbleQuick.Chat("c", "Ruhig", 1, 0, null), null)));
        check("x".equals(BubbleQuick.row(new BubbleQuick.Chat("c", "", 1, 0, null), "x")));
        // the lock screen: how many, never the words
        check(BubbleQuick.waiting(0, true).equals("Nichts Wichtiges ungelesen.") && BubbleQuick.waiting(1, false).startsWith("1 important message") && BubbleQuick.waiting(3, true).startsWith("3 wichtige Nachrichten"));
        // the places a tap opens are the phone UI's own
        check("#/chat/ch_new".equals(com.teydralab.autark.android.PhoneRoutes.chat("ch_new")) && com.teydralab.autark.android.PhoneRoutes.chat("a b") == null);
    }

    /** The quick area's and the lock screen's wiring, read from the sources. */
    private static void controlWiring(String button, String settings, String manifest) {
        // the bubble goes on the lock screen unless the choice lets it stay; the broadcasts and the setting's change re-check
        check(button.contains("BubbleLock.shows(lockChoiceNow(), locked)") && button.contains("Intent.ACTION_SCREEN_OFF") && button.contains("Intent.ACTION_USER_PRESENT")
                && button.contains("keyguard.isKeyguardLocked()") && button.contains("!power.isInteractive()") && button.contains("registerOnSharedPreferenceChangeListener(lockChoice)")
                && button.contains("unregisterReceiver(lockChanged)") && button.contains("unregisterOnSharedPreferenceChangeListener(lockChoice)"));
        // the note: decided when the person sends (panel and hold), put into the body only through BubbleLock
        String deliver = button.substring(button.indexOf("private String[] deliver("), button.indexOf("private String[] chatTarget("));
        check(deliver.contains("if (!BubbleLock.shows(choice, wasLocked)) throw new Failed(") && deliver.contains("BubbleLock.body(text, BubbleLock.noted(choice, wasLocked))")
                && deliver.indexOf("BubbleLock.shows(") < deliver.indexOf("chatTarget(link)"));
        check(button.split("boolean wasLocked = locked\\(\\);", -1).length == 3 + 1); // submit, the hold and openRoute
        String call = button.substring(button.indexOf("private void call()"), button.indexOf("private String[] route("));
        check(call.indexOf("BubbleLock.calls(lockChoiceNow(), locked())") >= 0 && call.indexOf("BubbleLock.calls(") < call.indexOf("new BubbleCall("));
        // the first opening asks once, never while locked; a choice in the panel only unlocked
        String open = button.substring(button.indexOf("private void open()"), button.indexOf("private void collapse()"));
        check(open.contains("!BubbleLock.chosen(lockChoiceNow()) && !place.getBoolean(BubbleLock.ASKED, false) && !locked()") && open.contains("putBoolean(BubbleLock.ASKED, true)"));
        check(button.substring(button.indexOf("private void chooseLock("), button.indexOf("private void grow(")).contains("if (locked()) return;"));
        // the quick area: its own thread, only the phone's chat calls, the words only unlocked, a tap opens the app's place
        String load = button.substring(button.indexOf("private void loadQuick()"), button.indexOf("private void renderQuickLater()"));
        check(load.contains("quickWork.execute(") && load.contains("\"chats.list\"") && load.contains("\"messages.list\"") && load.contains("if (readable)")
                && load.contains("BubbleLock.readable(locked())") && load.contains("round != quickRound") && !load.contains("messages.send") && !load.contains("work.execute"));
        String render = button.substring(button.indexOf("private void renderQuick()"), button.indexOf("private TextView quickHeading("));
        check(render.contains("PhoneRoutes.chat(row[0])") && render.contains("openRoute(\"#/tasks\")") && render.contains("this::lockSettings") && render.contains("!quickReadable"));
        // S9 check 27.11.2026: Tasks and the lock-screen row keep their › – it is its own view, only the words are cut
        check(render.contains("quickLink(german ? \"Aufgaben\" : \"Tasks\"") && render.contains("quickLink(BubbleLock.row(") && !render.contains("›"));
        String link = button.substring(button.indexOf("private LinearLayout quickLink("), button.indexOf("private void openRoute("));
        check(link.contains("new LinearLayout.LayoutParams(0, -2, 1)") && link.contains("quickRow(\"›\"") && link.contains("new LinearLayout.LayoutParams(-2, -2)"));
        // S9 check 27.11.2026: the panel is opaque – the home screen showed through behind + and the field
        String panel = button.substring(button.indexOf("private LinearLayout makePanel()"), button.indexOf("private LinearLayout makeAsk()"));
        check(button.contains("PANEL_BG = Color.rgb(") && button.contains("FIELD_BG = Color.rgb(") && panel.contains("background.setColor(PANEL_BG)")
                && panel.contains("box.setColor(FIELD_BG)") && !panel.contains("setAlpha(") && !panel.contains("background.setColor(BG)"));
        // S9 check 27.11.2026: One UI names the App info entry "In-App notification settings" – the question names only the arrow
        String askText = button.substring(button.indexOf("private LinearLayout makeAsk()"), button.indexOf("private void chooseLock("));
        check(askText.contains("über den Pfeil oben in der Blase.\"") && askText.contains("with the arrow at the top of the bubble.\"")
                && !askText.contains("App-Info") && !askText.contains("App info"));
        check(manifest.contains("android.intent.action.APPLICATION_PREFERENCES")); // the entry itself stays
        check(button.contains("R.drawable.ic_todo_up") && button.contains("this::toggleQuick") && button.contains("putExtra(PhoneRoutes.EXTRA, route)"));
        check(button.substring(button.indexOf("private void lockSettings()"), button.indexOf("private ImageView icon(")).contains("if (locked())"));
        // the settings dialog: the App info entry, nothing changes while locked
        check(manifest.contains("android:name=\".phoneuse.BubbleSettings\" android:exported=\"true\"") && manifest.contains("android.intent.action.APPLICATION_PREFERENCES"));
        check(settings.contains("keyguard.isKeyguardLocked()") && settings.indexOf("isKeyguardLocked()") < settings.indexOf("putString(BubbleLock.KEY")
                && settings.contains("setSingleChoiceItems(") && settings.contains("BubbleLock.ORDER[which]"));
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

