// Owns: the phone's local entrance to its PC – a listener on 127.0.0.1 only the app's own WebView passes (its first
// request carries the app's private gate cookie), each TCP connection one stream over the encrypted peer channel to the
// PC's own runtime port (rendezvous/phone.ts: o/d/a/e messages, at most WINDOW unacknowledged bytes per direction).
// The WebView therefore shows the PC's unchanged phone UI at http://127.0.0.1:<port>, a secure context like https.
// B-084: a request whose channel dies before the PC answered gets a 503 instead of hanging; one that hears nothing for
// 4 s has the link probed once (Channels.probe), so a dead link is found within seconds. M1: the phone holds channels
// to several PCs; a new stream takes the page's one (Channels.await) and retire() – the page moved to another PC – ends
// the streams left on the others (a stream that raced that move ends at once too: one PC answers the page). Owner
// 27.11.2026: a better way to the same PC cuts nothing – drain() lets the old channel's streams run to their end and
// closes it after the last; a new stream waits for a channel as long as the page waits (a socket 4 s, below the page's
// OPEN_LIMIT_MS – 5 s since 27.11.2026, 8 s in 0.3.20 – so no stream opens for a socket the page gave up; any other
// request 20 s).
// Never: listens beyond loopback, lets another app's connection through, or buffers without bound.
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
import java.util.Base64;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public final class StreamProxy {
    /** The current channel to the PC, waited for up to a few seconds when a stream starts. */
    public interface Channels {
        PeerChannel await(long timeoutMs);
        /** The page's channel now, or null (never waits). */
        PeerChannel used();
        /** A stream heard nothing for a while: check the link now (a dead one ends, its streams get their 503). */
        void probe();
    }

    public static final String GATE_COOKIE = "autark_gate";
    static final int WINDOW = 256 * 1024;
    private static final int CHUNK = 32 * 1024;
    private static final long QUIET_MS = 4_000;
    /** How long a new stream waits for a channel: the page's socket (its own limit, OPEN_LIMIT_MS, is 5 s), any other request. */
    static final long SOCKET_WAIT_MS = 4_000, REQUEST_WAIT_MS = 20_000;
    private static final byte[] END = new byte[0];
    /** The channel died: a stream the PC has not answered yet answers 503 itself. */
    private static final byte[] DEAD = new byte[0];

    private final ServerSocket server;
    private final String gate;
    private final Channels channels;
    private final Map<PeerChannel, Map<Integer, Stream>> live = new ConcurrentHashMap<>();
    private final AtomicInteger nextId = new AtomicInteger(1);
    /** Moves of the page to another PC (retire), so a stream that raced one ends. */
    private final AtomicInteger moves = new AtomicInteger();
    /** Channels that gave way to a better one to the same PC: they close after their last stream. */
    private final Set<PeerChannel> draining = ConcurrentHashMap.newKeySet();
    private volatile boolean closed;

    /** Listens on 127.0.0.1:`port` (0 or a taken port: any free one). */
    public StreamProxy(int port, String gate, Channels channels) throws IOException {
        this.gate = gate;
        this.channels = channels;
        ServerSocket socket = new ServerSocket();
        try { socket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 32); }
        catch (IOException taken) { socket.close(); socket = new ServerSocket(); socket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 32); }
        server = socket;
        Thread accept = new Thread(this::acceptLoop, "autark-proxy");
        accept.setDaemon(true);
        accept.start();
    }

    public int port() { return server.getLocalPort(); }

    public String origin() { return "http://127.0.0.1:" + port(); }

    public void close() {
        closed = true;
        try { server.close(); } catch (IOException ignored) { /* closing */ }
    }

    /** Messages of a channel from the PC: the bytes and acknowledgements of this proxy's streams. */
    public void deliver(PeerChannel channel, Map<String, Object> message) {
        Map<Integer, Stream> streams = live.get(channel);
        if (streams == null) return;
        Stream stream = streams.get((int) Json.num(message, "s", -1));
        if (stream == null) return;
        String type = Json.str(message, "t");
        if ("d".equals(type)) {
            String b = Json.str(message, "b");
            if (b != null) stream.toLocal.offer(Base64.getDecoder().decode(b));
        } else if ("a".equals(type)) stream.acked(Json.num(message, "n", 0));
        else if ("e".equals(type)) stream.toLocal.offer(END);
    }

    /** The channel ended: its streams end (503 where the PC had not answered yet), the WebView reconnects on its own. */
    public void channelClosed(PeerChannel channel) {
        draining.remove(channel);
        Map<Integer, Stream> streams = live.remove(channel);
        if (streams != null) for (Stream stream : streams.values()) stream.toLocal.offer(DEAD);
    }

    /** The page moved to `keep` (B-084 M1): streams still on another PC's channel end there too (that PC hears it), so
     *  the page's sockets and phone use (phoneuse/UseLink) come back through `keep`; the other channels stay open. */
    public void retire(PeerChannel keep) {
        moves.incrementAndGet();
        for (Map.Entry<PeerChannel, Map<Integer, Stream>> entry : live.entrySet()) {
            if (entry.getKey() == keep) continue;
            for (Stream stream : new java.util.ArrayList<>(entry.getValue().values())) { stream.toLocal.offer(DEAD); stream.finish(true); }
        }
    }

    /** `old` gave way to a better channel to the same PC: its open streams run to their end, then it closes. */
    public void drain(PeerChannel old) {
        draining.add(old);
        closeIfDrained(old);
    }

    private void closeIfDrained(PeerChannel channel) {
        Map<Integer, Stream> streams = live.get(channel);
        if ((streams == null || streams.isEmpty()) && draining.remove(channel)) channel.close();
    }

    private static void unavailable(OutputStream out) throws IOException {
        byte[] body = "Your PC is not reachable right now. Autark must be running on it.".getBytes(StandardCharsets.UTF_8);
        out.write(("HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.write(body);
        out.flush();
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                Socket socket = server.accept();
                Thread worker = new Thread(() -> serve(socket), "autark-stream");
                worker.setDaemon(true);
                worker.start();
            } catch (IOException error) {
                if (closed) return;
            }
        }
    }

    private void serve(Socket socket) {
        try {
            socket.setTcpNoDelay(true);
            socket.setSoTimeout(15_000);
            InputStream in = socket.getInputStream();
            byte[] head = readHead(in);
            if (head == null || !hasGate(new String(head, StandardCharsets.ISO_8859_1))) {
                socket.getOutputStream().write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                socket.close();
                return;
            }
            socket.setSoTimeout(0);
            int moved = moves.get();
            PeerChannel channel = channels.await(upgrade(new String(head, StandardCharsets.ISO_8859_1)) ? SOCKET_WAIT_MS : REQUEST_WAIT_MS);
            if (channel == null || channel.isClosed()) {
                unavailable(socket.getOutputStream());
                socket.close();
                return;
            }
            Stream stream = new Stream(nextId.getAndIncrement(), channel, socket);
            live.computeIfAbsent(channel, key -> new ConcurrentHashMap<>()).put(stream.id, stream);
            if (channel.isClosed()) channelClosed(channel);
            if (moves.get() != moved && channels.used() != channel) { unavailable(socket.getOutputStream()); stream.finish(false); return; } // the page moved to another PC meanwhile: one PC per page
            channel.send(Json.map("t", "o", "s", stream.id));
            stream.start();
            RelayLink.LATER.schedule(() -> { if (!stream.answered && !stream.done) channels.probe(); }, QUIET_MS, TimeUnit.MILLISECONDS);
            stream.upload(head);
            byte[] buffer = new byte[CHUNK];
            for (;;) {
                int read = in.read(buffer);
                if (read < 0) break;
                byte[] chunk = new byte[read];
                System.arraycopy(buffer, 0, chunk, 0, read);
                if (!stream.upload(chunk)) break;
            }
            stream.finish(true);
        } catch (IOException | RuntimeException error) { // a failure on this thread ends this request, never the app
            try { socket.close(); } catch (IOException ignored) { /* closing */ }
        }
    }

    /** True for a WebSocket upgrade (the page's own socket). */
    static boolean upgrade(String head) {
        for (String line : head.split("\r\n")) {
            int colon = line.indexOf(':');
            if (colon > 0 && line.substring(0, colon).trim().equalsIgnoreCase("upgrade") && line.substring(colon + 1).trim().equalsIgnoreCase("websocket")) return true;
        }
        return false;
    }

    private boolean hasGate(String head) {
        for (String line : head.split("\r\n")) {
            int colon = line.indexOf(':');
            if (colon <= 0 || !line.substring(0, colon).trim().toLowerCase(Locale.ROOT).equals("cookie")) continue;
            for (String part : line.substring(colon + 1).split(";")) {
                String[] pair = part.trim().split("=", 2);
                if (pair.length == 2 && pair[0].equals(GATE_COOKIE) && constantEquals(pair[1], gate)) return true;
            }
        }
        return false;
    }

    private static boolean constantEquals(String a, String b) {
        return java.security.MessageDigest.isEqual(Crypto.sha256(Crypto.utf8(a)), Crypto.sha256(Crypto.utf8(b)));
    }

    /** The first request head (through the empty line), or null when it is not one. */
    private static byte[] readHead(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int matched = 0;
        while (matched < 4) {
            int b = in.read();
            if (b < 0 || head.size() > 32 * 1024) return null;
            head.write(b);
            matched = (b == (matched % 2 == 0 ? '\r' : '\n')) ? matched + 1 : (b == '\r' ? 1 : 0);
        }
        return head.toByteArray();
    }

    private final class Stream {
        final int id;
        final PeerChannel channel;
        final Socket socket;
        final LinkedBlockingQueue<byte[]> toLocal = new LinkedBlockingQueue<>();
        private long unacked;
        private volatile boolean done;
        /** The PC's first bytes reached the WebView. */
        volatile boolean answered;

        Stream(int id, PeerChannel channel, Socket socket) { this.id = id; this.channel = channel; this.socket = socket; }

        /** Bytes from the PC go to the WebView on a thread of their own; each written chunk is acknowledged. */
        void start() {
            Thread writer = new Thread(() -> {
                try {
                    OutputStream out = socket.getOutputStream();
                    for (;;) {
                        byte[] data = toLocal.take();
                        if (data == DEAD && !answered) unavailable(out);
                        if (data == END || data == DEAD) break;
                        answered = true;
                        out.write(data);
                        out.flush();
                        channel.send(Json.map("t", "a", "s", id, "n", data.length));
                    }
                } catch (IOException | InterruptedException | RuntimeException error) { /* the WebView closed it */ }
                finish(true);
            }, "autark-stream-out");
            writer.setDaemon(true);
            writer.start();
        }

        /** Sends bytes to the PC, waiting while WINDOW bytes are unacknowledged; false once the stream ended. */
        boolean upload(byte[] data) {
            synchronized (this) {
                while (!done && unacked >= WINDOW) {
                    try { wait(1_000); } catch (InterruptedException error) { Thread.currentThread().interrupt(); return false; }
                    if (channel.isClosed()) done = true;
                }
                if (done) return false;
                unacked += data.length;
            }
            channel.send(Json.map("t", "d", "s", id, "b", Base64.getEncoder().encodeToString(data)));
            return true;
        }

        synchronized void acked(long n) {
            unacked = Math.max(0, unacked - n);
            notifyAll();
        }

        void finish(boolean tell) {
            synchronized (this) {
                if (done && socket.isClosed()) return;
                done = true;
                notifyAll();
            }
            Map<Integer, Stream> streams = live.get(channel);
            boolean mine = streams != null && streams.remove(id) != null;
            if (tell && mine) channel.send(Json.map("t", "e", "s", id));
            toLocal.offer(END);
            try { socket.close(); } catch (IOException ignored) { /* closing */ }
            if (mine) closeIfDrained(channel);
        }
    }

    /** For a test or the status line: open streams over all channels. */
    public int openStreams() {
        int count = 0;
        for (Map<Integer, Stream> streams : live.values()) count += streams.size();
        return count;
    }
}
