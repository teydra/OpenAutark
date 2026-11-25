// Owns: the data of a pairing (one PC as the phone keeps it, what pairing gives the phone) and the static half of
// PhoneConnection – pairing a new phone key with a PC under its Remote ID (the PC's own connect request with role "phone",
// RemotePair), reading the pinned PCs back from storage, putting one PC first, and whether two lists pin the same PCs.
// Ported from relay/PhonePairing.java and the data classes of PhoneConnection.java.
// Never: keeps state, stores anything, or reaches a PC outside the pairing request.
import Foundation

/// One PC of the company as the phone keeps it.
public struct Pc: Equatable {
    public let fingerprint: String
    public let publicKey: String
    public let name: String
    public let deviceId: String
    /// The PC's peer listener addresses (http(s) base URLs, at most 8): the direct route dials `<address>/peer/phone`, the tunnel is the way back.
    public let addresses: [String]

    public init(fingerprint: String, publicKey: String, name: String?, deviceId: String?, addresses: [String] = []) {
        self.fingerprint = fingerprint
        self.publicKey = publicKey
        self.name = name ?? "PC"
        self.deviceId = deviceId ?? ""
        self.addresses = addresses
    }
}

/// What pairing gives the phone (kept in the keychain by the caller).
public struct Paired: Equatable {
    public let relay: String
    public let seed: String
    public let deviceId: String
    public let token: String
    public let pcs: [Pc]

    public init(relay: String, seed: String, deviceId: String, token: String, pcs: [Pc]) {
        self.relay = relay; self.seed = seed; self.deviceId = deviceId; self.token = token; self.pcs = pcs
    }

    /// The PCs as JSON (app storage).
    public var pcsJson: String {
        let rows: [Any] = pcs.map { pc in
            var row: JSONObject = ["fingerprint": pc.fingerprint, "publicKey": pc.publicKey, "name": pc.name, "deviceId": pc.deviceId]
            if !pc.addresses.isEmpty { row["addresses"] = pc.addresses as [Any] }
            return row
        }
        return Json.write(rows)
    }

    /// PCs from storage JSON (keys fingerprint, publicKey, name, deviceId); bad rows are skipped.
    public static func pcsOf(_ value: Any?) -> [Pc] { PhonePairing.pcsOf(value) }

    public func withPcs(_ next: [Pc]) -> Paired { Paired(relay: relay, seed: seed, deviceId: deviceId, token: token, pcs: next) }
}

/// A pairing in progress; cancel() ends it (the PC hears it).
public final class Pairing {
    private let lock = NSLock()
    private var cancelledFlag = false
    fileprivate var link: RelayLink?

    public init() {}

    public func cancel() {
        lock.lock(); cancelledFlag = true; let current = link; lock.unlock()
        current?.close()
    }

    public var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelledFlag }

    fileprivate func attach(_ link: RelayLink) { lock.lock(); self.link = link; lock.unlock() }
}

/// Shows the code while the person compares it on the PC.
public typealias CodeHandler = (_ code: String, _ pcName: String) -> Void

public enum PhonePairing {
    /// Pairs a new phone key with the PC under `remoteId`: the code shows through `codes`, then the person accepts on the PC.
    public static func pair(relay: String, remoteId: String, name: String, pairing: Pairing, connector: WebSocketConnector, codes: CodeHandler) throws -> Paired {
        let id = remoteId.filter { !$0.isWhitespace && $0 != "-" }
        if id.count != 9 || !id.allSatisfy({ $0.isASCII && $0.isNumber }) { throw AutarkError("The Remote ID has nine digits.") }
        let seed = Crypto.newSeed()
        let link = RelayLink(seed: seed, pins: [], connector: connector, events: nil)
        pairing.attach(link)
        defer { link.close() }
        try link.connect(url: relay)
        let found = try link.find(remoteId: id)
        guard let pc = found.first else {
            throw AutarkError("No PC with this Remote ID is online at the meeting server. Is Autark running there and accepting connection requests?")
        }
        let exchange = RemotePair(transport: { body, timeoutMs in try link.request(pc, body: ["op": "pair", "body": body] as JSONObject, timeoutMs: timeoutMs) },
                                  seed: seed, deviceId: RemotePair.newDeviceId(), name: name)
        let asked = try exchange.ask(remoteId: id, pcFingerprint: pc.fingerprint)
        codes(asked.code, asked.pcName)
        let accepted = try exchange.awaitAccept(asked, cancelled: { pairing.cancelled })
        let pcs = [Pc(fingerprint: pc.fingerprint, publicKey: Crypto.b64url(pc.publicKey), name: asked.pcName, deviceId: asked.pcDeviceId)]
        return Paired(relay: relay, seed: Crypto.b64url(seed), deviceId: accepted.deviceId, token: accepted.token, pcs: pcs)
    }

    /// PCs from storage JSON; bad rows are skipped.
    public static func pcsOf(_ value: Any?) -> [Pc] {
        var out = [Pc]()
        guard let list = value as? [Any] else { return out }
        for item in list {
            guard out.count < 16, let row = item as? JSONObject, let fp = Json.str(row, "fingerprint"), let pub = Json.str(row, "publicKey") else { continue }
            if fp.count != 64 || !fp.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) { continue }
            guard let key = Crypto.fromB64url(pub), Crypto.fingerprint(key) == fp else { continue }
            out.append(Pc(fingerprint: fp, publicKey: pub, name: Json.str(row, "name"), deviceId: Json.str(row, "deviceId"), addresses: addressesOf(row["addresses"])))
        }
        return out
    }

    /// A PC's addresses (http(s) base URLs, at most 8); anything else is skipped.
    public static func addressesOf(_ value: Any?) -> [String] {
        var out = [String]()
        guard let list = value as? [Any] else { return out }
        for item in list {
            guard let text = item as? String, out.count < DirectPipe.maxAddresses, !out.contains(text) else { continue }
            if DirectPipe.url(text) != nil { out.append(text) } // only what the direct route can dial
        }
        return out
    }

    /// True when both lists pin the same PC keys (order and names aside).
    public static func samePins(_ a: [Pc], _ b: [Pc]) -> Bool {
        Set(a.map { $0.fingerprint + " " + $0.publicKey }) == Set(b.map { $0.fingerprint + " " + $0.publicKey })
    }

    /// `pcs` with `fp` first, or `pcs` itself when `fp` is not among them.
    public static func first(_ pcs: [Pc], _ fp: String?) -> [Pc] {
        guard let fp = fp, let at = pcs.firstIndex(where: { $0.fingerprint == fp }) else { return pcs }
        var out = pcs
        let pc = out.remove(at: at)
        out.insert(pc, at: 0)
        return out
    }
}
