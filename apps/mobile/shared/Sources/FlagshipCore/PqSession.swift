import Foundation
import CryptoKit

/// `flagship/pq-session/v1`, the Swift twin of packages/protocol/src/pqSession.ts. DRAFT, pending
/// Q01 external cryptographic review. Spec: docs/architecture-v2/pq-suites.md §13. Vectors:
/// test-vectors/pq-session/.
///
/// A PQ-authenticated channel to a box inside the TLS connection: an ephemeral X-Wing key from
/// this device, the box's encapsulation, and hybrid signatures by both sides under keys already
/// pinned through `flagship/pq-key-binding/v1`. In a strict scope the phone sends its requests
/// to the box only through it.
public struct PqSessionError: Error, Equatable, CustomStringConvertible {
    public let code: String
    public init(_ code: String) { self.code = code }
    public var description: String { code }
}

private func sfail(_ code: String) -> PqSessionError { PqSessionError(code) }

public enum PqSession {
    public static let tagSession = "flagship/pq-session/v1"
    public static let tagHello = "flagship/pq-session-hello/v1"
    public static let tagAccept = "flagship/pq-session-accept/v1"
    public static let tagFinish = "flagship/pq-session-finish/v1"
    public static let tagKeys = "flagship/pq-session-keys/v1"
    public static let tagRecord = "flagship/pq-session-record/v1"
    public static let maxSkewMs: Int64 = 5 * 60 * 1000
    public static let maxRecord = 16 * 1024 * 1024
    public static let idleMs: Int64 = 15 * 60 * 1000
    public static let maxLifetimeMs: Int64 = 12 * 3600 * 1000
    public static let dirInitiator: UInt8 = 1
    public static let dirResponder: UInt8 = 2

    /// A signer for this device's hybrid key under `purpose` (the PQ key store).
    public typealias Signer = (_ purpose: String, _ payload: [UInt8]) throws -> [UInt8]

    static func subjectOk(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard let f = b.first, b.count <= 253, (0x61...0x7a).contains(f) || (0x30...0x39).contains(f) else { return false }
        return b.dropFirst().allSatisfy { (0x61...0x7a).contains($0) || (0x30...0x39).contains($0) || [0x2e, 0x3a, 0x40, 0x2d].contains($0) }
    }

    static func lp8(_ s: String) throws -> [UInt8] {
        let b = PqBin.utf8(s)
        guard b.count <= 255 else { throw sfail("session-malformed") }
        return PqBin.lp8(b)
    }

    static func sha512(_ b: [UInt8]) -> [UInt8] { Array(SHA512.hash(data: b)) }

    static func hexField(_ o: [String: Any], _ k: String, _ n: Int) throws -> [UInt8] {
        guard let s = o[k] as? String, s.count == n * 2, let b = PqBin.unhex(s), b.count == n else { throw sfail("session-malformed") }
        return b
    }

    static func timeField(_ o: [String: Any], _ k: String) throws -> Int64 {
        guard let n = o[k] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { throw sfail("session-malformed") }
        let d = n.doubleValue
        guard d >= 0, d <= 9_007_199_254_740_991, d == d.rounded() else { throw sfail("session-malformed") }
        return n.int64Value
    }

    static func exact(_ w: Any?, _ keys: [String]) throws -> [String: Any] {
        guard let o = w as? [String: Any], o.keys.sorted() == keys.sorted(), (o["v"] as? NSNumber)?.intValue == 1,
              CFGetTypeID(o["v"] as! NSNumber) != CFBooleanGetTypeID() else { throw sfail("session-malformed") }
        return o
    }

    public struct Hello: Equatable {
        public let responder: String
        public let initiatorRole: String
        public let initiatorSubject: String
        public let initiatorKeyId: [UInt8]
        public let responderKeyId: [UInt8]
        public let ephemeralPub: [UInt8]
        public let nonce: [UInt8]
        public let issuedAt: Int64

        public var jsonObject: [String: Any] {
            ["v": 1, "responder": responder, "initiatorRole": initiatorRole, "initiatorSubject": initiatorSubject,
             "initiatorKeyId": PqBin.hex(initiatorKeyId), "responderKeyId": PqBin.hex(responderKeyId),
             "ephemeralPub": PqBin.hex(ephemeralPub), "nonce": PqBin.hex(nonce), "issuedAt": issuedAt]
        }

        public func bytes() throws -> [UInt8] {
            try PqSession.lp8(PqSession.tagHello) + PqSession.lp8(responder) + PqSession.lp8(initiatorRole)
                + PqSession.lp8(initiatorSubject) + initiatorKeyId + responderKeyId + ephemeralPub + nonce
                + PqBin.u64be(UInt64(issuedAt))
        }

        public static func parse(_ w: Any?) throws -> Hello {
            let o = try PqSession.exact(w, ["ephemeralPub", "initiatorKeyId", "initiatorRole", "initiatorSubject", "issuedAt", "nonce", "responder", "responderKeyId", "v"])
            guard let r = o["responder"] as? String, PqSession.subjectOk(r),
                  let s = o["initiatorSubject"] as? String, PqSession.subjectOk(s),
                  let role = o["initiatorRole"] as? String, role == "device" || role == "box-stk" else { throw sfail("session-malformed") }
            return Hello(responder: r, initiatorRole: role, initiatorSubject: s,
                         initiatorKeyId: try PqSession.hexField(o, "initiatorKeyId", 32),
                         responderKeyId: try PqSession.hexField(o, "responderKeyId", 32),
                         ephemeralPub: try PqSession.hexField(o, "ephemeralPub", PqHybrid.sealPublicKeyLen),
                         nonce: try PqSession.hexField(o, "nonce", 32), issuedAt: try PqSession.timeField(o, "issuedAt"))
        }
    }

    /// `flagship/pq-session-accept/v1|<responder>|<hex SHA-512(SHA-512(hello) || enc || nonce || time)>`.
    public static func acceptTbs(helloBytes: [UInt8], responder: String, enc: [UInt8], nonce: [UInt8], issuedAt: Int64) -> [UInt8] {
        PqBin.utf8("\(tagAccept)|\(responder)|" + PqBin.hex(sha512(sha512(helloBytes) + enc + nonce + PqBin.u64be(UInt64(issuedAt)))))
    }

    /// `flagship/pq-session-finish/v1|<initiatorSubject>|<hex SHA-512(accept || sigR || confirmR)>`.
    public static func finishTbs(_ tbsA: [UInt8], _ sigR: [UInt8], _ confirmR: [UInt8], initiatorSubject: String) -> [UInt8] {
        PqBin.utf8("\(tagFinish)|\(initiatorSubject)|" + PqBin.hex(sha512(tbsA + sigR + confirmR)))
    }

    struct Prk {
        let key: SymmetricKey
        init(_ ss: [UInt8]) {
            let p = HKDF<SHA512>.extract(inputKeyMaterial: SymmetricKey(data: ss), salt: PqBin.utf8(PqSession.tagSession))
            key = SymmetricKey(data: Data(p))
        }
        func expand(_ label: String, _ th: [UInt8]) throws -> [UInt8] {
            let info = try PqSession.lp8(PqSession.tagKeys) + PqSession.lp8(label) + th
            let k = HKDF<SHA512>.expand(pseudoRandomKey: key, info: info, outputByteCount: 32)
            return k.withUnsafeBytes { Array($0) }
        }
        func confirm(_ label: String, _ th: [UInt8]) throws -> [UInt8] {
            var k = try expand(label, th)
            defer { PqBin.zero(&k) }
            return Array(Array(HMAC<SHA512>.authenticationCode(for: th, using: SymmetricKey(data: k)))[0..<32])
        }
        func traffic(_ th4: [UInt8]) throws -> Keys {
            Keys(sessionId: try expand("session-id", th4), i2r: try expand("initiator-to-responder", th4),
                 r2i: try expand("responder-to-initiator", th4))
        }
    }

    struct Keys {
        let sessionId: [UInt8]
        var i2r: [UInt8]
        var r2i: [UInt8]
    }

    /// The initiator between hello and accept.
    public final class Initiator {
        public let hello: Hello
        let helloBytes: [UInt8]
        let responder: VerifiedPqKeyBinding
        var ephemeralSeed: [UInt8]?

        /// Opens a session to `responder` (the box's verified STK binding) as `identity`.
        public init(responder: VerifiedPqKeyBinding, initiatorRole: String, identity: VerifiedPqKeyBinding, now: Int64,
                    ephemeralSeed: [UInt8]? = nil, nonce: [UInt8]? = nil) throws {
            guard responder.role == "box-stk", PqSession.subjectOk(responder.subjectId) else { throw sfail("responder-mismatch") }
            guard identity.role == initiatorRole, initiatorRole == "device" || initiatorRole == "box-stk" else { throw sfail("unknown-initiator") }
            let seed = ephemeralSeed ?? PqBin.random(32)
            guard seed.count == 32, let pk = PqPrim.xwingPublicKey(seed) else { throw sfail("randomness") }
            let n = nonce ?? PqBin.random(32)
            guard n.count == 32 else { throw sfail("randomness") }
            hello = Hello(responder: responder.subjectId, initiatorRole: initiatorRole, initiatorSubject: identity.subjectId,
                          initiatorKeyId: PqBin.unhex(identity.keyIdHex) ?? [], responderKeyId: PqBin.unhex(responder.keyIdHex) ?? [],
                          ephemeralPub: pk, nonce: n, issuedAt: now)
            helloBytes = try hello.bytes()
            self.responder = responder
            self.ephemeralSeed = seed
        }

        deinit { if var s = ephemeralSeed { PqBin.zero(&s) } }

        /// Checks the box's accept and answers with the finish; single use.
        public func finish(accept w: Any?, now: Int64, sign: Signer) throws -> (finish: [String: Any], channel: Channel) {
            guard var seed = ephemeralSeed else { throw sfail("session-expired") }
            ephemeralSeed = nil
            defer { PqBin.zero(&seed) }
            let o = try PqSession.exact(w, ["confirm", "enc", "issuedAt", "nonce", "signature", "v"])
            let enc = try PqSession.hexField(o, "enc", PqHybrid.sealEncLen)
            let nonce = try PqSession.hexField(o, "nonce", 32)
            let issuedAt = try PqSession.timeField(o, "issuedAt")
            let sigR = try PqSession.hexField(o, "signature", PqHybrid.sigLen)
            let confirmR = try PqSession.hexField(o, "confirm", 32)
            if abs(issuedAt - now) > PqSession.maxSkewMs { throw sfail("session-stale") }
            let tbsA = PqSession.acceptTbs(helloBytes: helloBytes, responder: hello.responder, enc: enc, nonce: nonce, issuedAt: issuedAt)
            do { try PqHybrid.hybridVerify(publicKey: responder.hybridPublicKey, purpose: PqSession.tagAccept, payload: tbsA, signature: sigR) } catch { throw sfail("bad-signature") }
            guard var ss = PqPrim.xwingDecapsulate(enc, seed) else { throw sfail("confirm-failed") }
            let prk = Prk(ss)
            PqBin.zero(&ss)
            let th1 = PqSession.sha512(tbsA + sigR)
            guard PqBin.equal(try prk.confirm("responder-confirm", th1), confirmR) else { throw sfail("confirm-failed") }
            let tbsF = PqSession.finishTbs(tbsA, sigR, confirmR, initiatorSubject: hello.initiatorSubject)
            let sigI = try sign(PqSession.tagFinish, tbsF)
            guard sigI.count == PqHybrid.sigLen else { throw sfail("bad-signature") }
            let confirmI = try prk.confirm("initiator-confirm", PqSession.sha512(tbsF + sigI))
            let keys = try prk.traffic(PqSession.sha512(tbsF + sigI + confirmI))
            return (["v": 1, "signature": PqBin.hex(sigI), "confirm": PqBin.hex(confirmI)],
                    Channel(side: .initiator, keys: keys, now: now, peer: responder))
        }
    }

    /// The responder's half; boxes run the TypeScript port, this exists for the shared vectors.
    public final class Pending {
        let initiator: VerifiedPqKeyBinding
        let createdAt: Int64
        let tbsF: [UInt8]
        var prk: Prk?

        init(initiator: VerifiedPqKeyBinding, createdAt: Int64, tbsF: [UInt8], prk: Prk) {
            self.initiator = initiator; self.createdAt = createdAt; self.tbsF = tbsF; self.prk = prk
        }

        public func complete(finish w: Any?, now: Int64) throws -> Channel {
            guard let prk else { throw sfail("session-expired") }
            self.prk = nil
            if abs(now - createdAt) > PqSession.maxSkewMs { throw sfail("session-stale") }
            let o = try PqSession.exact(w, ["confirm", "signature", "v"])
            let sigI = try PqSession.hexField(o, "signature", PqHybrid.sigLen)
            let confirmI = try PqSession.hexField(o, "confirm", 32)
            do { try PqHybrid.hybridVerify(publicKey: initiator.hybridPublicKey, purpose: PqSession.tagFinish, payload: tbsF, signature: sigI) } catch { throw sfail("bad-signature") }
            guard PqBin.equal(try prk.confirm("initiator-confirm", PqSession.sha512(tbsF + sigI)), confirmI) else { throw sfail("confirm-failed") }
            return Channel(side: .responder, keys: try prk.traffic(PqSession.sha512(tbsF + sigI + confirmI)), now: now, peer: initiator)
        }
    }

    public static func accept(hello w: Any?, identity: VerifiedPqKeyBinding,
                              lookup: (_ role: String, _ subject: String, _ keyIdHex: String) -> VerifiedPqKeyBinding?,
                              now: Int64, sign: Signer, encapsulation: [UInt8]? = nil, nonce: [UInt8]? = nil) throws -> (accept: [String: Any], pending: Pending) {
        let h = try Hello.parse(w)
        guard identity.role == "box-stk", h.responder == identity.subjectId, PqBin.hex(h.responderKeyId) == identity.keyIdHex else { throw sfail("responder-mismatch") }
        if abs(h.issuedAt - now) > maxSkewMs { throw sfail("session-stale") }
        guard let ini = lookup(h.initiatorRole, h.initiatorSubject, PqBin.hex(h.initiatorKeyId)),
              ini.role == h.initiatorRole, ini.subjectId == h.initiatorSubject, ini.keyIdHex == PqBin.hex(h.initiatorKeyId) else { throw sfail("unknown-initiator") }
        do { _ = try PqHybrid.parseHybridSealPublicKey(h.ephemeralPub) } catch { throw sfail("bad-public-key") }
        var eseed = encapsulation ?? PqBin.random(64)
        defer { PqBin.zero(&eseed) }
        guard eseed.count == 64, var e = PqPrim.xwingEncapsulate(h.ephemeralPub, eseed) else { throw sfail("bad-public-key") }
        let prk = Prk(e.ss)
        PqBin.zero(&e.ss)
        let n = nonce ?? PqBin.random(32)
        let tbsA = acceptTbs(helloBytes: try h.bytes(), responder: h.responder, enc: e.ct, nonce: n, issuedAt: now)
        let sigR = try sign(tagAccept, tbsA)
        guard sigR.count == PqHybrid.sigLen else { throw sfail("bad-signature") }
        let confirmR = try prk.confirm("responder-confirm", sha512(tbsA + sigR))
        let tbsF = finishTbs(tbsA, sigR, confirmR, initiatorSubject: h.initiatorSubject)
        return (["v": 1, "enc": PqBin.hex(e.ct), "nonce": PqBin.hex(n), "issuedAt": now, "signature": PqBin.hex(sigR), "confirm": PqBin.hex(confirmR)],
                Pending(initiator: ini, createdAt: now, tbsF: tbsF, prk: prk))
    }

    static func recordNonce(_ dir: UInt8, _ seq: UInt64) -> [UInt8] { [0, 0, 0, dir] + PqBin.u64be(seq) }

    static func recordAad(_ sid: [UInt8], _ dir: UInt8, _ seq: UInt64) throws -> [UInt8] {
        try lp8(tagRecord) + sid + [dir] + PqBin.u64be(seq)
    }

    public static func sealRecord(key: [UInt8], sessionId: [UInt8], dir: UInt8, seq: UInt64, plaintext: [UInt8]) throws -> [UInt8] {
        guard plaintext.count <= maxRecord else { throw sfail("record-too-large") }
        let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: try AES.GCM.Nonce(data: recordNonce(dir, seq)),
                                   authenticating: try recordAad(sessionId, dir, seq))
        return PqBin.u64be(seq) + Array(box.ciphertext) + Array(box.tag)
    }

    public static func openRecord(key: [UInt8], sessionId: [UInt8], dir: UInt8, record: [UInt8]) throws -> (seq: UInt64, plaintext: [UInt8]) {
        guard record.count >= 24 else { throw sfail("decrypt-failed") }
        guard record.count <= 24 + maxRecord else { throw sfail("record-too-large") }
        let seq = PqBin.readU64(record[0..<8])
        guard seq <= 9_007_199_254_740_991 else { throw sfail("decrypt-failed") }
        do {
            let box = try AES.GCM.SealedBox(nonce: try AES.GCM.Nonce(data: recordNonce(dir, seq)),
                                            ciphertext: record[8..<(record.count - 16)], tag: record[(record.count - 16)...])
            return (seq, Array(try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: try recordAad(sessionId, dir, seq))))
        } catch {
            throw sfail("decrypt-failed")
        }
    }

    public enum Side { case initiator, responder }

    /// One established session (thread-safe: requests may be in flight together).
    public final class Channel: @unchecked Sendable {
        public let side: Side
        public let peer: VerifiedPqKeyBinding
        public let sessionIdHex: String
        let establishedAt: Int64
        private var keys: Keys
        private var lastUsed: Int64
        private var nextSeq: UInt64 = 0
        private var maxSeen: UInt64?
        private var seen = Set<UInt64>()
        private let lock = NSLock()

        init(side: Side, keys: Keys, now: Int64, peer: VerifiedPqKeyBinding) {
            self.side = side; self.keys = keys; self.establishedAt = now; self.lastUsed = now; self.peer = peer
            self.sessionIdHex = PqBin.hex(keys.sessionId)
        }

        public func expired(now: Int64) -> Bool {
            lock.lock(); defer { lock.unlock() }
            return now - lastUsed > PqSession.idleMs || now - establishedAt > PqSession.maxLifetimeMs
        }

        private func live(_ now: Int64) throws {
            if now - lastUsed > PqSession.idleMs || now - establishedAt > PqSession.maxLifetimeMs { throw sfail("session-expired") }
            lastUsed = now
        }

        public func sealRequest(_ plaintext: [UInt8], now: Int64) throws -> (seq: UInt64, record: [UInt8]) {
            lock.lock(); defer { lock.unlock() }
            guard side == .initiator else { throw sfail("session-malformed") }
            try live(now)
            let seq = nextSeq
            nextSeq += 1
            return (seq, try PqSession.sealRecord(key: keys.i2r, sessionId: keys.sessionId, dir: PqSession.dirInitiator, seq: seq, plaintext: plaintext))
        }

        public func openResponse(seq: UInt64, record: [UInt8]) throws -> [UInt8] {
            guard side == .initiator else { throw sfail("session-malformed") }
            let r = try PqSession.openRecord(key: keys.r2i, sessionId: keys.sessionId, dir: PqSession.dirResponder, record: record)
            guard r.seq == seq else { throw sfail("replay") }
            return r.plaintext
        }

        public func openRequest(_ record: [UInt8], now: Int64) throws -> (seq: UInt64, plaintext: [UInt8]) {
            lock.lock(); defer { lock.unlock() }
            guard side == .responder else { throw sfail("session-malformed") }
            try live(now)
            let r = try PqSession.openRecord(key: keys.i2r, sessionId: keys.sessionId, dir: PqSession.dirInitiator, record: record)
            if seen.contains(r.seq) || (maxSeen.map { r.seq + 1024 <= $0 } ?? false) { throw sfail("replay") }
            seen.insert(r.seq)
            if maxSeen.map({ r.seq > $0 }) ?? true {
                maxSeen = r.seq
                seen = seen.filter { $0 + 1024 > r.seq }
            }
            return r
        }

        public func sealResponse(seq: UInt64, _ plaintext: [UInt8]) throws -> [UInt8] {
            guard side == .responder else { throw sfail("session-malformed") }
            return try PqSession.sealRecord(key: keys.r2i, sessionId: keys.sessionId, dir: PqSession.dirResponder, seq: seq, plaintext: plaintext)
        }

        public func close() {
            lock.lock(); defer { lock.unlock() }
            PqBin.zero(&keys.i2r); PqBin.zero(&keys.r2i)
            lastUsed = Int64.min / 2
        }
    }
}
