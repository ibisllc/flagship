import CryptoKit
import Foundation

/// voi.ci calls (docs/voici-calls.md §2-§3), the Swift twin of packages/protocol/src/voiciCalls.ts: the SDP profile,
/// the caller's signed request (checked here before the phone rings through), the owner's answer, the CA receipt,
/// end and call-allow orders, the per-call X-Wing encapsulation, the frame layer (k(dir) from the shared secret and
/// both records, epoch keys every 30,000 frames, 88-byte sealed frames, replay window and gap limit) and the sealed
/// push / missed call. Shared vectors: packages/protocol/test-vectors/voici-calls/vectors.json.
public enum VoiciCallDir: String, Sendable { case c2p, p2c }

public enum VoiciCallRequestRefusal: String, Sendable {
    case tooLarge = "too-large", malformed, wrongAudience = "wrong-audience", callsOff = "calls-off", blocked, revoked
    case rateLimited = "rate-limited", notAllowed = "not-allowed", badAttestation = "bad-attestation"
    case badDelegation = "bad-delegation", badThread = "bad-thread", wrongConv = "wrong-conv", badSdp = "bad-sdp"
    case badKey = "bad-key", badSignature = "bad-signature", stale
}

public enum VoiciCallAnswerRefusal: String, Sendable {
    case malformed, wrongCall = "wrong-call", wrongRequest = "wrong-request", badSdp = "bad-sdp", badSignature = "bad-signature", stale
}

public enum VoiciCallReceiptRefusal: String, Sendable {
    case malformed, unknownCa = "unknown-ca", badSignature = "bad-signature", tooLong = "too-long", wrongAccount = "wrong-account"
    case wrongDevice = "wrong-device", notYetValid = "not-yet-valid", expired
}

public struct VoiciCallRequestCheckContext {
    public var pageId: String
    public var acceptsCalls: Bool
    public var origin: String
    public var caKeys: [String]
    public var now: Int64
    public var blocked: Set<String>?
    public var revoked: Set<String>?
    public var rateLimit: ((JSONValue) -> VoiciCallRequestRefusal?)?
    public var allowed: ((JSONValue) -> Bool)?
    public var skipFresh: Bool

    public init(pageId: String, acceptsCalls: Bool, origin: String, caKeys: [String], now: Int64, blocked: Set<String>? = nil,
                revoked: Set<String>? = nil, rateLimit: ((JSONValue) -> VoiciCallRequestRefusal?)? = nil,
                allowed: ((JSONValue) -> Bool)? = nil, skipFresh: Bool = false) {
        self.pageId = pageId; self.acceptsCalls = acceptsCalls; self.origin = origin; self.caKeys = caKeys; self.now = now
        self.blocked = blocked; self.revoked = revoked; self.rateLimit = rateLimit; self.allowed = allowed; self.skipFresh = skipFresh
    }
}

/// A checked call request: the fields the phone needs, plus the whole record for the answer's hash.
public struct VoiciCallRequest: Equatable, Sendable {
    public var pageId: String
    public var conv: String
    public var callId: String
    public var from: String
    public var callerXwingPub: String
    public var offerSdp: String
    public var issuedAt: Int64
    public var delegatePub: String
    public var json: JSONValue
    /// What the caller is able to send: "audio" or "audio,video" (voici-calls-v2.md §1.1; absent on the wire = audio).
    public var media: String = "audio"
    public var hasVideo: Bool { media == VoiciCalls.mediaVideo }
}

public struct VoiciCallAnswerBody: Equatable, Sendable {
    public var callId: String
    public var deviceRef: String
    public var requestHash: String
    public var xwingCiphertext: String
    public var answerSdp: String
    public var turnUser: String
    public var turnSecret: String
    public var issuedAt: Int64
    /// What the answering device is able to send; nil = not on the wire (audio).
    public var media: String?
    public init(callId: String, deviceRef: String, requestHash: String, xwingCiphertext: String, answerSdp: String,
                turnUser: String, turnSecret: String, issuedAt: Int64, media: String? = nil) {
        self.callId = callId; self.deviceRef = deviceRef; self.requestHash = requestHash; self.xwingCiphertext = xwingCiphertext
        self.answerSdp = answerSdp; self.turnUser = turnUser; self.turnSecret = turnSecret; self.issuedAt = issuedAt; self.media = media
    }
}

public enum VoiciCalls {
    public static let tagRequest = "flagship/voici-call-request/v1"
    public static let tagAnswer = "flagship/voici-call-answer/v1"
    public static let tagReceipt = "flagship/voici-call-receipt/v1"
    public static let tagEnd = "flagship/voici-call-end/v1"
    public static let tagAllow = "flagship/voici-call-allow/v1"
    public static let tagFrame = "flagship/voici-call-frame/v1"
    public static let tagPush = "flagship/voici-call-push/v1"
    public static let tagMissedCall = "flagship/voici-missed-call/v1"

    public static let skewMs: Int64 = 10 * 60_000
    public static let ringMs: Int64 = 45_000
    public static let maxCallMs: Int64 = 60 * 60_000
    public static let receiptTtlMs: Int64 = maxCallMs + 5 * 60_000
    public static let maxSdpBytes = 16 * 1024
    public static let maxRequestBytes = 40 * 1024
    public static let framePlaintext = 64
    public static let frameMax = framePlaintext - 1
    public static let sealedFrame = 8 + framePlaintext + 16
    public static let framesPerEpoch: UInt64 = 30_000
    public static let replayWindow: UInt64 = 128
    public static let maxGapFrames: UInt64 = 3000
    public static let maxCtr: UInt64 = 1 << 32
    public static let endReasons: Set<String> = ["hangup", "cancel", "decline", "busy", "no-answer", "limit", "failed"]
    public static let missedReasons: Set<String> = ["no-answer", "busy", "cancel", "decline"]
    public static let mediaAudio = "audio"
    public static let mediaVideo = "audio,video"
    public static let mediaValues: Set<String> = [mediaAudio, mediaVideo]
    /// Sealed video frame sizes (voici-calls-v2.md §1.6): 1 KiB doubling to 1 MiB.
    public static let videoBuckets: [Int] = (0..<11).map { 1024 << $0 }
    public static let cameraStates: Set<String> = ["on", "off", "paused"]
    static let videoExtmaps = ["urn:ietf:params:rtp-hdrext:sdes:mid", "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"]

    static func isPageId(_ s: String) -> Bool { CanonicalJson.isLowerHex(s, bytes: 16) }
    static func isUsername(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard (1...64).contains(b.count) else { return false }
        func ok(_ c: UInt8) -> Bool { (0x61...0x7a).contains(c) || (0x30...0x39).contains(c) }
        return ok(b.first!) && ok(b.last!) && b.allSatisfy { ok($0) || $0 == 0x2d }
    }

    public static func sdpHash(_ sdp: String) -> String { CanonicalJson.sha256Hex(sdp) }

    public static func deviceRef(devicePubHex: String) throws -> String {
        CanonicalJson.sha256Hex(try CanonicalJson.hexToBytes(devicePubHex))
    }

    // MARK: SDP

    static func lines(_ sdp: String) -> [String] {
        sdp.components(separatedBy: "\n").map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
    }

    static func isOpusRtpmap(_ l: String) -> Bool {
        let lw = l.lowercased()
        guard lw.hasPrefix("a=rtpmap:") else { return false }
        let rest = lw.dropFirst("a=rtpmap:".count)
        guard let sp = rest.firstIndex(of: " ") else { return false }
        let pt = rest[rest.startIndex..<sp], codec = rest[rest.index(after: sp)...]
        return !pt.isEmpty && pt.allSatisfy { $0.isASCII && $0.isNumber } && (codec == "opus/48000" || codec == "opus/48000/2")
    }

    static func isFingerprintLine(_ l: String) -> Bool {
        let p = "a=fingerprint:sha-256 "
        guard l.hasPrefix(p) else { return false }
        let groups = l.dropFirst(p.count).split(separator: ":", omittingEmptySubsequences: false)
        return groups.count == 32 && groups.allSatisfy { g in g.count == 2 && g.allSatisfy { "0123456789ABCDEF".contains($0) } }
    }

    static func rtpmapPt(_ l: String) -> String { String(l.dropFirst("a=rtpmap:".count).split(separator: " ")[0]) }

    /// The SDP rules (§0.3); nil when the description is a call description, else the refusal.
    static func sections(_ ls: [String]) -> [(kind: String, lines: [String])] {
        var out: [(kind: String, lines: [String])] = []
        for l in ls {
            if l.hasPrefix("m=") { out.append((String(l.dropFirst(2).split(separator: " ", omittingEmptySubsequences: false)[0]), [l])) }
            else if !out.isEmpty { out[out.count - 1].lines.append(l) }
        }
        return out
    }

    static func isVp8Rtpmap(_ l: String) -> Bool {
        let lw = l.lowercased()
        guard lw.hasPrefix("a=rtpmap:"), lw.hasSuffix(" vp8/90000") else { return false }
        let pt = lw.dropFirst("a=rtpmap:".count).dropLast(" vp8/90000".count)
        return !pt.isEmpty && pt.allSatisfy { $0.isASCII && $0.isNumber }
    }

    static func isVideoExtmap(_ l: String) -> Bool { videoExtmaps.contains { l.hasSuffix(" " + $0) } }

    public static func checkSdp(_ sdp: String, media: String = mediaAudio) -> String? {
        if sdp.utf8.count > maxSdpBytes { return "too-large" }
        let ls = lines(sdp)
        let secs = sections(ls)
        if media == mediaVideo {
            if secs.count != 2 || secs[0].kind != "audio" || secs[1].kind != "video" { return "bad-media" }
            let v = secs[1].lines
            let maps = v.filter { $0.hasPrefix("a=rtpmap:") }
            if maps.count != 1 || !isVp8Rtpmap(maps[0]) { return "not-vp8" }
            if v.contains(where: { $0.hasPrefix("a=extmap:") && !isVideoExtmap($0) }) { return "video-extension" }
        } else if secs.count != 1 || secs[0].kind != "audio" { return "not-audio-only" }
        guard let rtpmap = ls.first(where: isOpusRtpmap) else { return "no-opus" }
        let pt = rtpmapPt(rtpmap)
        let fmtp = ls.first { $0.hasPrefix("a=fmtp:\(pt) ") }
        var params: [String: String] = [:]
        for p in (fmtp.map { String($0.dropFirst("a=fmtp:\(pt) ".count)) } ?? "").split(separator: ";", omittingEmptySubsequences: false) {
            let kv = p.trimmingCharacters(in: .whitespaces).split(separator: "=", omittingEmptySubsequences: false).map(String.init)
            if params[kv[0]] == nil { params[kv[0]] = kv.count > 1 ? kv[1] : nil }
        }
        if params["cbr"] != "1" { return "not-cbr" }
        if params["usedtx"] != "0" { return "dtx" }
        if ls.contains(where: { $0.hasPrefix("a=extmap:") && $0.contains("ssrc-audio-level") }) { return "audio-level" }
        if !ls.contains(where: isFingerprintLine) { return "no-fingerprint" }
        return nil
    }

    static func fmtpLine(_ pt: String) -> String {
        "a=fmtp:\(pt) minptime=20;useinbandfec=1;cbr=1;usedtx=0;stereo=0;sprop-stereo=0;maxaveragebitrate=24000"
    }

    static func ptAttribute(_ l: String) -> String? {
        for p in ["a=rtpmap:", "a=fmtp:", "a=rtcp-fb:"] where l.hasPrefix(p) {
            let rest = l.dropFirst(p.count)
            guard let sp = rest.firstIndex(of: " ") else { return nil }
            let pt = rest[rest.startIndex..<sp]
            return !pt.isEmpty && pt.allSatisfy({ $0.isASCII && $0.isNumber }) ? String(pt) : nil
        }
        return nil
    }

    /// Rewrites an audio SDP to the call profile (Opus only, the fixed fmtp, ptime 20, no header extension but MID);
    /// each side applies it to its own description before signing. Idempotent.
    public static func mungeSdp(_ sdp: String) -> String {
        let eol = sdp.contains("\r\n") ? "\r\n" : "\n"
        let ls = lines(sdp).filter { !$0.isEmpty }
        guard let rtpmap = ls.first(where: isOpusRtpmap) else { return sdp }
        let pt = rtpmapPt(rtpmap)
        let hasFmtp = ls.contains { $0.hasPrefix("a=fmtp:\(pt) ") }
        let vpt = ls.first(where: isVp8Rtpmap).map(rtpmapPt)
        let rtx = Set(ls.filter { $0.hasPrefix("a=ssrc-group:FID ") }.compactMap { l -> String? in
            let f = l.split(separator: " ", omittingEmptySubsequences: false)
            return f.count > 2 ? String(f[2]) : nil
        })
        var out: [String] = []
        var inAudio = false
        var inVideo = false
        for l in ls {
            if l.hasPrefix("m=") {
                inAudio = l.hasPrefix("m=audio ")
                inVideo = l.hasPrefix("m=video ") && vpt != nil
                if inAudio || inVideo {
                    let f = l.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
                    out.append((Array(f.prefix(3)) + [inAudio ? pt : vpt!]).joined(separator: " "))
                    continue
                }
            }
            if inVideo {
                if l.hasPrefix("a=extmap:") && !isVideoExtmap(l) { continue }
                if l == "a=extmap-allow-mixed" || l.hasPrefix("a=ssrc-group:FID ") { continue }
                if let p = ptAttribute(l), p != vpt { continue }
                if l.hasPrefix("a=ssrc:") {
                    let id = l.dropFirst("a=ssrc:".count).split(separator: " ", omittingEmptySubsequences: false)[0]
                    if rtx.contains(String(id)) { continue }
                }
                out.append(l)
                continue
            }
            if inAudio {
                if (l.hasPrefix("a=extmap:") && !l.hasSuffix(" urn:ietf:params:rtp-hdrext:sdes:mid")) || l == "a=extmap-allow-mixed" { continue }
                if let p = ptAttribute(l), p != pt { continue }
                if l.hasPrefix("a=fmtp:\(pt) ") { out.append(fmtpLine(pt)); continue }
                if l.hasPrefix("a=ptime:") { continue }
                out.append(l)
                if l == rtpmap {
                    if !hasFmtp { out.append(fmtpLine(pt)) }
                    out.append("a=ptime:20")
                }
                continue
            }
            out.append(l)
        }
        return out.joined(separator: eol) + eol
    }

    public static func sdpFingerprint(_ sdp: String) -> String? {
        lines(sdp).first(where: isFingerprintLine).map { String($0.dropFirst("a=fingerprint:".count)) }
    }

    // MARK: request

    /// `media` nil = not on the wire (audio); present, it is appended (voici-calls-v2.md §1.1).
    public static func canonicalRequest(pageId: String, conv: String, callId: String, callerXwingPub: String, offerSdp: String, issuedAt: Int64,
                                        media: String? = nil) throws -> [UInt8] {
        guard isPageId(pageId), CanonicalJson.isLowerHex(conv, bytes: 32), CanonicalJson.isLowerHex(callId, bytes: 16),
              CanonicalJson.isLowerHex(callerXwingPub, bytes: PqHybrid.sealPublicKeyLen), CanonicalJson.isTime(issuedAt),
              media.map(mediaValues.contains) ?? true
        else { throw CanonicalJsonError("\(tagRequest): bad field") }
        return CanonicalJson.join([tagRequest, pageId, conv, callId, callerXwingPub, sdpHash(offerSdp), String(issuedAt)] + (media.map { [$0] } ?? []))
    }

    static let requestKeys: Set<String> = ["v", "kind", "pageId", "conv", "callId", "from", "callerXwingPub", "offerSdp", "issuedAt", "cred", "sig"]

    static func requestFields(_ v: JSONValue?) -> (pageId: String, conv: String, callId: String, from: String, xpub: String, sdp: String, at: Int64, sig: String, cred: [String: JSONValue], media: String?)? {
        guard let r = v?.object, Set(r.keys) == requestKeys || Set(r.keys) == requestKeys.union(["media"]),
              r["v"]?.isOne == true, r["kind"]?.string == "voici-call-request",
              CanonicalJson.isLowerHex(r["sig"], bytes: 64), let cred = r["cred"]?.object, CanonicalJson.isLowerHex(r["from"], bytes: 32),
              let pageId = r["pageId"]?.string, let conv = r["conv"]?.string, let callId = r["callId"]?.string,
              let xpub = r["callerXwingPub"]?.string, let sdp = r["offerSdp"]?.string, let at = r["issuedAt"]?.time
        else { return nil }
        var media: String?
        if let m = r["media"] { guard let ms = m.string else { return nil }; media = ms }
        guard (try? canonicalRequest(pageId: pageId, conv: conv, callId: callId, callerXwingPub: xpub, offerSdp: sdp, issuedAt: at, media: media)) != nil
        else { return nil }
        return (pageId, conv, callId, r["from"]!.string!, xpub, sdp, at, r["sig"]!.string!, cred, media)
    }

    /// The canonical bytes of a wire request (the frame keys' transcript), nil when it doesn't parse.
    public static func requestBytes(_ request: JSONValue) -> [UInt8]? {
        guard let f = requestFields(request) else { return nil }
        return try? canonicalRequest(pageId: f.pageId, conv: f.conv, callId: f.callId, callerXwingPub: f.xpub, offerSdp: f.sdp, issuedAt: f.at, media: f.media)
    }

    public static func requestHash(_ request: JSONValue) -> String? {
        requestBytes(request).map(CanonicalJson.sha256Hex)
    }

    /// The request checks, cheapest first (§6): size, shape, page, calls on, blocked, revoked, rate limits, attestation,
    /// delegation, thread statement, conv, SDP, the caller's X-Wing key, B's signature, freshness, the owner's rule.
    public static func checkRequest(_ input: JSONValue, _ ctx: VoiciCallRequestCheckContext) -> VoiciVerdict<VoiciCallRequest, VoiciCallRequestRefusal> {
        var raw = input
        switch input {
        case .string(let text):
            if text.utf8.count > maxRequestBytes { return .refused(.tooLarge) }
            guard let p = JSONValue.parse(text) else { return .refused(.malformed) }
            raw = p
        case .brokenString: return .refused(.malformed)
        default:
            if CanonicalJson.jsonStringifyByteCount(input) > maxRequestBytes { return .refused(.tooLarge) }
        }
        guard let f = requestFields(raw) else { return .refused(.malformed) }
        let c = f.cred
        if Set(c.keys) != ["attestation", "delegation", "delegationSig", "threadStmt", "threadSig"] { return .refused(.malformed) }
        if !CanonicalJson.same(f.pageId, ctx.pageId) { return .refused(.wrongAudience) }
        if !ctx.acceptsCalls { return .refused(.callsOff) }
        if ctx.blocked?.contains(f.from) == true { return .refused(.blocked) }
        if let dp = c["delegation"]?["delegatePub"]?.string, ctx.revoked?.contains(dp) == true { return .refused(.revoked) }
        if let limited = ctx.rateLimit?(raw) { return .refused(limited) }
        guard case .ok(let att) = MessagesAttestations.checkMessagesKeyAttestation(c["attestation"], caKeys: ctx.caKeys, now: ctx.now, pseudonymPub: f.from)
        else { return .refused(.badAttestation) }
        let want = WebDelegations.Want(origin: ctx.origin, audience: ctx.pageId, principalPub: f.from, now: ctx.now, notAfter: att.expiresAt)
        guard case .ok(let del) = WebDelegations.checkWebDelegation(c["delegation"], signature: c["delegationSig"], want: want)
        else { return .refused(.badDelegation) }
        guard let ts = VoiciMessages.parseVoiciThreadStatement(c["threadStmt"]), CanonicalJson.same(ts.pageId, ctx.pageId),
              CanonicalJson.same(ts.pseudonymPub, f.from), let threadSig = c["threadSig"]?.string,
              let tsBytes = try? VoiciMessages.canonicalVoiciThreadStatement(ts), CanonicalJson.ed25519VerifyHex(threadSig, tsBytes, f.from)
        else { return .refused(.badThread) }
        guard let conv = try? VoiciMessages.voiciConv(pageId: ctx.pageId, pseudonymPub: f.from), conv == f.conv else { return .refused(.wrongConv) }
        if checkSdp(f.sdp, media: f.media ?? mediaAudio) != nil { return .refused(.badSdp) }
        guard let xpub = try? CanonicalJson.hexToBytes(f.xpub), (try? PqHybrid.parseHybridSealPublicKey(xpub)) != nil else { return .refused(.badKey) }
        guard let bytes = try? canonicalRequest(pageId: f.pageId, conv: f.conv, callId: f.callId, callerXwingPub: f.xpub, offerSdp: f.sdp, issuedAt: f.at, media: f.media),
              CanonicalJson.p256VerifyP1363(f.sig, bytes, del.delegatePub) else { return .refused(.badSignature) }
        if !ctx.skipFresh && abs(f.at - ctx.now) > skewMs { return .refused(.stale) }
        if let allowed = ctx.allowed, !allowed(raw) { return .refused(.notAllowed) }
        return .ok(VoiciCallRequest(pageId: f.pageId, conv: f.conv, callId: f.callId, from: f.from, callerXwingPub: f.xpub,
                                    offerSdp: f.sdp, issuedAt: f.at, delegatePub: del.delegatePub, json: raw, media: f.media ?? mediaAudio))
    }

    // MARK: per-call keys

    /// The answering phone's encapsulation to the caller's per-call key (eseed: 64 random bytes).
    public static func encapsulate(callerXwingPub: [UInt8], eseed: [UInt8]? = nil) throws -> (ciphertext: [UInt8], sharedSecret: [UInt8]) {
        let pk = try PqHybrid.parseHybridSealPublicKey(callerXwingPub)
        let e = eseed ?? PqBin.random(PqHybrid.sealRandomnessLen)
        guard e.count == PqHybrid.sealRandomnessLen, let r = PqPrim.xwingEncapsulate(pk, e) else { throw CanonicalJsonError("voici-call: randomness") }
        return (r.ct, r.ss)
    }

    public static func decapsulate(ciphertext: [UInt8], callerSeed: [UInt8]) throws -> [UInt8] {
        guard ciphertext.count == PqHybrid.sealEncLen, let ss = PqPrim.xwingDecapsulate(ciphertext, callerSeed) else { throw CanonicalJsonError("voici-call: ciphertext") }
        return ss
    }

    static func hkdf(_ ikm: [UInt8], salt: [UInt8], info: String) -> [UInt8] {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: Array(info.utf8), outputByteCount: 32)
            .withUnsafeBytes { Array($0) }
    }

    public static func frameKeys(sharedSecret: [UInt8], requestBytes: [UInt8], answerBytes: [UInt8]) -> (c2p: [UInt8], p2c: [UInt8]) {
        let th = CanonicalJson.sha256(requestBytes + answerBytes)
        return (hkdf(sharedSecret, salt: th, info: "\(tagFrame)|c2p"), hkdf(sharedSecret, salt: th, info: "\(tagFrame)|p2c"))
    }

    /// The video keys (voici-calls-v2.md §1.5): their own directional keys from the same secret.
    public static func videoFrameKeys(sharedSecret: [UInt8], requestBytes: [UInt8], answerBytes: [UInt8]) -> (c2p: [UInt8], p2c: [UInt8]) {
        let th = CanonicalJson.sha256(requestBytes + answerBytes)
        return (hkdf(sharedSecret, salt: th, info: "\(tagFrame)|c2p|video"), hkdf(sharedSecret, salt: th, info: "\(tagFrame)|p2c|video"))
    }

    public static func nextFrameKey(_ k: [UInt8]) -> [UInt8] { hkdf(k, salt: [], info: "\(tagFrame)|next") }

    public static func epoch(_ ctr: UInt64) -> UInt64 { ctr / framesPerEpoch }

    // MARK: frames

    static func be64(_ n: UInt64) -> [UInt8] { (0..<8).map { UInt8((n >> (8 * (7 - UInt64($0)))) & 0xff) } }
    static func nonce(_ dir: VoiciCallDir, _ ctr: UInt64) -> [UInt8] { [0, 0, 0, dir == .c2p ? 1 : 2] + be64(ctr) }
    static func aad(_ callId: String, _ dir: VoiciCallDir, _ ctr: UInt64) -> [UInt8] { Array("\(callId)|\(dir.rawValue)|\(ctr)".utf8) }

    public static func sealFrame(key: [UInt8], callId: String, dir: VoiciCallDir, ctr: UInt64, frame: [UInt8]) throws -> [UInt8] {
        guard frame.count <= frameMax else { throw CanonicalJsonError("voici-call: frame too long") }
        guard ctr < maxCtr else { throw CanonicalJsonError("voici-call: counter") }
        var pt = [UInt8](repeating: 0, count: framePlaintext)
        pt[0] = UInt8(frame.count)
        pt.replaceSubrange(1..<(1 + frame.count), with: frame)
        let box = try AES.GCM.seal(pt, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce(dir, ctr)), authenticating: aad(callId, dir, ctr))
        return be64(ctr) + Array(box.ciphertext) + Array(box.tag)
    }

    public static func openFrame(key: [UInt8], callId: String, dir: VoiciCallDir, sealed: [UInt8]) -> (ctr: UInt64, frame: [UInt8])? {
        guard sealed.count == sealedFrame else { return nil }
        let ctr = sealed[0..<8].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        guard ctr < maxCtr,
              let box = try? AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce(dir, ctr)), ciphertext: sealed[8..<(8 + framePlaintext)], tag: sealed[(8 + framePlaintext)...]),
              let ptData = try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad(callId, dir, ctr)) else { return nil }
        let pt = Array(ptData)
        let len = Int(pt[0])
        guard len <= frameMax, pt[(1 + len)...].allSatisfy({ $0 == 0 }) else { return nil }
        return (ctr, Array(pt[1..<(1 + len)]))
    }

    // MARK: video frames (voici-calls-v2.md §1.5, §1.6)

    /// The VP8 payload header that stays clear: 10 bytes on a key frame (bit 0 of byte 0 clear), else 3.
    public static func videoClearLen(_ frame: [UInt8]) -> Int {
        guard let b = frame.first else { return 0 }
        return b & 1 == 0 ? 10 : 3
    }

    public static func videoBucket(_ n: Int) -> Int? { videoBuckets.first { $0 >= n } }

    static let videoOverhead = 8 + 4 + 16
    static func videoAad(_ callId: String, _ dir: VoiciCallDir, _ ctr: UInt64, _ clear: ArraySlice<UInt8>) -> [UInt8] {
        Array("\(callId)|\(dir.rawValue)|video|\(ctr)|".utf8) + clear
    }
    static func be32(_ n: Int) -> [UInt8] { (0..<4).map { UInt8((n >> (8 * (3 - $0))) & 0xff) } }

    public static func sealVideoFrame(key: [UInt8], callId: String, dir: VoiciCallDir, ctr: UInt64, frame: [UInt8]) throws -> [UInt8] {
        guard ctr < maxCtr else { throw CanonicalJsonError("voici-call: counter") }
        let c = videoClearLen(frame)
        guard c > 0, frame.count >= c else { throw CanonicalJsonError("voici-call: video frame too short") }
        let body = frame[c...]
        guard let total = videoBucket(c + videoOverhead + body.count) else { throw CanonicalJsonError("voici-call: video frame too long") }
        var pt = [UInt8](repeating: 0, count: total - c - 8 - 16)
        pt.replaceSubrange(0..<4, with: be32(body.count))
        pt.replaceSubrange(4..<(4 + body.count), with: body)
        let box = try AES.GCM.seal(pt, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce(dir, ctr)), authenticating: videoAad(callId, dir, ctr, frame[0..<c]))
        return Array(frame[0..<c]) + be64(ctr) + Array(box.ciphertext) + Array(box.tag)
    }

    static func videoCtr(_ sealed: [UInt8]) -> UInt64? {
        guard videoBuckets.contains(sealed.count) else { return nil }
        let c = videoClearLen(sealed)
        guard c > 0, sealed.count >= c + videoOverhead else { return nil }
        return sealed[c..<(c + 8)].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
    }

    public static func openVideoFrame(key: [UInt8], callId: String, dir: VoiciCallDir, sealed: [UInt8]) -> (ctr: UInt64, frame: [UInt8])? {
        guard let ctr = videoCtr(sealed), ctr < maxCtr else { return nil }
        let c = videoClearLen(sealed)
        let tagAt = sealed.count - 16
        guard let box = try? AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce(dir, ctr)), ciphertext: sealed[(c + 8)..<tagAt], tag: sealed[tagAt...]),
              let ptData = try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: videoAad(callId, dir, ctr, sealed[0..<c])) else { return nil }
        let pt = Array(ptData)
        let len = pt[0..<4].reduce(0) { ($0 << 8) | Int($1) }
        guard len <= pt.count - 4, pt[(4 + len)...].allSatisfy({ $0 == 0 }) else { return nil }
        return (ctr, Array(sealed[0..<c]) + pt[4..<(4 + len)])
    }

    // MARK: answer

    public static func canonicalAnswer(_ a: VoiciCallAnswerBody) throws -> [UInt8] {
        guard CanonicalJson.isLowerHex(a.callId, bytes: 16), CanonicalJson.isLowerHex(a.deviceRef, bytes: 32),
              CanonicalJson.isLowerHex(a.requestHash, bytes: 32), CanonicalJson.isLowerHex(a.xwingCiphertext, bytes: PqHybrid.sealEncLen),
              CanonicalJson.isLowerHex(a.turnUser, bytes: 16), CanonicalJson.isLowerHex(a.turnSecret, bytes: 32), CanonicalJson.isTime(a.issuedAt),
              a.media.map(mediaValues.contains) ?? true
        else { throw CanonicalJsonError("\(tagAnswer): bad field") }
        return CanonicalJson.join([tagAnswer, a.callId, a.deviceRef, a.requestHash, a.xwingCiphertext, sdpHash(a.answerSdp), a.turnUser,
                                   CanonicalJson.sha256Hex(a.turnSecret), String(a.issuedAt)] + (a.media.map { [$0] } ?? []))
    }

    /// The wire answer, signed by the page's owner messages signing key.
    public static func signAnswer(_ a: VoiciCallAnswerBody, ownerSignSeed: [UInt8]) throws -> JSONValue {
        let sig = try CanonicalJson.ed25519SignHex(try canonicalAnswer(a), seed: ownerSignSeed)
        var o: [String: JSONValue] = ["v": .number(1), "kind": .string("voici-call-answer"), "callId": .string(a.callId), "deviceRef": .string(a.deviceRef),
                        "requestHash": .string(a.requestHash), "xwingCiphertext": .string(a.xwingCiphertext), "answerSdp": .string(a.answerSdp),
                        "turnUser": .string(a.turnUser), "turnSecret": .string(a.turnSecret), "issuedAt": .number(Double(a.issuedAt)), "sig": .string(sig)]
        if let m = a.media { o["media"] = .string(m) }
        return .object(o)
    }

    static let answerKeys: Set<String> = ["v", "kind", "callId", "deviceRef", "requestHash", "xwingCiphertext", "answerSdp", "turnUser", "turnSecret", "issuedAt", "sig"]

    public static func parseAnswer(_ v: JSONValue?) -> (body: VoiciCallAnswerBody, sig: String)? {
        guard let r = v?.object, Set(r.keys) == answerKeys || Set(r.keys) == answerKeys.union(["media"]),
              r["v"]?.isOne == true, r["kind"]?.string == "voici-call-answer",
              let sig = r["sig"]?.string, CanonicalJson.isLowerHex(sig, bytes: 64),
              let callId = r["callId"]?.string, let dref = r["deviceRef"]?.string, let rh = r["requestHash"]?.string,
              let ct = r["xwingCiphertext"]?.string, let sdp = r["answerSdp"]?.string, let tu = r["turnUser"]?.string,
              let ts = r["turnSecret"]?.string, let at = r["issuedAt"]?.time else { return nil }
        var media: String?
        if let m = r["media"] { guard let ms = m.string else { return nil }; media = ms }
        let b = VoiciCallAnswerBody(callId: callId, deviceRef: dref, requestHash: rh, xwingCiphertext: ct, answerSdp: sdp, turnUser: tu, turnSecret: ts, issuedAt: at, media: media)
        return (try? canonicalAnswer(b)) != nil ? (b, sig) : nil
    }

    public static func checkAnswer(_ v: JSONValue, request: JSONValue, ownerSignPub: String, now: Int64? = nil) -> VoiciVerdict<VoiciCallAnswerBody, VoiciCallAnswerRefusal> {
        guard let (a, sig) = parseAnswer(v), let bytes = try? canonicalAnswer(a), let rf = requestFields(request) else { return .refused(.malformed) }
        if a.callId != rf.callId { return .refused(.wrongCall) }
        if a.requestHash != requestHash(request) { return .refused(.wrongRequest) }
        let reqMedia = rf.media ?? mediaAudio
        if a.media == mediaVideo && reqMedia != mediaVideo { return .refused(.badSdp) }
        if checkSdp(a.answerSdp, media: reqMedia) != nil { return .refused(.badSdp) }
        if !CanonicalJson.ed25519VerifyHex(sig, bytes, ownerSignPub) { return .refused(.badSignature) }
        if let now, abs(a.issuedAt - now) > skewMs { return .refused(.stale) }
        return .ok(a)
    }

    // MARK: receipt

    public static func canonicalReceipt(account: String, callId: String, deviceRef: String, issuedAt: Int64, expiresAt: Int64) throws -> [UInt8] {
        guard isUsername(account), CanonicalJson.isLowerHex(callId, bytes: 16), CanonicalJson.isLowerHex(deviceRef, bytes: 32),
              CanonicalJson.isTime(issuedAt), CanonicalJson.isTime(expiresAt), expiresAt > issuedAt
        else { throw CanonicalJsonError("\(tagReceipt): bad field") }
        return CanonicalJson.join([tagReceipt, account, callId, deviceRef, String(issuedAt), String(expiresAt)])
    }

    public static func checkReceipt(_ v: JSONValue?, caKeys: [String], now: Int64, account: String, deviceRef want: String? = nil) -> VoiciVerdict<JSONValue, VoiciCallReceiptRefusal> {
        guard let r = v?.object, Set(r.keys) == ["v", "kind", "account", "callId", "deviceRef", "issuedAt", "expiresAt", "signedBy", "signature"],
              r["v"]?.isOne == true, r["kind"]?.string == "voici-call-receipt", let signedBy = r["signedBy"]?.string, CanonicalJson.isLowerHex(signedBy, bytes: 32),
              let sig = r["signature"]?.string, CanonicalJson.isLowerHex(sig, bytes: 64), let acct = r["account"]?.string, let callId = r["callId"]?.string,
              let dref = r["deviceRef"]?.string, let at = r["issuedAt"]?.time, let exp = r["expiresAt"]?.time,
              let bytes = try? canonicalReceipt(account: acct, callId: callId, deviceRef: dref, issuedAt: at, expiresAt: exp)
        else { return .refused(.malformed) }
        if !caKeys.contains(where: { CanonicalJson.same($0, signedBy) }) { return .refused(.unknownCa) }
        if !CanonicalJson.ed25519VerifyHex(sig, bytes, signedBy) { return .refused(.badSignature) }
        if exp - at > receiptTtlMs { return .refused(.tooLong) }
        if acct != account { return .refused(.wrongAccount) }
        if let want, dref != want { return .refused(.wrongDevice) }
        if now < at - skewMs { return .refused(.notYetValid) }
        if now >= exp { return .refused(.expired) }
        return .ok(v!)
    }

    // MARK: end, allow

    public static func canonicalEnd(callId: String, side: String, reason: String, issuedAt: Int64) throws -> [UInt8] {
        guard CanonicalJson.isLowerHex(callId, bytes: 16), side == "caller" || side == "owner", endReasons.contains(reason), CanonicalJson.isTime(issuedAt)
        else { throw CanonicalJsonError("\(tagEnd): bad field") }
        return CanonicalJson.join([tagEnd, callId, side, reason, String(issuedAt)])
    }

    public static func signEndOwner(callId: String, reason: String, issuedAt: Int64, ownerSignSeed: [UInt8]) throws -> JSONValue {
        let sig = try CanonicalJson.ed25519SignHex(try canonicalEnd(callId: callId, side: "owner", reason: reason, issuedAt: issuedAt), seed: ownerSignSeed)
        return .object(["v": .number(1), "kind": .string("voici-call-end"), "callId": .string(callId), "side": .string("owner"),
                        "reason": .string(reason), "issuedAt": .number(Double(issuedAt)), "sig": .string(sig)])
    }

    /// An end order for `callId`: the caller's under B (P-256), the owner's under ownerSignPub. Returns its reason.
    public static func checkEnd(_ v: JSONValue?, callId: String, callerPub: String, ownerSignPub: String) -> String? {
        guard let r = v?.object, Set(r.keys) == ["v", "kind", "callId", "side", "reason", "issuedAt", "sig"], r["v"]?.isOne == true,
              r["kind"]?.string == "voici-call-end", let sig = r["sig"]?.string, let cid = r["callId"]?.string, let side = r["side"]?.string,
              let reason = r["reason"]?.string, let at = r["issuedAt"]?.time,
              let bytes = try? canonicalEnd(callId: cid, side: side, reason: reason, issuedAt: at), cid == callId else { return nil }
        let ok = side == "caller" ? CanonicalJson.p256VerifyP1363(sig, bytes, callerPub) : CanonicalJson.ed25519VerifyHex(sig, bytes, ownerSignPub)
        return ok ? reason : nil
    }

    public static func canonicalAllow(pageId: String, conv: String, op: String, issuedAt: Int64) throws -> [UInt8] {
        guard isPageId(pageId), CanonicalJson.isLowerHex(conv, bytes: 32), op == "allow" || op == "disallow", CanonicalJson.isTime(issuedAt)
        else { throw CanonicalJsonError("\(tagAllow): bad field") }
        return CanonicalJson.join([tagAllow, pageId, conv, op, String(issuedAt)])
    }

    public static func signAllow(pageId: String, conv: String, op: String, issuedAt: Int64, ownerSignSeed: [UInt8]) throws -> String {
        try CanonicalJson.ed25519SignHex(try canonicalAllow(pageId: pageId, conv: conv, op: op, issuedAt: issuedAt), seed: ownerSignSeed)
    }

    // MARK: push, missed call

    static func openCanonical(_ seed: [UInt8], purpose: String, callId: String, sealed: [UInt8]) -> [String: JSONValue]? {
        guard let opened = try? PqHybrid.hybridOpen(recipientSecretKey: seed, expectedPurpose: purpose, context: [Array(callId.utf8)], sealed: sealed),
              let text = CanonicalJson.utf8Decode(opened.plaintext), let v = JSONValue.parse(text), CanonicalJson.isCanonical(v, text) else { return nil }
        return v.object
    }

    /// Opens the push's sealed caller (§6): {callId, pageId, conv, from}; nil unless it is for `callId` and conv matches.
    public static func openPush(inboxSeed: [UInt8], callId: String, sealed: [UInt8]) -> (pageId: String, conv: String, from: String)? {
        guard let o = openCanonical(inboxSeed, purpose: tagPush, callId: callId, sealed: sealed), Set(o.keys) == ["v", "callId", "pageId", "conv", "from"],
              o["v"]?.isOne == true, o["callId"]?.string == callId, let pageId = o["pageId"]?.string, isPageId(pageId),
              let conv = o["conv"]?.string, CanonicalJson.isLowerHex(conv, bytes: 32), let from = o["from"]?.string, CanonicalJson.isLowerHex(from, bytes: 32),
              (try? VoiciMessages.voiciConv(pageId: pageId, pseudonymPub: from)) == conv else { return nil }
        return (pageId, conv, from)
    }

    public struct MissedCall: Equatable, Sendable {
        public var request: VoiciCallRequest
        public var ringingAt: Int64
        public var endedAt: Int64
        public var reason: String
    }

    /// Opens a missed call from the mailbox and checks its request's signatures (no clock check).
    public static func openMissedCall(inboxSeed: [UInt8], callId: String, sealed: [UInt8], pageId: String, origin: String, caKeys: [String]) -> MissedCall? {
        guard let o = openCanonical(inboxSeed, purpose: tagMissedCall, callId: callId, sealed: sealed),
              Set(o.keys) == ["v", "request", "ringingAt", "endedAt", "reason"], o["v"]?.isOne == true,
              let ringing = o["ringingAt"]?.time, let ended = o["endedAt"]?.time, ended >= ringing,
              let reason = o["reason"]?.string, missedReasons.contains(reason), let req = o["request"],
              case .ok(let r) = checkRequest(req, VoiciCallRequestCheckContext(pageId: pageId, acceptsCalls: true, origin: origin, caKeys: caKeys, now: ringing, skipFresh: true)),
              r.callId == callId else { return nil }
        return MissedCall(request: r, ringingAt: ringing, endedAt: ended, reason: reason)
    }
}

/// The sending half of one direction of a call: a counter from 0 and the current epoch key.
public final class VoiciCallFrameSender {
    private var ctr: UInt64 = 0
    private var epoch: UInt64 = 0
    private var key: [UInt8]
    private let callId: String
    private let dir: VoiciCallDir
    private let video: Bool

    /// `video`: the video frame layer (voici-calls-v2.md §1.5) on its own counters, else audio.
    public init(baseKey: [UInt8], callId: String, dir: VoiciCallDir, video: Bool = false) {
        self.key = baseKey; self.callId = callId; self.dir = dir; self.video = video
    }

    public func seal(_ frame: [UInt8]) throws -> [UInt8] {
        let e = VoiciCalls.epoch(ctr)
        while epoch < e {
            let next = VoiciCalls.nextFrameKey(key)
            PqBin.zero(&key)
            key = next
            epoch += 1
        }
        let out = video ? try VoiciCalls.sealVideoFrame(key: key, callId: callId, dir: dir, ctr: ctr, frame: frame)
                        : try VoiciCalls.sealFrame(key: key, callId: callId, dir: dir, ctr: ctr, frame: frame)
        ctr += 1
        return out
    }
}

/// The receiving half: a 128-frame replay window, a 3,000-frame gap limit, the newest two epochs' keys only.
public final class VoiciCallFrameReceiver {
    private var highest: Int64 = -1
    private var seen = Set<UInt64>()
    private var keys: [UInt64: [UInt8]]
    private var top: UInt64 = 0
    private let callId: String
    private let dir: VoiciCallDir
    private let video: Bool

    public init(baseKey: [UInt8], callId: String, dir: VoiciCallDir, video: Bool = false) {
        self.keys = [0: baseKey]; self.callId = callId; self.dir = dir; self.video = video
    }

    public func open(_ sealed: [UInt8]) -> [UInt8]? {
        let peeked: UInt64? = video ? VoiciCalls.videoCtr(sealed)
            : (sealed.count == VoiciCalls.sealedFrame ? sealed[0..<8].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) } : nil)
        guard let ctr = peeked, ctr < VoiciCalls.maxCtr, Int64(ctr) <= highest + Int64(VoiciCalls.maxGapFrames) else { return nil }
        if Int64(ctr) <= highest - Int64(VoiciCalls.replayWindow) || seen.contains(ctr) { return nil }
        let e = VoiciCalls.epoch(ctr)
        if e + 1 < top { return nil }
        var pending: [[UInt8]] = []
        var k = keys[e]
        if e > top {
            var cur = keys[top]!
            for _ in top..<e { cur = VoiciCalls.nextFrameKey(cur); pending.append(cur) }
            k = cur
        }
        let opened = k.flatMap { key in
            video ? VoiciCalls.openVideoFrame(key: key, callId: callId, dir: dir, sealed: sealed) : VoiciCalls.openFrame(key: key, callId: callId, dir: dir, sealed: sealed)
        }
        guard let opened else {
            for i in pending.indices { PqBin.zero(&pending[i]) }
            return nil
        }
        for p in pending { top += 1; keys[top] = p }
        for ep in keys.keys where ep + 1 < top {
            var kk = keys[ep]!
            PqBin.zero(&kk)
            keys[ep] = nil
        }
        if Int64(ctr) > highest { highest = Int64(ctr) }
        seen.insert(ctr)
        seen = seen.filter { Int64($0) > highest - Int64(VoiciCalls.replayWindow) }
        return opened.frame
    }
}
