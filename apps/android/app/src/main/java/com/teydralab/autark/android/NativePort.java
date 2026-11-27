// Owns: the one channel between the PC's page and the app (B-084 decision 4). After every new main-frame document of
// the app's own origin it makes a WebMessageChannel, hands the page one end as 'autark-port' (posted to that origin
// only, so opaque-origin agent frames never get it), keeps the other and drops the previous one. Messages are JSON
// {t, …} both ways. Page → app: 'colors' (SystemBars), 'speak'/'stopSpeech' (PhoneSpeech), 'download' (PhoneDownloads),
// 'haptic' and 'shot' (16.11.2026: a picture of the app's own window for a feedback report – PixelCopy, longest side
// SHOT_SIDE, JPEG 85, answered as 'shot' {data} or {error}) are handled here; 'card', 'switch', 'add', 'forget',
// 'refused' (the PC refused the page's token) and 'wake' {id, key, name} (W 19.11.2026: wake a closed PC through the
// phone's own meeting-server link, answered 'woken' {id} or {id, error}; 'status' says wake:true so the page knows) go to
// the activity (Listener). App → page: send(), with the latest
// 'companies' and 'status' sent again to every new page, a crash report the person chose to send ('crash' {text},
// CrashReport's Report) once, to the first page that has its port – then the report's file goes –, and 'feedback'
// {down} (16.11.2026: volume up and down pressed together, MainActivity/VolumePair – the feedback cell's press). Owner
// 19.11.2026 (a call or recording goes on outside the app): the page's 'voice.live' {on, kind} – any voice capture of
// the page started or ended, kind 'call' or 'dictation' – goes to the activity (Listener.voiceLive; KeepAlive), a page
// that goes away ends it, and 'voice.stop' asks the page to end its voice (the voice notice's End). Owner 19.11.2026
// (the way back to the to-do bubble): the page's 'bubble.pull' {x, y}, 'bubble.move' {x, y} and 'bubble.drop' {x, y}
// (CSS px of the page; a pull without x is a press without a finger) go to phoneuse/BubblePull in screen px, and
// 'bubble.state' {available, out} goes to every new page and on every change, so its header icon knows. STIMME 21.11.2026
// (the phone hears dictation itself): the page's 'hear' {id, data (base64), mime, language} – a dictation piece – goes to
// the person's ChatGPT plan from here (phoneuse/PlanHearing over the company's UseLink, on a thread of its own) and is
// answered 'heard' {id, text} or {id, error} (the page then sends it to the PC as before); 'status' says hear:true so
// the page knows. Owner 25.11.2026 (anonymous usage count): the page's 'usage' {on?} sets this phone's switch (usage/UsageCount) and every 
// 'usage' {on, text} goes to the page – to each new one, and as the answer – so Settings › Security shows the phone's own switch. Never: addJavascriptInterface, a second port, a message from another origin, a picture of anything but
// the app's window, or the plan login to the page.
package com.teydralab.autark.android;

import android.app.Activity;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.view.HapticFeedbackConstants;
import android.view.PixelCopy;
import android.view.View;
import android.view.Window;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;
import java.io.ByteArrayOutputStream;
import java.util.function.Supplier;
import com.teydralab.autark.android.phoneuse.BubblePull;
import com.teydralab.autark.android.phoneuse.PlanHearing;
import com.teydralab.autark.android.phoneuse.UseLink;
import com.teydralab.autark.android.usage.UsageCount;
import com.teydralab.autark.android.usage.UsageText;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class NativePort {
    /** What the page asks of the activity (main thread). */
    interface Listener {
        /** The current company's name and 64 px picture (data URL or null) – Companies.setCard. */
        void card(String name, String avatar);
        /** Switch to this company (an id from the 'companies' list). */
        void switchCompany(String id);
        /** Add a company: the pairing screens, Back returns. */
        void addCompany();
        /** Forget this phone (the current company): the same confirm as autark-app:forget. */
        void forget();
        /** The PC refused the page's token (4401): the page goes to the next PC of the company that has not refused. */
        void refused();
        /** W: wake the PC `id` whose wake helper key is `key`; the answer goes back with woken(). */
        void wake(String id, String key, String name);
        /** The page's voice capture went live (on) or ended; kind 'call', 'dictation' or null. */
        void voiceLive(boolean on, String kind);
    }

    private static final String TAG = "AutarkPort";
    /** The longest side of a window picture (the PC's feedback form shows it full size). */
    static final int SHOT_SIDE = 1600;
    /** As much of a crash report as a feedback report carries (the PC keeps clientDiagnostics to 12 000 characters). */
    static final int CRASH_CHARS = 12_000;
    /** The largest dictation piece the page hands over to hear (base64 chars of 25 MB). */
    static final int HEAR_CHARS = 34 * 1024 * 1024;
    private final Activity activity;
    private final Supplier<String> origin;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final PhoneSpeech speech;
    private final PhoneDownloads downloads;
    private WebMessagePort port;
    private WebView view;
    private JSONObject companies;
    private JSONObject status;
    private String crash;
    /** The page reported live voice (and has not ended it yet). */
    private boolean voice;
    /** The bubble's state to the page ('bubble.state'). */
    private final BubblePull.State bubble = (available, out) -> {
        try { send(new JSONObject().put("t", "bubble.state").put("available", available).put("out", out)); } catch (JSONException ignored) { /* never for booleans */ }
    };

    NativePort(Activity activity, Supplier<String> origin, Listener listener) {
        this.activity = activity;
        this.origin = origin;
        this.listener = listener;
        this.speech = new PhoneSpeech(activity, (id) -> send(message("speechDone", "id", id)));
        this.downloads = new PhoneDownloads(activity, (name) -> send(message("saved", "name", name)));
    }

    /** A new main-frame document finished loading in view (PhoneNavigation: newDocument). Main thread. */
    void pageLoaded(WebView loaded, String url) {
        String own = origin.get();
        if (own == null || !ConnectionAddress.sameOrigin(own, url)) return;
        close();
        // A stored file opened as the whole page (GET /files/<sha>) is the person's content, not the app: no port.
        String path = Uri.parse(url).getPath();
        if (path != null && path.startsWith("/files/")) return;
        WebMessagePort[] ends = loaded.createWebMessageChannel();
        WebMessagePort mine = ends[0];
        mine.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override public void onMessage(WebMessagePort from, WebMessage message) { if (port == mine) receive(message.getData()); }
        }, main);
        loaded.postWebMessage(new WebMessage("autark-port", new WebMessagePort[] { ends[1] }), Uri.parse(own));
        port = mine;
        view = loaded;
        if (companies != null) send(companies);
        if (status != null) send(status);
        sendUsage();
        BubblePull.listen(activity, bubble); // sends the current state to this page at once
        sendCrash();
    }

    /** Owner 25.11.2026: this phone's anonymous usage count – the switch and its words – to the page, which shows it in Settings › Security and answers a tap with {t:'usage', on}. */
    private void sendUsage() {
        try { send(new JSONObject().put("t", "usage").put("on", UsageCount.on(activity)).put("text", UsageText.SENTENCE)); } catch (JSONException ignored) { /* never for these values */ }
    }

    /** The last crash's report the person chose to send (main thread): it goes to the page once it has its port. */
    void crash(String report) {
        crash = report.length() > CRASH_CHARS ? report.substring(0, CRASH_CHARS) : report;
        sendCrash();
    }

    private void sendCrash() {
        if (crash == null || !send(message("crash", "text", crash))) return;
        crash = null;
        CrashReport.clear(activity); // handed over: the page keeps it in its report (and its outbox while the PC is away)
    }

    /** App → page; false while the page has no port. Any thread. */
    boolean send(JSONObject message) {
        WebMessagePort target = port;
        if (target == null || message == null) return false;
        String text = message.toString();
        main.post(() -> { if (port == target) target.postMessage(new WebMessage(text)); });
        return true;
    }

    /** The company list (Companies.listJson) – kept and sent again to every new page. */
    void companies(String listJson) {
        try { companies = new JSONObject().put("t", "companies").put("list", new JSONArray(listJson)); } catch (JSONException error) { return; }
        send(companies);
    }

    /**
     * The connection line: the PC tunnelled to (or null), whether the link is up and – 0.3.20, no PC outranks another – how many
     * of the company's PCs have a channel now (`online` of `total`, both 0 when unknown; the page words it) – kept and sent again to every new page.
     */
    void status(String pc, boolean connected, int online, int total) {
        try {
            status = new JSONObject().put("t", "status").put("connected", connected).put("wake", true).put("hear", true);
            if (pc != null) status.put("pc", pc);
            if (total > 0) status.put("online", online).put("total", total);
        } catch (JSONException error) { return; }
        send(status);
    }

    /** Shared into Autark: the text (or null) and how many files wait for the page's next file chooser. */
    void share(String text, int files) {
        try { JSONObject out = new JSONObject().put("t", "share").put("files", files); if (text != null) out.put("text", text); send(out); } catch (JSONException ignored) { /* never for these values */ }
    }

    /** W: how the wake of PC `id` went – null: woken, else the sentence why not. Any thread. */
    void woken(String id, String error) {
        try { JSONObject out = new JSONObject().put("t", "woken").put("id", id); if (error != null) out.put("error", error); send(out); } catch (JSONException ignored) { /* never for strings */ }
    }

    /** The link came back after a pause or a network change: the page refreshes its data. */
    void resume() { send(message("resume")); }

    /** Volume up and down together went down (true) or were let go (false): the page presses its feedback cell. */
    void feedback(boolean down) {
        try { send(new JSONObject().put("t", "feedback").put("down", down)); } catch (JSONException ignored) { /* never for these values */ }
    }

    /** The voice notice's End: the page ends its call or recording (and answers 'voice.live' off); false without a page. */
    boolean voiceStop() { return send(message("voice.stop")); }

    PhoneDownloads downloads() { return downloads; }

    /** The page is gone (renderer gone, forget, onDestroy): ends the port, the voice and a half-received file. */
    void dispose() {
        BubblePull.unlisten(bubble);
        close();
        speech.shutdown();
    }

    /** The page goes (a new document, the app page left, dispose): its port, voice, speech and half-received file end. */
    void close() {
        if (voice) voice(false, null);
        if (port != null) { try { port.close(); } catch (IllegalStateException ignored) { /* already closed */ } }
        port = null;
        view = null;
        speech.stop();
        downloads.cancel();
    }

    private void receive(String data) {
        JSONObject in;
        try { in = new JSONObject(data == null ? "" : data); } catch (JSONException error) { Log.w(TAG, "not JSON"); return; }
        switch (in.optString("t")) {
            case "colors": SystemBars.apply(text(in, "top"), text(in, "bottom")); break;
            case "speak": speech.speak(text(in, "id"), text(in, "text"), text(in, "lang")); break;
            case "stopSpeech": speech.stop(); break;
            case "download": downloads.chunk(text(in, "name"), text(in, "mime"), text(in, "data"), in.optBoolean("last"), in.optInt("seq", -1)); break;
            case "haptic": if (view != null) view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP); break;
            case "card": listener.card(text(in, "name"), text(in, "avatar")); break;
            case "switch": { String id = text(in, "id"); if (id != null) listener.switchCompany(id); break; }
            case "add": listener.addCompany(); break;
            case "forget": listener.forget(); break;
            case "refused": listener.refused(); break;
            case "wake": { String id = text(in, "id"); if (id != null) listener.wake(id, text(in, "key"), text(in, "name")); break; }
            case "shot": shot(); break;
            case "usage": if (in.has("on")) UsageCount.set(activity, in.optBoolean("on")); sendUsage(); break;
            case "hear": hear(text(in, "id"), text(in, "data"), text(in, "mime"), text(in, "language")); break;
            case "voice.live": voice(in.optBoolean("on"), text(in, "kind")); break;
            case "bubble.pull": { int[] at = onScreen(in); BubblePull.pull(activity, at == null ? -1 : at[0], at == null ? -1 : at[1]); break; }
            case "bubble.move": case "bubble.drop": { int[] at = onScreen(in); if (at != null) BubblePull.move(at[0], at[1], "bubble.drop".equals(in.optString("t"))); break; }
            default: Log.w(TAG, "unknown message " + in.optString("t"));
        }
    }

    private void voice(boolean on, String kind) {
        voice = on;
        listener.voiceLive(on, kind);
    }

    /** A dictation piece heard by the person's plan from this phone (a thread of its own); answered 'heard' by id. */
    private void hear(String id, String data, String mime, String language) {
        if (id == null) return;
        UseLink link = UseLink.linked();
        if (link == null || data == null || data.length() > HEAR_CHARS) { send(message("heard", "id", id, "error", "missed")); return; }
        Thread worker = new Thread(() -> {
            JSONObject answer;
            try {
                byte[] audio = Base64.decode(data, Base64.DEFAULT);
                answer = message("heard", "id", id, "text", link.hearing().hear(audio, mime, language));
            } catch (PlanHearing.Missed missed) {
                Log.i(TAG, "dictation goes over the PC: " + missed.getMessage()); // a reason, never a value
                answer = message("heard", "id", id, "error", "missed");
            } catch (InterruptedException stopped) {
                Thread.currentThread().interrupt();
                answer = message("heard", "id", id, "error", "missed");
            } catch (IllegalArgumentException | OutOfMemoryError broken) {
                answer = message("heard", "id", id, "error", "missed");
            }
            send(answer);
        }, "autark-hear");
        worker.setDaemon(true);
        worker.start();
    }

    /** A picture of the app's own window (main thread): PixelCopy, then scaled and encoded off the main thread. */
    private void shot() {
        Window window = activity.getWindow();
        View decor = window == null ? null : window.peekDecorView();
        if (decor == null || decor.getWidth() <= 0 || decor.getHeight() <= 0) { send(message("shot", "error", "The app's window is not drawn yet.")); return; }
        Bitmap full = Bitmap.createBitmap(decor.getWidth(), decor.getHeight(), Bitmap.Config.ARGB_8888);
        try {
            PixelCopy.request(window, full, (result) -> {
                if (result != PixelCopy.SUCCESS) { full.recycle(); send(message("shot", "error", "Android did not copy the window (" + result + ").")); return; }
                Thread encode = new Thread(() -> send(encoded(full)), "autark-shot");
                encode.setDaemon(true);
                encode.start();
            }, main);
        } catch (IllegalArgumentException | IllegalStateException error) {
            full.recycle();
            send(message("shot", "error", "Android did not copy the window."));
        }
    }

    /** The picture as {t:'shot', data:'data:image/jpeg;base64,…'} (longest side at most SHOT_SIDE). */
    private static JSONObject encoded(Bitmap full) {
        try {
            float scale = Math.min(1f, SHOT_SIDE / (float) Math.max(full.getWidth(), full.getHeight()));
            Bitmap sized = scale >= 1f ? full : Bitmap.createScaledBitmap(full, Math.round(full.getWidth() * scale), Math.round(full.getHeight() * scale), true);
            ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
            sized.compress(Bitmap.CompressFormat.JPEG, 85, jpeg);
            if (sized != full) sized.recycle();
            return message("shot", "data", "data:image/jpeg;base64," + Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP));
        } catch (RuntimeException | OutOfMemoryError error) {
            return message("shot", "error", "The picture could not be made on this phone.");
        } finally {
            full.recycle();
        }
    }

    /** The page's {x, y} (CSS px of its viewport) in screen px, or null without them. */
    private int[] onScreen(JSONObject in) {
        WebView page = view;
        if (page == null || !in.has("x") || !in.has("y")) return null;
        int[] origin = new int[2];
        page.getLocationOnScreen(origin);
        float density = activity.getResources().getDisplayMetrics().density;
        return new int[] { origin[0] + Math.round((float) in.optDouble("x") * density), origin[1] + Math.round((float) in.optDouble("y") * density) };
    }

    private static String text(JSONObject in, String key) { return in.isNull(key) ? null : in.optString(key, null); }

    private static JSONObject message(String type, String... pairs) {
        JSONObject out = new JSONObject();
        try { out.put("t", type); for (int i = 0; i + 1 < pairs.length; i += 2) out.put(pairs[i], pairs[i + 1]); } catch (JSONException ignored) { /* never for strings */ }
        return out;
    }
}
