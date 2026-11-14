#if DEBUG
import Foundation

/// A scripted retail box on a fake radio for the mock gym and the unit tests: real
/// `flagship/box-claim/v1` bytes, a receipt signed by a fixed box key, and one scenario per stop the
/// claim screens must show (docs/retail-box-setup.md §13.2 item 5).
public final class MockBoxClaimRadio: BoxClaimRadio, @unchecked Sendable {
    public enum Scenario: String, Sendable, CaseIterable {
        case normal
        /// An unclaimed box is already advertising before the buyer plugs theirs in.
        case boxAlreadyNearby
        /// A second box appears after the first.
        case secondBox
        /// The box reports a press before the phone showed the instruction.
        case earlyPress
        /// Two phones armed at once.
        case contention
        /// A burst of two presses.
        case doublePress
        /// The box sends a receipt from another session (a relay passing the real box's on).
        case relayReceipt
        /// The first Wi-Fi attempt fails with a wrong password; the second goes online.
        case wrongPassword
        /// Nothing ever advertises.
        case noBox
    }

    /// The mock box's key: Ed25519 seed 0x71…, ML-DSA seed 0x72… (as the shared vectors).
    public static let stkSecret = [UInt8](repeating: 0x71, count: 32) + [UInt8](repeating: 0x72, count: 32)
    public static var stkHybridPubHex: String {
        PqBin.hex((try? PqHybrid.hybridSigKeygen(edSeed: Array(stkSecret[0..<32]), mldsaSeed: Array(stkSecret[32...])).publicKey) ?? [])
    }
    public static var stkPubHex: String { String(stkHybridPubHex.prefix(64)) }

    public let scenario: Scenario
    /// How long after the scan starts the box "powers on" and appears.
    public let appearAfterMs: UInt64
    /// When the scripted press happens after `arm`.
    public let pressAfterArmMs: UInt64
    private let lock = NSLock()
    private var scanning = false
    private var onAdverts: (@Sendable ([BoxClaimAdvert]) -> Void)?
    public private(set) var sentNetwork: BoxClaim.WiFiConfig??

    public init(scenario: Scenario, appearAfterMs: UInt64 = 4_000, pressAfterArmMs: UInt64 = 3_200) {
        self.scenario = scenario
        self.appearAfterMs = appearAfterMs
        self.pressAfterArmMs = scenario == .earlyPress ? 100 : pressAfterArmMs
    }

    static let box = BoxClaimAdvert(peripheral: "mock-box", advertId: "0123456789abcdef", state: .unclaimed)
    static let other = BoxClaimAdvert(peripheral: "mock-other", advertId: "fedcba9876543210", state: .unclaimed)

    public func startScan(onAdverts: @escaping @Sendable ([BoxClaimAdvert]) -> Void) async throws {
        lock.lock(); scanning = true; self.onAdverts = onAdverts; lock.unlock()
        if scenario == .boxAlreadyNearby { onAdverts([Self.other]) }
        guard scenario != .noBox else { return }
        Task {
            try? await Task.sleep(nanoseconds: appearAfterMs * 1_000_000)
            emit([Self.box])
            if scenario == .secondBox {
                try? await Task.sleep(nanoseconds: min(1_500, appearAfterMs) * 1_000_000)
                emit([Self.box, Self.other])
            }
        }
    }

    private func emit(_ a: [BoxClaimAdvert]) {
        lock.lock(); let cb = scanning ? onAdverts : nil; lock.unlock()
        cb?(a)
    }

    public func stopScan() {
        lock.lock(); scanning = false; onAdverts = nil; lock.unlock()
    }

    public func connect(_ advert: BoxClaimAdvert) async throws -> any BoxClaimLink {
        MockBoxClaimLink(radio: self)
    }

    fileprivate func recordNetwork(_ w: BoxClaim.WiFiConfig?) {
        lock.lock(); sentNetwork = .some(w); lock.unlock()
    }
}

/// The box end of one mock link: answers the phone as `RetailClaimService` does.
final class MockBoxClaimLink: BoxClaimLink, @unchecked Sendable {
    private let radio: MockBoxClaimRadio
    private let lock = NSLock()
    private var queue: [[UInt8]] = []
    private var waiting: CheckedContinuation<[UInt8], Error>?
    private var closed = false
    private var pending: BoxClaim.BoxPending?
    private var channel: BoxClaim.Channel?
    private var wifiTries = 0

    init(radio: MockBoxClaimRadio) { self.radio = radio }

    func send(_ message: [UInt8]) async throws {
        if isClosed { throw BoxClaimRadioError.linkClosed }
        try await handle(message)
    }

    private var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closed }

    func receive() async throws -> [UInt8] {
        try await withCheckedThrowingContinuation { c in
            lock.lock()
            if !queue.isEmpty { let m = queue.removeFirst(); lock.unlock(); c.resume(returning: m); return }
            if closed { lock.unlock(); c.resume(throwing: BoxClaimRadioError.linkClosed); return }
            waiting = c
            lock.unlock()
        }
    }

    func close() {
        lock.lock(); closed = true; let w = waiting; waiting = nil; lock.unlock()
        w?.resume(throwing: BoxClaimRadioError.linkClosed)
    }

    private func push(_ m: [UInt8]) {
        lock.lock()
        if let w = waiting { waiting = nil; lock.unlock(); w.resume(returning: m); return }
        queue.append(m)
        lock.unlock()
    }

    private func handshake(_ o: [String: Any]) {
        let d = (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data()
        push(BoxClaim.encodeMessage(kind: BoxClaim.frameHandshake, payload: Array(d)))
    }

    private func record(_ json: String) {
        guard let ch = channel, let r = try? ch.seal(Array(json.utf8)) else { return }
        push(BoxClaim.encodeMessage(kind: BoxClaim.frameRecord, payload: r))
    }

    private func later(_ ms: UInt64, _ f: @escaping @Sendable () -> Void) {
        Task { try? await Task.sleep(nanoseconds: ms * 1_000_000); f() }
    }

    private func handle(_ raw: [UInt8]) async throws {
        let (kind, payload) = try BoxClaim.decodeMessage(raw)
        if kind == BoxClaim.frameHandshake {
            let obj = try JSONSerialization.jsonObject(with: Data(payload))
            if let o = obj as? [String: Any], o["t"] as? String == "hello" {
                let p = try BoxClaim.BoxPending(hello: o, state: .unclaimed, codeKey: nil)
                pending = p
                handshake(p.accept.json)
            } else if let p = pending {
                pending = nil
                let (ready, ch) = try p.complete(finish: obj)
                channel = ch
                handshake(ready)
            }
            return
        }
        guard let ch = channel else { return }
        let msg = try BoxClaim.PhoneMessage.parse(try ch.openJson(payload))
        let s = radio.scenario
        switch msg {
        case .arm:
            record(#"{"t":"armed"}"#)
            if s == .contention {
                later(1_000) { [weak self] in self?.record(#"{"t":"press-result","ok":false,"reason":"contention"}"#) }
                return
            }
            let at = radio.pressAfterArmMs
            let count = s == .doublePress ? 2 : 1
            later(at + 400) { [weak self] in
                self?.record(#"{"t":"press","atMs":\#(at),"count":\#(count),"long":false}"#)
                if count == 1 { self?.record(#"{"t":"press-result","ok":true}"#) } else { self?.record(#"{"t":"press-result","ok":false,"reason":"burst"}"#) }
            }
        case .wifiScan:
            record(#"{"t":"wifi-list","networks":[{"ssid":"Home Wi-Fi","security":"wpa2-wpa3","signal":82,"band":"5"},{"ssid":"Neighbour","security":"wpa2","signal":31,"band":"2.4"},{"ssid":"Office","security":"enterprise","signal":40,"band":"5"}]}"#)
        case .claim(let recipe):
            guard let data = recipe.data(using: .utf8),
                  let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let blob = o["blob"] as? [String: Any],
                  let domain = blob["serverDomain"] as? String,
                  let ac = blob["authCode"] as? [String: Any], let serial = ac["serial"] as? String else {
                record(#"{"t":"refused","reason":"recipe-invalid"}"#)
                return
            }
            let transcript = s == .relayReceipt ? String(repeating: "ab", count: 64) : ch.transcriptHex
            let unsigned = BoxClaim.Receipt(mode: .open, serverDomain: domain, serial: serial, stkHybridPub: MockBoxClaimRadio.stkHybridPubHex,
                                            bootKeyBindingSha256: "", model: "Mini PC N100", imageVersion: "0.4.0",
                                            transcript: transcript, issuedAt: Int64(Date().timeIntervalSince1970 * 1000))
            let signed = try unsigned.signed { p, m in try PqHybrid.hybridSign(secretKey: MockBoxClaimRadio.stkSecret, purpose: p, payload: m) }
            let rj = try JSONSerialization.data(withJSONObject: ["t": "receipt", "receipt": signed.json], options: [.sortedKeys])
            record(String(data: rj, encoding: .utf8)!)
        case .network(let w):
            radio.recordNetwork(w)
            let via = w == nil ? "ethernet" : "wifi"
            record(#"{"t":"network-status","stage":"connecting","via":"\#(via)"}"#)
            wifiTries += 1
            let fail = s == .wrongPassword && w != nil && wifiTries == 1
            later(800) { [weak self] in
                if fail {
                    self?.record(#"{"t":"network-status","stage":"failed","via":"wifi","failure":"wrong-password"}"#)
                } else {
                    self?.record(#"{"t":"network-status","stage":"online","via":"\#(via)"}"#)
                }
            }
        case .abort:
            close()
        }
    }
}
#endif
