import CryptoKit
import Foundation

/// Calling from the app (docs/voici-calls.md "Calling from the app"): the caller's half of a voi.ci call, which the
/// app plays when it calls a page it knows, and the browser handoff it falls back to when its media engine is
/// missing. Swift twin of the handoff section of packages/protocol/src/voiciCalls.ts (vectors: section `handoff` of
/// packages/protocol/test-vectors/voici-calls/vectors.json).
///
/// Handoff: `{kind:"flagship/voici-call-handoff/v1", username, pageId, media, issuedAt, expiresAt (≤ 5 min), delegatePriv
/// (P-256 scalar hex), signIn (a flagship/voici-sign-in/v1 answer whose delegation names delegatePriv's key, ≤ 10 min)}`,
/// sealed AES-256-GCM under HKDF(X25519(app, browser), "flagship/qr/v1", "flagship/qr/enc/v1") and delivered over
/// `/qr-pipe` to `https://voi.ci/<username>#call=<sid>.<browser X25519 secret, base64url>`.
public enum VoiciCallerAnswerRefusal: String, Sendable {
    case malformed, wrongCall = "wrong-call", wrongRequest = "wrong-request", badSdp = "bad-sdp", badSignature = "bad-signature", stale
    case badCallKey = "bad-call-key"
}

public enum VoiciCallHandoffs {
    public static let tag = "flagship/voici-call-handoff/v1"
    public static let ttlMs: Int64 = 5 * 60_000
    public static let sessionMs: Int64 = 10 * 60_000

    /// The sign-in link's username rule (`^[a-z0-9](?:-?[a-z0-9]){0,31}$`): the tab keeps it as its session's page.
    public static func isUsername(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard (1...32).contains(b.count) else { return false }
        func ok(_ c: UInt8) -> Bool { (0x61...0x7a).contains(c) || (0x30...0x39).contains(c) }
        guard ok(b.first!), ok(b.last!) else { return false }
        for i in b.indices where !ok(b[i]) { if b[i] != 0x2d || !ok(b[i - 1]) || !ok(b[i + 1]) { return false } }
        return true
    }

    /// The delegate's public key (uncompressed SEC1 hex) for a P-256 scalar (hex), nil when it isn't one.
    public static func delegatePub(_ privHex: String) -> String? {
        guard CanonicalJson.isLowerHex(privHex, bytes: 32), let raw = try? CanonicalJson.hexToBytes(privHex),
              let k = try? P256.Signing.PrivateKey(rawRepresentation: raw) else { return nil }
        return CanonicalJson.hex(Array(k.publicKey.x963Representation))
    }

    /// The handoff record (exact keys; its canonical JSON is the sealed plaintext).
    public static func handoff(username: String, pageId: String, media: String, issuedAt: Int64, expiresAt: Int64, delegatePriv: String,
                               signIn: JSONValue) throws -> JSONValue {
        guard isUsername(username), VoiciCalls.isPageId(pageId), VoiciCalls.mediaValues.contains(media),
              CanonicalJson.isTime(issuedAt), CanonicalJson.isTime(expiresAt), expiresAt > issuedAt, expiresAt - issuedAt <= ttlMs,
              delegatePub(delegatePriv) != nil, signIn["pageId"]?.string == pageId
        else { throw CanonicalJsonError("\(tag): bad field") }
        return .object(["kind": .string(tag), "username": .string(username), "pageId": .string(pageId), "media": .string(media),
                        "issuedAt": .number(Double(issuedAt)), "expiresAt": .number(Double(expiresAt)), "delegatePriv": .string(delegatePriv),
                        "signIn": signIn])
    }

    public static func link(host: String, username: String, sid: String, browserSecret: [UInt8]) throws -> String {
        let sidOk = !sid.isEmpty && sid.count <= 64 && sid.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "-" || $0 == "_" }
        guard isUsername(username), sidOk, browserSecret.count == 32 else { throw CanonicalJsonError("\(tag): bad link field") }
        return "https://\(host)/\(username)#call=\(sid).\(Base64URL.encode(Data(browserSecret)))"
    }

    /// The pipe key (the sign-in / remote-ticket construction).
    public static func key(mySecret: [UInt8], peerPub: [UInt8]) throws -> [UInt8] {
        let me = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: mySecret)
        let shared = try me.sharedSecretFromKeyAgreement(with: try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPub))
        return shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: QrRelay.relayHkdfSalt, sharedInfo: QrRelay.encInfo, outputByteCount: 32)
            .withUnsafeBytes { Array($0) }
    }

    public static func publicKey(_ secret: [UInt8]) throws -> [UInt8] {
        Array(try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret).publicKey.rawRepresentation)
    }

    /// The app's delivery `{phonePk, nonce, ciphertext}` (base64url), sealed to the browser's secret.
    public static func seal(_ handoff: JSONValue, appSecret: [UInt8], browserSecret: [UInt8], nonce: [UInt8]) throws -> (phonePk: String, nonce: String, ciphertext: String) {
        let k = try key(mySecret: appSecret, peerPub: try publicKey(browserSecret))
        let box = try AES.GCM.seal(Data(try CanonicalJson.canonicalJsonBytes(handoff)), using: SymmetricKey(data: k), nonce: try AES.GCM.Nonce(data: nonce))
        return (Base64URL.encode(Data(try publicKey(appSecret))), Base64URL.encode(Data(nonce)), Base64URL.encode(box.ciphertext + box.tag))
    }

    // MARK: the caller's records

    /// The wire request the caller signs with its delegated P-256 key (IEEE P1363 r‖s).
    public static func signedRequest(pageId: String, conv: String, callId: String, from: String, callerXwingPub: String, offerSdp: String,
                                     issuedAt: Int64, cred: JSONValue, media: String?, sign: ([UInt8]) throws -> [UInt8]) throws -> JSONValue {
        let bytes = try VoiciCalls.canonicalRequest(pageId: pageId, conv: conv, callId: callId, callerXwingPub: callerXwingPub, offerSdp: offerSdp,
                                                    issuedAt: issuedAt, media: media)
        let sig = try sign(bytes)
        guard sig.count == 64 else { throw CanonicalJsonError("\(VoiciCalls.tagRequest): bad signature") }
        var o: [String: JSONValue] = ["v": .number(1), "kind": .string("voici-call-request"), "pageId": .string(pageId), "conv": .string(conv),
                                      "callId": .string(callId), "from": .string(from), "callerXwingPub": .string(callerXwingPub),
                                      "offerSdp": .string(offerSdp), "issuedAt": .number(Double(issuedAt)), "cred": cred, "sig": .string(CanonicalJson.hex(sig))]
        if let media { o["media"] = .string(media) }
        return .object(o)
    }

    /// The caller's signed end order (side "caller").
    public static func signedEnd(callId: String, reason: String, issuedAt: Int64, sign: ([UInt8]) throws -> [UInt8]) throws -> JSONValue {
        let sig = try sign(try VoiciCalls.canonicalEnd(callId: callId, side: "caller", reason: reason, issuedAt: issuedAt))
        guard sig.count == 64 else { throw CanonicalJsonError("\(VoiciCalls.tagEnd): bad signature") }
        return .object(["v": .number(1), "kind": .string("voici-call-end"), "callId": .string(callId), "side": .string("caller"),
                        "reason": .string(reason), "issuedAt": .number(Double(issuedAt)), "sig": .string(CanonicalJson.hex(sig))])
    }

    /// The answer as the caller checks it (checkVoiciCallAnswer in TS): an owner-signed answer, or one from a locked
    /// device signed by a call key whose binding (`callKey`) verifies under the page's ownerSignPub for `username`.
    public static func checkAnswer(_ v: JSONValue, request: JSONValue, ownerSignPub: String, username: String?, callKeyPub: String? = nil,
                                   now: Int64? = nil) -> VoiciVerdict<VoiciCallAnswerBody, VoiciCallerAnswerRefusal> {
        guard var o = v.object else { return .refused(.malformed) }
        let proof = o["callKey"]
        o["callKey"] = nil
        guard let (a, sig) = VoiciCalls.parseAnswer(.object(o)), let bytes = try? VoiciCalls.canonicalAnswer(a), let rf = VoiciCalls.requestFields(request)
        else { return .refused(.malformed) }
        if a.callId != rf.callId { return .refused(.wrongCall) }
        if a.requestHash != VoiciCalls.requestHash(request) { return .refused(.wrongRequest) }
        let reqMedia = rf.media ?? VoiciCalls.mediaAudio
        if a.media == VoiciCalls.mediaVideo && reqMedia != VoiciCalls.mediaVideo { return .refused(.badSdp) }
        if VoiciCalls.checkSdp(a.answerSdp, media: reqMedia) != nil { return .refused(.badSdp) }
        if let proof {
            guard let username, VoiciCalls.verifyCallKeyBinding(proof, ownerSignPub: ownerSignPub, username: username),
                  let key = proof["binding"]?["callKeyPub"]?.string else { return .refused(.badCallKey) }
            if let callKeyPub, callKeyPub != key { return .refused(.badCallKey) }
            if (try? VoiciCalls.deviceRef(devicePubHex: key)) != a.deviceRef { return .refused(.badCallKey) }
            if !CanonicalJson.p256VerifyP1363(sig, bytes, key) { return .refused(.badSignature) }
        } else if callKeyPub != nil || !CanonicalJson.ed25519VerifyHex(sig, bytes, ownerSignPub) {
            return .refused(.badSignature)
        }
        if let now, abs(a.issuedAt - now) > VoiciCalls.skewMs { return .refused(.stale) }
        return .ok(a)
    }
}
