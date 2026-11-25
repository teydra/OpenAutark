// Owns: which pipe a channel to one PC runs over, like the PC's devices/reach.ts: the PC's direct addresses all at once – the first
// socket that opens within the window runs the pinned handshake, the later ones close as they open – and the tunnel through the
// meeting server when none opens in time or the handshake over the direct socket fails (another device on that address, a refusal).
// One pipe per PC at a time: the direct socket replaces the tunnel, it is never added to it. Ported from relay/Route.java.
// Never: retries, remembers a route, or decides trust (the handshake does).
import Foundation

public enum Route {
    /// Opens one pipe (throws when it cannot).
    public typealias Opener = () throws -> LinkPipe

    /// How long the direct addresses get before the tunnel is opened (a LAN answers in milliseconds).
    public static var directMs: Int { DirectPipe.connectMs }

    /// The channel over the first direct pipe that opens and passes the handshake, else over `tunnel` (nil: direct only, then it throws).
    public static func open<C>(direct: [Opener], windowMs: Int, tunnel: Opener?, handshake: (LinkPipe) throws -> C) throws -> C {
        let pipe = direct.isEmpty ? nil : first(direct, windowMs: windowMs)
        var failure: Error?
        if let pipe = pipe {
            do { return try handshake(pipe) } catch {
                pipe.close()
                failure = error
            }
        }
        guard let tunnel = tunnel else { throw failure ?? AutarkError("No direct address of the PC answered.") }
        return try handshake(try tunnel())
    }

    private final class Race {
        let condition = NSCondition()
        var won: LinkPipe?
        var over = false
        var failed = 0
    }

    /// The first of `opens` that opens within `windowMs` (each on a thread of its own), or nil; the others close as they open.
    static func first(_ opens: [Opener], windowMs: Int) -> LinkPipe? {
        let race = Race()
        let total = opens.count
        for open in opens {
            spawn("autark-direct-dial") {
                var pipe: LinkPipe? = try? open()
                race.condition.lock()
                if pipe != nil && race.won == nil && !race.over { race.won = pipe; pipe = nil }
                else if pipe == nil { race.failed += 1 }
                race.condition.broadcast()
                race.condition.unlock()
                pipe?.close() // a later one, or the window ended
            }
        }
        let deadline = Date().addingTimeInterval(Double(windowMs) / 1000)
        race.condition.lock()
        defer { race.condition.unlock() }
        while race.won == nil && race.failed < total {
            if !race.condition.wait(until: deadline) { break }
        }
        race.over = true
        return race.won
    }
}
