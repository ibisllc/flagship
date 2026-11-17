#if os(iOS)
import Darwin
import Flagship
import FlagshipCore
import Network
import XCTest
@testable import FlagshipUI

/// The phone's media path end to end on the real iOS libwebrtc (the simulator slice of the pinned xcframework): a
/// caller engine reaches a callee engine only through CallTurnGate and the TurnResponder, whose relay socket forwards
/// to the callee's loopback host candidate, as on the phone. Plain TCP TURN on this host's LAN address stands in for
/// the TLS stream the relay carries (the TLS layer is PhoneTlsTerminator's, tested apart). A responder that never
/// sends to the peer (2026-11-16, e640a8ab0) fails here: ICE never connects.
final class CallMediaLoopbackTests: XCTestCase {
    func testACallConnectsThroughTheTurnResponderOnLoopback() async throws {
        try XCTSkipUnless(CallMediaFactory.bundled, "built without Vendor/WebRTC")
        guard let host = Self.lanIPv4() else { throw XCTSkip("no LAN IPv4 address for the caller's TURN connection") }
        let cred = CallTurnCredential(user: "u\(UInt32.random(in: 0...UInt32.max))", secret: "s\(UInt64.random(in: 0...UInt64.max))")
        let server = try TurnTcpServer()
        defer { server.stop() }
        let port = try await server.ready()

        let callee = WebRTCCallMediaEngine()
        let caller = WebRTCCallMediaEngine()
        defer { caller.stop(); callee.stop(); CallTurnGate.shared.disarm() }
        let calleeUp = expectation(description: "callee connected")
        let callerUp = expectation(description: "caller connected")
        callee.onConnected = { calleeUp.fulfill() }
        caller.onConnected = { callerUp.fulfill() }
        callee.onFailed = { XCTFail("callee media failed") }
        caller.onFailed = { XCTFail("caller media failed") }
        caller.onLocalIce = { c in callee.addRemoteIce(c) }

        let callId = String(repeating: "ab", count: 16)
        let audio = (c2p: [UInt8](repeating: 1, count: 32), p2c: [UInt8](repeating: 2, count: 32))
        callee.start(CallFrameCrypto(callId: callId, audio: audio, video: nil))
        caller.startCaller(CallFrameCrypto.caller(callId: callId, audio: audio, video: nil))

        let offer = VoiciCalls.mungeSdp(try await caller.offer(video: false))
        let answer = VoiciCalls.mungeSdp(try await callee.answer(offerSdp: offer, video: false, turn: cred))
        CallTurnGate.shared.arm(.init(user: cred.user, secret: cred.secret))
        try await caller.applyAnswer(sdp: answer, iceServer: CallerIceServer(url: "turn:\(host):\(port)?transport=tcp", username: cred.user, credential: cred.secret))

        await fulfillment(of: [calleeUp, callerUp], timeout: 20)
    }

    /// This host's first non-loopback IPv4 (the simulator shares the Mac's interfaces).
    static func lanIPv4() -> String? {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0 else { return nil }
        defer { freeifaddrs(head) }
        var p = head
        while let i = p {
            defer { p = i.pointee.ifa_next }
            guard let a = i.pointee.ifa_addr, a.pointee.sa_family == sa_family_t(AF_INET),
                  i.pointee.ifa_flags & UInt32(IFF_LOOPBACK) == 0, i.pointee.ifa_flags & UInt32(IFF_UP) != 0 else { continue }
            var buf = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(a, socklen_t(a.pointee.sa_len), &buf, socklen_t(buf.count), nil, 0, NI_NUMERICHOST) == 0 {
                return String(cString: buf)
            }
        }
        return nil
    }
}

/// A plain-TCP TURN listener that hands each stream to CallTurnGate, as PhoneTlsTerminator does after TLS.
private final class TurnTcpServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "test.turn")
    private var readyCont: CheckedContinuation<UInt16, Error>?

    init() throws {
        listener = try NWListener(using: .tcp, on: .any)
        listener.newConnectionHandler = { [weak self] c in self?.accept(c) }
        listener.stateUpdateHandler = { [weak self] st in
            guard let self else { return }
            switch st {
            case .ready: if let p = self.listener.port?.rawValue { self.readyCont?.resume(returning: p); self.readyCont = nil }
            case .failed(let e): self.readyCont?.resume(throwing: e); self.readyCont = nil
            default: break
            }
        }
    }

    func ready() async throws -> UInt16 {
        try await withCheckedThrowingContinuation { c in
            queue.async {
                self.readyCont = c
                self.listener.start(queue: self.queue)
            }
        }
    }

    func stop() { listener.cancel() }

    private func accept(_ c: NWConnection) {
        c.start(queue: queue)
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, _ in
            guard let data, let first = data.first else { c.cancel(); return }
            let (route, conn) = CallTurnGate.shared.open(firstByte: first)
            guard route == .turn, let conn else { c.cancel(); return }
            conn.attach(toClient: { b in c.send(content: b, completion: .contentProcessed { _ in }) }, end: { c.cancel() })
            func feed(_ d: Data) -> Bool {
                guard let out = conn.onClientBytes(d) else { return false }
                for b in out { c.send(content: b, completion: .contentProcessed { _ in }) }
                return true
            }
            guard feed(data) else { conn.close(); c.cancel(); return }
            func next() {
                c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { d, _, done, err in
                    if let d, !d.isEmpty, !feed(d) { conn.close(); c.cancel(); return }
                    if done || err != nil { conn.close(); c.cancel() } else { next() }
                }
            }
            next()
        }
    }
}
#endif
