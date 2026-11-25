// Owns: the companies this phone is paired with – one record per company {id, name, avatar, port, relay, seed, deviceId,
// token, pcs} plus the current one; one fixed local port per company (47920, 47921, …, never reused) so each company has
// its own origin (and its own web storage); a new pairing that shares a PC fingerprint replaces that company's record; the
// list the page shows ({id, name, avatar?, current, pc?} – never a key or token). Ported from Companies.java (without the
// 0.3.x migration, which has no iOS counterpart). The records live in a string store: the keychain in the app, a dictionary
// in the host tests.
// Never: depends on a platform framework, connects, or deletes web storage.
import Foundation

/// A string store (the keychain in the app, a dictionary in tests); put(key, nil) removes the key.
public protocol StringStore: AnyObject {
    func get(_ key: String) -> String?
    func put(_ key: String, _ value: String?)
}

public final class MemoryStore: StringStore {
    private var values = [String: String]()
    public init() {}
    public func get(_ key: String) -> String? { values[key] }
    public func put(_ key: String, _ value: String?) { values[key] = value }
}

public final class Companies {
    public static let firstPort = 47920
    public static let avatarLimit = 16 * 1024

    private let store: StringStore
    private var list = [JSONObject]()
    private var current: String?
    private var next = 1

    public init(store: StringStore) {
        self.store = store
        if let saved = store.get("list"), let rows = (try? Json.parse(saved)) as? [Any] {
            for row in rows { if let map = row as? JSONObject, Json.str(map, "id") != nil { list.append(map) } }
        }
        current = store.get("current")
        next = Int(store.get("next") ?? "") ?? (list.count + 1)
        if byId(current) == nil { current = list.first.flatMap { Json.str($0, "id") } }
    }

    public var currentId: String? { current }

    /// The current company's pairing, or nil when the phone is paired with none.
    public var currentPaired: Paired? { paired(byId(current)) }

    /// The current company's local port (its own origin).
    public var port: Int { byId(current).map { Json.num($0, "port", Companies.firstPort) } ?? Companies.firstPort }

    public var count: Int { list.count }

    /// A finished pairing: the company that shares a PC fingerprint gets the new keys (same id, port, card), else a new one.
    /// Becomes current; returns its id.
    @discardableResult
    public func add(_ paired: Paired) -> String {
        var same: Int? = nil
        for (index, row) in list.enumerated() {
            for pc in pcs(row) where paired.pcs.contains(where: { $0.fingerprint == pc.fingerprint }) { same = index }
        }
        if let index = same {
            let old = list[index]
            var updated = record(id: Json.str(old, "id")!, port: Json.num(old, "port", Companies.firstPort), paired: paired)
            updated["name"] = old["name"]
            updated["avatar"] = old["avatar"]
            list[index] = updated
            current = Json.str(old, "id")
        } else {
            let n = max(next, 1)
            next = n + 1
            current = "c\(n)"
            list.append(record(id: "c\(n)", port: Companies.firstPort + n - 1, paired: paired))
        }
        save()
        return current!
    }

    @discardableResult
    public func setCurrent(_ id: String) -> Bool {
        if byId(id) == nil { return false }
        current = id
        save()
        return true
    }

    /// The PC list grew or changed; `id` is the company whose connection reported it.
    public func setPcs(company id: String, _ pcs: [Pc]) {
        guard let index = list.firstIndex(where: { Json.str($0, "id") == id }), !pcs.isEmpty, let row = paired(list[index]) else { return }
        list[index]["pcs"] = try? Json.parse(row.withPcs(pcs).pcsJson)
        save()
    }

    /// The current company's card from its page: name (≤ 80 chars) and a small data:image picture (≤ 16 KB, else none).
    public func setCard(name: String?, avatar: String?) {
        guard let id = current, let index = list.firstIndex(where: { Json.str($0, "id") == id }) else { return }
        let clean = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        list[index]["name"] = String(clean.prefix(80))
        if let avatar = avatar, avatar.hasPrefix("data:image/"), avatar.utf16.count <= Companies.avatarLimit { list[index]["avatar"] = avatar } else { list[index]["avatar"] = NSNull() }
        save()
    }

    /// Removes one company; the first remaining one becomes current. Returns the new current id or nil.
    @discardableResult
    public func remove(_ id: String?) -> String? {
        if let index = list.firstIndex(where: { Json.str($0, "id") == id }) { list.remove(at: index) }
        if id != nil && id == current { current = list.first.flatMap { Json.str($0, "id") } }
        save()
        return current
    }

    /// What the page shows: [{id, name, avatar?, current, pc?}] – pc (the PC tunnelled to) only on the current one.
    public func listJson(pcName: String?) -> String {
        var out = [Any]()
        for row in list {
            guard let id = Json.str(row, "id") else { continue }
            let name = Json.str(row, "name") ?? ""
            let rowPcs = pcs(row)
            var item: JSONObject = ["id": id, "name": name.isEmpty ? (rowPcs.isEmpty ? "Company" : rowPcs[0].name) : name]
            if let avatar = row["avatar"] as? String { item["avatar"] = avatar }
            item["current"] = id == current
            if id == current, let pcName = pcName, !pcName.isEmpty { item["pc"] = pcName }
            out.append(item)
        }
        return Json.write(out)
    }

    private func record(id: String, port: Int, paired: Paired) -> JSONObject {
        ["id": id, "name": "", "port": port, "relay": paired.relay, "seed": paired.seed, "deviceId": paired.deviceId,
         "token": paired.token, "pcs": (try? Json.parse(paired.pcsJson)) ?? [Any]()]
    }

    private func byId(_ id: String?) -> JSONObject? {
        guard let id = id else { return nil }
        return list.first { Json.str($0, "id") == id }
    }

    private func pcs(_ row: JSONObject) -> [Pc] { Paired.pcsOf(row["pcs"]) }

    private func paired(_ row: JSONObject?) -> Paired? {
        guard let row = row, let seed = Json.str(row, "seed"), !seed.isEmpty else { return nil }
        return Paired(relay: Json.str(row, "relay") ?? ConnectionAddress.defaultRelay, seed: seed, deviceId: Json.str(row, "deviceId") ?? "",
                      token: Json.str(row, "token") ?? "", pcs: pcs(row))
    }

    private func save() {
        store.put("list", Json.write(list as [Any]))
        store.put("current", current)
        store.put("next", String(next))
    }
}
