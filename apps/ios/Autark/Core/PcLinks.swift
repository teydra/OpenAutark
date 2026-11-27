// Owns: the phone's channels to the PCs of its company – one per pinned PC that is online, at most `cap` – with the pause
// before a failed PC is tried again (PhoneConnection.backoff per PC, short while the app is in front; a minute once the backoff
// ran out while another channel is up) and which one the page uses (owner 27.11.2026: no PC picker, every PC is the same): the
// first channel that is up, in the phone's order; the page stays on it for as long as it is open, and when it drops the page goes
// to the next open one at once – no version ranks a PC, no later or newer PC takes the page off an open channel. A PC that
// refused the page's token (refuse) is passed over for as long as another linked PC has not refused – each PC refuses at most
// once per connection, so the page never circles; with every linked PC refused, the page stays where it is ('Not paired').
// Ported from relay/PcLinks.java.
// Never: opens or closes a channel itself (PhoneConnection does), or knows what a channel is beyond "closed".
import Foundation

public final class PcLinks<C> {
    /// Channels kept at once: idle tunnels over the one meeting-server socket, a handful of bytes each per ping.
    public static var cap: Int { 8 }
    /// The backoff's steps (0.5 … 10 s); after them a PC that still fails while another channel is up waits `spareMs`.
    private static var backoffSteps: Int { 5 }
    public static var spareMs: Int64 { 60_000 }

    private let closed: (C) -> Bool
    private let lock = NSRecursiveLock()
    private var order = [String]()
    private var channels = [String: C]()
    private var fails = [String: Int]()
    private var retryAt = [String: Int64]()
    private var refused = Set<String>()
    private var used: String?

    public init(closed: @escaping (C) -> Bool) { self.closed = closed }

    /// `fp` refused the page's token; true when that is news (nil: no PC, nothing changes).
    public func refuse(_ fp: String?) -> Bool {
        guard let fp = fp else { return false }
        lock.lock(); defer { lock.unlock() }
        return refused.insert(fp).inserted
    }

    /// A new channel to `fp`.
    public func put(_ fp: String, _ channel: C) {
        lock.lock(); defer { lock.unlock() }
        if channels[fp] == nil { order.append(fp) }
        channels[fp] = channel
        fails[fp] = nil
        retryAt[fp] = nil
    }

    /// Opening a channel to `fp` failed: it waits its backoff (short while the app is in front) before the next try.
    public func failed(_ fp: String, now: Int64, front: Bool) {
        lock.lock(); defer { lock.unlock() }
        let count = (fails[fp] ?? 0) + 1
        fails[fp] = count
        let spare = count > PcLinks.backoffSteps && live() > 0 // the page has a PC: a PC that keeps failing never keeps the radio awake
        retryAt[fp] = now + (spare ? PcLinks.spareMs : PhoneConnection.backoff(count - 1, front: front))
    }

    /// Forgets closed channels; returns the open ones of PCs that are no longer pinned (the caller closes them).
    public func prune(pinned: [String]) -> [C] {
        lock.lock(); defer { lock.unlock() }
        var gone = [C]()
        for fp in order {
            guard let channel = channels[fp] else { continue }
            if closed(channel) { drop(fp) }
            else if !pinned.contains(fp) { drop(fp); gone.append(channel) }
        }
        return gone
    }

    private func drop(_ fp: String) {
        channels[fp] = nil
        order.removeAll { $0 == fp }
    }

    /// The PCs in `order` to open a channel to now: online, without one, due, and within the cap.
    public func toOpen(order wanted: [String], online: (String) -> Bool, now: Int64) -> [String] {
        lock.lock(); defer { lock.unlock() }
        var out = [String]()
        let room = PcLinks.cap - live()
        for fp in wanted {
            if out.count >= room { break }
            let at = retryAt[fp]
            if live(fp) || !online(fp) || (at != nil && at! > now) { continue }
            out.append(fp)
        }
        return out
    }

    /// Milliseconds until the next failed PC is due (Int64.max when none waits).
    public func nextRetry(now: Int64) -> Int64 {
        lock.lock(); defer { lock.unlock() }
        var next = Int64.max
        for at in retryAt.values where at > now { next = min(next, at - now) }
        return next
    }

    /// The app came back, the network changed or a PC came online: every failed PC is due again, its backoff starts over.
    public func retryNow() {
        lock.lock(); defer { lock.unlock() }
        fails.removeAll()
        retryAt.removeAll()
    }

    /// Settles the page's PC (see the header) and returns its channel, or nil when none is up.
    public func pick(order wanted: [String]) -> C? {
        lock.lock(); defer { lock.unlock() }
        var willing = false // a linked PC that has not refused the page's token
        for fp in wanted { willing = willing || (live(fp) && !refused.contains(fp)) }
        if let current = used, usable(current, willing) { return channels[current] } // the page stays on an open channel (also when every linked PC refused)
        used = nil
        for fp in wanted where usable(fp, willing) { used = fp; break }
        guard let current = used else { return nil }
        return channels[current]
    }

    /// Linked, and not refused while another linked PC has not refused.
    private func usable(_ fp: String, _ willing: Bool) -> Bool { live(fp) && !(willing && refused.contains(fp)) }

    /// The page's channel now (open), or nil.
    public func usedChannel() -> C? {
        lock.lock(); defer { lock.unlock() }
        guard let fp = used, live(fp) else { return nil }
        return channels[fp]
    }

    /// The page's PC now, or nil.
    public func usedPc() -> String? {
        lock.lock(); defer { lock.unlock() }
        guard let fp = used, live(fp) else { return nil }
        return fp
    }

    /// True when the channel to `fp` is open.
    public func live(_ fp: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let channel = channels[fp] else { return false }
        return !closed(channel)
    }

    /// Open channels.
    public func live() -> Int {
        lock.lock(); defer { lock.unlock() }
        return channels.values.filter { !closed($0) }.count
    }

    /// Every channel kept (stop() closes them).
    public func all() -> [C] {
        lock.lock(); defer { lock.unlock() }
        return order.compactMap { channels[$0] }
    }
}
