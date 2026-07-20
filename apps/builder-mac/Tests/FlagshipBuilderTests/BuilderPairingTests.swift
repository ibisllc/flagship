import XCTest
import CryptoKit
@testable import FlagshipBuilderCore

/// Phone↔builder pairing — crypto + protocol tests.
///
/// The headline guard is `test_crossPlatformVector`: it pins the X25519 +
/// HKDF derivation to a vector computed independently with Node's
/// `crypto` (X25519 + hkdfSync) from fixed raw keys. If CryptoKit and the
/// phone/relay's crypto ever drift, this breaks. The same vector is
/// asserted on the TS side (apps/com) so neither implementation can move
/// the constants unilaterally.
final class BuilderPairingTests: XCTestCase {

    // Vector from apps/com builderPairingVector.test.ts (Node crypto).
    private let builderPrivHex = "0101010101010101010101010101010101010101010101010101010101010101"
    private let phonePrivHex  = "0202020202020202020202020202020202020202020202020202020202020202"
    private let builderPubB64u = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
    private let phonePubB64u  = "zo060cy2M-x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk"
    private let encKeyHex     = "638fab7912f28c5b71444e4899ccb48c553eaa1c952da13fd0985d90faec5136"
    private let expectedSas   = "658275"
    private let codeBytesHex  = "0102030405"
    private let expectedHuman = "AEBAGBAF"
    private let expectedSid   = "F2x43pqWEQ9rjC9jLfItSh4RE0K3Izzb"

    private func hex(_ s: String) -> Data {
        var d = Data(); var i = s.startIndex
        while i < s.endIndex { let n = s.index(i, offsetBy: 2); d.append(UInt8(s[i..<n], radix: 16)!); i = n }
        return d
    }
    private func hexOf(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

    func test_crossPlatformVector() throws {
        let builderPriv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(builderPrivHex))
        let phonePriv  = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(phonePrivHex))

        // Public keys derived by CryptoKit must match Node's.
        XCTAssertEqual(Base64URLBuilder.encode(builderPriv.publicKey.rawRepresentation), builderPubB64u)
        XCTAssertEqual(Base64URLBuilder.encode(phonePriv.publicKey.rawRepresentation), phonePubB64u)

        // Builder derives SAS + AEAD key from ECDH(builderPriv, phonePub).
        let phonePub = Base64URLBuilder.decode(phonePubB64u)!
        let mat = try BuilderPairing.deriveMaterial(builderPrivateKey: builderPriv, phonePublicKey: phonePub)
        XCTAssertEqual(mat.matchCode, expectedSas)
        let keyHex = mat.aeadKey.withUnsafeBytes { hexOf(Data($0)) }
        XCTAssertEqual(keyHex, encKeyHex)
    }

    func test_sessionIdAndShortCodeVector() {
        let code = hex(codeBytesHex)
        XCTAssertEqual(BuilderPairing.humanCode(fromBytes: code), expectedHuman)
        XCTAssertEqual(BuilderPairing.sessionId(forCodeBytes: code), expectedSid)
        XCTAssertEqual(BuilderPairing.formatHumanCode(expectedHuman), "AEBA-GBAF")
    }

    func test_shortCodeRoundTripTolerant() {
        let code = BuilderPairing.newCodeBytes()
        let human = BuilderPairing.humanCode(fromBytes: code)
        // Lowercase, spaced, dashed all decode back to the same bytes.
        XCTAssertEqual(BuilderPairing.codeBytes(fromHumanCode: human), code)
        XCTAssertEqual(BuilderPairing.codeBytes(fromHumanCode: human.lowercased()), code)
        let dashed = BuilderPairing.formatHumanCode(human)
        XCTAssertEqual(BuilderPairing.codeBytes(fromHumanCode: dashed), code)
        XCTAssertNil(BuilderPairing.codeBytes(fromHumanCode: "nope!!!"))
    }

    func test_qrPayloadFormat() throws {
        let builderPriv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(builderPrivHex))
        let payload = BuilderPairing.qrPayload(humanCode: expectedHuman,
                                              builderPublicKey: builderPriv.publicKey.rawRepresentation)
        XCTAssertEqual(payload, "flagship://builder?c=\(expectedHuman)&k=\(builderPubB64u)")
    }

    /// End-to-end interop: a simulated phone derives the same key, seals a
    /// payload exactly like `QrRelay.seal` (ct||tag + separate 12-byte
    /// nonce), and the builder opens it.
    func test_sealOpenInterop() throws {
        let builderPriv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(builderPrivHex))
        let phonePriv  = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(phonePrivHex))

        // Phone side derives from ECDH(phonePriv, builderPub) — same key.
        let phoneMat = try BuilderPairing.deriveMaterial(
            builderPrivateKey: phonePriv,
            phonePublicKey: builderPriv.publicKey.rawRepresentation)

        let plaintext = Data("{\"hello\":\"recipe\"}".utf8)
        let nonceBytes = Data((0..<12).map { _ in UInt8.random(in: 0...255) })
        let sealed = try AES.GCM.seal(plaintext, using: phoneMat.aeadKey,
                                      nonce: try AES.GCM.Nonce(data: nonceBytes))
        let ct = sealed.ciphertext + sealed.tag

        let opened = try BuilderPairing.open(
            ciphertextBase64Url: Base64URLBuilder.encode(ct),
            nonceBase64Url: Base64URLBuilder.encode(nonceBytes),
            key: phoneMat.aeadKey)
        XCTAssertEqual(opened, plaintext)
    }

    // MARK: - Engine state machine

    private func engine() -> BuilderPairingEngine {
        let priv = try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(builderPrivHex))
        return BuilderPairingEngine(privateKey: priv, codeBytes: hex(codeBytesHex))
    }

    func test_engineSendsBuilderHelloWhenPhoneJoins() {
        let e = engine()
        let actions = e.onRelayFrame(["kind": "peer-joined"])
        XCTAssertEqual(actions, [.send(.builderHello(builderPubKeyB64: builderPubB64u))])
    }

    func test_recipeAcceptedFrame() {
        let json = BuilderPairingEngine.encode(.recipeAccepted)
        let object = try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: String]
        XCTAssertEqual(object, ["kind": "recipe-accepted"])
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
        let builderPub = Base64URLBuilder.decode(builderPubB64u)!
        let mat = try BuilderPairing.deriveMaterial(builderPrivateKey: phonePriv, phonePublicKey: builderPub)
        let plaintext = Data("RECIPE".utf8)
        let nonce = Data((0..<12).map { _ in UInt8.random(in: 0...255) })
        let sealed = try AES.GCM.seal(plaintext, using: mat.aeadKey, nonce: try AES.GCM.Nonce(data: nonce))
        let ct = sealed.ciphertext + sealed.tag

        let actions = e.onRelayFrame(["kind": "peer", "frame": [
            "kind": "deliver",
            "ciphertext": Base64URLBuilder.encode(ct),
            "nonce": Base64URLBuilder.encode(nonce),
        ]])
        XCTAssertEqual(actions, [.recipe(plaintext)])
    }

    func test_enginePeerGoneBeforePairingKeepsQrLive() {
        let e = engine()
        XCTAssertEqual(e.onRelayFrame(["kind": "peer-gone"]), [])
        XCTAssertEqual(e.stage, .waitingForPhone)
    }

    func test_engineResumesConfirmedSessionForSamePhone() {
        let e = engine()
        _ = e.onRelayFrame(["kind": "peer", "frame": ["kind": "phone-hello", "phonePk": phonePubB64u]])
        _ = e.onRelayFrame(["kind": "peer", "frame": ["kind": "confirm-pairing"]])
        XCTAssertEqual(e.onRelayFrame(["kind": "peer-gone"]), [.stage(.reconnecting)])
        XCTAssertEqual(e.onRelayFrame(["kind": "peer", "frame": ["kind": "phone-hello", "phonePk": phonePubB64u]]), [.stage(.paired)])
    }

    func test_engineEndsOnExpired() {
        let e = engine()
        let actions = e.onRelayFrame(["kind": "expired"])
        guard actions.count == 1, case .stage(.ended) = actions[0] else {
            return XCTFail("expected ended stage, got \(actions)")
        }
    }

    // MARK: - Session-end policy (model behaviour via the shared seam)

    /// A DELIVERED recipe survives a terminal `.ended` (e.g. expiry): the one-shot
    /// deposit is complete and the phone may leave, so the burn UI is kept.
    func test_deliveredRecipeSurvivesSessionEnd() {
        XCTAssertEqual(SessionEndPolicy.onSessionEnded(recipeDelivered: true), .keepDeliveredRecipe)
    }

    /// An `.ended` with NO recipe yet (phone left before delivering) relocks to
    /// a fresh QR.
    func test_sessionEndWithoutRecipeRelocks() {
        XCTAssertEqual(SessionEndPolicy.onSessionEnded(recipeDelivered: false), .relock)
    }

    func test_engineExposesStableSessionIdAndQr() {
        let e = engine()
        XCTAssertEqual(e.sessionId, expectedSid)
        XCTAssertEqual(e.humanCode, expectedHuman)
        XCTAssertEqual(e.humanCodeDisplay, "AEBA-GBAF")
        XCTAssertEqual(e.publicKeyB64, builderPubB64u)
        XCTAssertTrue(e.qrPayload.hasPrefix("flagship://builder?c=\(expectedHuman)&k="))
    }
}
