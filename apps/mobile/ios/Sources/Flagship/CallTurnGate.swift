import Foundation
import os

/// The calls log (same subsystem and category as FlagshipUI's `voiciCallLog`): states and codes only.
let callPathLog = CallLog()

/// One call's TURN connection behind the endpoint: bytes in from the caller's TLS stream, bytes back out.
public protocol CallTurnConnection: AnyObject {
    /// Bytes for the client's TLS stream; nil ends the connection.
    func onClientBytes(_ data: Data) -> [Data]?
    /// Called once, before the first bytes: where bytes the peer sends later go, and how to end the stream.
    func attach(toClient: @escaping (Data) -> Void, end: @escaping () -> Void)
    func close()
}

public extension CallTurnConnection {
    func attach(toClient: @escaping (Data) -> Void, end: @escaping () -> Void) {}
}

/// The phone side of a voi.ci call's transport (docs/voici-calls.md §4): the bare-name endpoint's demux after TLS and
/// the one TURN connection a call may have.
///
/// The caller's only ICE server is `turns:<account>.<apex>:443`, so its TURN-over-TLS stream arrives on the same
/// relayed streams as HTTP visits. The first byte after TLS decides (`flagship-turn-lite` `is_turn_first_byte`): a
/// STUN first byte goes to TURN, anything else to the HTTP endpoint. TURN is accepted only while a call this device
/// answered is armed with its one-time credential, only once, and only when a responder is linked; otherwise the
/// stream is closed. The responder is `rust/crates/flagship-turn-lite` (sans-IO) through `flagship-turn-ffi`
/// (FlagshipUI's TurnResponder); a build without the CI's libraries (tools/libwebrtc) has no factory.
public final class CallTurnGate: @unchecked Sendable {
    public static let shared = CallTurnGate()

    public enum Route: Equatable { case http, turn, close }

    public struct Credential: Equatable, Sendable {
        public let user: String
        public let secret: String
        public init(user: String, secret: String) { self.user = user; self.secret = secret }
    }

    /// Makes the responder for an armed call. Nil while no TURN responder is linked into the app.
    public var factory: ((Credential) -> CallTurnConnection?)? {
        get { lock.withLock { _factory } }
        set { lock.withLock { _factory = newValue } }
    }

    private let lock = NSLock()
    private var _factory: ((Credential) -> CallTurnConnection?)?
    private var armed: Credential?
    private var taken = false

    public init() {}

    /// A STUN message's first byte (its top two bits are zero); ChannelData overlaps HTTP methods, so only this decides.
    public static func isTurnFirstByte(_ b: UInt8) -> Bool { b & 0xC0 == 0 }

    /// The demux rule, pure: where a relayed stream goes, from its first byte after TLS.
    public static func route(firstByte: UInt8, turnReady: Bool) -> Route {
        guard isTurnFirstByte(firstByte) else { return .http }
        return turnReady ? .turn : .close
    }

    /// The answer carrying this credential was sent: one TURN connection may now open.
    public func arm(_ c: Credential) {
        lock.withLock { armed = c; taken = false }
        callPathLog.notice("turn gate: armed")
    }

    /// The call ended (or this device didn't win): no TURN until the next answer.
    public func disarm() {
        lock.withLock { armed = nil; taken = false }
        callPathLog.notice("turn gate: disarmed")
    }

    public var isArmed: Bool { lock.withLock { armed != nil } }

    /// Where a new stream goes. A TURN stream takes the call's one connection (nil connection: close the stream).
    public func open(firstByte: UInt8) -> (route: Route, connection: CallTurnConnection?) {
        lock.lock()
        let ready = armed != nil && !taken && _factory != nil
        let r = Self.route(firstByte: firstByte, turnReady: ready)
        if r == .close {
            let why = armed == nil ? "not-armed" : taken ? "already-taken" : "no-factory"
            callPathLog.notice("turn gate: close (\(why, privacy: .public))")
        }
        guard r == .turn, let cred = armed, let make = _factory else {
            lock.unlock()
            return (r, nil)
        }
        taken = true
        lock.unlock()
        guard let conn = make(cred) else {
            callPathLog.notice("turn gate: close (factory-nil)")
            return (.close, nil)
        }
        callPathLog.notice("turn gate: turn")
        return (.turn, conn)
    }
}
