// Owns: the phone's channels to the PCs of its company (B-084 M1) – one per pinned PC that is online, at most CAP – with
// the pause before a failed PC is tried again (PhoneConnection.backoff per PC,
// short while the app is in front; a minute once the backoff ran out while another channel is up) and which one the
// page uses (owner 27.11.2026: no PC picker, every PC is the same): the first channel that is up, in the phone's order;
// the page stays on it for as long as it is open, and when it drops the page goes to the next open one at once. A PC
// that refused the page's token (refuse) is passed over for as long as another linked PC has not refused – each PC
// refuses at most once per connection, so the page never circles; with every linked PC refused, the page stays where
// it is (it says 'Not paired').
// Never: opens or closes a channel itself (PhoneConnection does), or knows what a channel is beyond "closed".
package com.teydralab.autark.android.relay;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;

final class PcLinks<C> {
    /** Channels kept at once: idle tunnels over the one meeting-server socket, a handful of bytes each per ping. */
    static final int CAP = 8;
    /** The backoff's steps (0.5 … 10 s); after them a PC that still fails while another channel is up waits SPARE_MS. */
    private static final int BACKOFF_STEPS = 5;
    static final long SPARE_MS = 60_000;

    private final Predicate<C> closed;
    private final Map<String, C> channels = new LinkedHashMap<>();
    private final Map<String, Integer> fails = new HashMap<>();
    private final Map<String, Long> retryAt = new HashMap<>();
    private final Set<String> refused = new HashSet<>();
    private String used;

    PcLinks(Predicate<C> closed) { this.closed = closed; }

    /** `fp` refused the page's token; true when that is news (null: no PC, nothing changes). */
    synchronized boolean refuse(String fp) { return fp != null && refused.add(fp); }

    /** A new channel to `fp`. */
    synchronized void put(String fp, C channel) {
        channels.put(fp, channel);
        fails.remove(fp);
        retryAt.remove(fp);
    }

    /** Opening a channel to `fp` failed: it waits its backoff (short while the app is in front) before the next try. */
    synchronized void failed(String fp, long now, boolean front) {
        int count = fails.merge(fp, 1, Integer::sum);
        boolean spare = count > BACKOFF_STEPS && live() > 0; // the page has a PC: a PC that keeps failing never keeps the radio awake
        retryAt.put(fp, now + (spare ? SPARE_MS : PhoneConnection.backoff(count - 1, front)));
    }

    /** Forgets closed channels; returns the open ones of PCs that are no longer pinned (the caller closes them). */
    synchronized List<C> prune(List<String> pinned) {
        List<C> gone = new ArrayList<>();
        for (String fp : new ArrayList<>(channels.keySet())) {
            C channel = channels.get(fp);
            if (closed.test(channel)) channels.remove(fp);
            else if (!pinned.contains(fp)) { channels.remove(fp); gone.add(channel); }
        }
        return gone;
    }

    /** The PCs in `order` to open a channel to now: online, without one, due, and within CAP. */
    synchronized List<String> toOpen(List<String> order, Predicate<String> online, long now) {
        List<String> out = new ArrayList<>();
        int room = CAP - live();
        for (String fp : order) {
            if (out.size() >= room) break;
            Long at = retryAt.get(fp);
            if (live(fp) || !online.test(fp) || (at != null && at > now)) continue;
            out.add(fp);
        }
        return out;
    }

    /** Milliseconds until the next failed PC is due (Long.MAX_VALUE when none waits). */
    synchronized long nextRetry(long now) {
        long next = Long.MAX_VALUE;
        for (long at : retryAt.values()) if (at > now) next = Math.min(next, at - now);
        return next;
    }

    /** The app came back, the network changed or a PC came online: every failed PC is due again, its backoff starts over. */
    synchronized void retryNow() { fails.clear(); retryAt.clear(); }

    /** Settles the page's PC (see the header) and returns its channel, or null when none is up. */
    synchronized C pick(List<String> order) {
        boolean willing = false; // a linked PC that has not refused the page's token
        for (String fp : order) willing |= live(fp) && !refused.contains(fp);
        if (used != null && usable(used, willing)) return channels.get(used); // the page stays on an open channel
        used = null;
        for (String fp : order) if (usable(fp, willing)) { used = fp; break; }
        return used == null ? null : channels.get(used);
    }

    /** Linked, and not refused while another linked PC has not refused. */
    private boolean usable(String fp, boolean willing) {
        return live(fp) && !(willing && refused.contains(fp));
    }

    /** The page's channel now (open), or null. */
    synchronized C used() { return used != null && live(used) ? channels.get(used) : null; }

    /** The page's PC now, or null. */
    synchronized String usedPc() { return used != null && live(used) ? used : null; }

    /** True when the channel to `fp` is open. */
    synchronized boolean live(String fp) {
        C channel = channels.get(fp);
        return channel != null && !closed.test(channel);
    }

    /** Open channels. */
    synchronized int live() {
        int count = 0;
        for (C channel : channels.values()) if (!closed.test(channel)) count++;
        return count;
    }

    /** Every channel kept (stop() closes them). */
    synchronized List<C> all() { return new ArrayList<>(channels.values()); }
}
