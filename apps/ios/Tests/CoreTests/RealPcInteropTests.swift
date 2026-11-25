// Owns: the Swift core against the REAL meeting server and the REAL desktop code, on Linux (WebSocket: RawWebSocket.swift): tools/real-pc.mjs runs services/remote-relay, and as the PC apps/desktop's relay-client.ts, remote/requests.ts
// (connect request, role 'phone') and PhoneBridge (handshake, channel, streams). This test pairs with it by Remote ID, checks that
// both screens show the same code, connects through a real tunnel, reads the PC's version, loads a page, a 900 kB answer and a
// 700 kB upload through the local entrance. Skipped unless AUTARK_REAL_RELAY, AUTARK_REAL_REMOTE_ID and AUTARK_REAL_LOG are set.
// Not an iPhone test (no CryptoKit, no iOS URLSession) and not the production meeting server.
import XCTest
import Foundation
@testable import AutarkCore

final class RealPcInteropTests: XCTestCase {
    private func harnessEvents(_ path: String) -> [JSONObject] {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").compactMap { try? Json.object(String($0)) }
    }

    private func get(_ origin: String, _ path: String, method: String = "GET", body: Bytes = []) -> Bytes {
        let port = Int(origin.split(separator: ":").last!)!
        guard let client = TcpConnection.connect(port: port) else { return [] }
        var head = "\(method) \(path) HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: autark_gate=gate-secret\r\nConnection: close\r\n"
        if method == "POST" { head += "Content-Length: \(body.count)\r\n" }
        client.write(Crypto.utf8(head + "\r\n") + body)
        var all = Bytes()
        while let part = client.read(max: 64 * 1024, timeoutSeconds: 20) { all.append(contentsOf: part) }
        return all
    }

    private func bodyOf(_ response: Bytes) -> Bytes {
        for i in 0..<max(0, response.count - 3) where response[i] == 13 && response[i + 1] == 10 && response[i + 2] == 13 && response[i + 3] == 10 { return Bytes(response[(i + 4)...]) }
        return []
    }

    func testPairAndBrowseAgainstTheRealMeetingServerAndDesktopCode() throws {
        let env = ProcessInfo.processInfo.environment
        guard let relay = env["AUTARK_REAL_RELAY"], let remoteId = env["AUTARK_REAL_REMOTE_ID"], let log = env["AUTARK_REAL_LOG"] else {
            throw XCTSkip("no real PC: run tools/real-pc.mjs and set AUTARK_REAL_RELAY, AUTARK_REAL_REMOTE_ID, AUTARK_REAL_LOG")
        }
        let version = env["AUTARK_REAL_VERSION"] ?? "9.9.9-real"
        let connector = RawWebSocketConnector() // plain TCP WebSocket: Linux URLSession has none (RawWebSocket.swift)

        // pairing: the real desktop shows the request and (the harness) accepts it
        let shown = Locked<String?>(nil)
        let pairing = Pairing()
        let paired = try PhonePairing.pair(relay: relay, remoteId: remoteId, name: "Linux test phone", pairing: pairing, connector: connector,
                                           codes: { code, _ in shown.value = code })
        let request = harnessEvents(log).last { Json.str($0, "event") == "request" }
        XCTAssertNotNil(request, "the real PC saw the request")
        XCTAssertEqual(shown.value, request.flatMap { Json.str($0, "code") }, "the phone shows the code the real PC shows")
        XCTAssertEqual(paired.pcs.count, 1)
        XCTAssertEqual(paired.pcs[0].name, "Real Desktop PC")
        XCTAssertEqual(paired.deviceId, "dev_acceptedphone0001")
        XCTAssertTrue(paired.token.hasPrefix("tok-real-"))
        XCTAssertEqual(Crypto.remoteId(paired.pcs[0].fingerprint), remoteId)

        // connecting: a real tunnel, the real PhoneBridge handshake and streams
        let statuses = Locked([String]())
        let connection = PhoneConnection(paired: paired, connector: connector, status: { text, connected in statuses.with { $0.append((connected ? "+" : "-") + text) } })
        connection.channelWaitMs = 5_000
        let origin = try connection.start(port: 0, gate: "gate-secret")
        defer { connection.stop() }
        eventually(30, "connected to the real PC") { statuses.value.contains("+Connected to Real Desktop PC.") }
        XCTAssertEqual(connection.version, version)

        let page = String(decoding: get(origin, "/"), as: UTF8.self)
        XCTAssertTrue(page.hasPrefix("HTTP/1.1 200"), String(page.prefix(120)))
        XCTAssertTrue(page.contains("served by the real PC code path"))

        let big = bodyOf(get(origin, "/big"))
        XCTAssertEqual(big.count, 900_000)
        XCTAssertEqual(big, Bytes((0..<900_000).map { UInt8(truncatingIfNeeded: $0 % 251) }))

        let up = Bytes((0..<700_000).map { UInt8(truncatingIfNeeded: $0 &* 7) })
        XCTAssertEqual(String(decoding: bodyOf(get(origin, "/upload", method: "POST", body: up)), as: UTF8.self), "real PC got 700000 bytes")

        // what the real PC saw: the token on the version request, the cookie of the page request
        let seen = harnessEvents(log).filter { Json.str($0, "event") == "http" }
        XCTAssertTrue(seen.contains { Json.str($0, "url") == "/rpc" && Json.str($0, "auth") == "yes" })
        XCTAssertTrue(seen.contains { Json.str($0, "url") == "/big" })
        XCTAssertTrue(harnessEvents(log).contains { Json.str($0, "event") == "channels" }, "the real PhoneBridge opened a phone channel")
    }
}
