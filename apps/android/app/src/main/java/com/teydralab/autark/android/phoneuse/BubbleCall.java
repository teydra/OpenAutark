// Owns: a call from the to-do bubble without the app coming up (owner 19.11.2026: "da kann ich direkt einfach sprechen und
// dann wird es dem Richtigen zugeordnet"). The bubble listens the way the app's own call does (owner 20.11.2026: the
// phone's recognizer heard English words in German speech): the microphone (Mic) runs for the whole call, the end of each
// spoken line is found by level (SpokenAudio.Turns, the page's fallback rule, with PRE_ROLL_MS before its start), and the
// line goes to the PC as WAV (files.upload) to be heard in the person's language with the chat as context
// (voice.transcribe) – one after another on my worker, so lines keep their order; while the phone speaks, nothing is
// taken (its own voice would be heard). The first line (or the typed text, when the panel had some) goes out through the
// host (TodoButton.route, task_cxs4s3pt: the chat the person used last and its agent, the draft's shots there as a silent line); then I
// subscribe chat:<id> on the link, open the call (calls.start) and send that line as the call's first spoken line
// (messages.send with speech {source, live, call}), so the live voice answers at once; every later line goes the same way.
// The chat's agent rows after my last line are read by PhoneSpeech: the live voice's row of this call (meta.call.voice
// 'talker') sentence by sentence while it is written, any other agent row when final, and a system row of this call
// (the same reading rules as the page, shared/voice/conversation.ts). The person's tap on the dot ends it (calls.end,
// events.unsubscribe). No such chat: one line, no call. The link ends or the call row ends: the call is over
// here, with one line; another device took the call over (this phone is neither its holder nor joined): over quietly.
// Several devices of the person can be in one call (JOIN): only the one that heard the person's newest line reads the
// reply – a line said on another device makes me quiet until my next line goes out. Nobody speaks – no line heard, no
// agent row, the phone silent – for SILENCE_MS (FIRST_SILENCE_MS before the first line): over with one line; a
// microphone that gave only digital silence for MUTED_MS (Android keeps it from the bubble) ends the call with one line
// too. A spoken line the PC could not hear shows its reason (Host.note) and the call goes on; HEAR_FAILURES_MAX in a row
// end it. While the call runs KeepAlive holds the CPU
// and the audio focus (KeepAlive.bubbleCall; its notice's End ends this call).
// Never: opens the app, keeps what was said beyond the RPC, or listens while the phone speaks (its own voice would be heard).
package com.teydralab.autark.android.phoneuse;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import com.teydralab.autark.android.KeepAlive;
import com.teydralab.autark.android.PhoneSpeech;
import com.teydralab.autark.android.relay.Json;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class BubbleCall implements UseLink.Events {
    /** The bubble around the call (TodoButton). */
    interface Host {
        /** My worker thread: {chatId, agentId} of the chat the person used last (the draft's shots already there), or null.
         *  Throws with a line for the person. */
        String[] route(String text) throws Exception;
        /** Main thread: the dot during the call – the agent's initial (null while unknown) and whether I listen right now. */
        void look(String initial, boolean hearing);
        /** Main thread, once: the call is over; `line` says why (null: the person ended it, or another device took it over). */
        void over(String line);
        /** Main thread: one line for the person while the call goes on (a spoken line the PC could not hear). */
        void note(String line);
    }

    private static final long CALL_MS = 60_000;
    /** A spoken line heard by the PC's local model can take a while on a slow PC. */
    private static final long HEAR_MS = 120_000;
    /** How often the call checks for silence. */
    private static final long WATCH_MS = 5_000;
    /** Only digital silence from the microphone this long: Android keeps it from the bubble. */
    private static final long MUTED_MS = 6_000;
    /** Spoken lines in a row the PC could not hear before the call ends (one alone only shows its line). */
    private static final int HEAR_FAILURES_MAX = 3;
    /** Nobody spoke for this long (no line, no agent row, the phone silent): the call ends; before the first line sooner. */
    private static final long SILENCE_MS = 3 * 60_000;
    private static final long FIRST_SILENCE_MS = 45_000;

    private final Context context;
    private final UseLink link;
    private final String language;
    private final Host host;
    private final Mic mic;
    private final boolean german;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService work = Executors.newSingleThreadExecutor((job) -> {
        Thread thread = new Thread(job, "autark-bubble-call");
        thread.setDaemon(true);
        return thread;
    });
    private final Runnable watch = this::watch;

    // All below: main thread only.
    private volatile boolean ended;
    /** The chat whose events I subscribed (set before the subscribe goes out, so the end always unsubscribes it). */
    private volatile String subscribed;
    /** When something was last said in the call (elapsedRealtime), and whether the bubble listens now (the Mic's thread
     *  reads it: lines are taken only while true). */
    private volatile long lastVoice;
    private volatile boolean hearing;
    // The Mic's thread only (guarded by `audio`): the level turns, the line being spoken, the audio just before it.
    private final Object audio = new Object();
    private final SpokenAudio.Turns turns = new SpokenAudio.Turns();
    private short[] spokenLine;
    private int spokenLength;
    private final short[] preRoll = new short[SpokenAudio.samples(SpokenAudio.PRE_ROLL_MS)];
    private int preRollAt;
    private boolean preRollFull;
    private long micSamples;
    private long lastLoud;
    private boolean mutedSaid;
    /** My worker's count of the lines it sent to be heard (their file names), and how many failed in a row. */
    private int heardLines;
    private int hearFailures;
    private PhoneSpeech voice;
    private final Set<String> speaking = new HashSet<>();
    private int lines;
    private boolean routing;
    private volatile String chatId;
    private String callId;
    private String holder;
    private String initial;
    /** The seq of my last line; -1 until the first one is in (rows that come before are kept in `early`). */
    private long sentSeq = -1;
    /** The seq of the person's newest line of this call, said here or on another device of the call (-1: none yet). */
    private long heardSeq = -1;
    /** My lines on their way (their own rows may come before messages.send answers). */
    private int inFlight;
    private final List<String> waiting = new ArrayList<>();
    private final List<Map<String, Object>> early = new ArrayList<>();
    private Set<String> spoken = new HashSet<>();
    /** The live voice's row read while it was written, and how much of it. */
    private String saidId;
    private String saidText = "";
    private String speaker;

    BubbleCall(Context context, UseLink link, String language, Host host) {
        this.context = context;
        this.link = link;
        this.language = language;
        this.german = UiLang.german(context);
        this.host = host;
        this.mic = new Mic(context);
    }

    /** Main thread: listening from now on; with `typed` that text is the first line and goes out at once. */
    void start(String typed) {
        lastVoice = SystemClock.elapsedRealtime();
        KeepAlive.bubbleCall(context, this::end); // the CPU awake and the audio focus while the call runs
        host.look(null, false);
        if (!mic.start(this::heardAudio, () -> post(() -> finish(german ? "Das Mikrofon ist weg – Anruf beendet." : "The microphone went away – call ended.")))) { finish(german ? "Das Mikrofon ging nicht auf – kein Anruf." : "The microphone did not open – no call."); return; }
        main.postDelayed(watch, WATCH_MS);
        listen();
        if (!typed.isEmpty()) open(typed);
    }

    /** Main thread: the person ends the call. */
    void end() { finish(null); }

    // ------------------------------------------------------------------ the call

    private void heard(String text) {
        if (chatId == null && !routing) open(text);
        else send(text);
    }

    /** The first line: the chat found, subscribed and the call opened (my worker). */
    private void open(String text) {
        routing = true;
        work.execute(() -> {
            String line;
            try {
                String[] chat = host.route(text);
                if (chat == null) {
                    post(() -> finish(german ? "Kein offener Chat mit einem Agenten – darum kein Anruf." : "No open chat with an agent – so no call."));
                    return;
                }
                String id = chat[0];
                link.listen(this);
                subscribed = id;
                link.request("events.subscribe", Json.map("topics", Collections.singletonList("chat:" + id)), CALL_MS);
                if (ended) { hangUp(id, null); return; } // ended meanwhile: its unsubscribe may have gone out first
                Map<String, Object> call = startCall(id);
                String name = null;
                try {
                    Object agent = link.request("agents.get", Json.map("id", chat[1]), CALL_MS);
                    @SuppressWarnings("unchecked") String found = agent instanceof Map ? Json.str((Map<String, Object>) agent, "name") : null;
                    name = found;
                } catch (UseLink.Refused unnamed) { /* the dot keeps the Autark mark */ }
                String letter = name == null || name.trim().isEmpty() ? null : name.trim().substring(0, 1).toUpperCase(Locale.ROOT);
                String callNow = Json.str(call, "callId");
                String holderNow = Json.str(call, "holder");
                main.post(() -> opened(id, callNow, holderNow, letter, text));
                return;
            } catch (UseLink.Refused refused) {
                line = refused.late ? (german ? "Der PC hat nicht geantwortet." : "The PC did not answer.") : refused.getMessage();
            } catch (InterruptedException stop) {
                return;
            } catch (Exception failed) {
                line = failed instanceof RuntimeException || failed.getMessage() == null ? (german ? "Anrufen ging nicht." : "The call did not start.") : failed.getMessage();
            }
            String said = line;
            post(() -> finish(said));
        });
    }

    /** calls.start, waited for at most CALL_MS; an answer that comes after I gave up on it is hung up at once. */
    private Map<String, Object> startCall(String chat) throws UseLink.Refused, InterruptedException {
        AtomicInteger state = new AtomicInteger(); // 0 waiting, 1 answered, 2 given up
        AtomicReference<Object> result = new AtomicReference<>();
        AtomicReference<String> error = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        link.call("calls.start", Json.map("conversationId", chat), new UseLink.Answer() {
            @Override public void result(Object value) {
                if (state.compareAndSet(0, 1)) { result.set(value); done.countDown(); }
                else hangUp(null, Json.str(map(value), "callId")); // too late: this phone keeps no call it does not use
            }
            @Override public void error(String message) { if (state.compareAndSet(0, 1)) { error.set(message); done.countDown(); } }
        });
        if (!done.await(CALL_MS, TimeUnit.MILLISECONDS) && state.compareAndSet(0, 2)) throw new UseLink.Refused(null, true);
        done.await(); // answered just as the wait ran out
        if (error.get() != null) throw new UseLink.Refused(error.get(), false);
        return map(result.get());
    }

    private void opened(String chat, String call, String who, String letter, String first) {
        if (ended) { link.unlisten(this); hangUp(chat, call); return; } // the person ended it while it was being set up
        routing = false;
        chatId = chat;
        callId = call;
        holder = who;
        initial = letter;
        host.look(initial, hearing);
        send(first);
        if (!waiting.isEmpty()) { send(String.join(" ", waiting)); waiting.clear(); }
    }

    /** One line of the call (my worker sends them in order). */
    private void send(String text) {
        if (chatId == null) { waiting.add(text); return; }
        String chat = chatId;
        String call = callId;
        Map<String, Object> speech = call == null ? Json.map("source", "endpoint", "live", true) : Json.map("source", "endpoint", "live", true, "call", call);
        inFlight++;
        try {
            work.execute(() -> {
                if (ended) return; // a line heard before the end stays unsent
                try {
                    Object sent = link.request("messages.send", Json.map("conversationId", chat, "body", text, "clientId", UUID.randomUUID().toString(), "speech", speech), CALL_MS);
                    @SuppressWarnings("unchecked") Map<String, Object> message = sent instanceof Map ? (Map<String, Object>) sent : Json.map();
                    long seq = Json.num(message, "seq", -1);
                    Map<String, Object> meta = map(message.get("meta"));
                    String runtimeCall = Json.str(map(meta.get("call")), "id");
                    post(() -> { inFlight--; sent(seq, runtimeCall); });
                } catch (UseLink.Refused refused) {
                    String line = refused.late ? (german ? "Der PC hat nicht geantwortet." : "The PC did not answer.") : refused.getMessage();
                    post(() -> finish(line));
                } catch (InterruptedException stop) {
                    Thread.currentThread().interrupt();
                }
            });
        } catch (RuntimeException over) { inFlight--; /* the call ended meanwhile */ }
    }

    private void sent(long seq, String runtimeCall) {
        if (seq > sentSeq) sentSeq = seq;
        if (runtimeCall != null) callId = runtimeCall; // the runtime's call for this line, so the end reaches it
        if (early.isEmpty() || sentSeq < 0) return;
        List<Map<String, Object>> rows = new ArrayList<>(early);
        early.clear();
        for (Map<String, Object> row : rows) observe(row);
    }

    @Override public void event(String name, Map<String, Object> data) {
        if ("message.created".equals(name) || "message.updated".equals(name)) post(() -> observe(data));
    }

    @Override public void closed() {
        post(() -> finish(german ? "Die Verbindung zum PC ist weg – Anruf beendet." : "The connection to your PC dropped – call ended."));
    }

    /** One row of the chat: what of it the person hears (the page's rules, shared/voice/conversation.ts observe). */
    private void observe(Map<String, Object> row) {
        if (ended || chatId == null || !chatId.equals(Json.str(row, "conversationId"))) return;
        Map<String, Object> meta = map(row.get("meta"));
        Map<String, Object> call = map(meta.get("call"));
        boolean mine = callId != null && callId.equals(Json.str(call, "id"));
        String kind = Json.str(row, "kind");
        if ("status".equals(kind)) {
            if (!mine || !(call.get("lines") instanceof List)) return; // only my call's own row
            if (call.get("endedAt") != null) { finish(german ? "Der Anruf ist zu Ende." : "The call ended."); return; }
            if (holder != null && !holder.isEmpty() && !member(call, holder)) finish(null); // taken over: the other device has it
            return;
        }
        String author = Json.str(row, "authorKind");
        if ("human".equals(author) && mine) { personSaid(Json.num(row, "seq", -1)); return; }
        boolean voiceRow = "agent".equals(author) || ("system".equals(author) && mine);
        if (!voiceRow || Boolean.TRUE.equals(row.get("silent"))) return;
        lastVoice = SystemClock.elapsedRealtime(); // an agent works or speaks: the call is not silent
        if (sentSeq < 0) { if (early.size() < 50) early.add(row); return; }
        String id = Json.str(row, "id");
        if (id == null || Json.num(row, "seq", -1) <= sentSeq || otherReads()) return; // the device that heard the newest line reads
        String body = Json.str(row, "body");
        String state = Json.str(row, "state");
        if ("streaming".equals(state)) {
            if (mine && "talker".equals(Json.str(call, "voice"))) piece(row, call, id, body == null ? "" : body);
            return;
        }
        if (!spoken.add(id)) return;
        if (spoken.size() > 200) spoken = new HashSet<>();
        if ("failed".equals(state)) {
            String error = Json.str(meta, "error");
            finish(error == null || error.isEmpty() ? (german ? "Die Antwort ging nicht." : "The voice reply failed.") : error);
            return;
        }
        String whole = "final".equals(state) ? speakable(body) : "";
        String already = id.equals(saidId) ? saidText : "";
        if (id.equals(saidId)) { saidId = null; saidText = ""; }
        String rest = already.isEmpty() || whole.isEmpty() ? whole : whole.startsWith(already) ? whole.substring(already.length()).trim() : whole;
        if (!rest.isEmpty()) read(row, call, rest);
    }

    /** Owner 19.11.2026 (several devices in one call): the device that heard the person's newest line reads the reply. */
    private boolean otherReads() { return heardSeq > sentSeq; }

    /** A person's line of my call, here or on another device: said there, I go quiet (that device reads) until my next line. */
    private void personSaid(long seq) {
        if (seq <= heardSeq) return;
        heardSeq = seq;
        if (inFlight > 0 || !otherReads()) return; // a line of mine on its way: its own row
        saidId = null;
        saidText = "";
        if (voice != null && !speaking.isEmpty()) voice.stop(); // each stopped line reports done: listening starts again
    }

    /** Whether the device `who` (pc/participant) is in the call: its holder or joined beside it (call.ts callMember). */
    private static boolean member(Map<String, Object> call, String who) {
        if (who.equals(device(call))) return true;
        Object joined = call.get("joined");
        if (joined instanceof List) for (Object one : (List<?>) joined) if (one instanceof Map && who.equals(device(map(one)))) return true;
        return false;
    }

    private static String device(Map<String, Object> record) {
        String pc = Json.str(record, "pc");
        return (pc == null ? "" : pc) + "/" + String.valueOf(record.get("participant"));
    }

    /** The live voice writes while it speaks: each finished sentence is read at once, the rest when the row is final. */
    private void piece(Map<String, Object> row, Map<String, Object> call, String id, String body) {
        String done = sentencesDone(speakable(body));
        String already = id.equals(saidId) ? saidText : "";
        if (done.isEmpty() || done.length() <= already.length()) return;
        saidId = id;
        saidText = done;
        read(row, call, !already.isEmpty() && done.startsWith(already) ? done.substring(already.length()).trim() : done);
    }

    /** One piece into the phone's voice – the speaker's name in front when the speaker changed. */
    private void read(Map<String, Object> row, Map<String, Object> call, String text) {
        String author = Json.str(row, "authorId");
        boolean changed = speaker != null && !speaker.equals(author);
        speaker = author;
        String name = changed ? Json.str(call, "name") : null;
        say(name == null || name.trim().isEmpty() ? text : name.trim() + ": " + text);
    }

    private void say(String text) {
        if (voice == null) voice = new PhoneSpeech(context, this::spokenDone);
        String id = "bubble-call-" + (++lines);
        speaking.add(id);
        quiet(); // the microphone rests while the phone speaks
        voice.speak(id, text, null);
    }

    private void spokenDone(String id) {
        speaking.remove(id);
        lastVoice = SystemClock.elapsedRealtime();
        if (speaking.isEmpty() && !ended) listen();
    }

    // ------------------------------------------------------------------ listening

    private void listen() {
        if (ended || hearing || !speaking.isEmpty()) return;
        synchronized (audio) { turns.reset(); spokenLine = null; spokenLength = 0; preRollAt = 0; preRollFull = false; }
        hearing = true;
        host.look(initial, true);
    }

    /** Listening pauses (the phone is about to speak): a line being spoken is dropped. */
    private void quiet() {
        hearing = false;
        synchronized (audio) { turns.reset(); spokenLine = null; spokenLength = 0; }
        if (!ended) host.look(initial, false);
    }

    /** The Mic's thread: each block of the call's audio – a line starts, grows and, at its end, goes to the PC. */
    private void heardAudio(short[] block, int count) {
        short[] line = null;
        int length = 0;
        boolean muted;
        synchronized (audio) {
            for (int i = 0; i < count; i++) if (block[i] != 0) lastLoud = micSamples + i + 1;
            micSamples += count;
            muted = !mutedSaid && micSamples - lastLoud > SpokenAudio.samples((int) MUTED_MS); // no sound at all lately: Android silences it
            if (muted) mutedSaid = true;
            if (!hearing) return;
            SpokenAudio.Turns.Edge edge = turns.feed(block, count);
            if (edge == SpokenAudio.Turns.Edge.START) {
                spokenLine = new short[SpokenAudio.samples(SpokenAudio.LINE_MAX_MS + SpokenAudio.PRE_ROLL_MS) + count];
                spokenLength = 0;
                int kept = preRollFull ? preRoll.length : preRollAt;
                for (int i = 0; i < kept; i++) spokenLine[spokenLength++] = preRoll[(preRollFull ? preRollAt + i : i) % preRoll.length];
                lastVoice = SystemClock.elapsedRealtime();
            }
            if (spokenLine != null) {
                int room = Math.min(count, spokenLine.length - spokenLength);
                System.arraycopy(block, 0, spokenLine, spokenLength, room);
                spokenLength += room;
            } else {
                for (int i = 0; i < count; i++) { preRoll[preRollAt] = block[i]; preRollAt = (preRollAt + 1) % preRoll.length; if (preRollAt == 0) preRollFull = true; }
            }
            if (edge == SpokenAudio.Turns.Edge.END && spokenLine != null) {
                line = spokenLine;
                length = spokenLength;
                spokenLine = null;
                spokenLength = 0;
                preRollAt = 0;
                preRollFull = false;
            }
        }
        if (muted) { post(() -> finish(german ? "Android gibt der Blase gerade kein Mikrofon – Anruf beendet. Ruf in der App an." : "Android gives the bubble no microphone right now – call ended. Call from the app.")); return; }
        if (line != null) hear(SpokenAudio.wav(line, 0, length));
    }

    /** A spoken line to the PC (my worker, in order): uploaded, heard in the person's language, then a line of the call. */
    private void hear(byte[] wav) {
        lastVoice = SystemClock.elapsedRealtime();
        String chat = chatId;
        try {
            work.execute(() -> {
                if (ended) return;
                String line;
                try {
                    String fileId = TodoPost.fileId(link.request("files.upload", SpokenAudio.upload(wav, ++heardLines), CALL_MS));
                    if (fileId != null) {
                        String text = SpokenAudio.text(link.request("voice.transcribe", SpokenAudio.transcribe(fileId, language, null, chat), HEAR_MS));
                        hearFailures = 0;
                        if (!text.isEmpty()) post(() -> { lastVoice = SystemClock.elapsedRealtime(); heard(text); });
                        return;
                    }
                    line = german ? "Der PC hat die Aufnahme nicht angenommen." : "The PC did not take the recording.";
                } catch (UseLink.Refused refused) {
                    line = refused.late ? (german ? "Der PC hat nicht rechtzeitig zugehört." : "The PC did not answer in time.") : refused.getMessage();
                } catch (InterruptedException stop) {
                    Thread.currentThread().interrupt();
                    return;
                }
                // One line the PC could not hear: the person reads why and says it again; several in a row end the call.
                String why = line;
                if (++hearFailures >= HEAR_FAILURES_MAX) post(() -> finish(why));
                else post(() -> host.note(why));
            });
        } catch (RuntimeException over) { /* the call ended meanwhile */ }
    }

    /** Every WATCH_MS: nobody spoke – no line heard, no agent row, the phone silent – for too long: the call is over. */
    private void watch() {
        if (ended) return;
        long now = SystemClock.elapsedRealtime();
        boolean talking;
        synchronized (audio) { talking = turns.speaking(); }
        boolean busy = !speaking.isEmpty() || talking;
        if (!busy && now - lastVoice > (chatId == null && !routing ? FIRST_SILENCE_MS : SILENCE_MS)) {
            finish(german ? "Eine Weile hat niemand gesprochen – Anruf beendet." : "Nobody spoke for a while – call ended.");
            return;
        }
        main.postDelayed(watch, WATCH_MS);
    }

    // ------------------------------------------------------------------ the end

    private void finish(String line) {
        if (ended) return;
        ended = true;
        main.removeCallbacks(watch);
        hearing = false;
        mic.stop();
        speaking.clear();
        if (voice != null) { voice.shutdown(); voice = null; }
        link.unlisten(this);
        work.shutdown(); // a call being set up finishes and is hung up at once (opened)
        hangUp(subscribed, callId);
        KeepAlive.bubbleCall(context, null);
        host.over(line);
    }

    /** The call row ends and the chat's events stop (sent on the link's own thread; no answer awaited). */
    private static void hangUp(String chat, String call) {
        if (call != null) UseLink.call("calls.end", Json.map("callId", call));
        if (chat != null) UseLink.call("events.unsubscribe", Json.map("topics", Collections.singletonList("chat:" + chat)));
    }

    private void post(Runnable step) { main.post(() -> { if (!ended) step.run(); }); }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) { return value instanceof Map ? (Map<String, Object>) value : Json.map(); }

    // ------------------------------------------------------------------ speakable text (conversation-parts.ts)

    /** A Markdown answer as speakable text: no fences, markup or bullets, a link as its words, a line without a stop ends as a sentence. */
    static String speakable(String markdown) {
        if (markdown == null) return "";
        String text = markdown
                .replaceAll("```[\\s\\S]*?(```|$)", " ")
                .replaceAll("!\\[[^\\]]*\\]\\([^)]*\\)", " ")
                .replaceAll("\\[([^\\]]+)\\]\\([^)]*\\)", "$1")
                .replaceAll("(?m)^[ \\t]*[-+•][ \\t]+", "")
                .replaceAll("[`*_#>|~]+", " ")
                .replaceAll("([^\\s.!?:;,])[ \\t]*\\n\\s*(?=\\S)", "$1. ")
                .replaceAll("\\s+", " ")
                .trim();
        return text.length() > 4000 ? text.substring(0, 4000) : text;
    }

    private static final Pattern SENTENCE_END = Pattern.compile("[.!?…][\"'”’)\\]]*(?=\\s|$)|\\n");
    private static final Pattern ABBREVIATION = Pattern.compile("(?:^|\\s)(?:[\\p{L}\\d]|[\\p{L}\\d]+\\.[\\p{L}\\d.]*|ca|bzw|usw|etc|vgl|ggf|evtl|inkl|zzgl|bspw|Nr|Dr|Prof|Hr|Fr|St|Str|Tel|Mio|Mrd|Mr|Mrs|Ms|Jr|vs|approx)\\.$",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    private static final Pattern GOES_ON = Pattern.compile("^[\"'”’)\\]]*\\s+\\p{Ll}");
    private static final int PIECE_MIN = 15;

    /** The finished sentences at the start of a text still being written (a piece at least PIECE_MIN long), or "". */
    static String sentencesDone(String text) {
        int at = 0;
        Matcher match = SENTENCE_END.matcher(text);
        while (match.find()) {
            int end = match.end();
            if (".".equals(match.group()) && (ABBREVIATION.matcher(text.substring(Math.max(0, match.start() - 40), end)).find() || GOES_ON.matcher(text.substring(end)).find())) continue;
            if (end - at >= PIECE_MIN) at = end;
        }
        return at > 0 ? text.substring(0, at).trim() : "";
    }
}
