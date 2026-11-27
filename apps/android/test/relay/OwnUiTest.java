// Owns: the app's own interface at its entrance on a host JVM (owner 27.11.2026) – a real StreamProxy on loopback with
// a map for the APK's assets/ui and a channel source that has no PC: the interface's files, a navigation path, HEAD,
// the old service worker's end (/sw.js) and missing or unsafe paths are answered at once and never ask for a channel;
// the PC's data paths, sockets and POSTs do (and get the 503 of no PC); a forwarded request goes with Connection: close;
// the gate still keeps other apps out; a taken company port is retried briefly and then reported, never swapped; the
// page's policy is the one runtime/http/static.ts sends while that file is there.
// Never: a WebView or a PC (a phone does that).
package com.teydralab.autark.android.relay;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class OwnUiTest {
    private static int assertions;
    private static final AtomicInteger waits = new AtomicInteger();

    public static void main(String[] args) throws Exception {
        Map<String, byte[]> assets = new HashMap<>();
        assets.put("index.html", bytes("<!doctype html><title>Autark</title>"));
        assets.put("main.js", bytes("console.log('main')"));
        assets.put("chunks/chat-ABCD1234.js", bytes("export {}"));
        assets.put("icons/icon-192.png", new byte[] { (byte) 0x89, 'P', 'N', 'G' });
        StreamProxy.Channels none = new StreamProxy.Channels() {
            @Override public PeerChannel await(long timeoutMs) { waits.incrementAndGet(); return null; }
            @Override public PeerChannel used() { return null; }
            @Override public void probe() {}
        };
        StreamProxy proxy = new StreamProxy(0, "g4te", none, new UiFiles(assets::get));
        try {
            interfaceFiles(proxy.port());
            dataPaths(proxy.port());
        } finally {
            proxy.close();
        }
        rules();
        takenPort(none);
        sameCsp();
        System.out.println(assertions + " own interface assertions passed.");
    }

    private static void interfaceFiles(int port) throws Exception {
        Reply index = get(port, "GET / HTTP/1.1", true);
        check(index.status == 200 && index.body.equals("<!doctype html><title>Autark</title>"), "/ is the app's index.html: " + index.status);
        check(UiFiles.APP_CSP.equals(index.headers.get("content-security-policy")) && "text/html; charset=utf-8".equals(index.headers.get("content-type")), "index.html carries the page's policy and type");
        check("no-cache".equals(index.headers.get("cache-control")) && "close".equals(index.headers.get("connection")) && "nosniff".equals(index.headers.get("x-content-type-options")), "the shell revalidates, one request per connection");
        Reply route = get(port, "GET /chats/ch_1?from=notice HTTP/1.1", true);
        check(route.status == 200 && route.body.startsWith("<!doctype html>"), "a navigation path without an extension is index.html");
        Reply main = get(port, "GET /main.js HTTP/1.1", true);
        check(main.status == 200 && "text/javascript; charset=utf-8".equals(main.headers.get("content-type")) && "no-cache".equals(main.headers.get("cache-control")) && !main.headers.containsKey("content-security-policy"), "main.js: its type, revalidated, no policy");
        Reply chunk = get(port, "GET /chunks/chat-ABCD1234.js HTTP/1.1", true);
        check(chunk.status == 200 && "public, max-age=31536000, immutable".equals(chunk.headers.get("cache-control")), "a content-hashed chunk never changes");
        Reply icon = get(port, "GET /icons/icon-192.png HTTP/1.1", true);
        check(icon.status == 200 && "image/png".equals(icon.headers.get("content-type")) && "4".equals(icon.headers.get("content-length")), "an icon with its type and length");
        Reply head = get(port, "HEAD / HTTP/1.1", true);
        check(head.status == 200 && head.body.isEmpty() && "36".equals(head.headers.get("content-length")), "HEAD: the headers only");
        Reply worker = get(port, "GET /sw.js HTTP/1.1", true);
        check(worker.status == 200 && worker.body.contains("caches.delete(name)") && worker.body.contains("self.registration.unregister()")
                && worker.body.contains("if (names.length)") && "text/javascript; charset=utf-8".equals(worker.headers.get("content-type")) && "no-cache".equals(worker.headers.get("cache-control")),
                "/sw.js ends the old worker: caches gone, unregistered, a reload only where it found a cache");
        check(get(port, "GET /missing.js HTTP/1.1", true).status == 404, "a missing file is 404, not the shell");
        check(get(port, "GET /../secret HTTP/1.1", true).status == 404 && get(port, "GET /%2e%2e/secret HTTP/1.1", true).status == 404 && get(port, "GET /.env HTTP/1.1", true).status == 404, "no '..' and no dotfile, encoded or not");
        check(get(port, "GET / HTTP/1.1", false).status == 403, "without the gate cookie: 403, as before");
        check(waits.get() == 0, "no interface request asked for a channel (" + waits.get() + ")");
    }

    private static void dataPaths(int port) throws Exception {
        for (String line : new String[] { "GET /events HTTP/1.1", "GET /files/" + "ab".repeat(32) + " HTTP/1.1", "GET /sandbox/app?m=1 HTTP/1.1", "GET /turn/silero.onnx HTTP/1.1", "POST /rpc HTTP/1.1" }) {
            int before = waits.get();
            Reply reply = get(port, line, true);
            check(reply.status == 503 && waits.get() == before + 1, line + " goes to a PC (none here: 503)");
        }
        int before = waits.get();
        Reply socket = get(port, "GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket", true);
        check(socket.status == 503 && waits.get() == before + 1, "the page's socket goes to a PC");
    }

    private static void rules() {
        check(!UiFiles.ours("GET /ws HTTP/1.1\r\n\r\n") && !UiFiles.ours("GET /rpc HTTP/1.1\r\n\r\n") && !UiFiles.ours("GET /mcp HTTP/1.1\r\n\r\n")
                && !UiFiles.ours("GET /.well-known/workforce HTTP/1.1\r\n\r\n") && !UiFiles.ours("GET /peer/pair HTTP/1.1\r\n\r\n") && !UiFiles.ours("PUT /index.html HTTP/1.1\r\n\r\n"), "the PC's paths and other methods are not the interface's");
        check(UiFiles.ours("GET /wsx.js HTTP/1.1\r\n\r\n") && UiFiles.ours("GET /tasks HTTP/1.1\r\n\r\n") && UiFiles.ours("HEAD /manifest.webmanifest HTTP/1.1\r\n\r\n"), "a name that only starts like a data path is the interface's");
        String closed = StreamProxy.closing("POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nContent-Length: 2\r\n\r\n");
        check(closed.equals("POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n"), "a forwarded request asks the PC to close after its answer: " + closed);
        check(UiFiles.type("x.webmanifest").equals("application/manifest+json") && UiFiles.type("a.wasm").equals("application/wasm") && UiFiles.type("odd.bin").equals("application/octet-stream"), "types as shared/files/mime.ts");
    }

    private static void takenPort(StreamProxy.Channels none) throws Exception {
        try (ServerSocket holder = new ServerSocket()) {
            holder.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0));
            long started = System.currentTimeMillis();
            try {
                new StreamProxy(holder.getLocalPort(), "g", none, new UiFiles(path -> null)).close();
                check(false, "a taken port must not be swapped for another");
            } catch (IOException taken) {
                long took = System.currentTimeMillis() - started;
                check(taken.getMessage().contains(String.valueOf(holder.getLocalPort())) && took >= (StreamProxy.BIND_TRIES - 1) * 90L && took < 2_000, "a taken company port is tried briefly, then reported (" + took + " ms)");
            }
        }
    }

    /** UiFiles.APP_CSP is the policy runtime/http/static.ts sends for index.html (read from that file while it is there). */
    private static void sameCsp() throws Exception {
        Path statics = Paths.get(System.getProperty("autark.android"), "../desktop/src/runtime/http/static.ts");
        if (!Files.exists(statics)) { System.out.println("static.ts is gone: APP_CSP is the app's own now."); return; }
        String text = new String(Files.readAllBytes(statics), StandardCharsets.UTF_8);
        int start = text.indexOf("export const APP_CSP = [");
        String block = text.substring(start, text.indexOf("].join", start));
        StringBuilder csp = new StringBuilder();
        Matcher part = Pattern.compile("^\\s*(?:\"([^\"]*)\"|'([^']*)'),", Pattern.MULTILINE).matcher(block);
        while (part.find()) csp.append(csp.length() == 0 ? "" : "; ").append(part.group(1) != null ? part.group(1) : part.group(2));
        check(csp.toString().equals(UiFiles.APP_CSP), "the page's policy equals the PC's APP_CSP: " + csp);
    }

    private static final class Reply {
        int status;
        final Map<String, String> headers = new HashMap<>();
        String body = "";
    }

    /** One request on its own connection (the entrance closes it after the answer). */
    private static Reply get(int port, String head, boolean gate) throws IOException {
        try (Socket socket = new Socket(InetAddress.getByName("127.0.0.1"), port)) {
            socket.setSoTimeout(30_000);
            OutputStream out = socket.getOutputStream();
            String request = head + "\r\nHost: 127.0.0.1:" + port + (gate ? "\r\nCookie: x=1; " + StreamProxy.GATE_COOKIE + "=g4te" : "") + (head.startsWith("POST") ? "\r\nContent-Length: 0" : "") + "\r\n\r\n";
            out.write(request.getBytes(StandardCharsets.US_ASCII));
            out.flush();
            InputStream in = socket.getInputStream();
            ByteArrayOutputStream all = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int read; (read = in.read(buffer)) > 0; ) all.write(buffer, 0, read);
            String text = new String(all.toByteArray(), StandardCharsets.UTF_8);
            Reply reply = new Reply();
            int split = text.indexOf("\r\n\r\n");
            String[] lines = text.substring(0, Math.max(0, split)).split("\r\n");
            reply.status = Integer.parseInt(lines[0].split(" ")[1]);
            for (int i = 1; i < lines.length; i++) {
                int colon = lines[i].indexOf(':');
                if (colon > 0) reply.headers.put(lines[i].substring(0, colon).trim().toLowerCase(java.util.Locale.ROOT), lines[i].substring(colon + 1).trim());
            }
            reply.body = text.substring(split + 4);
            return reply;
        }
    }

    private static byte[] bytes(String text) { return text.getBytes(StandardCharsets.UTF_8); }

    private static void check(boolean condition, String what) {
        assertions++;
        if (!condition) throw new AssertionError(what);
    }
}
