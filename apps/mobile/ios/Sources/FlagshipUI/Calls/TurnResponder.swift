#if canImport(FlagshipTurn)
import Darwin
import Flagship
import FlagshipTurn
import Foundation
import OSLog
import Security

/// The phone's TURN responder for the call in progress (docs/voici-calls.md §4): `rust/crates/flagship-turn-lite`
/// through `flagship-turn-ffi` (FlagshipTurn.xcframework, built by .github/workflows/libwebrtc.yml), plus the loopback
/// UDP socket its relayed traffic leaves from. The caller's TLS stream comes in through CallTurnGate; the datagrams
/// go to and from this phone's own peer connection, which gathers only a loopback host candidate. Same rules as
/// Android TurnResponder.kt.
final class TurnResponder: CallTurnConnection, @unchecked Sendable {
    /// 64 kbit/s each way (docs/voici-calls.md §4); a video call 2.56 Mbit/s: the 1.2 Mbit/s ceiling of
    /// voici-calls-v2.md §1.3, doubled by the frame padding (§1.6).
    static let audioRateBytesPerS = 8_000
    static let videoRateBytesPerS = 320_000
    private static let realm = "flagship"
    private static let maxDatagram = 4096

    private let lock = NSLock()
    private var handle: OpaquePointer?
    private let fd: Int32
    private let source: DispatchSourceRead
    private var toClient: ((Data) -> Void)?
    private var end: (() -> Void)?
    private var resumed = false
    private var loggedClient = false
    private var loggedToPeer = false
    private var loggedFromPeer = false
    /// What crosses the relay socket, by direction and kind (STUN method/class/error, DTLS, RTP, RTCP), for the
    /// device log: every 2 s and at close. "c>p" is the caller to this phone's peer connection, "p>c" the way back.
    private var mix: [String: Int] = [:]
    private var loggedSendError = false
    private var mixAt = TurnResponder.nowMs()
    private var usernames: Set<String> = []

    /// The relay socket and a native responder for one armed call; nil when either can't be made.
    static func open(_ c: CallTurnGate.Credential, rateBytesPerS: Int) -> TurnResponder? {
        let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard fd >= 0 else {
            voiciCallLog.notice("turn responder: open failed (socket \(errno, privacy: .public))")
            return nil
        }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sp in
                bind(fd, sp, len) == 0 && getsockname(fd, sp, &len) == 0
            }
        }
        guard bound else {
            voiciCallLog.notice("turn responder: open failed (bind \(errno, privacy: .public))")
            Darwin.close(fd); return nil
        }
        let port = UInt16(bigEndian: addr.sin_port)
        var nonce = [UInt8](repeating: 0, count: 16)
        guard SecRandomCopyBytes(kSecRandomDefault, nonce.count, &nonce) == errSecSuccess else {
            voiciCallLog.notice("turn responder: open failed (random)")
            Darwin.close(fd); return nil
        }
        let config = [realm, c.user, c.secret, nonce.map { String(format: "%02x", $0) }.joined(),
                      "127.0.0.1:\(port)", "127.0.0.1", String(rateBytesPerS)].joined(separator: "\n")
        let bytes = Array(config.utf8)
        guard let h = bytes.withUnsafeBufferPointer({ flagship_turn_new($0.baseAddress, $0.count) }) else {
            voiciCallLog.notice("turn responder: open failed (native)")
            Darwin.close(fd)
            return nil
        }
        voiciCallLog.notice("turn responder: open, relay loopback:\(port, privacy: .public)")
        return TurnResponder(handle: h, fd: fd)
    }

    private init(handle: OpaquePointer, fd: Int32) {
        self.handle = handle
        self.fd = fd
        source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: DispatchQueue(label: "flagship.turn"))
        source.setEventHandler { [weak self] in self?.readOne() }
        source.setCancelHandler { Darwin.close(fd) }
    }

    func attach(toClient: @escaping (Data) -> Void, end: @escaping () -> Void) {
        let resume: Bool = lock.withLock {
            guard handle != nil, !resumed else { return false }
            self.toClient = toClient
            self.end = end
            resumed = true
            return true
        }
        if resume { source.resume() }
    }

    func onClientBytes(_ data: Data) -> [Data]? {
        let out: Data? = lock.withLock {
            guard let h = handle else { return nil }
            let now = Self.nowMs()
            return data.withUnsafeBytes { raw in
                Self.take(flagship_turn_client_bytes(h, raw.bindMemory(to: UInt8.self).baseAddress, raw.count, now))
            }
        }
        guard let out, let r = Self.decode(out) else {
            voiciCallLog.notice("turn responder: undecodable answer to client bytes")
            return nil
        }
        guard r.status == 0 else {
            voiciCallLog.notice("turn responder: client bytes status \(r.status, privacy: .public)")
            return nil
        }
        let (firstClient, firstToPeer): (Bool, Bool) = lock.withLock {
            defer { loggedClient = true; if !r.peers.isEmpty { loggedToPeer = true } }
            return (!loggedClient, !loggedToPeer && !r.peers.isEmpty)
        }
        if firstClient {
            let method = data.count >= 2 ? (UInt16(data[data.startIndex]) << 8 | UInt16(data[data.startIndex + 1])) : 0
            voiciCallLog.notice("turn responder: first client message 0x\(String(format: "%04x", method), privacy: .public), \(r.client.count, privacy: .public) bytes back")
        }
        if firstToPeer, let p = r.peers.first { voiciCallLog.notice("turn responder: first datagram to peer loopback:\(p.0, privacy: .public)") }
        for (port, d) in r.peers {
            note("c>p:\(port)", d)
            send(d, port: port)
        }
        return r.client.isEmpty ? [] : [r.client]
    }

    private func readOne() {
        var buf = [UInt8](repeating: 0, count: Self.maxDatagram)
        var from = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let n = withUnsafeMutablePointer(to: &from) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { recvfrom(fd, &buf, buf.count, 0, $0, &len) }
        }
        guard n > 0, from.sin_addr.s_addr == inet_addr("127.0.0.1") else { return }
        let port = UInt16(bigEndian: from.sin_port)
        let firstFromPeer: Bool = lock.withLock { defer { loggedFromPeer = true }; return !loggedFromPeer }
        if firstFromPeer { voiciCallLog.notice("turn responder: first datagram from peer loopback:\(port, privacy: .public)") }
        // The native call runs under the lock; the client write does not.
        let (out, sink): (Data?, ((Data) -> Void)?) = lock.withLock {
            guard let h = handle else { return (nil, nil) }
            let now = Self.nowMs()
            let o = buf.withUnsafeBufferPointer { Self.take(flagship_turn_peer_datagram(h, port, $0.baseAddress, n, now)) }
            return (o, toClient)
        }
        let datagram = Data(buf[0..<n])
        if let out, let r = Self.decode(out), !r.client.isEmpty {
            note("p>c:\(port)", datagram)
            sink?(r.client)
        } else {
            note("p>c:\(port) dropped", datagram)
            if firstFromPeer { voiciCallLog.notice("turn responder: first peer datagram not forwarded (no permission or channel?)") }
        }
    }

    private func send(_ d: Data, port: UInt16) {
        var to = sockaddr_in()
        to.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        to.sin_family = sa_family_t(AF_INET)
        to.sin_addr.s_addr = inet_addr("127.0.0.1")
        to.sin_port = port.bigEndian
        let sent = d.withUnsafeBytes { raw in
            withUnsafePointer(to: &to) { p in
                p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    sendto(fd, raw.baseAddress, raw.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
        }
        if sent != d.count {
            let e = errno
            let first: Bool = lock.withLock { defer { loggedSendError = true }; return !loggedSendError }
            if first { voiciCallLog.notice("turn responder: send to peer loopback:\(port, privacy: .public) failed, errno \(e, privacy: .public)") }
        }
    }

    func close() {
        let wasOpen: Bool = lock.withLock {
            guard let h = handle else { return false }
            flagship_turn_free(h)
            handle = nil
            end = nil
            toClient = nil
            // A dispatch source must be resumed before it is cancelled and released.
            if !resumed { resumed = true; source.resume() }
            return true
        }
        if wasOpen {
            flushMix(force: true)
            voiciCallLog.notice("turn responder: closed")
            source.cancel()
        }
    }

    deinit { if handle != nil { close() } }

    private static func nowMs() -> UInt64 { UInt64(Date().timeIntervalSince1970 * 1000) }

    /// A datagram's kind: STUN (method, class, error code), DTLS, RTP or RTCP. Contents never leave the phone.
    static func kind(_ d: Data) -> (String, String?) {
        let b = [UInt8](d.prefix(512))
        guard let f = b.first else { return ("empty", nil) }
        if f & 0xC0 == 0, b.count >= 20, b[4] == 0x21, b[5] == 0x12, b[6] == 0xA4, b[7] == 0x42 {
            let t = UInt16(b[0]) << 8 | UInt16(b[1])
            let method = (t & 0x000F) | ((t & 0x00E0) >> 1) | ((t & 0x3E00) >> 2)
            let cls = ((t >> 4) & 1) | ((t >> 7) & 2)
            var name = ["req", "ind", "ok", "err"][Int(cls)]
            var user: String?
            var i = 20
            while i + 4 <= b.count {
                let at = UInt16(b[i]) << 8 | UInt16(b[i + 1]), l = Int(UInt16(b[i + 2]) << 8 | UInt16(b[i + 3]))
                guard i + 4 + l <= b.count else { break }
                if at == 0x0009, l >= 4 { name += "\(Int(b[i + 6]) * 100 + Int(b[i + 7]))" }
                if at == 0x0006 { user = String(decoding: b[(i + 4)..<(i + 4 + l)], as: UTF8.self) }
                i += 4 + ((l + 3) & ~3)
            }
            return ("stun\(String(format: "%03x", method)) \(name)", user)
        }
        if (20...63).contains(f) { return ("dtls\(f)", nil) }
        if (128...191).contains(f), b.count >= 2 { return ((200...206).contains(b[1]) ? "rtcp" : "rtp", nil) }
        return ("other", nil)
    }

    private func note(_ dir: String, _ d: Data) {
        let (k, user) = Self.kind(d)
        let newUser: String? = lock.withLock {
            mix["\(dir) \(k)", default: 0] += 1
            guard let user, usernames.insert("\(dir) \(user)").inserted, usernames.count <= 8 else { return nil }
            return user
        }
        // ICE ufrags only (USERNAME of a connectivity check), so the log shows whether both sides agree on them.
        if let newUser { voiciCallLog.notice("turn mix: \(dir, privacy: .public) check username \(newUser, privacy: .public)") }
        flushMix(force: false)
    }

    private func flushMix(force: Bool) {
        let line: String? = lock.withLock {
            let now = Self.nowMs()
            guard force || now >= mixAt + 2000, !mix.isEmpty else { return nil }
            mixAt = now
            defer { mix = [:] }
            return mix.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ", ")
        }
        if let line { voiciCallLog.notice("turn mix: \(line, privacy: .public)") }
    }

    private static func take(_ b: FlagshipTurnBuf) -> Data {
        defer { flagship_turn_buf_free(b) }
        guard let p = b.ptr else { return Data() }
        return Data(bytes: p, count: b.len)
    }

    /// include/flagship_turn.h: status, client bytes, then peer datagrams.
    static func decode(_ b: Data) -> (status: UInt8, client: Data, peers: [(UInt16, Data)])? {
        let a = [UInt8](b)
        var i = 0
        func u16() -> Int? { guard i + 2 <= a.count else { return nil }; defer { i += 2 }; return Int(a[i]) << 8 | Int(a[i + 1]) }
        guard a.count >= 7 else { return nil }
        let status = a[0]
        let n = Int(a[1]) << 24 | Int(a[2]) << 16 | Int(a[3]) << 8 | Int(a[4])
        i = 5
        guard n <= a.count - i else { return nil }
        let client = Data(a[i..<i + n])
        i += n
        guard let count = u16() else { return nil }
        var peers: [(UInt16, Data)] = []
        for _ in 0..<count {
            guard let port = u16(), let len = u16(), i + len <= a.count else { return nil }
            peers.append((UInt16(port), Data(a[i..<i + len])))
            i += len
        }
        return (status, client, peers)
    }
}
#endif
