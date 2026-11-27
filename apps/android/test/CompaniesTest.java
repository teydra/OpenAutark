// Owns: executable checks of the phone's company list (B-084) with a map as the store – the 0.3.x 'pairing' move to c1
// on port 47920, one never-reused port per company, the replace-by-PC-fingerprint rule, cards, remove and the page list
// without keys or tokens. Never: claims SharedPreferences or WebView behaviour.
package com.teydralab.autark.android;

import com.teydralab.autark.android.relay.Crypto;
import com.teydralab.autark.android.relay.Json;
import com.teydralab.autark.android.relay.PhoneConnection;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class CompaniesTest {
    private static int assertions;

    static final class MapStore implements Companies.Store {
        final Map<String, String> values = new HashMap<>();
        @Override public String get(String key) { return values.get(key); }
        @Override public void put(String key, String value) { if (value == null) values.remove(key); else values.put(key, value); }
    }

    public static void main(String[] args) {
        PhoneConnection.Pc a = pc("PC A"), b = pc("PC B"), c = pc("PC C");

        // 0.3.x: one 'pairing' record becomes c1 on the old port; gate and askedNotifications stay where they were.
        MapStore old = new MapStore(), store = new MapStore();
        PhoneConnection.Paired first = new PhoneConnection.Paired("wss://relay.test", "seed1", "dev_1", "tok1", Arrays.asList(a));
        old.put("relay", first.relay); old.put("seed", first.seed); old.put("deviceId", first.deviceId); old.put("token", first.token);
        old.put("pcs", first.pcsJson()); old.put("gate", "g"); old.put("askedNotifications", "true");
        Companies companies = new Companies(store, old);
        equal("c1", companies.currentId());
        equal(47920, companies.port());
        equal("seed1", companies.current().seed);
        equal("tok1", companies.current().token);
        equal(a.fingerprint, companies.current().pcs.get(0).fingerprint);
        check(old.get("seed") == null && old.get("pcs") == null && old.get("token") == null);
        equal("g", old.get("gate"));
        equal("true", old.get("askedNotifications"));

        // A reload reads the same list and does not migrate twice.
        old.put("seed", "stale");
        companies = new Companies(store, old);
        equal("seed1", companies.current().seed);
        equal(1, companies.size());

        // 0.3.x before B-078: a single PC by fingerprint.
        MapStore older = new MapStore();
        older.put("seed", "s0"); older.put("pcFingerprint", a.fingerprint); older.put("pcPublicKey", a.publicKey); older.put("pcName", "Old PC");
        Companies legacy = new Companies(new MapStore(), older);
        equal("Old PC", legacy.current().pcs.get(0).name);
        check(older.get("pcFingerprint") == null);

        // A second company: own id and the next port; it becomes current.
        String second = companies.add(new PhoneConnection.Paired("wss://relay.test", "seed2", "dev_2", "tok2", Arrays.asList(b)));
        equal("c2", second);
        equal(47921, companies.port());
        equal(2, companies.size());

        // Pairing again with a PC that c1 already has replaces c1's keys and keeps its id, port and card.
        check(companies.setCurrent("c1"));
        companies.setCard("Teydra Lab", "data:image/jpeg;base64,AAAA");
        companies.setCurrent("c2");
        String again = companies.add(new PhoneConnection.Paired("wss://relay.test", "seed1b", "dev_1b", "tok1b", Arrays.asList(c, a)));
        equal("c1", again);
        equal(2, companies.size());
        equal(47920, companies.port());
        equal("seed1b", companies.current().seed);
        check(companies.listJson(null).contains("\"name\":\"Teydra Lab\""));

        // Cards: name is trimmed and capped; a picture over 16 KB or not data:image is dropped.
        companies.setCard("  Long  ", "https://evil.test/x.png");
        check(!companies.listJson(null).contains("evil.test"));
        companies.setCard("Big", "data:image/png;base64," + repeat('A', Companies.AVATAR_LIMIT));
        check(!companies.listJson(null).contains("data:image/png"));
        companies.setCard(repeat('n', 100), null);
        check(companies.listJson(null).contains("\"name\":\"" + repeat('n', 80) + "\""));

        // PCs grow for the company whose connection reported them; empty lists change nothing.
        companies.setPcs("c2", Arrays.asList(b, pc("PC D")));
        companies.setCurrent("c2");
        equal(2, companies.current().pcs.size());
        companies.setPcs("c2", new ArrayList<>());
        equal(2, companies.current().pcs.size());
        check(!companies.setCurrent("c9"));
        equal("c2", companies.currentId());

        // The page list: current ticked, the PC name only on the current one, never a seed or token; unnamed → first PC's name.
        String list = companies.listJson("Büro-PC");
        @SuppressWarnings("unchecked") List<Object> rows = (List<Object>) Json.parse(list);
        equal(2, rows.size());
        Map<?, ?> row2 = (Map<?, ?>) rows.get(1);
        equal("c2", row2.get("id"));
        equal(Boolean.TRUE, row2.get("current"));
        equal("Büro-PC", row2.get("pc"));
        equal("PC B", row2.get("name"));
        check(((Map<?, ?>) rows.get(0)).get("pc") == null);
        check(!list.contains("seed") && !list.contains("tok") && !list.contains("dev_"));

        // Remove: the first remaining one becomes current; a removed port is never handed out again.
        equal("c1", companies.remove("c2"));
        String third = companies.add(new PhoneConnection.Paired("wss://relay.test", "seed3", "dev_3", "tok3", Arrays.asList(pc("PC E"))));
        equal("c3", third);
        equal(47922, companies.port());
        companies = new Companies(store, old);
        equal("c3", companies.currentId());
        equal(47922, companies.port());
        companies.remove("c3");
        equal("c1", companies.remove("missing"));
        equal(null, companies.remove("c1"));
        check(companies.current() == null);
        equal(47920, companies.port());

        // A fresh phone starts at c1 on 47920.
        Companies fresh = new Companies(new MapStore(), new MapStore());
        check(fresh.current() == null);
        equal("c1", fresh.add(new PhoneConnection.Paired("wss://relay.test", "s", "d", "t", Arrays.asList(a))));
        equal(47920, fresh.port());
        // The preview takes its own run of ports, so it runs beside the released app (S9, 27.11.2026).
        Companies preview = new Companies(new MapStore(), new MapStore(), Companies.PREVIEW_FIRST_PORT);
        preview.add(new PhoneConnection.Paired("wss://relay.test", "s", "d", "t", Arrays.asList(a)));
        equal(47520, preview.port());
        preview.add(new PhoneConnection.Paired("wss://relay.test", "s2", "d2", "t2", Arrays.asList(b)));
        equal(47521, preview.port());
        System.out.println(assertions + " company list assertions passed.");
    }

    private static PhoneConnection.Pc pc(String name) {
        byte[] key = Crypto.random(32);
        return new PhoneConnection.Pc(Crypto.fingerprint(key), Crypto.b64url(key), name, "dev_" + name.replace(" ", ""));
    }

    private static String repeat(char c, int n) { char[] out = new char[n]; Arrays.fill(out, c); return new String(out); }

    private static void equal(Object expected, Object actual) {
        assertions++;
        if (expected == null ? actual != null : !expected.equals(actual)) throw new AssertionError("expected " + expected + " but got " + actual);
    }

    private static void check(boolean condition) {
        assertions++;
        if (!condition) throw new AssertionError("check failed");
    }
}
