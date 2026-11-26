// Owns: the app's own second socket to the PC (B-078, D6) – /ws through the same local entrance as the WebView (its gate
// cookie, this phone's token), so it lives as long as the phone's connection, also while the app is in the background.
// It calls phoneUse.attach (model, screen, whether phone use is on – again whenever that changes) and keeps the list of
// my PCs the answer brings (the connection then pins all of them), hears phoneUse.request for this device only and
// answers each with phoneUse.reply – one step at a time, on a thread of its own (StepThread), with the request's agent
// (`by`) for the bubble; the AI's question (say with ask) holds the next steps until it is answered. Every attach goes there too:
// a change arrives on Android's main thread (service on/off, the disclosure's "Agree"), which may not write to a socket
// (10.11.2026). Hello and subscribe go out before a listener can see the socket, so attach never comes before them.
// When phone use is off it answers 'off' and shows the enable notification; a build without phone use offers its
// phone-use build instead (PhoneUseUpgrade).
// The PC's 'notify' events on the same subscription become the app's own notifications (AppNotices, B-084).
// It also carries the to-do button's own calls (TodoButton: files.upload, ui.state, chats.get, messages.send) – call()
// sends one request and hands its {id, result} / {id, error:{message}} to the caller's Answer; a socket that ends fails
// every call still waiting; request() is the same, waited for on the caller's thread. The link that runs is linked() (one
// per paired company; the to-do button shows while one does). The bubble's call (BubbleCall) listens to the events of
// the chat topic it subscribed (listen(): every event frame besides the two above, and the socket's end).
// A notice of the app sends its answer over the same link without waiting for one (the static call: CallNotice's calls.decline).
// Reconnects with backoff (2 s … 60 s) after the socket ended or never came up; the backoff starts again at 2 s only
// after a connection brought an attach answer.
// Never: acts on a request for another device, or keeps a step beyond its answer.
package com.teydralab.autark.android.phoneuse;

import android.content.Context;
import android.os.Build;
import android.util.DisplayMetrics;
import com.teydralab.autark.android.AppNotices;
import com.teydralab.autark.android.PhoneUseUpgrade;
import com.teydralab.autark.android.relay.Json;
import com.teydralab.autark.android.relay.PhoneConnection;
import com.teydralab.autark.android.relay.StreamProxy;
import com.teydralab.autark.android.relay.WebSocketClient;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

public final class UseLink implements WebSocketClient.Listener {
    /** The PCs of the company arrived (phoneUse.attach). */
    public interface Pcs { void changed(List<PhoneConnection.Pc> pcs); }

    /** The answer to one call(): exactly one of the two, on the socket's reader thread (or the caller's when nothing went out). */
    public interface Answer {
        void result(Object result);
        void error(String message);
    }

    /** The events of a topic the bubble's call subscribed, and the socket's end – on the socket's reader thread. */
    interface Events {
        void event(String name, Map<String, Object> data);
        void closed();
    }

    /** request()'s failure: the PC's message, or none when it did not answer in time (`late`). */
    static final class Refused extends Exception {
        final boolean late;
        Refused(String message, boolean late) { super(message); this.late = late; }
    }

    /** What a call hears when this phone has no socket to the PC right now, or the socket ended before the answer. */
    static final String UNLINKED = "Not connected to your PC right now.";
    private static volatile UseLink linked;
    private static volatile Runnable linkChanged;

    private static final long[] BACKOFF_MS = { 2_000, 5_000, 15_000, 30_000, 60_000 };
    private final Context context;
    private final String origin;
    private final String gate;
    private final String token;
    private final String deviceId;
    /** The phone's Ed25519 device key (the pairing key): signs voice.planLogin's proof. */
    private final byte[] seed;
    /** The last proof's `at`: each one rises (the PC takes a proof once). */
    private long proofAt;
    private final Pcs pcs;
    private final StepThread steps = new StepThread((line) -> android.util.Log.w("autark", line));
    /** My listener for the service turning on or off (one object, so stop() drops exactly mine). */
    private final Runnable onService = this::changed;
    private final AtomicInteger ids = new AtomicInteger(1);
    private final Object lock = new Object();
    private volatile WebSocketClient socket;
    private volatile int attachId = -1;
    private volatile boolean stopped;
    /** Counts ended sockets (closed() on the reader thread); guarded by lock. */
    private long closes;
    /** The current socket's attach answer arrived. */
    private volatile boolean answered;
    private Thread worker;
    /** call()'s requests still waiting for their answer, by frame id. */
    private final Map<Integer, Answer> calls = new ConcurrentHashMap<>();
    private volatile Events events;

    /** The PC this link goes to (its address, no secret): what a value read from the PC belongs to. */
    String origin() { return origin; }

    /** The running link of the paired company, or null (not paired, or between two companies). */
    public static UseLink linked() { return linked; }

    /** `listener` hears (any thread) when linked() changes – the to-do button shows or goes. */
    public static void onLinked(Runnable listener) { linkChanged = listener; }

    private static void tellLinked() {
        Runnable listener = linkChanged;
        if (listener != null) listener.run();
    }

    public UseLink(Context context, String origin, String gate, String token, String deviceId, byte[] seed, Pcs pcs) {
        this.context = context.getApplicationContext();
        this.origin = origin; this.gate = gate; this.token = token; this.deviceId = deviceId; this.seed = seed; this.pcs = pcs;
    }

    private synchronized long nextProofAt() {
        proofAt = Math.max(System.currentTimeMillis(), proofAt + 1);
        return proofAt;
    }

    public void start() {
        UseService.onChange(onService);
        worker = new Thread(this::run, "autark-phone-use");
        worker.setDaemon(true);
        worker.start();
        linked = this;
        tellLinked();
    }

    /** Any thread (a company switch stops the old link on a thread of its own, CompanyLink.stop). */
    public void stop() {
        stopped = true;
        UseService.dropChange(onService);
        WebSocketClient ws = socket;
        if (ws != null) ws.close();
        synchronized (lock) { lock.notifyAll(); }
        steps.stop();
        failCalls();
        if (linked == this) { linked = null; tellLinked(); }
    }

    /** One request to the PC with this phone's rights (a thread of the caller's own, never the main one: it writes the
     *  socket); `answer` hears its result or error once. */
    public void call(String method, Map<String, Object> params, Answer answer) {
        WebSocketClient ws = socket;
        if (ws == null || stopped) { answer.error(UNLINKED); return; }
        int id = ids.getAndIncrement();
        calls.put(id, answer);
        send(ws, Json.map("id", id, "method", method, "params", params));
        // The socket ended meanwhile (its close may have failed the waiting calls before this one was in the map).
        if (socket != ws) { Answer left = calls.remove(id); if (left != null) left.error(UNLINKED); }
    }

    /** call(), waited for on this (non-main) thread at most `ms`: the result, or Refused. */
    Object request(String method, Map<String, Object> params, long ms) throws Refused, InterruptedException {
        java.util.concurrent.atomic.AtomicReference<Object> result = new java.util.concurrent.atomic.AtomicReference<>();
        java.util.concurrent.atomic.AtomicReference<String> error = new java.util.concurrent.atomic.AtomicReference<>();
        java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
        call(method, params, new Answer() {
            @Override public void result(Object value) { result.set(value); done.countDown(); }
            @Override public void error(String message) { error.set(message); done.countDown(); }
        });
        if (!done.await(ms, java.util.concurrent.TimeUnit.MILLISECONDS)) throw new Refused(null, true);
        if (error.get() != null) throw new Refused(error.get(), false);
        return result.get();
    }

    /** STIMME 21.11.2026: the phone's own dictation hearing (PlanHearing) with the plan login this PC hands to this phone
     *  (voice.planLogin, proven with the device key `seed` – only this native side has it; `fresh` after the plan refused
     *  the copy). */
    public PlanHearing hearing() {
        return PlanHearing.of(new PlanHearing.Pc() {
            @Override public Map<String, Object> login(String language, boolean fresh) throws PlanHearing.Missed, InterruptedException {
                Map<String, Object> params = PlanHearing.loginParams(seed, deviceId, nextProofAt(), language, fresh);
                Object answer;
                try { answer = request("voice.planLogin", params, fresh ? PlanHearing.FRESH_MS : PlanHearing.LOGIN_MS); }
                catch (Refused refused) { throw new PlanHearing.Missed(refused.late ? "the PC did not answer" : "the PC gives no plan login"); }
                if (!(answer instanceof Map)) throw new PlanHearing.Missed("no login");
                @SuppressWarnings("unchecked") Map<String, Object> map = (Map<String, Object>) answer;
                return map;
            }
            @Override public String place() { return origin; }
        });
    }

    /** Whether the PC answers within `ms` (on a non-main thread): any answer, also a refusal of an older PC, shows a living socket;
     *  no answer, or no socket, does not. The socket has no keep-alive of its own, so one half dead after a network change says nothing. */
    boolean alive(long ms) throws InterruptedException {
        try { request("todos.speechLanguage", Json.map(), ms); return true; }
        catch (Refused refused) { return Resend.provesAlive(refused.late, refused.getMessage()); }
    }

    /** Ends the current socket (a half dead one): run() connects anew within its first backoff. */
    void reconnect() {
        WebSocketClient ws = socket;
        if (ws != null) ws.close();
    }

    /** `listener` hears the event frames and the socket's end from now on (one at a time: the bubble's call). */
    void listen(Events listener) { events = listener; }

    /** Stops `listener` – only while it is still the one. */
    void unlisten(Events listener) { if (events == listener) events = null; }

    private void failCalls() {
        for (Integer id : new java.util.ArrayList<>(calls.keySet())) {
            Answer left = calls.remove(id);
            if (left != null) left.error(UNLINKED);
        }
    }

    private void run() {
        int attempt = 0;
        while (!stopped) {
            try {
                long seen;
                synchronized (lock) { seen = closes; answered = false; }
                WebSocketClient ws = WebSocketClient.connect(origin.replaceFirst("^http", "ws") + "/ws", this, "Cookie: " + StreamProxy.GATE_COOKIE + "=" + gate + "\r\n");
                send(ws, Json.map("protocol", 1, "token", token, "client", "pwa", "deviceName", model()));
                send(ws, Json.map("id", ids.getAndIncrement(), "method", "events.subscribe", "params", Json.map("topics", java.util.Collections.singletonList("system"))));
                // The reader runs already: a close that came before this line is counted in `closes`, never lost.
                synchronized (lock) { if (closes == seen) socket = ws; }
                if (socket == ws) steps.post(() -> attach(ws));
                synchronized (lock) {
                    while (!stopped && closes == seen) lock.wait(60_000);
                    if (socket == ws) socket = null;
                }
                // A PC that accepts the socket and then closes it (unknown token, not on its roster yet) gets the same
                // backoff as one that is out of reach; only an attach answer counts as a working connection.
                if (answered) attempt = 0;
            } catch (IOException | RuntimeException error) {
                // out of reach (or a failure on this thread, which must not end the app) – the backoff below
            } catch (InterruptedException error) {
                return;
            }
            pause(BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]);
        }
    }

    /** Phone use turned on or off, or the person agreed (any thread, often the main one): attach again on the step thread. */
    private void changed() {
        WebSocketClient ws = socket;
        if (ws != null) steps.post(() -> attach(ws));
    }

    /** phoneUse.attach on `ws` (on the step thread; nothing when that socket ended meanwhile). */
    private void attach(WebSocketClient ws) {
        if (socket != ws) return;
        int id = ids.getAndIncrement();
        attachId = id;
        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        send(ws, Json.map("id", id, "method", "phoneUse.attach", "params", Json.map("model", model(), "ready", UseService.current() != null && UseConsent.agreed(context),
                "screen", Json.map("width", metrics.widthPixels, "height", metrics.heightPixels))));
    }

    @Override public void text(String text) {
        Map<String, Object> frame;
        try { frame = Json.object(text); } catch (IllegalArgumentException error) { return; }
        if ("phoneUse.request".equals(frame.get("event")) && frame.get("data") instanceof Map) {
            @SuppressWarnings("unchecked") Map<String, Object> request = (Map<String, Object>) frame.get("data");
            if (!deviceId.equals(Json.str(request, "deviceId"))) return;
            steps.post(() -> handle(request));
            return;
        }
        if ("notify".equals(frame.get("event")) && frame.get("data") instanceof Map) {
            @SuppressWarnings("unchecked") Map<String, Object> note = (Map<String, Object>) frame.get("data");
            AppNotices.event(context, note);
            return;
        }
        Events ear = events;
        if (ear != null && frame.get("event") instanceof String && frame.get("data") instanceof Map) {
            @SuppressWarnings("unchecked") Map<String, Object> data = (Map<String, Object>) frame.get("data");
            ear.event((String) frame.get("event"), data);
            return;
        }
        Answer waiting = frame.get("id") instanceof Number ? calls.remove(((Number) frame.get("id")).intValue()) : null;
        if (waiting != null) {
            Object error = frame.get("error");
            if (error == null) { waiting.result(frame.get("result")); return; }
            @SuppressWarnings("unchecked") String message = error instanceof Map ? Json.str((Map<String, Object>) error, "message") : null;
            waiting.error(message == null || message.isEmpty() ? "The PC refused it." : message);
            return;
        }
        if (Json.num(frame, "id", -1) == attachId && frame.get("result") instanceof Map) {
            @SuppressWarnings("unchecked") Map<String, Object> result = (Map<String, Object>) frame.get("result");
            answered = true;
            List<PhoneConnection.Pc> list = PhoneConnection.Paired.pcsOf(result.get("pcs"));
            if (!list.isEmpty()) pcs.changed(list);
        }
    }

    private void handle(Map<String, Object> request) {
        String id = Json.str(request, "id");
        String op = Json.str(request, "op");
        if (id == null || op == null) return;
        Object args = request.get("args");
        @SuppressWarnings("unchecked") Map<String, Object> params = args instanceof Map ? (Map<String, Object>) args : Json.map();
        UseService service = UseService.current();
        Map<String, Object> reply;
        if (service == null || !UseConsent.agreed(context)) {
            EnablePrompt.show(context);
            PhoneUseUpgrade.prompt(context);
            reply = Json.map("id", id, "error", Json.map("code", "off", "message", offText(service != null)));
        } else {
            try { reply = Json.map("id", id, "result", service.run(op, params, Json.str(request, "job"), Json.str(request, "by"))); }
            catch (UseService.UseError error) { reply = Json.map("id", id, "error", Json.map("code", error.code, "message", String.valueOf(error.getMessage()))); }
            catch (RuntimeException error) { reply = Json.map("id", id, "error", Json.map("code", "conflict", "message", "The step failed on the phone: " + error.getClass().getSimpleName())); }
        }
        send(Json.map("id", ids.getAndIncrement(), "method", "phoneUse.reply", "params", reply));
    }

    /** The 'off' answer the AI reads: what this phone has and what I do next. */
    private String offText(boolean serviceOn) {
        if (UseConsent.available(context)) return serviceOn ? "The person has not yet agreed to the phone-use disclosure in the app." : "Phone use is off on this phone.";
        if (PhoneUseUpgrade.offered(context)) return "This app build carries no phone use. Autark is fetching its phone-use build by itself now "
                + "(or after one tap on 'Let the AI use this phone'); then the person agrees and switches it on. I try again after that.";
        return "This app build (from Google Play) carries no phone use and cannot add it by itself.";
    }

    /** One RPC call over the running link (any thread: it goes out on the step thread); false without a link. The answer is not awaited. */
    public static boolean call(String method, Map<String, Object> params) {
        UseLink link = linked;
        return link != null && link.steps.post(() -> link.send(Json.map("id", link.ids.getAndIncrement(), "method", method, "params", params)));
    }

    private void send(Map<String, Object> frame) {
        WebSocketClient ws = socket;
        if (ws != null) send(ws, frame);
    }

    /** A write that fails – the socket ended, or Android refused it on the wrong thread – closes it; never thrown. A refusal
     *  (a RuntimeException, not a lost connection) is said in logcat by class and place, without the frame's content. */
    private static void send(WebSocketClient ws, Map<String, Object> frame) {
        try { ws.sendText(Json.write(frame)); } catch (IOException | RuntimeException error) {
            if (error instanceof RuntimeException) android.util.Log.w("autark", "phone-use write refused: " + error.getClass().getName() + StepThread.where(error));
            ws.close();
        }
    }

    @Override public void binary(byte[] data) { /* the RPC socket sends text only */ }

    @Override public void closed(String reason) {
        synchronized (lock) { closes++; socket = null; lock.notifyAll(); }
        failCalls();
        Events ear = events;
        if (ear != null) ear.closed();
    }

    private void pause(long ms) {
        synchronized (lock) { if (!stopped) { try { lock.wait(ms); } catch (InterruptedException error) { Thread.currentThread().interrupt(); } } }
    }

    private static String model() {
        String name = (Build.MANUFACTURER + " " + Build.MODEL).trim();
        return name.isEmpty() ? "Android phone" : name.length() > 60 ? name.substring(0, 60) : name;
    }
}
