// Owns: the placeholder for the WebRTC way (F25 stage 2: RtcWay, RtcPlan, PageRtc, relay/WebRtc on Android) – NOT ported. It names what
// that way needs from a WebRTC library – one answering peer connection per try with exactly the STUN servers of the PC's offer, its
// candidates, ICE states and the PC's data channel – so a later stage can plug a library in behind PhoneConnection without touching the
// rest. Mirrors relay/RtcEngine.java. Nothing in the app implements it and PhoneConnection does not use it yet.
// What it would take (apps/ios/README.md, "WebRTC"): a Swift WebRTC binary – the community build stasel/WebRTC (Swift package of the
// Google libwebrtc xcframework, MIT-style licence, ~25–30 MB per slice) or a build of Google's own xcframework – plus a port of RtcWay
// (315 lines of Java: signalling over the channel, the data channel running the pinned handshake again), RtcPlan (51 lines, pure) and
// the page side (PageRtc, 84 lines); about two days of work and a real device or a second simulator to try it. libwebrtc's logging must
// be turned off (Android's WebRtcConfig.SILENT: no candidate, address or SDP in a log).
// Never: claims a way that does not exist; PhoneConnection stays on the tunnel and the direct socket until an engine is plugged in.
import Foundation

/// One peer connection the engine made for a try.
public protocol RtcPeer: AnyObject {
    /// The answer's SDP.
    var sdp: String { get }
    /// Ends it on the engine's own thread; returns at once.
    func close()
}

/// What a peer connection reports (its threads).
public protocol RtcEvents: AnyObject {
    func candidate(_ line: String)
    func gathered()
    /// ICE connection state: new, checking, connected, completed, disconnected, failed or closed.
    func ice(_ state: String)
    /// The PC's data channel is open; `send` writes a frame to it.
    func open(label: String, send: @escaping (_ data: Bytes, _ text: Bool) -> Void)
    func message(_ data: Bytes, text: Bool)
    func closed()
    /// The types (host, srflx, prflx, relay) of the candidate pair in use.
    func pair(local: String, remote: String)
}

public protocol RtcEngine: AnyObject {
    /// The phone's network for the PC's counts (wifi, cell, ethernet, vpn, other) or nil.
    var net: String? { get }
    /// A peer connection with exactly `stun` as its ICE servers (none for an empty list), which took `offer` and answered it.
    /// Throws when WebRTC is missing on this phone or refuses the offer.
    func answer(offer: String, stun: [String], events: RtcEvents) throws -> RtcPeer
}

public enum Rtc {
    /// No engine is plugged in on iOS: the page's PC is reached through the direct socket or the tunnel only.
    public static let available = false
}
