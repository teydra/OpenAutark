// Owns: keeping an encrypted channel to EVERY PC of the company that is online (at most PcLinks.cap), each a tunnel through
// the one meeting-server connection – the phone belongs to the company, not to one PC: it pins every PC it knows, reconnects at
// once after the server or a PC went away and, when a try fails, with backoff per PC (0.5 s … 2 s while the app is in front,
// front(); up to 10 s behind; a PC that comes online is tried at once), and hands the local entrance (StreamProxy) the channel the
// page uses (PcLinks: the first one up – owner 27.11.2026, no PC picker; the page takes it as soon as it is up, not after the
// round's other PCs, and a slow PC never holds a waiting request past its wait); when that PC drops, the page moves to another
// channel at once and its old streams end. check() (foreground, network change) resets the backoff and probes the link at once;
// onLinked hears the page reach another PC, or its PC again after its channel ended (the page then hears 'resume'); refused() (the
// PC refused the page's token) moves the page to a PC of the company that has not refused while this connection lives.
// A better way to the same PC never cuts the page (owner 27.11.2026): the streams open on the old way run to their end and only new
// streams take the new one (StreamProxy.drain).
// F29 (direct way): a channel goes straight to the PC whenever one of its addresses (from the pairing or the PC's own phone.pcs
// answer, PcList, kept with the PC) answers – Route races them and falls back to the tunnel, the same pinned handshake either way; the
// direct socket replaces that PC's tunnel. After check() (foreground, network change) the page's PC, if reached through the tunnel,
// is tried directly once and a direct channel takes its place (home Wi-Fi while mobile data stays up); the tunnel drains and closes. The
// page's PC is asked for its PC list (addresses, new PCs) after every move of the page and every check(), because iOS has no
// phoneUse.attach.
// W: wakePc() sends a closed PC's wake over the same meeting-server link (Wake) – it needs no PC online, only the foreground app.
// Ported from relay/PhoneConnection.java, without WebRTC (RtcWay/PageRtc: a placeholder in Rtc.swift).
// Never: stores anything itself (the caller keeps Paired), polls the PC, or talks to a PC it does not pin.
import Foundation

public typealias StatusHandler = (_ text: String, _ connected: Bool) -> Void

public final class PhoneConnection: Channels, RelayEvents {
    private static let backoffMs: [Int64] = [500, 1_000, 2_000, 5_000, 10_000]
    private static let listMs = 4_000
    /// The longest pause between tries while the app is in front.
    public static let frontMs: Int64 = 2_000

    /// The pause after `attempt` failed tries in a row (at most `frontMs` while the app is in front).
    public static func backoff(_ attempt: Int, front: Bool) -> Int64 {
        let step = backoffMs[max(0, min(attempt, backoffMs.count - 1))]
        return front ? min(step, frontMs) : step
    }

    private let seed: Bytes
    private let status: StatusHandler
    private let connector: WebSocketConnector
    private let condition = NSCondition()
    private let state = NSLock()
    private var pairedValue: Paired
    private var proxy: StreamProxy?
    private var link: RelayLink?
    private let links = PcLinks<PeerChannel>(closed: { $0.isClosed })
    /// The page's channel and PC the loop announced last (loop thread).
    private var shown: PeerChannel?
    private var shownPc: String?
    /// The app is in front: the pauses between tries stay short.
    private var inFront = true
    private var stopped = false
    private var wake = false
    private var attempt = 0
    private var probeNow = false
    private var linkedHandler: (() -> Void)?
    private var lastStatus = ""
    private var started = false
    private var pageChannelHandler: ((String) -> Void)?
    private var pcsHandler: (([Pc]) -> Void)?
    /// After check(): the page's PC, reached through the tunnel, is tried directly once.
    private var directNow = false
    /// The page's PC is asked for its PC list (after a move of the page and after check()).
    private var listNow = false
    private var listeners = [ObjectIdentifier: ChannelListener]()
    /// True while the page's new PC is being announced: the entrance hands out no channel until then.
    private var announcing = false
    /// How long a new request of the page waits for a channel before it gets its 503.
    public var channelWaitMs = 20_000

    public init(paired: Paired, connector: WebSocketConnector, status: @escaping StatusHandler) {
        self.pairedValue = paired
        self.seed = Crypto.fromB64url(paired.seed) ?? Bytes(repeating: 0, count: 32)
        self.connector = connector
        self.status = status
    }

    /// Opens the local entrance (127.0.0.1:`port` – the company's port never changes, a taken one is an error; port 0: any free
    /// one) and starts connecting; returns its origin. `ui` is the app's own interface, which the entrance answers (the app
    /// always passes it; without it – a test – every request goes to the PC).
    public func start(port: Int, gate: String, ui: UiFiles? = nil) throws -> String {
        let entrance = try StreamProxy(port: port, gate: gate, channels: self, ui: ui, fixedPort: port > 0)
        entrance.channelWaitMs = channelWaitMs
        state.lock(); proxy = entrance; started = true; state.unlock()
        spawn("autark-connection") { [self] in self.run() }
        return entrance.origin
    }

    public func stop() {
        state.lock(); stopped = true; let current = link; let entrance = proxy; state.unlock()
        nudge()
        current?.close() // first: it ends the tunnels too and never waits for a stuck send
        for open in links.all() { open.close() }
        entrance?.close()
    }

    /// Frees the local entrance's port now (a loopback listener: no network write).
    public func closeEntrance() { state.lock(); let entrance = proxy; state.unlock(); entrance?.close() }

    private var isStopped: Bool { state.lock(); defer { state.unlock() }; return stopped }

    /// The page's PC refused the page's token (4401, the page's 'refused'): the page moves to the next PC of the company
    /// that has not refused in this connection; when every linked PC refused, the page stays where it is ('Not paired').
    public func refused() {
        if links.refuse(links.usedPc()) { nudge() }
    }

    /// Try now instead of after the pause.
    public func nudge() {
        condition.lock(); wake = true; condition.broadcast(); condition.unlock()
    }

    /// The app came to the front or the network changed: the backoff starts over, the link proves itself within 2 s, the PC list is
    /// asked again and a page on the tunnel tries its PC directly once (F29).
    public func check() {
        state.lock(); attempt = 0; directNow = true; listNow = true; state.unlock()
        links.retryNow()
        probe()
    }

    /// The link and every channel are probed on the connection's own thread (a stuck send never blocks the caller).
    public func probe() {
        state.lock(); probeNow = true; state.unlock()
        nudge()
    }

    /// The app came to the front (true) or went behind (false): the pauses between tries stay short in front, up to 10 s behind.
    public func front(_ isFront: Bool) { state.lock(); inFront = isFront; state.unlock() }

    private var isFront: Bool { state.lock(); defer { state.unlock() }; return inFront }

    /// Runs on the connection's thread whenever the page moves to a new channel – another PC, or its PC again after a drop
    /// (the page then hears `resume`).
    public func onLinked(_ listener: @escaping () -> Void) { state.lock(); linkedHandler = listener; state.unlock() }

    /// Called on the connection's thread, synchronously, whenever the page moves to another PC's channel (the first one too) with
    /// that PC's fingerprint – BEFORE the entrance hands the new channel to any stream, so the first data frame of that PC reaches
    /// the page after the announcement (the offline cache owner, OfflineOwner). Keep it short: streams wait for it.
    public func onPageChannel(_ handler: @escaping (String) -> Void) { state.lock(); pageChannelHandler = handler; state.unlock() }

    /// Called (on the connection's thread) when the PC list the page's PC told changed what the phone keeps – the caller stores it
    /// (Companies.setPcs).
    public func onPcsChanged(_ handler: @escaping ([Pc]) -> Void) { state.lock(); pcsHandler = handler; state.unlock() }

    /// The company's PCs changed: a new or removed pin re-registers at the server (its tunnels end and come back).
    public func updatePcs(_ pcs: [Pc]) {
        if pcs.isEmpty { return }
        state.lock()
        let before = pairedValue
        if before.pcsJson == before.withPcs(pcs).pcsJson { state.unlock(); return }
        pairedValue = before.withPcs(pcs)
        let current = link
        state.unlock()
        if let current = current, !PhonePairing.samePins(before.pcs, pcs) { current.close() }
        nudge()
    }

    public var paired: Paired { state.lock(); defer { state.unlock() }; return pairedValue }

    /// The pinned PCs in the phone's order.
    public var pcs: [Pc] { paired.pcs }

    /// W (19.11.2026): wakes a PC of mine whose app is closed (its helper key `wakePub`) through this connection's meeting-server
    /// link (Wake) – no PC needs to be online. Any thread but the main one (network).
    public func wakePc(wakePub: String?, name: String) throws {
        guard let current = currentLink(), current.isUp else {
            nudge()
            throw AutarkError("This phone can't reach the meeting server right now – try again in a moment.")
        }
        try Wake.send(link: current, seed: seed, wakePub: wakePub, name: name, now: Clock.nowMs())
    }

    /// True when the meeting server reports the PC `fingerprint` online now.
    public func online(_ fingerprint: String) -> Bool {
        state.lock(); let current = link; state.unlock()
        guard let relay = current else { return false }
        return relay.isUp && relay.online(fingerprint)
    }

    /// The name of the PC the page uses now, or nil while there is none.
    public var pcName: String? { links.usedPc().map { nameOf($0) } }

    /// Open channels to PCs of the company (the page's one included).
    public var linkedCount: Int { links.live() }

    /// The PC the page uses now (for the status line and tests), or nil.
    public var pc: String? { links.usedPc() }

    /// This phone's own fingerprint.
    public var selfFingerprint: String { Crypto.fingerprint(Crypto.ed25519Public(seed: seed)) }

    public var openStreams: Int { state.lock(); let entrance = proxy; state.unlock(); return entrance?.openStreams ?? 0 }

    // MARK: Channels (the local entrance's view)

    public func waitChannel(timeoutMs: Int) -> PeerChannel? {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        condition.lock(); defer { condition.unlock() }
        while !isStopped {
            if !isAnnouncing, let used = links.usedChannel() { return used }
            let left = deadline.timeIntervalSinceNow
            if left <= 0 { return isAnnouncing ? nil : links.pick(order: order()) } // a round still opening a slow PC: a linked one serves now (nil: none)
            wake = true
            condition.broadcast()
            _ = condition.wait(until: Date().addingTimeInterval(min(left, 1)))
        }
        return isAnnouncing ? nil : links.usedChannel()
    }

    private var isAnnouncing: Bool { state.lock(); defer { state.unlock() }; return announcing }

    public func usedChannel() -> PeerChannel? { isAnnouncing ? nil : links.usedChannel() }

    // MARK: RelayEvents

    public func presence(online: Bool) {
        if online { links.retryNow() } // a PC came online: tried now, not after its backoff
        nudge()
    }

    public func down(reason: String) { nudge() }

    // MARK: the loop

    private func run() {
        while !isStopped {
            do {
                try ensureLink()
                guard let current = currentLink() else { continue }
                state.lock(); let doProbe = probeNow; probeNow = false; state.unlock()
                if doProbe { current.probe(); for open in links.all() { open.probe() } }
                let wanted = order()
                for gone in links.prune(pinned: wanted) { gone.close() }
                if links.usedChannel() == nil && links.live() > 0 { settle(wanted, current, nil) } // the page's PC dropped: move now, not after this round's opens
                var failure: String? = nil
                for fp in links.toOpen(order: wanted, online: { current.online($0) }, now: Clock.nowMs()) {
                    if isStopped { break }
                    if links.usedChannel() == nil { say("Connecting to \(nameOf(fp))…", false) }
                    do { try openChannel(fp) } catch {
                        links.failed(fp, now: Clock.nowMs(), front: isFront)
                        failure = (error as? AutarkError)?.message ?? error.localizedDescription
                        continue
                    }
                    if links.usedChannel() == nil { settle(wanted, current, nil) } // the first channel up takes the page now, not after the round's other PCs
                }
                settle(wanted, current, failure)
                state.lock(); var askList = listNow; listNow = false; let tryNow = directNow; directNow = false; state.unlock()
                if askList && doProbe {
                    // the probe measures silence: the list request's answer would count as the traffic it looks for (and a dead link would hold this
                    // thread for the request's wait) – the list is asked once the probe has had its say
                    askList = false
                    state.lock(); listNow = true; state.unlock()
                    later(milliseconds: RelayLink.probeMs + 300) { [weak self] in self?.nudge() }
                }
                if askList && !isStopped { refreshPcList() }
                if tryNow && !isStopped && tryDirect() { settle(wanted, current, nil) }
                pause(Int(min(15_000, links.nextRetry(now: Clock.nowMs()))))
                current.checkAlive()
                for open in links.all() { open.checkAlive() }
            } catch {
                say((error as? AutarkError)?.message ?? "Connection failed.", false)
                state.lock(); let n = attempt; attempt += 1; state.unlock()
                pause(Int(PhoneConnection.backoff(n, front: isFront)))
            }
        }
        let current = currentLink() // stop() may have come while a link or channel was being made: what I made last ends here
        for open in links.all() { open.close() }
        current?.close()
    }

    private func currentLink() -> RelayLink? { state.lock(); defer { state.unlock() }; return link }

    /// The page's PC after this round. A move to another PC announces it and ends the streams left on the old one; that move, or
    /// its own PC back after its channel ended, tells the listener. A better way to the same PC moves nothing: new streams take it.
    private func settle(_ wanted: [String], _ current: RelayLink, _ failure: String?) {
        condition.lock()
        let next = links.pick(order: wanted)
        let pc = next == nil ? nil : links.usedPc()
        let otherPc = pc != nil && pc != shownPc
        let back = next != nil && next !== shown && (shown == nil || shown!.isClosed)
        state.lock()
        let announce = otherPc ? pageChannelHandler : nil
        if announce != nil { announcing = true } // set before the lock is released: no stream can take the new channel meanwhile
        state.unlock()
        condition.broadcast()
        condition.unlock()
        shown = next
        if let pc = pc { shownPc = pc }
        if let announce = announce, let fp = pc {
            announce(fp)
            state.lock(); announcing = false; state.unlock()
            condition.lock(); condition.broadcast(); condition.unlock()
        } else if announce != nil {
            state.lock(); announcing = false; state.unlock()
        }
        if let next = next {
            state.lock(); attempt = 0; let entrance = proxy; let listener = linkedHandler; state.unlock()
            let others = links.live() - 1
            say("Connected to \(nameOf(pc))" + (next.direct ? " directly" : "") + (others > 0 ? " (+\(others))" : "") + ".", true)
            if otherPc { entrance?.retire(keep: next) }
            if otherPc || back {
                state.lock(); listNow = true; state.unlock()
                if let listener = listener, !isStopped { listener() }
            }
            return
        }
        var any = false
        for fp in wanted { any = any || current.online(fp) }
        if !any { say("None of your PCs is online. Autark must be running on one of them.", false) }
        else if let failure = failure { say(failure, false) } // else: an online PC waits its retry, the last line stays
    }

    /// The pinned PCs' fingerprints in the phone's order.
    private func order() -> [String] { paired.pcs.map { $0.fingerprint } }

    private func nameOf(_ fp: String?) -> String {
        guard let fp = fp else { return "your PC" }
        return paired.pcs.first(where: { $0.fingerprint == fp })?.name ?? "your PC"
    }

    private func keyOf(_ fp: String) -> Bytes? {
        guard let pc = paired.pcs.first(where: { $0.fingerprint == fp }) else { return nil }
        return Crypto.fromB64url(pc.publicKey)
    }

    private func ensureLink() throws {
        if let existing = currentLink(), existing.isUp { return }
        let pins: [(String, Bytes)] = paired.pcs.compactMap { pc in Crypto.fromB64url(pc.publicKey).map { (pc.fingerprint, $0) } }
        let next = RelayLink(seed: seed, pins: pins, connector: connector, events: self)
        say("Reaching the meeting server…", false)
        try next.connect(url: paired.relay)
        state.lock(); link = next; state.unlock()
    }

    /// The listener of one channel: the PC list's answer goes to the question, everything else to the local entrance.
    private final class ChannelListener: PeerListener {
        weak var owner: PhoneConnection?
        var channel: PeerChannel?
        let listing = Locked<PcList?>(nil)
        init(owner: PhoneConnection) { self.owner = owner }

        func message(_ message: JSONObject) {
            if PcList.mine(message) { listing.value?.deliver(message); return }
            if let channel = channel { owner?.proxyValue()?.deliver(channel, message) }
        }

        func closed() {
            listing.value?.deliver(["t": "e"] as JSONObject) // the list wait ends with the channel
            if let channel = channel { owner?.proxyValue()?.channelClosed(channel); owner?.forget(channel) }
            owner?.nudge()
            channel = nil
        }
    }

    fileprivate func forget(_ channel: PeerChannel) { state.lock(); listeners[ObjectIdentifier(channel)] = nil; state.unlock() }

    fileprivate func proxyValue() -> StreamProxy? { state.lock(); defer { state.unlock() }; return proxy }

    private func addressesOf(_ fp: String) -> [String] {
        paired.pcs.first(where: { $0.fingerprint == fp })?.addresses ?? []
    }

    /// F29: the page's PC, reached through the tunnel, tried directly once; true when a direct channel took its place – the tunnel's
    /// open streams run to their end there, then it closes (StreamProxy.drain); only new streams take the direct channel.
    private func tryDirect() -> Bool {
        guard let fp = links.usedPc(), let used = links.usedChannel(), !used.direct, !addressesOf(fp).isEmpty else { return false }
        do { try openChannel(fp, directOnly: true) } catch { return false } // it stays on the tunnel
        if let better = links.usedChannel(), better !== used { shown = better } // the page's way changed, not its PC: the drained tunnel ending is no "back"
        proxyValue()?.drain(used)
        return true
    }

    /// Asks the page's PC for its PC list (phone.pcs): new PCs get pinned, their addresses are kept for the direct route. One small
    /// request on the connection's thread, like the version; an older PC without phone.pcs simply does not answer.
    private func refreshPcList() {
        guard let fp = links.usedPc(), let channel = links.usedChannel(), !channel.isClosed else { return }
        state.lock(); let listener = listeners[ObjectIdentifier(channel)]; let token = pairedValue.token; state.unlock()
        guard let target = listener else { return }
        let question = PcList(send: { channel.send($0) })
        target.listing.value = question
        let told = question.fetch(token: token, timeoutMs: PhoneConnection.listMs)
        target.listing.value = nil
        if let told = told { apply(told: told, reached: fp) }
    }

    private func apply(told: [Pc], reached: String) {
        state.lock()
        let before = pairedValue
        let merged = PcList.merged(known: before.pcs, told: told, reached: reached)
        if merged.isEmpty || before.pcsJson == before.withPcs(merged).pcsJson { state.unlock(); return }
        pairedValue = before.withPcs(merged)
        let current = link
        let handler = pcsHandler
        let oldAddresses = before.pcs.first(where: { $0.fingerprint == reached })?.addresses ?? []
        let newAddresses = merged.first(where: { $0.fingerprint == reached })?.addresses ?? []
        if newAddresses != oldAddresses && !newAddresses.isEmpty { directNow = true } // addresses the page's PC did not have: try them now
        state.unlock()
        if let current = current, !PhonePairing.samePins(before.pcs, merged) { current.close() } // a new or removed pin: the server learns it
        handler?(merged)
        nudge()
    }

    /// A channel to `fp`: straight to one of its addresses when one answers, else (unless `directOnly`) through the meeting server.
    private func openChannel(_ fp: String, directOnly: Bool = false) throws {
        guard let pcPub = keyOf(fp) else { throw AutarkError("That PC is not one of yours.") }
        let relay = currentLink()
        let tunnel: Route.Opener? = directOnly ? nil : {
            guard let relay = relay else { throw AutarkError("The meeting server is not connected.") }
            return try relay.open(fp)
        }
        let info = paired
        var made: ChannelListener?
        // a listener per attempt: a late `closed` of a refused direct socket never reaches the channel that replaces it
        let next = try Route.open(direct: DirectPipe.openers(addressesOf(fp), connector: connector), windowMs: Route.directMs, tunnel: tunnel) { pipe in
            let attempt = ChannelListener(owner: self)
            let channel = try PeerChannel.connect(tunnel: pipe, seed: seed, deviceId: info.deviceId, pcPublicKey: pcPub, listener: attempt)
            made = attempt
            return channel
        }
        guard let listener = made else { throw AutarkError("The channel could not be made.") }
        listener.channel = next
        state.lock(); listeners[ObjectIdentifier(next)] = listener; state.unlock()
        if next.isClosed { forget(next) }
        if next.isClosed { throw AutarkError("\(nameOf(fp)) closed the connection.") } // waits its backoff, never a tight loop
        condition.lock(); links.put(fp, next); condition.unlock()
        if next.isClosed { proxyValue()?.channelClosed(next) }
    }

    private func pause(_ ms: Int) {
        condition.lock()
        if !wake && !isStopped { _ = condition.wait(until: Date().addingTimeInterval(Double(ms) / 1000)) }
        wake = false
        condition.unlock()
    }

    private func say(_ text: String, _ connected: Bool) {
        if isStopped { return } // a stopped link (company switch, forget) never speaks over the next one
        state.lock()
        if text == lastStatus { state.unlock(); return }
        lastStatus = text
        state.unlock()
        status(text, connected)
    }
}
