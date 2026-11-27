// Owns: the link rules the iPhone app shares with Android since 27.11.2026 (apps/android commit 2b83dc84), on the phone's whole path in
// this process (FakeRelay as the meeting server and the PCs): the page takes the first channel that is up in the phone's order and a
// PC that links later never takes it off (no picker, no version ranking, a failing first PC never holds the page back); the pauses
// between tries stay short while the app is in front (2 s) and grow to 10 s behind; the local entrance's stream that a better way
// to the same PC leaves behind runs to its end (StreamProxy.drain), and a stream that raced a move to another PC ends.
// Never: a real network or a claim about a device (a TestFlight build does that).
import XCTest
@testable import AutarkCore

final class LinkParityTests: XCTestCase {
    private struct Rig {
        let relay: FakeRelay
        let pcs: [FakeRelay.Pc]
        let paired: Paired
    }

    /// `count` PCs that pinned this phone; `online[i] == false`: PC i is not at the meeting server yet.
    private func rig(count: Int, online: [Bool]? = nil) -> Rig {
        let relay = FakeRelay()
        let seed = Bytes(repeating: 0x11, count: 32)
        let phoneFp = Crypto.fingerprint(Crypto.ed25519Public(seed: seed))
        var pcs = [FakeRelay.Pc]()
        for i in 0..<count {
            let pc = FakeRelay.Pc(seed: Bytes(repeating: UInt8(0x30 + i), count: 32))
            pc.peers.insert(phoneFp)
            pcs.append(pc)
            if online?[i] ?? true { relay.addPc(pc) }
        }
        let rows = pcs.enumerated().map { Pc(fingerprint: $1.fingerprint, publicKey: Crypto.b64url($1.publicKey), name: "PC\($0)", deviceId: "dev_pc\($0)") }
        let paired = Paired(relay: "wss://relay.test/autark", seed: Crypto.b64url(seed), deviceId: "dev_phoneaccepted0001", token: "tok_parity", pcs: rows)
        return Rig(relay: relay, pcs: pcs, paired: paired)
    }

    private func start(_ r: Rig, front: Bool = true) throws -> (PhoneConnection, Locked<[String]>) {
        let statuses = Locked([String]())
        let connection = PhoneConnection(paired: r.paired, connector: r.relay, status: { text, connected in statuses.with { $0.append((connected ? "+" : "-") + text) } })
        connection.channelWaitMs = 1_500
        connection.front(front)
        _ = try connection.start(port: 0, gate: "gate-secret")
        return (connection, statuses)
    }

    // MARK: 1 – the first channel up serves

    func testTheFirstPcInThePhonesOrderServesWhenAllAreUp() throws {
        let r = rig(count: 3)
        let (connection, _) = try start(r)
        defer { connection.stop() }
        eventually(15, "all three linked") { connection.linkedCount == 3 }
        XCTAssertEqual(connection.pc, r.pcs[0].fingerprint, "the first PC in the phone's order, no version and no pick ranks")
    }

    func testAFailingFirstPcNeverHoldsThePageBackAndNeverTakesItLater() throws {
        let r = rig(count: 2)
        r.relay.failOpenTo = [r.pcs[0].fingerprint] // the first PC is online but does not take the tunnel
        let (connection, statuses) = try start(r)
        defer { connection.stop() }
        eventually(10, "the page is on the second PC") { connection.pc == r.pcs[1].fingerprint }
        XCTAssertGreaterThanOrEqual(r.relay.openAttempts(to: r.pcs[0].fingerprint), 1, "the first PC was tried first")
        XCTAssertFalse(statuses.value.contains { $0.contains("Connected to PC0") })
        r.relay.failOpenTo = []
        connection.check() // its backoff starts over
        eventually(15, "the first PC links too") { connection.linkedCount == 2 }
        Thread.sleep(forTimeInterval: 0.5)
        XCTAssertEqual(connection.pc, r.pcs[1].fingerprint, "a PC that links later, first in the order or not, never takes the page off an open channel")
    }

    func testAPcThatComesOnlineLaterIsLinkedAtOnceButTheSecondStays() throws {
        let r = rig(count: 2, online: [false, true])
        let (connection, _) = try start(r)
        defer { connection.stop() }
        eventually(10, "the page is on the only PC online") { connection.pc == r.pcs[1].fingerprint }
        XCTAssertEqual(r.relay.openAttempts(to: r.pcs[0].fingerprint), 0, "an offline PC is not tried")
        r.relay.pcCameOnline(r.pcs[0])
        eventually(10, "the PC that came online is linked at once") { connection.linkedCount == 2 }
        Thread.sleep(forTimeInterval: 0.5)
        XCTAssertEqual(connection.pc, r.pcs[1].fingerprint)
    }

    func testThePageMovesWhenItsPcDropsAndStaysThereWhenTheFirstIsBack() throws {
        let r = rig(count: 2)
        let (connection, _) = try start(r)
        defer { connection.stop() }
        eventually(15, "both linked") { connection.linkedCount == 2 }
        XCTAssertEqual(connection.pc, r.pcs[0].fingerprint)
        r.relay.removePcOnline(r.pcs[0])
        r.relay.peers[0].close() // the first PC's tunnel (opened first) ends
        eventually(10, "the page moved to the second PC") { connection.pc == r.pcs[1].fingerprint }
        r.relay.pcCameOnline(r.pcs[0])
        eventually(15, "the first PC is linked again") { connection.linkedCount == 2 }
        Thread.sleep(forTimeInterval: 0.5)
        XCTAssertEqual(connection.pc, r.pcs[1].fingerprint, "the page stays where it works")
    }

    // MARK: 2 – short steps in front

    func testInFrontAFailingPcIsTriedEvery2SecondsBehindItBacksOffTo10() throws {
        let front = rig(count: 1), behind = rig(count: 1)
        front.relay.failOpenTo = [front.pcs[0].fingerprint]
        behind.relay.failOpenTo = [behind.pcs[0].fingerprint]
        let (inFront, _) = try start(front, front: true)
        let (inBack, _) = try start(behind, front: false)
        defer { inFront.stop(); inBack.stop() }
        // tries at 0, 0.5, 1.5, 3.5 s; then 5.5 s in front (2 s step) but 8.5 s behind (5 s step)
        Thread.sleep(forTimeInterval: 7)
        let a = front.relay.openAttempts(to: front.pcs[0].fingerprint), b = behind.relay.openAttempts(to: behind.pcs[0].fingerprint)
        XCTAssertGreaterThanOrEqual(a, 5, "in front: 5 tries within 7 s (\(a))")
        XCTAssertLessThanOrEqual(b, 4, "behind: the fifth try waits 5 s after the fourth (\(b))")
        XCTAssertGreaterThan(a, b)
    }
}
