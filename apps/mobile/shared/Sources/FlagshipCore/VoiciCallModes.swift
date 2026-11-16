import CryptoKit
import Foundation

/// Anonymous calls (docs/voici-calls.md "Who may call a page"): a page open to anyone takes a call from a browser
/// with no account, signed by the browser key alone and carrying a proof of work on a challenge `.com` MACs. Swift
/// twin of the anonymous section of packages/protocol/src/voiciCallModes.ts (vectors: sections `pow` and `anon` of
/// test-vectors/voici-call-modes/vectors.json). The answering phone checks it and hashes it by its kind.
///
///   request  flagship/voici-call-request-anon/v1|<pageId>|<conv>|<callId>|<browserPub>|<callerXwingPub>|<H(offerSdp)>
///              |<issuedAt>|<H(powChallenge)>|<powNonce>[|<media>]       P-256 (IEEE P1363) by browserPub
///   conv     first 16 bytes (hex) of SHA-256("flagship/voici-anon-conv/v1|<pageId>|<browserPub>")
///   pow      flagship/voici-call-pow/v1|<pageId>|<issuedAt>|<bits>|<rand hex 32>|<mac hex 64>; SHA-256(challenge "|"
///            nonce) starts with `bits` zero bits
public enum VoiciCallRequestAnonRefusal: String, Sendable {
    case tooLarge = "too-large", malformed, wrongAudience = "wrong-audience", callsOff = "calls-off", notAllowed = "not-allowed", blocked
    case wrongConv = "wrong-conv", badSdp = "bad-sdp", badKey = "bad-key", badPow = "bad-pow", badSignature = "bad-signature", stale
}

public enum VoiciCallModes {
    public static let tagRequestAnon = "flagship/voici-call-request-anon/v1"
    public static let tagAnonConv = "flagship/voici-anon-conv/v1"
    public static let tagPow = "flagship/voici-call-pow/v1"
    public static let powMinBits = 12
    public static let powMaxBits = 26
    public static let anonKind = "voici-call-request-anon"
    static let anonKeys: Set<String> = ["v", "kind", "pageId", "conv", "callId", "browserPub", "callerXwingPub", "offerSdp", "issuedAt", "pow", "sig"]

    static func isDecimal(_ s: String, maxDigits: Int) -> Bool {
        let b = Array(s.utf8)
        guard (1...maxDigits).contains(b.count), b.allSatisfy({ (0x30...0x39).contains($0) }) else { return false }
        return b.count == 1 || b[0] != 0x30
    }

    /// The challenge's fields (no MAC check: only `.com` can check it).
    public static func parsePow(_ c: String) -> (pageId: String, issuedAt: Int64, bits: Int)? {
        guard c.utf8.count <= 256 else { return nil }
        let f = c.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard f.count == 6, f[0] == tagPow, VoiciCalls.isPageId(f[1]), isDecimal(f[2], maxDigits: 16), f[3].utf8.count == 2,
              f[3].utf8.allSatisfy({ (0x30...0x39).contains($0) }), let bits = Int(f[3]), CanonicalJson.isLowerHex(f[4], bytes: 16), CanonicalJson.isLowerHex(f[5], bytes: 32),
              (powMinBits...powMaxBits).contains(bits), let at = Int64(f[2]) else { return nil }
        return (f[1], at, bits)
    }

    static func leadingZeroBits(_ b: [UInt8]) -> Int {
        var n = 0
        for x in b {
            if x == 0 { n += 8; continue }
            return n + x.leadingZeroBitCount
        }
        return n
    }

    public static func powSolves(challenge: String, nonce: String) -> Bool {
        guard let c = parsePow(challenge), isDecimal(nonce, maxDigits: 16) else { return false }
        return leadingZeroBits(Array(SHA256.hash(data: Data("\(challenge)|\(nonce)".utf8)))) >= c.bits
    }

    public static func anonConv(pageId: String, browserPub: String) -> String {
        String(CanonicalJson.sha256Hex("\(tagAnonConv)|\(pageId)|\(browserPub)").prefix(32))
    }

    static func isP256Pub(_ s: String) -> Bool {
        guard CanonicalJson.isLowerHex(s, bytes: 65), s.hasPrefix("04"), let b = try? CanonicalJson.hexToBytes(s) else { return false }
        return (try? P256.Signing.PublicKey(x963Representation: b)) != nil
    }

    static func anonFields(_ v: JSONValue?) -> (pageId: String, conv: String, callId: String, browserPub: String, xpub: String, sdp: String, at: Int64,
                                                challenge: String, nonce: String, media: String?, sig: String)? {
        guard let r = v?.object, Set(r.keys) == anonKeys || Set(r.keys) == anonKeys.union(["media"]), r["v"]?.isOne == true, r["kind"]?.string == anonKind,
              let sig = r["sig"]?.string, CanonicalJson.isLowerHex(sig, bytes: 64), let pageId = r["pageId"]?.string, let conv = r["conv"]?.string,
              let callId = r["callId"]?.string, let bp = r["browserPub"]?.string, let xpub = r["callerXwingPub"]?.string, let sdp = r["offerSdp"]?.string,
              let at = r["issuedAt"]?.time, let pow = r["pow"]?.object, Set(pow.keys) == ["challenge", "nonce"], let ch = pow["challenge"]?.string,
              let nonce = pow["nonce"]?.string else { return nil }
        var media: String?
        if let m = r["media"] { guard let ms = m.string else { return nil }; media = ms }
        let f = (pageId, conv, callId, bp, xpub, sdp, at, ch, nonce, media, sig)
        return (try? canonicalRequestAnon(pageId: pageId, conv: conv, callId: callId, browserPub: bp, callerXwingPub: xpub, offerSdp: sdp, issuedAt: at,
                                          challenge: ch, nonce: nonce, media: media)) != nil ? f : nil
    }

    public static func canonicalRequestAnon(pageId: String, conv: String, callId: String, browserPub: String, callerXwingPub: String, offerSdp: String,
                                            issuedAt: Int64, challenge: String, nonce: String, media: String?) throws -> [UInt8] {
        guard VoiciCalls.isPageId(pageId), CanonicalJson.isLowerHex(conv, bytes: 16), CanonicalJson.isLowerHex(callId, bytes: 16), isP256Pub(browserPub),
              CanonicalJson.isLowerHex(callerXwingPub, bytes: PqHybrid.sealPublicKeyLen), CanonicalJson.isTime(issuedAt), parsePow(challenge) != nil,
              isDecimal(nonce, maxDigits: 16), media.map(VoiciCalls.mediaValues.contains) ?? true
        else { throw CanonicalJsonError("\(tagRequestAnon): bad field") }
        return CanonicalJson.join([tagRequestAnon, pageId, conv, callId, browserPub, callerXwingPub, VoiciCalls.sdpHash(offerSdp), String(issuedAt),
                                   CanonicalJson.sha256Hex(challenge), nonce] + (media.map { [$0] } ?? []))
    }

    /// The canonical bytes of an anonymous wire request, nil when it doesn't parse.
    public static func requestAnonBytes(_ v: JSONValue) -> [UInt8]? {
        guard let f = anonFields(v) else { return nil }
        return try? canonicalRequestAnon(pageId: f.pageId, conv: f.conv, callId: f.callId, browserPub: f.browserPub, callerXwingPub: f.xpub,
                                         offerSdp: f.sdp, issuedAt: f.at, challenge: f.challenge, nonce: f.nonce, media: f.media)
    }

    /// The answering phone's check, cheapest first (TS checkVoiciCallRequestAnon); `.com` checked the challenge's MAC,
    /// window and spending before ringing.
    public static func checkRequestAnon(_ v: JSONValue, pageId: String, acceptsCalls: Bool, callsFrom: String, now: Int64, blocked: Set<String> = [],
                                        skipFresh: Bool = false) -> VoiciVerdict<VoiciCallRequest, VoiciCallRequestAnonRefusal> {
        if let text = try? CanonicalJson.canonicalJson(v), text.utf8.count > VoiciCalls.maxRequestBytes { return .refused(.tooLarge) }
        guard let f = anonFields(v), let bytes = requestAnonBytes(v) else { return .refused(.malformed) }
        if f.pageId != pageId { return .refused(.wrongAudience) }
        if !acceptsCalls { return .refused(.callsOff) }
        if callsFrom != "anyone" { return .refused(.notAllowed) }
        if blocked.contains(f.conv) { return .refused(.blocked) }
        if f.conv != anonConv(pageId: f.pageId, browserPub: f.browserPub) { return .refused(.wrongConv) }
        if VoiciCalls.checkSdp(f.sdp, media: f.media ?? VoiciCalls.mediaAudio) != nil { return .refused(.badSdp) }
        guard let x = try? CanonicalJson.hexToBytes(f.xpub), (try? PqHybrid.parseHybridSealPublicKey(x)) != nil else { return .refused(.badKey) }
        if parsePow(f.challenge)?.pageId != f.pageId || !powSolves(challenge: f.challenge, nonce: f.nonce) { return .refused(.badPow) }
        if !CanonicalJson.p256VerifyP1363(f.sig, bytes, f.browserPub) { return .refused(.badSignature) }
        if !skipFresh && abs(f.at - now) > VoiciCalls.skewMs { return .refused(.stale) }
        return .ok(VoiciCallRequest(pageId: f.pageId, conv: f.conv, callId: f.callId, from: "", callerXwingPub: f.xpub, offerSdp: f.sdp, issuedAt: f.at,
                                    delegatePub: f.browserPub, json: v, media: f.media ?? VoiciCalls.mediaAudio))
    }
}
