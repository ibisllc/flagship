import Foundation
import CryptoKit

/// `flagship/box-claim/v1`, the Swift twin of packages/protocol/src/boxClaim.ts. DRAFT, pending
/// external review alongside `flagship/pq-session/v1`. Spec: docs/retail-box-setup.md §7, §15.
/// Vectors: packages/protocol/test-vectors/box-claim/.
///
/// The phone half drives a retail box claim; the box half exists so the mock box in the gym speaks
/// the same bytes as a real one.
public struct BoxClaimError: Error, Equatable, CustomStringConvertible {
    public let code: String
    public init(_ code: String) { self.code = code }
    public var description: String { code }
}

private func cfail(_ code: String) -> BoxClaimError { BoxClaimError(code) }

public enum BoxClaim {
    public static let tag = "flagship/box-claim/v1"
    public static let tagKeys = "flagship/box-claim-keys/v1"
    public static let tagConfirm = "flagship/box-claim-confirm/v1"
    public static let tagRecord = "flagship/box-claim-record/v1"
    public static let tagReceipt = "flagship/box-claim-receipt/v1"
    public static let tagKey = "flagship/box-claim-key/v1"
    public static let tagSetupCodeKey = "flagship/box-setup-code-key/v1"
    public static let tagMailbox = "flagship/box-claim-mailbox/v1"

    public enum Mode: String, Sendable { case open, code }
    public enum AdvertState: String, Sendable { case unclaimed, resetWindow = "reset-window" }

    public static let advertiseMs: Int64 = 10 * 60_000
    public static let pressWindowMs: Int64 = 20_000
    public static let instructionPauseMinMs: Int64 = 2_000
    public static let instructionPauseMaxMs: Int64 = 6_000
    public static let pressAfterInstructionMs: Int64 = 5_000
    public static let armLatencyMs: Int64 = 1_000
    public static let grantMs: Int64 = 2 * 60_000
    public static let powerKeyBurstEndMs: Int64 = 2_000
    public static let burstClaim = 1
    public static let burstShowCode = 3
    public static let burstReset = 5
    public static let setupCodeChars = 20
    public static let maxRecord = 64 * 1024
    public static let maxMessage = maxRecord + 1024
    public static let dirPhone: UInt8 = 1
    public static let dirBox: UInt8 = 2
    public static let frameHandshake: UInt8 = 0x01
    public static let frameRecord: UInt8 = 0x02

    /// GATT layout the box's BlueZ peripheral serves (docs/retail-box-setup.md §7.2, §11.1).
    public static let bleServiceUUID = "6f3c1a00-5e1b-4f0a-9c55-f1a95e5b0c01"
    /// Phone → box frames (write without response).
    public static let bleInboxUUID = "6f3c1a01-5e1b-4f0a-9c55-f1a95e5b0c01"
    /// Box → phone frames (notify).
    public static let bleOutboxUUID = "6f3c1a02-5e1b-4f0a-9c55-f1a95e5b0c01"

    /// A box's scan-response service data: version, state byte, 8-byte per-boot id. Nil when it is
    /// not a claim advert this app understands.
    public static func parseAdvert(serviceData d: [UInt8]) -> (state: AdvertState, id: String)? {
        guard d.count == 10, d[0] == 1 else { return nil }
        let state: AdvertState
        switch d[1] {
        case 1: state = .unclaimed
        case 2: state = .resetWindow
        default: return nil
        }
        return (state, PqBin.hex(Array(d[2...])))
    }

    public static func advertServiceData(state: AdvertState, id: [UInt8]) -> [UInt8] {
        [1, state == .unclaimed ? 1 : 2] + Array(id.prefix(8))
    }

    static func utf8(_ s: String) -> [UInt8] { Array(s.utf8) }
    static func sha256(_ b: [UInt8]) -> [UInt8] { Array(SHA256.hash(data: b)) }
    static func sha512(_ b: [UInt8]) -> [UInt8] { Array(SHA512.hash(data: b)) }
    static func u64be(_ n: UInt64) -> [UInt8] { (0..<8).map { UInt8((n >> (8 * (7 - UInt64($0)))) & 0xff) } }
    static func u32be(_ n: UInt32) -> [UInt8] { (0..<4).map { UInt8((n >> (8 * (3 - UInt32($0)))) & 0xff) } }

    static func random(_ n: Int, _ fixed: [UInt8]?) throws -> [UInt8] {
        if let fixed {
            guard fixed.count == n else { throw cfail("randomness") }
            return fixed
        }
        return PqBin.random(n)
    }

    static func hexField(_ o: [String: Any], _ k: String, _ n: Int, _ code: String = "claim-malformed") throws -> [UInt8] {
        guard let s = o[k] as? String, s.utf8.count == n * 2, let b = PqBin.unhex(s), b.count == n else { throw cfail(code) }
        return b
    }

    static func exact(_ w: Any?, _ keys: [String], _ code: String = "claim-malformed") throws -> [String: Any] {
        guard let o = w as? [String: Any], o.keys.sorted() == keys.sorted() else { throw cfail(code) }
        return o
    }

    static func isOne(_ v: Any?) -> Bool {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return false }
        return n.doubleValue == 1
    }

    static func safeInt(_ v: Any?) -> Int64? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d >= 0, d <= 9_007_199_254_740_991, d == d.rounded() else { return nil }
        return n.int64Value
    }

    // MARK: - Setup code

    static let crockford = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    /// 100 random bits as 20 Crockford base32 characters. `randomness` (13 bytes) is for vectors.
    public static func generateSetupCode(randomness: [UInt8]? = nil) throws -> String {
        var r = try random(13, randomness)
        defer { PqBin.zero(&r) }
        var out = ""
        for i in 0..<setupCodeChars {
            var v = 0
            for b in 0..<5 {
                let bit = i * 5 + b
                v = (v << 1) | Int((r[bit / 8] >> (7 - UInt8(bit % 8))) & 1)
            }
            out.append(crockford[v])
        }
        return out
    }

    public static func normalizeSetupCode(_ input: String) -> String? {
        var s = ""
        for ch in input.uppercased() {
            switch ch {
            case " ", "\t", "\n", "\r", "-": continue
            case "I", "L": s.append("1")
            case "O": s.append("0")
            default: s.append(ch)
            }
        }
        guard s.count == setupCodeChars, s.allSatisfy({ crockford.contains($0) }) else { return nil }
        return s
    }

    public static func formatSetupCode(_ code: String) -> String {
        var parts: [String] = []
        var cur = ""
        for ch in code {
            cur.append(ch)
            if cur.count == 4 { parts.append(cur); cur = "" }
        }
        if !cur.isEmpty { parts.append(cur) }
        return parts.joined(separator: "-")
    }

    static func canonicalCode(_ code: String) throws -> String {
        guard let n = normalizeSetupCode(code) else { throw cfail("claim-malformed") }
        return n
    }

    public static func setupCodeKey(_ code: String) throws -> [UInt8] {
        sha256(utf8("\(tagSetupCodeKey)|\(try canonicalCode(code))"))
    }

    public static func setupCodeMailboxId(_ code: String) throws -> String {
        PqBin.hex(sha256(utf8("\(tagMailbox)|\(try canonicalCode(code))")))
    }

    public static func setupCodeLink(_ code: String, apex: String = "flagshipserver.com") throws -> String {
        "https://\(apex)/claim#c=\(try canonicalCode(code))&v=1"
    }

    /// The code from a scanned `https://<apex>/claim#c=…&v=1`, or nil.
    public static func parseSetupCodeLink(_ link: String) -> String? {
        let t = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("https://"), let hashIx = t.firstIndex(of: "#") else { return nil }
        let head = t[t.index(t.startIndex, offsetBy: 8)..<hashIx]
        guard head.hasSuffix("/claim") else { return nil }
        let host = head.dropLast(6)
        guard !host.isEmpty, host.allSatisfy({ ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "." || $0 == "-" }) else { return nil }
        var params: [String: String] = [:]
        for pair in t[t.index(after: hashIx)...].split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
            let k = kv[0].removingPercentEncoding ?? kv[0]
            if params[k] == nil { params[k] = kv.count > 1 ? (kv[1].replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? kv[1]) : "" }
        }
        guard params["v"] == "1", let c = params["c"], !c.isEmpty else { return nil }
        return normalizeSetupCode(c)
    }

    // MARK: - Handshake

    public struct Randomness {
        public var ephemeralSeed: [UInt8]?
        public var nonce: [UInt8]?
        public var encapsulation: [UInt8]?
        public init(ephemeralSeed: [UInt8]? = nil, nonce: [UInt8]? = nil, encapsulation: [UInt8]? = nil) {
            self.ephemeralSeed = ephemeralSeed; self.nonce = nonce; self.encapsulation = encapsulation
        }
    }

    public struct Hello: Equatable {
        public let mode: Mode
        public let ephemeralPub: String
        public let nonce: String
        public var json: [String: Any] { ["v": 1, "t": "hello", "mode": mode.rawValue, "ephemeralPub": ephemeralPub, "nonce": nonce] }
        var bytes: [UInt8] { utf8([tag, "hello", mode.rawValue, ephemeralPub, nonce].joined(separator: "|")) }

        static func parse(_ w: Any?) throws -> Hello {
            let o = try exact(w, ["ephemeralPub", "mode", "nonce", "t", "v"])
            guard isOne(o["v"]), o["t"] as? String == "hello", let m = (o["mode"] as? String).flatMap(Mode.init) else { throw cfail("claim-malformed") }
            _ = try hexField(o, "ephemeralPub", PqHybrid.sealPublicKeyLen)
            _ = try hexField(o, "nonce", 32)
            return Hello(mode: m, ephemeralPub: o["ephemeralPub"] as! String, nonce: o["nonce"] as! String)
        }
    }

    public struct Accept: Equatable {
        public let mode: Mode
        public let state: AdvertState
        public let enc: String
        public let ephemeralPub: String
        public let nonce: String
        public var json: [String: Any] {
            ["v": 1, "t": "accept", "mode": mode.rawValue, "state": state.rawValue, "enc": enc, "ephemeralPub": ephemeralPub, "nonce": nonce]
        }
        var bytes: [UInt8] { utf8([tag, "accept", mode.rawValue, state.rawValue, enc, ephemeralPub, nonce].joined(separator: "|")) }

        static func parse(_ w: Any?) throws -> Accept {
            let o = try exact(w, ["enc", "ephemeralPub", "mode", "nonce", "state", "t", "v"])
            guard isOne(o["v"]), o["t"] as? String == "accept",
                  let m = (o["mode"] as? String).flatMap(Mode.init),
                  let st = (o["state"] as? String).flatMap(AdvertState.init) else { throw cfail("claim-malformed") }
            _ = try hexField(o, "enc", PqHybrid.sealEncLen)
            _ = try hexField(o, "ephemeralPub", PqHybrid.sealPublicKeyLen)
            _ = try hexField(o, "nonce", 32)
            return Accept(mode: m, state: st, enc: o["enc"] as! String, ephemeralPub: o["ephemeralPub"] as! String, nonce: o["nonce"] as! String)
        }
    }

    static func finishEncBytes(_ enc: String) -> [UInt8] { utf8([tag, "finish", enc].joined(separator: "|")) }

    static func parseFinish(_ w: Any?) throws -> (enc: String, confirm: [UInt8]) {
        let o = try exact(w, ["confirm", "enc", "t", "v"])
        guard isOne(o["v"]), o["t"] as? String == "finish" else { throw cfail("claim-malformed") }
        _ = try hexField(o, "enc", PqHybrid.sealEncLen)
        return (o["enc"] as! String, try hexField(o, "confirm", 32))
    }

    static func parseReady(_ w: Any?) throws -> [UInt8] {
        let o = try exact(w, ["confirm", "t", "v"])
        guard isOne(o["v"]), o["t"] as? String == "ready" else { throw cfail("claim-malformed") }
        return try hexField(o, "confirm", 32)
    }

    struct Schedule {
        let phoneKey: [UInt8]
        let boxKey: [UInt8]
        let confirmKey: [UInt8]
        let sessionId: [UInt8]
        let transcript: [UInt8]
    }

    static func schedule(_ mode: Mode, _ codeKey: [UInt8]?, _ ss1: [UInt8], _ ss2: [UInt8], _ th: [UInt8]) -> Schedule {
        let salt = sha512(utf8("\(tag)|\(mode.rawValue)|") + (codeKey ?? []))
        let prk = HKDF<SHA512>.extract(inputKeyMaterial: SymmetricKey(data: ss1 + ss2), salt: salt)
        let key = SymmetricKey(data: Data(prk))
        func ex(_ label: String, _ n: Int) -> [UInt8] {
            HKDF<SHA512>.expand(pseudoRandomKey: key, info: utf8("\(tagKeys)|\(label)|") + th, outputByteCount: n).withUnsafeBytes { Array($0) }
        }
        return Schedule(phoneKey: ex("phone-to-box", 32), boxKey: ex("box-to-phone", 32), confirmKey: ex("confirm", 32),
                        sessionId: ex("session-id", 16), transcript: th)
    }

    static func confirmTag(_ k: [UInt8], _ who: String, _ th: [UInt8]) -> [UInt8] {
        Array(HMAC<SHA256>.authenticationCode(for: utf8("\(tagConfirm)|\(who)|") + th, using: SymmetricKey(data: k)))
    }

    static func checkSealKey(_ pub: [UInt8]) throws {
        do { try PqHybrid.parseHybridSealPublicKey(pub) } catch { throw cfail("bad-public-key") }
    }

    /// The phone between hello and accept; single use.
    public final class PhoneStart {
        public let hello: Hello
        public let mode: Mode
        let codeKey: [UInt8]?
        var seed: [UInt8]?

        /// Mode `code` needs the code the phone scanned; mode `open` takes none.
        public init(mode: Mode, code: String? = nil, randomness: Randomness = Randomness()) throws {
            guard (mode == .code) == (code != nil) else { throw cfail("claim-malformed") }
            codeKey = try code.map { try BoxClaim.setupCodeKey($0) }
            let s = try BoxClaim.random(32, randomness.ephemeralSeed)
            guard let pk = PqPrim.xwingPublicKey(s) else { throw cfail("randomness") }
            hello = Hello(mode: mode, ephemeralPub: PqBin.hex(pk), nonce: PqBin.hex(try BoxClaim.random(32, randomness.nonce)))
            self.mode = mode
            seed = s
        }

        deinit { if var s = seed { PqBin.zero(&s) } }

        /// Answers the box's accept. Refuses a box that answers in another mode than asked.
        public func finish(accept w: Any?, randomness: Randomness = Randomness()) throws -> (finish: [String: Any], pending: PhonePending) {
            guard var s = seed else { throw cfail("claim-malformed") }
            seed = nil
            defer { PqBin.zero(&s) }
            let a = try Accept.parse(w)
            guard a.mode == mode else { throw cfail("mode-mismatch") }
            guard var ss1 = PqPrim.xwingDecapsulate(PqBin.unhex(a.enc)!, s) else { throw cfail("bad-public-key") }
            defer { PqBin.zero(&ss1) }
            let boxPub = PqBin.unhex(a.ephemeralPub)!
            try BoxClaim.checkSealKey(boxPub)
            var eseed = try BoxClaim.random(64, randomness.encapsulation)
            defer { PqBin.zero(&eseed) }
            guard var r = PqPrim.xwingEncapsulate(boxPub, eseed) else { throw cfail("bad-public-key") }
            defer { PqBin.zero(&r.ss) }
            let encHex = PqBin.hex(r.ct)
            let th = BoxClaim.sha512(hello.bytes + a.bytes + BoxClaim.finishEncBytes(encHex))
            let sch = BoxClaim.schedule(mode, codeKey, ss1, r.ss, th)
            let fin: [String: Any] = ["v": 1, "t": "finish", "enc": encHex, "confirm": PqBin.hex(BoxClaim.confirmTag(sch.confirmKey, "phone", th))]
            return (fin, PhonePending(schedule: sch, state: a.state))
        }
    }

    public final class PhonePending {
        let schedule: Schedule
        public let state: AdvertState
        var used = false
        init(schedule: Schedule, state: AdvertState) { self.schedule = schedule; self.state = state }

        /// Checks the box's confirmation. In mode `code` a box without the code fails here.
        public func confirm(ready w: Any?) throws -> Channel {
            guard !used else { throw cfail("claim-malformed") }
            used = true
            let c = try BoxClaim.parseReady(w)
            guard PqBin.equal(c, BoxClaim.confirmTag(schedule.confirmKey, "box", schedule.transcript)) else { throw cfail("confirm-failed") }
            return Channel(role: .phone, keys: schedule, advertState: state)
        }
    }

    /// The box between accept and finish (the mock box in the gym; a real box runs the TS code).
    public final class BoxPending {
        let hello: Hello
        public let accept: Accept
        let codeKey: [UInt8]?
        var ss1: [UInt8]
        var seed: [UInt8]?

        public init(hello w: Any?, state: AdvertState, codeKey: [UInt8]?, randomness: Randomness = Randomness()) throws {
            let h = try Hello.parse(w)
            if h.mode == .code && codeKey == nil { throw cfail("no-code") }
            let phonePub = PqBin.unhex(h.ephemeralPub)!
            try BoxClaim.checkSealKey(phonePub)
            var eseed = try BoxClaim.random(64, randomness.encapsulation)
            defer { PqBin.zero(&eseed) }
            guard let r = PqPrim.xwingEncapsulate(phonePub, eseed) else { throw cfail("bad-public-key") }
            let s = try BoxClaim.random(32, randomness.ephemeralSeed)
            guard let pk = PqPrim.xwingPublicKey(s) else { throw cfail("randomness") }
            accept = Accept(mode: h.mode, state: state, enc: PqBin.hex(r.ct), ephemeralPub: PqBin.hex(pk),
                            nonce: PqBin.hex(try BoxClaim.random(32, randomness.nonce)))
            hello = h
            self.codeKey = h.mode == .code ? codeKey : nil
            ss1 = r.ss
            seed = s
        }

        deinit { PqBin.zero(&ss1); if var s = seed { PqBin.zero(&s) } }

        public func complete(finish w: Any?) throws -> (ready: [String: Any], channel: Channel) {
            guard var s = seed else { throw cfail("claim-malformed") }
            seed = nil
            defer { PqBin.zero(&s) }
            let f = try BoxClaim.parseFinish(w)
            guard var ss2 = PqPrim.xwingDecapsulate(PqBin.unhex(f.enc)!, s) else { throw cfail("bad-public-key") }
            defer { PqBin.zero(&ss2) }
            let th = BoxClaim.sha512(hello.bytes + accept.bytes + BoxClaim.finishEncBytes(f.enc))
            let sch = BoxClaim.schedule(hello.mode, codeKey, ss1, ss2, th)
            PqBin.zero(&ss1)
            guard PqBin.equal(f.confirm, BoxClaim.confirmTag(sch.confirmKey, "phone", th)) else {
                throw cfail(hello.mode == .code ? "wrong-code" : "confirm-failed")
            }
            return (["v": 1, "t": "ready", "confirm": PqBin.hex(BoxClaim.confirmTag(sch.confirmKey, "box", th))],
                    Channel(role: .box, keys: sch, advertState: accept.state))
        }
    }

    // MARK: - Records

    static func recordAad(_ sid: [UInt8], _ dir: UInt8, _ seq: UInt64) -> [UInt8] { utf8("\(tagRecord)|") + sid + [dir] + u64be(seq) }
    static func recordNonce(_ dir: UInt8, _ seq: UInt64) -> [UInt8] { u32be(UInt32(dir)) + u64be(seq) }

    public static func sealRecord(key: [UInt8], sessionId: [UInt8], dir: UInt8, seq: UInt64, plaintext: [UInt8]) throws -> [UInt8] {
        guard plaintext.count <= maxRecord else { throw cfail("record-too-large") }
        let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: recordNonce(dir, seq)),
                                   authenticating: recordAad(sessionId, dir, seq))
        return u64be(seq) + Array(box.ciphertext) + Array(box.tag)
    }

    public static func openRecord(key: [UInt8], sessionId: [UInt8], dir: UInt8, record: [UInt8]) throws -> (seq: UInt64, plaintext: [UInt8]) {
        guard record.count >= 24 else { throw cfail("decrypt-failed") }
        guard record.count <= 24 + maxRecord else { throw cfail("record-too-large") }
        let seq = PqBin.readU64(record[0..<8])
        guard seq <= PqHybrid.maxSafeInteger else { throw cfail("decrypt-failed") }
        do {
            let sb = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: recordNonce(dir, seq)),
                                           ciphertext: record[8..<(record.count - 16)], tag: record[(record.count - 16)...])
            return (seq, Array(try AES.GCM.open(sb, using: SymmetricKey(data: key), authenticating: recordAad(sessionId, dir, seq))))
        } catch {
            throw cfail("decrypt-failed")
        }
    }

    /// One side of an open claim session; records arrive in order, so any gap is refused.
    public final class Channel {
        public enum Role { case phone, box }
        public let role: Role
        let keys: Schedule
        public let advertState: AdvertState
        public let sessionIdHex: String
        public let transcriptHex: String
        private var sendSeq: UInt64 = 0
        private var recvSeq: UInt64 = 0

        init(role: Role, keys: Schedule, advertState: AdvertState) {
            self.role = role; self.keys = keys; self.advertState = advertState
            sessionIdHex = PqBin.hex(keys.sessionId); transcriptHex = PqBin.hex(keys.transcript)
        }

        public func seal(_ plaintext: [UInt8]) throws -> [UInt8] {
            let mine = role == .phone
            let out = try BoxClaim.sealRecord(key: mine ? keys.phoneKey : keys.boxKey, sessionId: keys.sessionId,
                                              dir: mine ? BoxClaim.dirPhone : BoxClaim.dirBox, seq: sendSeq, plaintext: plaintext)
            sendSeq += 1
            return out
        }

        public func open(_ record: [UInt8]) throws -> [UInt8] {
            let mine = role == .phone
            let r = try BoxClaim.openRecord(key: mine ? keys.boxKey : keys.phoneKey, sessionId: keys.sessionId,
                                            dir: mine ? BoxClaim.dirBox : BoxClaim.dirPhone, record: record)
            guard r.seq == recvSeq else { throw cfail("replay") }
            recvSeq += 1
            return r.plaintext
        }

        public func openJson(_ record: [UInt8]) throws -> Any {
            let p = try open(record)
            guard let s = String(bytes: p, encoding: .utf8),
                  let o = try? JSONSerialization.jsonObject(with: Data(s.utf8), options: [.fragmentsAllowed]) else { throw cfail("claim-malformed") }
            return o
        }
    }

    // MARK: - Messages inside the channel

    public struct WiFiConfig: Equatable, Sendable {
        public var ssid: String
        public var psk: String
        public var regulatoryRegion: String
        public var issuedAt: Int64
        public init(ssid: String, psk: String, regulatoryRegion: String, issuedAt: Int64) {
            self.ssid = ssid; self.psk = psk; self.regulatoryRegion = regulatoryRegion; self.issuedAt = issuedAt
        }

        public var isValid: Bool {
            let n = ssid.utf8.count
            guard n >= 1, n <= 32 else { return false }
            let pskOk = psk.isEmpty || (psk.count >= 8 && psk.count <= 63)
                || (psk.utf8.count == 64 && psk.allSatisfy { $0.isHexDigit })
            guard pskOk else { return false }
            let rr = regulatoryRegion
            guard rr.isEmpty || (rr.count == 2 && rr.allSatisfy { ("A"..."Z").contains($0) }) else { return false }
            return issuedAt >= 0
        }
    }

    public enum WifiSecurity: String, Sendable { case open, wpa2, wpa3, wpa2wpa3 = "wpa2-wpa3", enterprise, wep }

    public struct WifiNetwork: Equatable, Sendable, Identifiable {
        public var id: String { ssid }
        public let ssid: String
        public let security: WifiSecurity
        public let signal: Int
        public let band: String
        public init(ssid: String, security: WifiSecurity, signal: Int, band: String) {
            self.ssid = ssid; self.security = security; self.signal = signal; self.band = band
        }
        /// The box joins WPA2/WPA3-Personal and open networks only (§15 "Network").
        public var supported: Bool { security != .enterprise && security != .wep }
    }

    public enum NetworkFailure: String, Sendable, CaseIterable {
        case noLink = "no-link", networkNotFound = "network-not-found", wrongPassword = "wrong-password"
        case unsupportedSecurity = "unsupported-security", noDhcp = "no-dhcp", noDns = "no-dns"
        case captivePortal = "captive-portal", relayUnreachable = "relay-unreachable"
    }

    public enum PressRefusal: String, Sendable { case noPress = "no-press", burst, longPress = "long-press", late, contention, notArmed = "not-armed", busy }

    public enum Refusal: String, Sendable {
        case noGrant = "no-grant", recipeInvalid = "recipe-invalid", recipeExpired = "recipe-expired"
        case alreadyClaimed = "already-claimed", windowClosed = "window-closed", entropy, outOfOrder = "out-of-order"
    }

    public enum PhoneMessage: Equatable {
        case arm, wifiScan, claim(recipe: String), network(WiFiConfig?), abort

        /// JSON in the field order the TS reference writes.
        public var jsonText: String {
            func q(_ s: String) -> String {
                let d = try! JSONSerialization.data(withJSONObject: [s], options: [.withoutEscapingSlashes])
                return String(String(data: d, encoding: .utf8)!.dropFirst().dropLast())
            }
            switch self {
            case .arm: return #"{"t":"arm"}"#
            case .wifiScan: return #"{"t":"wifi-scan"}"#
            case .abort: return #"{"t":"abort"}"#
            case .claim(let r): return #"{"t":"claim","recipe":"# + q(r) + "}"
            case .network(nil): return #"{"t":"network","wifi":null}"#
            case .network(let w?):
                return #"{"t":"network","wifi":{"ssid":"# + q(w.ssid) + #","psk":"# + q(w.psk) + #","regulatoryRegion":"#
                    + q(w.regulatoryRegion) + #","issuedAt":\#(w.issuedAt)}}"#
            }
        }

        public static func parse(_ w: Any?) throws -> PhoneMessage {
            guard let o = w as? [String: Any], let t = o["t"] as? String else { throw cfail("claim-malformed") }
            switch t {
            case "arm", "wifi-scan", "abort":
                _ = try exact(o, ["t"])
                return t == "arm" ? .arm : t == "abort" ? .abort : .wifiScan
            case "claim":
                _ = try exact(o, ["recipe", "t"])
                guard let r = o["recipe"] as? String, r.count <= maxRecord - 64 else { throw cfail("claim-malformed") }
                return .claim(recipe: r)
            case "network":
                _ = try exact(o, ["t", "wifi"])
                if o["wifi"] is NSNull { return .network(nil) }
                let wo = try exact(o["wifi"], ["issuedAt", "psk", "regulatoryRegion", "ssid"])
                guard let ssid = wo["ssid"] as? String, let psk = wo["psk"] as? String, let rr = wo["regulatoryRegion"] as? String,
                      let at = safeInt(wo["issuedAt"]) else { throw cfail("claim-malformed") }
                let cfg = WiFiConfig(ssid: ssid, psk: psk, regulatoryRegion: rr, issuedAt: at)
                guard cfg.isValid else { throw cfail("claim-malformed") }
                return .network(cfg)
            default:
                throw cfail("claim-malformed")
            }
        }
    }

    public enum BoxMessage: Equatable {
        case armed
        case press(atMs: Int64, count: Int, long: Bool)
        case pressResult(ok: Bool, reason: PressRefusal?)
        case wifiList([WifiNetwork])
        case receipt([String: AnyHashable])
        case networkStatus(stage: String, via: String, failure: NetworkFailure?)
        case refused(Refusal)

        public static func parse(_ w: Any?) throws -> BoxMessage {
            guard let o = w as? [String: Any], let t = o["t"] as? String else { throw cfail("claim-malformed") }
            switch t {
            case "armed": return .armed
            case "press":
                guard let at = safeInt(o["atMs"]), let c = safeInt(o["count"]), let l = o["long"] as? Bool else { throw cfail("claim-malformed") }
                return .press(atMs: at, count: Int(c), long: l)
            case "press-result":
                guard let ok = o["ok"] as? Bool else { throw cfail("claim-malformed") }
                if ok { return .pressResult(ok: true, reason: nil) }
                guard let r = (o["reason"] as? String).flatMap(PressRefusal.init) else { throw cfail("claim-malformed") }
                return .pressResult(ok: false, reason: r)
            case "wifi-list":
                guard let arr = o["networks"] as? [[String: Any]] else { throw cfail("claim-malformed") }
                return .wifiList(arr.compactMap { n in
                    guard let s = n["ssid"] as? String, let sec = (n["security"] as? String).flatMap(WifiSecurity.init),
                          let sig = safeInt(n["signal"]), let band = n["band"] as? String else { return nil }
                    return WifiNetwork(ssid: s, security: sec, signal: Int(sig), band: band)
                })
            case "receipt":
                guard let r = o["receipt"] as? [String: Any] else { throw cfail("claim-malformed") }
                var h: [String: AnyHashable] = [:]
                for (k, v) in r { if let hv = v as? AnyHashable { h[k] = hv } }
                return .receipt(h)
            case "network-status":
                guard let stage = o["stage"] as? String, ["connecting", "online", "failed"].contains(stage),
                      let via = o["via"] as? String, via == "ethernet" || via == "wifi" else { throw cfail("claim-malformed") }
                if stage == "failed" {
                    guard let f = (o["failure"] as? String).flatMap(NetworkFailure.init) else { throw cfail("claim-malformed") }
                    return .networkStatus(stage: stage, via: via, failure: f)
                }
                return .networkStatus(stage: stage, via: via, failure: nil)
            case "refused":
                guard let r = (o["reason"] as? String).flatMap(Refusal.init) else { throw cfail("claim-malformed") }
                return .refused(r)
            default:
                throw cfail("claim-malformed")
            }
        }
    }

    // MARK: - The phone's press check (§7.4)

    public static func instructionPauseMs(randomness: [UInt8]? = nil) throws -> Int64 {
        let r = try random(2, randomness)
        let span = instructionPauseMaxMs - instructionPauseMinMs
        let v = Double((Int(r[0]) << 8) | Int(r[1])) / 65536
        return instructionPauseMinMs + Int64((v * Double(span + 1)).rounded(.down))
    }

    public enum PressVerdict: String, Sendable { case ok, early, late, burst }

    public static func judgePressReport(armSentAt: Int64, instructionAt: Int64, atMs: Int64, count: Int, long: Bool, receivedAt: Int64) -> PressVerdict {
        if count != burstClaim || long { return .burst }
        let latest = armSentAt + armLatencyMs + atMs
        if receivedAt < instructionAt || latest < instructionAt { return .early }
        let earliest = armSentAt + atMs
        if earliest - instructionAt > pressAfterInstructionMs { return .late }
        if receivedAt - instructionAt > pressAfterInstructionMs + powerKeyBurstEndMs + armLatencyMs + 2_000 { return .late }
        return .ok
    }

    // MARK: - The claim receipt (§7.6)

    public struct Receipt: Equatable, Sendable {
        public let mode: Mode
        public let serverDomain: String
        public let serial: String
        public let stkHybridPub: String
        public let bootKeyBindingSha256: String
        public let model: String
        public let imageVersion: String
        public let transcript: String
        public let issuedAt: Int64
        public let signature: String

        public init(mode: Mode, serverDomain: String, serial: String, stkHybridPub: String, bootKeyBindingSha256: String,
                    model: String, imageVersion: String, transcript: String, issuedAt: Int64, signature: String = "") {
            self.mode = mode; self.serverDomain = serverDomain; self.serial = serial; self.stkHybridPub = stkHybridPub
            self.bootKeyBindingSha256 = bootKeyBindingSha256; self.model = model; self.imageVersion = imageVersion
            self.transcript = transcript; self.issuedAt = issuedAt; self.signature = signature
        }

        /// The Ed25519 half, the STK `.com` stores.
        public var stkPubHex: String { String(stkHybridPub.prefix(64)) }

        public var canonical: [UInt8] {
            utf8([tagReceipt, mode.rawValue, serverDomain, serial, stkHybridPub, bootKeyBindingSha256, model, imageVersion, transcript, String(issuedAt)].joined(separator: "|"))
        }

        public var json: [String: Any] {
            ["v": 1, "mode": mode.rawValue, "serverDomain": serverDomain, "serial": serial, "stkHybridPub": stkHybridPub,
             "bootKeyBindingSha256": bootKeyBindingSha256, "model": model, "imageVersion": imageVersion,
             "transcript": transcript, "issuedAt": issuedAt, "signature": signature]
        }

        public func signed(_ sign: (_ purpose: String, _ payload: [UInt8]) throws -> [UInt8]) throws -> Receipt {
            let sig = try sign(tagReceipt, canonical)
            guard sig.count == PqHybrid.sigLen else { throw cfail("bad-receipt") }
            return Receipt(mode: mode, serverDomain: serverDomain, serial: serial, stkHybridPub: stkHybridPub,
                           bootKeyBindingSha256: bootKeyBindingSha256, model: model, imageVersion: imageVersion,
                           transcript: transcript, issuedAt: issuedAt, signature: PqBin.hex(sig))
        }
    }

    static func receiptText(_ s: String) -> Bool {
        let b = Array(s.utf8)
        return (1...64).contains(b.count) && b.allSatisfy { (0x41...0x5a).contains($0) || (0x61...0x7a).contains($0) || (0x30...0x39).contains($0) || [0x2e, 0x5f, 0x2b, 0x20, 0x2d].contains($0) }
    }

    static func domainOk(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard let f = b.first, b.count <= 253, (0x61...0x7a).contains(f) || (0x30...0x39).contains(f) else { return false }
        return b.allSatisfy { (0x61...0x7a).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2e || $0 == 0x2d }
    }

    static func serialOk(_ s: String) -> Bool {
        let b = Array(s.utf8)
        return (8...64).contains(b.count) && b.allSatisfy { (0x41...0x5a).contains($0) || (0x61...0x7a).contains($0) || (0x30...0x39).contains($0) || $0 == 0x5f || $0 == 0x2d }
    }

    static func lowerHex(_ s: String, _ n: Int) -> Bool { s.utf8.count == n * 2 && PqBin.unhex(s) != nil }

    /// Checks a receipt on the phone: shape, the hybrid signature under the key it names, and that it
    /// was made in THIS session for the recipe the phone sent. A relay that passes the real box's
    /// receipt on fails `transcript-mismatch`.
    public static func verifyReceipt(_ wire: Any?, transcriptHex: String, mode: Mode, serverDomain: String, serial: String) throws -> Receipt {
        let o = try exact(wire, ["bootKeyBindingSha256", "imageVersion", "issuedAt", "mode", "model", "serial", "serverDomain", "signature", "stkHybridPub", "transcript", "v"], "bad-receipt")
        guard isOne(o["v"]),
              let m = (o["mode"] as? String).flatMap(Mode.init),
              let dom = o["serverDomain"] as? String, domainOk(dom),
              let ser = o["serial"] as? String, serialOk(ser),
              let stk = o["stkHybridPub"] as? String, lowerHex(stk, PqHybrid.sigPublicKeyLen),
              let bkb = o["bootKeyBindingSha256"] as? String, bkb.isEmpty || lowerHex(bkb, 32),
              let model = o["model"] as? String, receiptText(model),
              let img = o["imageVersion"] as? String, receiptText(img),
              let tr = o["transcript"] as? String, lowerHex(tr, 64),
              let at = safeInt(o["issuedAt"]),
              let sig = o["signature"] as? String, lowerHex(sig, PqHybrid.sigLen) else { throw cfail("bad-receipt") }
        guard tr == transcriptHex else { throw cfail("transcript-mismatch") }
        guard m == mode, dom == serverDomain, ser == serial else { throw cfail("bad-receipt") }
        let r = Receipt(mode: m, serverDomain: dom, serial: ser, stkHybridPub: stk, bootKeyBindingSha256: bkb, model: model,
                        imageVersion: img, transcript: tr, issuedAt: at, signature: sig)
        do {
            try PqHybrid.hybridVerify(publicKey: PqBin.unhex(stk)!, purpose: tagReceipt, payload: r.canonical, signature: PqBin.unhex(sig)!)
        } catch {
            throw cfail("bad-receipt")
        }
        return r
    }

    // MARK: - The phone's key pre-registration at `.com` (§4 step 8)

    public struct ClaimKey: Equatable, Sendable {
        public let username: String
        public let serial: String
        public let serverDomain: String
        public let stkPubHex: String
        public let issuedAt: Int64
        public init(username: String, serial: String, serverDomain: String, stkPubHex: String, issuedAt: Int64) {
            self.username = username; self.serial = serial; self.serverDomain = serverDomain
            self.stkPubHex = stkPubHex.lowercased(); self.issuedAt = issuedAt
        }
        public var canonical: [UInt8] {
            utf8([tagKey, username, serial, serverDomain, stkPubHex.lowercased(), String(issuedAt)].joined(separator: "|"))
        }
        public func sign(with key: Curve25519.Signing.PrivateKey) throws -> [UInt8] { Array(try key.signature(for: canonical)) }
        public func verify(signature: [UInt8], publicKey: [UInt8]) -> Bool {
            PqHybrid.ed25519VerifyStrict(signature: signature, message: canonical, publicKey: publicKey)
        }
    }

    // MARK: - Frames for small-MTU transports (BLE)

    public static func encodeMessage(kind: UInt8, payload: [UInt8]) -> [UInt8] { [kind] + payload }

    public static func decodeMessage(_ msg: [UInt8]) throws -> (kind: UInt8, payload: [UInt8]) {
        guard let k = msg.first, k == frameHandshake || k == frameRecord else { throw cfail("claim-malformed") }
        return (k, Array(msg.dropFirst()))
    }

    /// One flag byte (0x80 first, 0x40 last), then data, in frames of at most `mtu` bytes.
    public static func fragment(_ msg: [UInt8], mtu: Int) throws -> [[UInt8]] {
        guard mtu >= 20 else { throw cfail("claim-malformed") }
        guard msg.count <= maxMessage else { throw cfail("record-too-large") }
        let room = mtu - 1
        var out: [[UInt8]] = []
        var o = 0
        repeat {
            let end = min(o + room, msg.count)
            let flags: UInt8 = (o == 0 ? 0x80 : 0) | (end == msg.count ? 0x40 : 0)
            out.append([flags] + msg[o..<end])
            o += room
        } while o < msg.count
        return out
    }

    public final class Reassembler {
        private var parts: [UInt8] = []
        private var open = false
        public init() {}

        private func reset() { parts = []; open = false }

        /// A whole message when `frame` completes one; out-of-order frames throw.
        public func push(_ frame: [UInt8]) throws -> [UInt8]? {
            guard let flags = frame.first else { throw cfail("claim-malformed") }
            guard flags & 0x3f == 0 else { throw cfail("claim-malformed") }
            let first = flags & 0x80 != 0
            if first == open { reset(); throw cfail("claim-malformed") }
            open = true
            parts += frame.dropFirst()
            if parts.count > BoxClaim.maxMessage { reset(); throw cfail("record-too-large") }
            guard flags & 0x40 != 0 else { return nil }
            let msg = parts
            reset()
            return msg
        }
    }
}
