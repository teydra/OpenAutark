// Owns: the phone's reconnect pieces on a host JVM against a loopback stand-in (B-084) – the backoff steps, every frame
// (pings included) counting as traffic, kill() freeing a writer stuck in a send, probe() ending a silent meeting-server
// connection within 2 s and leaving an answering one up, and check() cutting a long backoff short.
// Never: a network test against the real meeting server or a claim about Android's own sockets (a phone does that).
package com.teydralab.autark.android.relay;

import java.io.IOException;
import java.net.Socket;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public final class ReconnectTest {
    private static int assertions;

    public static void main(String[] args) throws Exception {
        backoff();
        pingsCount();
        killFreesStuckWriter(false);
        killFreesStuckWriter(true); // close() (the UI thread's company switch, forget, cancel) never waits for the stuck send
        probe(FakeWs.Mode.RELAY_SILENT, false);
        probe(FakeWs.Mode.RELAY_ANSWERS, true);
        checkCutsBackoff();
        System.out.println(assertions + " reconnect assertions passed.");
    }

    private static void backoff() {
        long[] behind = { 500, 1_000, 2_000, 5_000, 10_000, 10_000, 10_000 };
        long[] front = { 500, 1_000, 2_000, 2_000, 2_000, 2_000, 2_000 }; // owner 27.11.2026: in front the steps stay short
        for (int i = 0; i < behind.length; i++) {
            check(PhoneConnection.backoff(i, false) == behind[i], "backoff step " + i + " behind");
            check(PhoneConnection.backoff(i, true) == front[i], "backoff step " + i + " in front");
        }
    }

    private static WebSocketClient.Listener quiet(AtomicInteger closes) {
        return new WebSocketClient.Listener() {
            @Override public void text(String text) {}
            @Override public void binary(byte[] data) {}
            @Override public void closed(String reason) { closes.incrementAndGet(); }
        };
    }

    /** A server ping moves lastFrameAt and is answered with a pong; the client's own ping reaches the server. */
    private static void pingsCount() throws Exception {
        try (FakeWs server = new FakeWs(FakeWs.Mode.UPGRADE_ONLY)) {
            AtomicInteger closes = new AtomicInteger();
            WebSocketClient client = WebSocketClient.connect(server.url(), quiet(closes));
            Socket socket = waitFor(server);
            long before = client.lastFrameAt();
            Thread.sleep(30);
            FakeWs.send(socket, 0x9, new byte[] { 7 });
            java.io.DataInputStream in = new java.io.DataInputStream(socket.getInputStream());
            int[] op = new int[1];
            byte[] pong = FakeWs.read(in, op);
            check(op[0] == 0xA && pong.length == 1 && pong[0] == 7, "the client answers a ping with its pong");
            check(client.lastFrameAt() > before, "a ping counts as a frame");
            client.ping();
            FakeWs.read(in, op);
            check(op[0] == 0x9, "ping() sends a ping");
            client.kill();
            client.kill();
            check(client.isClosed() && closes.get() == 1, "kill() ends once and tells the listener once");
        }
    }

    /** A writer blocked in a send (the server never reads) fails as soon as kill() runs, without the send lock. */
    private static void killFreesStuckWriter(boolean polite) throws Exception {
        try (FakeWs server = new FakeWs(FakeWs.Mode.UPGRADE_ONLY)) {
            AtomicInteger closes = new AtomicInteger();
            WebSocketClient client = WebSocketClient.connect(server.url(), quiet(closes));
            waitFor(server);
            AtomicInteger sent = new AtomicInteger();
            CountDownLatch ended = new CountDownLatch(1);
            Thread writer = new Thread(() -> {
                byte[] chunk = new byte[60 * 1024];
                try { for (;;) { client.sendBinary(chunk); sent.incrementAndGet(); } }
                catch (IOException expected) { ended.countDown(); }
            });
            writer.setDaemon(true);
            writer.start();
            int seen = -1;
            long until = System.currentTimeMillis() + 20_000;
            while (seen != sent.get() && System.currentTimeMillis() < until) { seen = sent.get(); Thread.sleep(400); }
            check(seen == sent.get(), "the writer got stuck once the buffers were full (" + seen + " frames)");
            long killed = System.currentTimeMillis();
            if (polite) client.close(); else client.kill();
            String how = polite ? "close()" : "kill()";
            check(ended.await(2, TimeUnit.SECONDS), "the stuck writer failed after " + how);
            check(System.currentTimeMillis() - killed < 2_000 && closes.get() == 1, how + " returned without waiting for the writer");
        }
    }

    /** probe(): a silent server connection ends within ~2 s, an answering one stays up. */
    private static void probe(FakeWs.Mode mode, boolean stays) throws Exception {
        try (FakeWs server = new FakeWs(mode)) {
            CountDownLatch down = new CountDownLatch(1);
            RelayLink link = new RelayLink(Crypto.newSeed(), Collections.emptyMap(), new RelayLink.Events() {
                @Override public void presence(boolean online) {}
                @Override public void down(String reason) { down.countDown(); }
            });
            link.connect(server.url());
            check(link.isUp(), "the link registered with the stand-in");
            long asked = System.currentTimeMillis();
            link.probe();
            boolean ended = down.await(RelayLink.PROBE_MS + 1_500, TimeUnit.MILLISECONDS);
            if (stays) check(!ended && link.isUp(), "an answering link stays up after probe()");
            else check(ended && System.currentTimeMillis() - asked >= RelayLink.PROBE_MS - 50, "a silent link ends about 2 s after probe() (ended " + ended + " after " + (System.currentTimeMillis() - asked) + " ms)");
            link.close();
        }
    }

    /** After several failed tries the next one waits 5 s; check() makes it happen at once. */
    private static void checkCutsBackoff() throws Exception {
        try (FakeWs server = new FakeWs(FakeWs.Mode.REFUSE)) {
            byte[] pcSeed = Crypto.newSeed();
            byte[] pcPub = Crypto.ed25519Public(pcSeed);
            List<PhoneConnection.Pc> pcs = Collections.singletonList(new PhoneConnection.Pc(Crypto.fingerprint(pcPub), Crypto.b64url(pcPub), "Test PC", "dev_pc"));
            PhoneConnection.Paired paired = new PhoneConnection.Paired(server.url(), Crypto.b64url(Crypto.newSeed()), "dev_phone", "token", pcs);
            AtomicReference<String> status = new AtomicReference<>("");
            PhoneConnection connection = new PhoneConnection(paired, (text, connected) -> status.set(text));
            connection.front(false); // behind: the long steps (in front they stop at 2 s)
            connection.start(0, "gate");
            try {
                for (int i = 0; i < 4; i++) check(server.acceptTimes.poll(6, TimeUnit.SECONDS) != null, "try " + (i + 1) + " reached the stand-in");
                long fourth = System.currentTimeMillis(); // the next pause is 5 s
                Thread.sleep(200);
                connection.check();
                Long next = server.acceptTimes.poll(3, TimeUnit.SECONDS);
                check(next != null && next - fourth < 1_500, "check() tried again at once instead of after 5 s");
                check(connection.pcName() == null, "no channel, no PC name");
            } finally {
                connection.stop();
            }
        }
    }

    private static Socket waitFor(FakeWs server) throws InterruptedException {
        for (int i = 0; i < 100 && server.last == null; i++) Thread.sleep(20);
        Thread.sleep(50); // the upgrade answer is written right after accept
        return server.last;
    }

    private static void check(boolean condition, String what) {
        assertions++;
        if (!condition) throw new AssertionError(what);
    }
}
