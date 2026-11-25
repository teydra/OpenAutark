// Owns: the companies this phone is paired with (B-084) – one record per company {id, name, avatar, port, relay, seed,
// deviceId, token, pcs} in the prefs 'companies' plus the current one; the one-time move of 0.3.x's single 'pairing'
// record into c1 on port 47920 (its origin and web storage stay); one fixed local port per company (47920, 47921, …,
// never reused) so each company has its own origin; a new pairing that shares a PC fingerprint replaces that company's
// record; the list the page shows ({id, name, avatar?, current, pc?} – never a key or token).
// Never: depends on Android (the activity hands it two string stores), connects, or deletes web storage.
package com.teydralab.autark.android;

import com.teydralab.autark.android.relay.Json;
import com.teydralab.autark.android.relay.PhoneConnection;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class Companies {
    /** A string store (SharedPreferences in the app, a map in host tests); put(key, null) removes the key. */
    interface Store {
        String get(String key);
        void put(String key, String value);
    }

    static final int FIRST_PORT = 47920;
    static final int AVATAR_LIMIT = 16 * 1024;
    private static final String[] OLD_KEYS = { "relay", "seed", "deviceId", "token", "pcs", "pcFingerprint", "pcPublicKey", "pcName" };
    private final Store store;
    private final List<Map<String, Object>> list = new ArrayList<>();
    private String current;
    private int next;

    /** Loads the list; on the first start after 0.3.x it moves the old 'pairing' record (gate and askedNotifications stay there). */
    Companies(Store store, Store pairing) {
        this.store = store;
        Object saved = parse(store.get("list"));
        if (saved instanceof List) for (Object row : (List<?>) saved) if (row instanceof Map) list.add(row(row));
        current = store.get("current");
        next = (int) num(store.get("next"), list.size() + 1);
        if (store.get("list") == null) migrate(pairing);
        if (byId(current) == null) current = list.isEmpty() ? null : (String) list.get(0).get("id");
    }

    private void migrate(Store pairing) {
        String seed = pairing.get("seed");
        if (seed != null && !seed.isEmpty()) {
            List<PhoneConnection.Pc> pcs = PhoneConnection.Paired.pcsOf(parse(or(pairing.get("pcs"), "[]")));
            String oldFp = or(pairing.get("pcFingerprint"), ""); // 0.3.x before B-078: one PC
            if (pcs.isEmpty() && !oldFp.isEmpty()) pcs.add(new PhoneConnection.Pc(oldFp, or(pairing.get("pcPublicKey"), ""), or(pairing.get("pcName"), "PC"), ""));
            if (!pcs.isEmpty()) {
                next = 2;
                list.add(record("c1", FIRST_PORT, new PhoneConnection.Paired(or(pairing.get("relay"), ConnectionAddress.DEFAULT_RELAY), seed,
                        or(pairing.get("deviceId"), ""), or(pairing.get("token"), ""), pcs)));
                current = "c1";
            }
        }
        save();
        for (String key : OLD_KEYS) pairing.put(key, null);
    }

    String currentId() { return current; }

    /** The current company's pairing, or null when the phone is paired with none. */
    PhoneConnection.Paired current() { return paired(byId(current)); }

    /** The current company's local port (its own origin). */
    int port() { Map<String, Object> row = byId(current); return row == null ? FIRST_PORT : (int) num(row.get("port"), FIRST_PORT); }

    int size() { return list.size(); }

    /** The other companies as {id, name} rows – what the offline screen offers so a company out of reach is never a dead end. */
    List<String[]> others() {
        List<String[]> out = new ArrayList<>();
        for (Map<String, Object> row : list) {
            String id = (String) row.get("id");
            if (id.equals(current)) continue;
            String name = (String) row.get("name");
            List<PhoneConnection.Pc> pcs = pcs(row);
            out.add(new String[] { id, name == null || name.isEmpty() ? (pcs.isEmpty() ? "Company" : pcs.get(0).name) : name });
        }
        return out;
    }

    /** A finished pairing: the company that shares a PC fingerprint gets the new keys (same id, port, card), else a new one. Becomes current; returns its id. */
    String add(PhoneConnection.Paired paired) {
        Map<String, Object> same = null;
        for (Map<String, Object> row : list) for (PhoneConnection.Pc pc : pcs(row)) for (PhoneConnection.Pc fresh : paired.pcs)
            if (pc.fingerprint.equals(fresh.fingerprint)) same = row;
        if (same != null) {
            Map<String, Object> updated = record((String) same.get("id"), (int) num(same.get("port"), FIRST_PORT), paired);
            updated.put("name", same.get("name"));
            updated.put("avatar", same.get("avatar"));
            list.set(list.indexOf(same), updated);
            current = (String) same.get("id");
        } else {
            int n = Math.max(next, 1);
            next = n + 1;
            current = "c" + n;
            list.add(record(current, FIRST_PORT + n - 1, paired));
        }
        save();
        return current;
    }

    boolean setCurrent(String id) {
        if (byId(id) == null) return false;
        current = id;
        save();
        return true;
    }

    /** The PC list grew or changed (phoneUse.attach); id is the company whose connection reported it. */
    void setPcs(String id, List<PhoneConnection.Pc> pcs) {
        Map<String, Object> row = byId(id);
        if (row == null || pcs.isEmpty()) return;
        row.put("pcs", parse(paired(row).withPcs(pcs).pcsJson()));
        save();
    }

    /** The current company's card from its page: name (≤ 80 chars) and a small data:image picture (≤ 16 KB, else none). */
    void setCard(String name, String avatar) {
        Map<String, Object> row = byId(current);
        if (row == null) return;
        String clean = name == null ? "" : name.trim();
        row.put("name", clean.length() > 80 ? clean.substring(0, 80) : clean);
        row.put("avatar", avatar != null && avatar.startsWith("data:image/") && avatar.length() <= AVATAR_LIMIT ? avatar : null);
        save();
    }

    /** Removes one company; the first remaining one becomes current. Returns the new current id or null. */
    String remove(String id) {
        Map<String, Object> row = byId(id);
        if (row != null) list.remove(row);
        if (id != null && id.equals(current)) current = list.isEmpty() ? null : (String) list.get(0).get("id");
        save();
        return current;
    }

    /** What the page shows: [{id, name, avatar?, current, pc?}] – pc (the PC tunnelled to) only on the current one. */
    String listJson(String pcName) {
        List<Object> out = new ArrayList<>();
        for (Map<String, Object> row : list) {
            String id = (String) row.get("id");
            String name = (String) row.get("name");
            List<PhoneConnection.Pc> pcs = pcs(row);
            Map<String, Object> item = Json.map("id", id, "name", name == null || name.isEmpty() ? (pcs.isEmpty() ? "Company" : pcs.get(0).name) : name);
            if (row.get("avatar") instanceof String) item.put("avatar", row.get("avatar"));
            item.put("current", id.equals(current));
            if (id.equals(current) && pcName != null && !pcName.isEmpty()) item.put("pc", pcName);
            out.add(item);
        }
        return Json.write(out);
    }

    private Map<String, Object> record(String id, int port, PhoneConnection.Paired paired) {
        return Json.map("id", id, "name", "", "avatar", null, "port", port, "relay", paired.relay, "seed", paired.seed,
                "deviceId", paired.deviceId, "token", paired.token, "pcs", parse(paired.pcsJson()));
    }

    private static PhoneConnection.Paired paired(Map<String, Object> row) {
        if (row == null) return null;
        List<PhoneConnection.Pc> pcs = pcs(row);
        String seed = Json.str(row, "seed");
        if (seed == null || seed.isEmpty() || pcs.isEmpty()) return null;
        return new PhoneConnection.Paired(or(Json.str(row, "relay"), ConnectionAddress.DEFAULT_RELAY), seed, or(Json.str(row, "deviceId"), ""), or(Json.str(row, "token"), ""), pcs);
    }

    private static List<PhoneConnection.Pc> pcs(Map<String, Object> row) {
        Object raw = row.get("pcs");
        List<PhoneConnection.Pc> valid = PhoneConnection.Paired.pcsOf(raw);
        if (!valid.isEmpty() || !(raw instanceof List)) return valid;
        // The 0.3.x single-PC record has no public key yet; keep its fingerprint so it still connects and dedupes.
        List<PhoneConnection.Pc> out = new ArrayList<>();
        for (Object item : (List<?>) raw) if (item instanceof Map) {
            @SuppressWarnings("unchecked") Map<String, Object> pc = (Map<String, Object>) item;
            String fp = Json.str(pc, "fingerprint");
            if (fp != null && fp.matches("[0-9a-f]{64}")) out.add(new PhoneConnection.Pc(fp, or(Json.str(pc, "publicKey"), ""), Json.str(pc, "name"), Json.str(pc, "deviceId")));
        }
        return out;
    }

    private Map<String, Object> byId(String id) {
        if (id == null) return null;
        for (Map<String, Object> row : list) if (id.equals(row.get("id"))) return row;
        return null;
    }

    private void save() {
        store.put("list", Json.write(list));
        store.put("current", current);
        store.put("next", String.valueOf(next));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> row(Object value) { return new LinkedHashMap<>((Map<String, Object>) value); }

    private static Object parse(String text) {
        if (text == null) return null;
        try { return Json.parse(text); } catch (IllegalArgumentException error) { return null; }
    }

    private static long num(Object value, long fallback) {
        if (value instanceof Number) return ((Number) value).longValue();
        if (value instanceof String) try { return Long.parseLong((String) value); } catch (NumberFormatException error) { return fallback; }
        return fallback;
    }

    private static String or(String value, String fallback) { return value == null ? fallback : value; }
}
