// Owns: the static half of PhoneConnection (B-084 split, kept out so that file stays under 300 lines) – pairing a new
// phone key with a PC under its Remote ID (the PC's own connect request with role "phone", relay/RemotePair), reading
// the pinned PCs back from storage or phoneUse.attach (F29: with their direct addresses), and whether two lists pin the
// same PCs.
// Never: keeps state, stores anything, or reaches a PC outside the pairing request.
package com.teydralab.autark.android.relay;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

final class PhonePairing {
    private PhonePairing() {}

    static PhoneConnection.Paired pair(String relay, String remoteId, String name, PhoneConnection.Pairing pairing, PhoneConnection.Codes codes) throws IOException {
        String id = remoteId.replaceAll("[\\s-]", "");
        if (!id.matches("\\d{9}")) throw new IOException("The Remote ID has nine digits.");
        byte[] seed = Crypto.newSeed();
        RelayLink link = new RelayLink(seed, Collections.emptyMap(), new RelayLink.Events() {
            @Override public void presence(boolean online) {}
            @Override public void down(String reason) {}
        });
        pairing.link = link;
        try {
            link.connect(relay);
            List<RelayLink.Found> found = link.find(id);
            if (found.isEmpty()) throw new IOException("No PC with this Remote ID is online at the meeting server. Is Autark running there and accepting connection requests?");
            RelayLink.Found pc = found.get(0); // any PC online under this ID will do – the meeting server lists them in turns (0.3.20); the person accepts on a PC either way
            RemotePair exchange = new RemotePair((body, timeoutMs) -> link.request(pc, Json.map("op", "pair", "body", body), timeoutMs), seed, RemotePair.newDeviceId(), name);
            RemotePair.Asked asked = exchange.ask(id, pc.fingerprint);
            codes.code(asked.code, asked.pcName);
            RemotePair.Accepted accepted = exchange.await(asked, () -> pairing.cancelled);
            List<PhoneConnection.Pc> pcs = new ArrayList<>();
            pcs.add(new PhoneConnection.Pc(pc.fingerprint, Crypto.b64url(pc.publicKey), asked.pcName, asked.pcDeviceId));
            return new PhoneConnection.Paired(relay, Crypto.b64url(seed), accepted.deviceId, accepted.token, pcs);
        } finally {
            link.close();
        }
    }

    /** PCs from storage JSON or from phoneUse.attach's `pcs` (keys fingerprint, publicKey, name, deviceId); bad rows are skipped. */
    static List<PhoneConnection.Pc> pcsOf(Object value) {
        List<PhoneConnection.Pc> out = new ArrayList<>();
        if (!(value instanceof List)) return out;
        for (Object item : (List<?>) value) {
            if (!(item instanceof Map) || out.size() >= 16) continue;
            @SuppressWarnings("unchecked") Map<String, Object> row = (Map<String, Object>) item;
            String fp = Json.str(row, "fingerprint"), pub = Json.str(row, "publicKey");
            if (fp == null || pub == null || !fp.matches("[0-9a-f]{64}")) continue;
            try { if (!Crypto.fingerprint(Crypto.fromB64url(pub)).equals(fp)) continue; } catch (IllegalArgumentException error) { continue; }
            out.add(new PhoneConnection.Pc(fp, pub, Json.str(row, "name"), Json.str(row, "deviceId"), addressesOf(row.get("addresses"))));
        }
        return out;
    }

    /** F29: a PC's direct addresses (http(s) base URLs DirectPipe can dial, at most 8); anything else is skipped. */
    static List<String> addressesOf(Object value) {
        List<String> out = new ArrayList<>();
        if (!(value instanceof List)) return out;
        for (Object item : (List<?>) value) {
            if (item instanceof String && DirectPipe.url((String) item) != null && !out.contains(item) && out.size() < DirectPipe.MAX_ADDRESSES) out.add((String) item);
        }
        return out;
    }

    /** True when both lists pin the same PC keys (order and names aside). */
    static boolean samePins(List<PhoneConnection.Pc> a, List<PhoneConnection.Pc> b) {
        java.util.Set<String> x = new java.util.HashSet<>(), y = new java.util.HashSet<>();
        for (PhoneConnection.Pc pc : a) x.add(pc.fingerprint + " " + pc.publicKey);
        for (PhoneConnection.Pc pc : b) y.add(pc.fingerprint + " " + pc.publicKey);
        return x.equals(y);
    }
}
