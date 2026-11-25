// Owns: one pairing with the PC under a Remote ID on its own thread, its texts for the wait level ("Finding the PC…", then
// "Accept on <PC> if it shows the same code." with the 4-digit code) and, when it fails, the reason. The finished pairing
// goes to the caller through `done` (the app hops to the main thread there). Ported from pair/PairRun.java.
// Never: stores the pairing, retries by itself, or reports anything after cancel().
import Foundation

public enum PairRun {
    /// What the wait level shows: a line, and the 4-digit code once the PC answered.
    public struct Wait: Equatable {
        public var line: String
        public var code: String?
        public init(line: String, code: String?) { self.line = line; self.code = code }
    }

    /// Starts the pairing; `status` hears the texts, `done` gets the pairing, or nil and the reason when it failed.
    public static func start(remoteId: String, name: String, connector: WebSocketConnector, relay: String = ConnectionAddress.defaultRelay,
                             status: @escaping (Wait) -> Void, done: @escaping (Paired?, String?) -> Void) -> Pairing {
        let running = Pairing()
        status(Wait(line: "Finding the PC through Autark's meeting server…", code: nil))
        spawn("autark-pair") {
            var result: Paired? = nil
            var reason: String? = nil
            do {
                result = try PhonePairing.pair(relay: relay, remoteId: remoteId, name: name, pairing: running, connector: connector, codes: { digits, pcName in
                    if !running.cancelled { status(Wait(line: "Accept on \(pcName) if it shows the same code.", code: digits)) }
                })
            } catch {
                reason = (error as? AutarkError)?.message ?? "Pairing failed."
            }
            if running.cancelled { return }
            done(result, reason)
        }
        return running
    }
}
