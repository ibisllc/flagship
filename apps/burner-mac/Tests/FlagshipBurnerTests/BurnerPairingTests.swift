import XCTest
import CryptoKit
@testable import FlagshipBurnerCore

/// Phone↔burner pairing — crypto + protocol tests.
///
/// The headline guard is `test_crossPlatformVector`: it pins the X25519 +
/// HKDF derivation to a vector computed independently with Node's
/// `crypto` (X25519 + hkdfSync) from fixed raw keys. If CryptoKit and the
/// phone/relay's crypto ever drift, this breaks. The same vector is
/// asserted on the TS side (apps/com) so neither implementation can move
/// the constants unilaterally.
final class BurnerPairingTests: XCTestCase {

    // Vector from apps/com burnerPairingVector.test.ts (Node crypto).
    private let burnerPrivHex = "0101010101010101010101010101010101010101010101010101010101010101"
    private let phonePrivHex  = "0202020202020202020202020202020202020202020202020202020202020202"
    private let burnerPubB64u = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
    private let phonePubB64u  = "zo060cy2M-x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk"
    private let encKeyHex     = "638fab7912f28c5b71444e4899ccb48c553eaa1c952da13fd0985d90faec5136"
    private let expectedSas   = "658275"
    private let codeBytesHex  = "0102030405"
    private let expectedHuman = "AEBAGBAF"
    private let expectedSid   = "KW3_KaK0uN8rcrQCLmsOJXXfhr9EEpib"

    private func hex(_ s: String) -> Data {
        var d = Data(); var i = s.startIndex
        while i < s.endIndex { let n = s.index(i, offsetBy: 2); d.append(UInt8(s[i..<n], radix: 16)!); i = n }
        return d
    }
    private func hexOf(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

    func test_crossPlatformVector() throws {
        let burnerPriv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(burnerPrivHex))
        let phonePriv  = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(phonePrivHex))

        // Public keys derived by CryptoKit must match Node's.
        XCTAssertEqual(Base64URLBurner.encode(burnerPriv.publicKey.rawRepresentation), burnerPubB64u)
        XCTAssertEqual(Base64URLBurner.encode(phonePriv.publicKey.rawRepresentation), phonePubB64u)

        // Burner derives SAS + AEAD key from ECDH(burnerPriv, phonePub).
        let phonePub = Base64URLBurner.decode(phonePubB64u)!
        let mat = try BurnerPairing.deriveMaterial(burnerPrivateKey: burnerPriv, phonePublicKey: phonePub)
        XCTAssertEqual(mat.matchCode, expectedSas)
        let keyHex = mat.aeadKey.withUnsafeBytes { hexOf(Data($0)) }
        XCTAssertEqual(keyHex, encKeyHex)
    }

    func test_sessionIdAndShortCodeVector() {
        let code = hex(codeBytesHex)
        XCTAssertEqual(BurnerPairing.humanCode(fromBytes: code), expectedHuman)
        XCTAssertEqual(BurnerPairing.sessionId(forCodeBytes: code), expectedSid)
        XCTAssertEqual(BurnerPairing.formatHumanCode(expectedHuman), "AEBA-GBAF")
    }

    func test_shortCodeRoundTripTolerant() {
        let code = BurnerPairing.newCodeBytes()
        let human = BurnerPairing.humanCode(fromBytes: code)
        // Lowercase, spaced, dashed all decode back to the same bytes.
        XCTAssertEqual(BurnerPairing.codeBytes(fromHumanCode: human), code)
        XCTAssertEqual(BurnerPairing.codeBytes(fromHumanCode: human.lowercased()), code)
        let dashed = BurnerPairing.formatHumanCode(human)
        XCTAssertEqual(BurnerPairing.codeBytes(fromHumanCode: dashed), code)
        XCTAssertNil(BurnerPairing.codeBytes(fromHumanCode: "nope!!!"))
    }

    func test_qrPayloadFormat() throws {
        let burnerPriv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(burnerPrivHex))
        let payload = BurnerPairing.qrPayload(humanCode: expectedHuman,
                                              burnerPublicKey: burnerPriv.publicKey.rawRepresentation)
        XCTAssertEqual(payload, "flagship://burner?c=\(expectedHuman)&k=\(burnerPubB64u)")
    }

    /// End-to-end interop: a simulated phone derives the same key, seals a
    /// payload exactly like `QrRelay.seal` (ct||tag + separate 12-byte
    /// nonce), and the burner opens it.
    func test_sealOpenInterop() throws {
        let burnerPriv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(burnerPrivHex))
        let phonePriv  = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(phonePrivHex))

        // Phone side derives from ECDH(phonePriv, burnerPub) — same key.
        let phoneMat = try BurnerPairing.deriveMaterial(
            burnerPrivateKey: phonePriv,
            phonePublicKey: burnerPriv.publicKey.rawRepresentation)

        let plaintext = Data("{\"hello\":\"recipe\"}".utf8)
        let nonceBytes = Data((0..<12).map { _ in UInt8.random(in: 0...255) })
        let sealed = try AES.GCM.seal(plaintext, using: phoneMat.aeadKey,
                                      nonce: try AES.GCM.Nonce(data: nonceBytes))
        let ct = sealed.ciphertext + sealed.tag

        let opened = try BurnerPairing.open(
            ciphertextBase64Url: Base64URLBurner.encode(ct),
            nonceBase64Url: Base64URLBurner.encode(nonceBytes),
            key: phoneMat.aeadKey)
        XCTAssertEqual(opened, plaintext)
    }

    // MARK: - Engine state machine

    private func engine() -> BurnerPairingEngine {
        let priv = try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(burnerPrivHex))
        return BurnerPairingEngine(privateKey: priv, codeBytes: hex(codeBytesHex))
    }

    func test_engineSendsBurnerHelloWhenPhoneJoins() {
        let e = engine()
        let actions = e.onRelayFrame(["kind": "peer-joined"])
        XCTAssertEqual(actions, [.send(.burnerHello(burnerPubKeyB64: burnerPubB64u))])
    }

    func test_engineDerivesSasOnPhoneHelloThenPairsOnConfirm() {
        let e = engine()
        let sas = e.onRelayFrame(["kind": "peer", "frame": ["kind": "phone-hello", "phonePk": phonePubB64u]])
        XCTAssertEqual(sas, [.stage(.awaitingConfirm(matchCode: expectedSas))])
        XCTAssertEqual(e.matchCode, expectedSas)

        let paired = e.onRelayFrame(["kind": "peer", "frame": ["kind": "confirm-pairing"]])
        XCTAssertEqual(paired, [.stage(.paired)])
    }

    func test_engineDeliversRecipeAfterHandshake() throws {
        let e = engine()
        _ = e.onRelayFrame(["kind": "peer", "frame": ["kind": "phone-hello", "phonePk": phonePubB64u]])

        // Phone seals a "recipe" with the negotiated key.
        let phonePriv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(phonePrivHex))
        let burnerPub = Base64URLBurner.decode(burnerPubB64u)!
        let mat = try BurnerPairing.deriveMaterial(burnerPrivateKey: phonePriv, phonePublicKey: burnerPub)
        let plaintext = Data("RECIPE".utf8)
        let nonce = Data((0..<12).map { _ in UInt8.random(in: 0...255) })
        let sealed = try AES.GCM.seal(plaintext, using: mat.aeadKey, nonce: try AES.GCM.Nonce(data: nonce))
        let ct = sealed.ciphertext + sealed.tag

        let actions = e.onRelayFrame(["kind": "peer", "frame": [
            "kind": "deliver",
            "ciphertext": Base64URLBurner.encode(ct),
            "nonce": Base64URLBurner.encode(nonce),
        ]])
        XCTAssertEqual(actions, [.recipe(plaintext)])
    }

    /// Drive the engine to `.paired` (the precondition for the hold/resume
    /// behaviour below).
    private func pairedEngine() -> BurnerPairingEngine {
        let e = engine()
        _ = e.onRelayFrame(["kind": "peer", "frame": ["kind": "phone-hello", "phonePk": phonePubB64u]])
        _ = e.onRelayFrame(["kind": "peer", "frame": ["kind": "confirm-pairing"]])
        return e
    }

    func test_enginePeerGoneBeforePairingStaysWaiting() {
        // From the initial waiting state, a peer-gone is a no-op (the QR stays
        // live for the phone to come back) — NOT an end/wipe.
        let e = engine()
        XCTAssertEqual(e.onRelayFrame(["kind": "peer-gone"]), [])
        XCTAssertEqual(e.stage, .waitingForPhone)
    }

    func test_engineHoldsOnPeerGoneAfterPaired() {
        let e = pairedEngine()
        let actions = e.onRelayFrame(["kind": "peer-gone"])
        XCTAssertEqual(actions, [.stage(.reconnecting)])
        XCTAssertEqual(e.stage, .reconnecting)
        // A second peer-gone while already holding is a no-op.
        XCTAssertEqual(e.onRelayFrame(["kind": "peer-gone"]), [])
    }

    func test_engineResumesOnSamePhoneReconnect() {
        let e = pairedEngine()
        _ = e.onRelayFrame(["kind": "peer-gone"])            // → reconnecting
        // The phone rejoins; we re-offer our pubkey, then it re-says hello.
        _ = e.onRelayFrame(["kind": "peer-joined"])
        let resumed = e.onRelayFrame(["kind": "peer", "frame": ["kind": "phone-hello", "phonePk": phonePubB64u]])
        XCTAssertEqual(resumed, [.stage(.paired)])           // no fresh SAS
        XCTAssertEqual(e.stage, .paired)
    }

    func test_engineIgnoresDifferentPhoneDuringReconnect() {
        let e = pairedEngine()
        _ = e.onRelayFrame(["kind": "peer-gone"])            // → reconnecting
        // A DIFFERENT phone (burner pubkey stands in as another valid key)
        // must not be able to seize a held session.
        let actions = e.onRelayFrame(["kind": "peer", "frame": ["kind": "phone-hello", "phonePk": burnerPubB64u]])
        XCTAssertFalse(actions.contains(.stage(.paired)))
        XCTAssertEqual(e.stage, .reconnecting)
    }

    func test_engineEndsOnExpired() {
        let e = engine()
        let actions = e.onRelayFrame(["kind": "expired"])
        guard actions.count == 1, case .stage(.ended) = actions[0] else {
            return XCTFail("expected ended stage, got \(actions)")
        }
    }

    func test_engineCapturesExpiresAtFromAccepted() {
        let e = engine()
        XCTAssertNil(e.expiresAtMs)
        _ = e.onRelayFrame(["kind": "accepted", "role": "burner", "expiresAt": 1_900_000_000_000.0])
        XCTAssertEqual(e.expiresAtMs, 1_900_000_000_000.0)
    }

    func test_engineWipesViaSessionEndedFromPhone() {
        let e = pairedEngine()
        let actions = e.onRelayFrame(["kind": "peer", "frame": ["kind": "session-ended"]])
        guard actions.count == 1, case .stage(.ended) = actions[0] else {
            return XCTFail("expected ended stage, got \(actions)")
        }
    }

    func test_engineExposesStableSessionIdAndQr() {
        let e = engine()
        XCTAssertEqual(e.sessionId, expectedSid)
        XCTAssertEqual(e.humanCode, expectedHuman)
        XCTAssertEqual(e.humanCodeDisplay, "AEBA-GBAF")
        XCTAssertEqual(e.publicKeyB64, burnerPubB64u)
        XCTAssertTrue(e.qrPayload.hasPrefix("flagship://burner?c=\(expectedHuman)&k="))
    }
}
