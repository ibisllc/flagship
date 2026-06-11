import XCTest
import CryptoKit
@testable import FlagshipCore

/// Swift mirror of `packages/protocol/tests/canonicalBytesVectors.test.ts`
/// (pair / box-unpair / wifi-config subset). Also exercises the local
/// sign/verify and seal/open round-trips, plus determinism of K_session
/// + SAS, since the cross-language fixture only pins canonical bytes
/// + signatures (no recorded K_session/SAS values yet).
final class NfcPairTests: XCTestCase {

    // MARK: - Round-trip: PAIR sign/verify

    func test_signPair_verifyPair_roundTrip() throws {
        let stk = Curve25519.Signing.PrivateKey()
        let eBox = Curve25519.KeyAgreement.PrivateKey()
        let payload = PairPayload(
            stkPub: stk.publicKey.rawRepresentation,
            eBoxPub: eBox.publicKey.rawRepresentation,
            nonce: Data(repeating: 0x11, count: 16),
            sessionId: Data(repeating: 0x05, count: 16),
            hint: PairHint(
                mdnsName: "flagship-abcdef.local",
                cloudRendezvousId: "rndz-abcdef",
                suffix6: "abcdef"
            )
        )
        let sig = try signPair(payload, stk: stk)
        XCTAssertTrue(verifyPair(payload, signature: sig))

        // Wrong key: substitute stkPub with a different identity → verify must fail.
        let otherStk = Curve25519.Signing.PrivateKey()
        var tampered = payload
        tampered.stkPub = otherStk.publicKey.rawRepresentation
        XCTAssertFalse(verifyPair(tampered, signature: sig),
                       "verify must fail when stkPub is swapped")

        // Tampered payload (same key, different content) → verify must fail.
        var altered = payload
        altered.nonce = Data(repeating: 0x22, count: 16)
        XCTAssertFalse(verifyPair(altered, signature: sig),
                       "verify must fail when nonce is altered under the same key")
    }

    // MARK: - Round-trip: BoxUnpair sign/verify

    func test_signBoxUnpair_verifyBoxUnpair_roundTrip() throws {
        let irk = Curve25519.Signing.PrivateKey()
        let u = BoxUnpair(
            userId: "harry",
            boxId: "b927c2d0bf0e6d27010d32bba280743e8fc4c6dec0b1702ddc7cd6be27cd078d",
            issuedAt: 1_735_689_600_000
        )
        let sig = try signBoxUnpair(u, irk: irk)
        XCTAssertTrue(verifyBoxUnpair(u, signature: sig, irkPub: irk.publicKey.rawRepresentation))

        let otherIrk = Curve25519.Signing.PrivateKey()
        XCTAssertFalse(verifyBoxUnpair(u, signature: sig, irkPub: otherIrk.publicKey.rawRepresentation),
                       "verify must fail under wrong IRK pubkey")

        var altered = u
        altered.userId = "sarah"
        XCTAssertFalse(verifyBoxUnpair(altered, signature: sig, irkPub: irk.publicKey.rawRepresentation),
                       "verify must fail when canonical-bytes input is altered")
    }

    // MARK: - Round-trip: WiFiConfig seal/open

    func test_sealWiFiConfig_openWiFiConfig_roundTrip() throws {
        let k = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        let w = WiFiConfig(
            ssid: "Home",
            psk: "correct-horse-battery-staple",
            regulatoryRegion: "US",
            issuedAt: 1_735_689_600_000
        )
        let sealed = try sealWiFiConfig(w, kSession: k)
        XCTAssertEqual(sealed.nonce.count, 12, "AES-GCM nonce MUST be 12 bytes")
        let opened = try openWiFiConfig(sealed, kSession: k)
        XCTAssertEqual(opened, w)

        // Wrong key: open MUST throw (CryptoKit AES-GCM auth failure).
        let wrongKey = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        XCTAssertThrowsError(try openWiFiConfig(sealed, kSession: wrongKey),
                             "open with wrong key must throw")
    }

    func test_sealWiFiConfig_rejects_wrongSizeKey() throws {
        let k = Data(repeating: 0xAA, count: 16) // half-size
        let w = WiFiConfig(ssid: "x", psk: "y", regulatoryRegion: "US", issuedAt: 1)
        XCTAssertThrowsError(try sealWiFiConfig(w, kSession: k)) { err in
            XCTAssertEqual(err as? NfcPairError, .kSessionWrongSize)
        }
    }

    // MARK: - HKDF determinism

    func test_deriveSessionKey_and_SAS_areDeterministic() {
        let ss = Data(repeating: 0x42, count: 32)
        let stkPub = Data(repeating: 0x01, count: 32)
        let eBoxPub = Data(repeating: 0x02, count: 32)
        let ePhonePub = Data(repeating: 0x03, count: 32)
        let nonce = Data(repeating: 0x04, count: 16)
        let sessionId = Data(repeating: 0x05, count: 16)

        let k1 = deriveSessionKey(
            sharedSecret: ss, stkPub: stkPub, eBoxPub: eBoxPub,
            ePhonePub: ePhonePub, nonce: nonce, sessionId: sessionId
        )
        let k2 = deriveSessionKey(
            sharedSecret: ss, stkPub: stkPub, eBoxPub: eBoxPub,
            ePhonePub: ePhonePub, nonce: nonce, sessionId: sessionId
        )
        XCTAssertEqual(k1, k2, "K_session must be deterministic for identical inputs")
        XCTAssertEqual(k1.count, 32)

        let s1 = deriveSAS(
            sharedSecret: ss, stkPub: stkPub, eBoxPub: eBoxPub,
            ePhonePub: ePhonePub, nonce: nonce, sessionId: sessionId
        )
        let s2 = deriveSAS(
            sharedSecret: ss, stkPub: stkPub, eBoxPub: eBoxPub,
            ePhonePub: ePhonePub, nonce: nonce, sessionId: sessionId
        )
        XCTAssertEqual(s1, s2, "SAS must be deterministic for identical inputs")
        XCTAssertEqual(s1.count, 4)

        // Different transcript inputs must yield different keys.
        let kDiff = deriveSessionKey(
            sharedSecret: ss, stkPub: stkPub, eBoxPub: eBoxPub,
            ePhonePub: Data(repeating: 0x99, count: 32),
            nonce: nonce, sessionId: sessionId
        )
        XCTAssertNotEqual(k1, kDiff, "K_session must change when transcript changes")
    }

    // MARK: - End-to-end: phone+box ECDH agrees on K_session + SAS

    func test_endToEnd_phoneAndBox_deriveSameKeyAndSAS() throws {
        // Box side: STK + box ephemeral X25519.
        let stk = Curve25519.Signing.PrivateKey()
        let eBox = Curve25519.KeyAgreement.PrivateKey()
        // Phone side: phone ephemeral X25519.
        let ePhone = Curve25519.KeyAgreement.PrivateKey()

        let nonce = Data((0..<16).map { _ in UInt8.random(in: 0...255) })
        let sessionId = Data((0..<16).map { _ in UInt8.random(in: 0...255) })

        let payload = PairPayload(
            stkPub: stk.publicKey.rawRepresentation,
            eBoxPub: eBox.publicKey.rawRepresentation,
            nonce: nonce,
            sessionId: sessionId,
            hint: PairHint(mdnsName: "x.local", cloudRendezvousId: "rndz-x", suffix6: "abcdef")
        )
        let sig = try signPair(payload, stk: stk)
        XCTAssertTrue(verifyPair(payload, signature: sig))

        // Phone derives ss from (ePhonePriv, eBoxPub).
        let ssPhone = try deriveSharedSecret(ePhonePriv: ePhone, eBoxPub: payload.eBoxPub)
        // Box derives ss from (eBoxPriv, ePhonePub) — must match.
        let ssBox = try deriveSharedSecret(ePhonePriv: eBox, eBoxPub: ePhone.publicKey.rawRepresentation)
        XCTAssertEqual(ssPhone, ssBox, "X25519 ECDH must agree on the shared secret")

        let kPhone = deriveSessionKey(
            sharedSecret: ssPhone,
            stkPub: payload.stkPub,
            eBoxPub: payload.eBoxPub,
            ePhonePub: ePhone.publicKey.rawRepresentation,
            nonce: payload.nonce,
            sessionId: payload.sessionId
        )
        let kBox = deriveSessionKey(
            sharedSecret: ssBox,
            stkPub: payload.stkPub,
            eBoxPub: payload.eBoxPub,
            ePhonePub: ePhone.publicKey.rawRepresentation,
            nonce: payload.nonce,
            sessionId: payload.sessionId
        )
        XCTAssertEqual(kPhone, kBox, "K_session must agree across phone + box")

        let sasPhone = deriveSAS(
            sharedSecret: ssPhone,
            stkPub: payload.stkPub,
            eBoxPub: payload.eBoxPub,
            ePhonePub: ePhone.publicKey.rawRepresentation,
            nonce: payload.nonce,
            sessionId: payload.sessionId
        )
        let sasBox = deriveSAS(
            sharedSecret: ssBox,
            stkPub: payload.stkPub,
            eBoxPub: payload.eBoxPub,
            ePhonePub: ePhone.publicKey.rawRepresentation,
            nonce: payload.nonce,
            sessionId: payload.sessionId
        )
        XCTAssertEqual(sasPhone, sasBox, "SAS must agree across phone + box")
    }

    // MARK: - stkPubToSuffix6

    func test_stkPubToSuffix6_lastSixHexChars() {
        // From the fixture: stkPubHex ends in "...cd078d" → suffix6 = "cd078d".
        let stkPub = NfcPairHex.decode(
            "b927c2d0bf0e6d27010d32bba280743e8fc4c6dec0b1702ddc7cd6be27cd078d"
        )
        XCTAssertEqual(stkPubToSuffix6(stkPub), "cd078d")
    }

    // MARK: - LED-SAS encoder

    func test_encodeLedSas_consumesFirst18Bits() throws {
        // Two zero bytes → 9 pulses all "R" (symbol 0).
        let zeros = Data(repeating: 0x00, count: 4)
        XCTAssertEqual(try encodeLedSas(zeros), String(repeating: "R", count: 9))

        // Not enough bytes — needs ceil(18/8)=3 bytes minimum.
        let short = Data([0xFF, 0xFF])
        XCTAssertThrowsError(try encodeLedSas(short))
    }

    // MARK: - Cross-language golden vectors

    /// Walk up from the test source file until we find the repo's
    /// `test-vectors/canonical-bytes.json`. Using `#filePath` keeps this
    /// portable across `xcodebuild` and Xcode's local-derived-data layout —
    /// both surface the source file's absolute path, and from there it's
    /// always 4 directories up to the repo root.
    private func loadVectorsJSON(file: StaticString = #filePath) throws -> [String: Any] {
        let testSrc = URL(fileURLWithPath: "\(file)")
        // .../apps/mobile/ios/Tests/FlagshipMobileTests/NfcPairTests.swift
        // deletingLastPathComponent six times peels off the filename + 5
        // dir levels (FlagshipMobileTests, Tests, ios, mobile, apps) →
        // repo root.
        var root = testSrc
        for _ in 0..<6 { root = root.deletingLastPathComponent() }
        let vectorsURL = root
            .appendingPathComponent("test-vectors")
            .appendingPathComponent("canonical-bytes.json")
        let data = try Data(contentsOf: vectorsURL)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "NfcPairTests", code: -1, userInfo: [
                NSLocalizedDescriptionKey: "vectors JSON is not an object"
            ])
        }
        return json
    }

    private func findVector(_ json: [String: Any], named: String) -> [String: Any]? {
        guard let vectors = json["vectors"] as? [[String: Any]] else { return nil }
        return vectors.first { ($0["name"] as? String) == named }
    }

    func test_goldenVector_pair_verifies() throws {
        let json = try loadVectorsJSON()
        guard let v = findVector(json, named: "pair") else {
            return XCTFail("pair vector missing from canonical-bytes.json")
        }
        guard let input = v["input"] as? [String: Any],
              let sigHex = v["signatureHex"] as? String,
              let hintDict = input["hint"] as? [String: Any]
        else { return XCTFail("malformed pair vector") }

        let payload = PairPayload(
            v: (input["v"] as? Int) ?? PAIR_PROTOCOL_VERSION,
            stkPub: NfcPairHex.decode((input["stkPub"] as? String) ?? ""),
            eBoxPub: NfcPairHex.decode((input["eBoxPub"] as? String) ?? ""),
            nonce: NfcPairHex.decode((input["nonce"] as? String) ?? ""),
            sessionId: NfcPairHex.decode((input["sessionId"] as? String) ?? ""),
            hint: PairHint(
                mdnsName: (hintDict["mdnsName"] as? String) ?? "",
                cloudRendezvousId: (hintDict["cloudRendezvousId"] as? String) ?? "",
                suffix6: (hintDict["suffix6"] as? String) ?? ""
            )
        )
        // Canonical bytes are non-empty + even-length hex (belt-and-
        // suspenders against an encoder regression that happens to still
        // verify against a recorded sig).
        let canonHex = NfcPairHex.encode(canonicalPair(payload))
        XCTAssertFalse(canonHex.isEmpty)
        XCTAssertEqual(canonHex.count % 2, 0)

        let sig = NfcPairHex.decode(sigHex)
        XCTAssertTrue(verifyPair(payload, signature: sig),
                      "recorded pair signature must verify against Swift canonical bytes")
    }

    func test_goldenVector_boxUnpair_verifies() throws {
        let json = try loadVectorsJSON()
        guard let metadata = json["metadata"] as? [String: Any],
              let irkPubHex = metadata["irkPubHex"] as? String
        else { return XCTFail("metadata.irkPubHex missing") }
        guard let v = findVector(json, named: "box-unpair") else {
            return XCTFail("box-unpair vector missing from canonical-bytes.json")
        }
        guard let input = v["input"] as? [String: Any],
              let sigHex = v["signatureHex"] as? String
        else { return XCTFail("malformed box-unpair vector") }

        // The fixture stores issuedAt as a JSON number; bridge to Int64.
        let issuedAt: Int64
        if let n = input["issuedAt"] as? Int64 { issuedAt = n }
        else if let n = input["issuedAt"] as? Int { issuedAt = Int64(n) }
        else if let n = input["issuedAt"] as? Double { issuedAt = Int64(n) }
        else { return XCTFail("issuedAt not coerce-able to Int64") }

        let u = BoxUnpair(
            userId: (input["userId"] as? String) ?? "",
            boxId: (input["boxId"] as? String) ?? "",
            issuedAt: issuedAt
        )
        let sig = NfcPairHex.decode(sigHex)
        let irkPub = NfcPairHex.decode(irkPubHex)
        XCTAssertTrue(verifyBoxUnpair(u, signature: sig, irkPub: irkPub),
                      "recorded box-unpair signature must verify against Swift canonical bytes")
    }

    func test_goldenVector_wifiConfig_canonicalBytes_matchRecordedHex() throws {
        let json = try loadVectorsJSON()
        guard let v = findVector(json, named: "wifi-config") else {
            return XCTFail("wifi-config vector missing from canonical-bytes.json")
        }
        guard let input = v["input"] as? [String: Any],
              let recordedHex = v["canonicalHex"] as? String
        else { return XCTFail("malformed wifi-config vector") }

        let issuedAt: Int64
        if let n = input["issuedAt"] as? Int64 { issuedAt = n }
        else if let n = input["issuedAt"] as? Int { issuedAt = Int64(n) }
        else if let n = input["issuedAt"] as? Double { issuedAt = Int64(n) }
        else { return XCTFail("issuedAt not coerce-able to Int64") }

        let w = WiFiConfig(
            ssid: (input["ssid"] as? String) ?? "",
            psk: (input["psk"] as? String) ?? "",
            regulatoryRegion: (input["regulatoryRegion"] as? String) ?? "",
            issuedAt: issuedAt
        )
        let canonHex = NfcPairHex.encode(canonicalWiFiConfig(w))
        XCTAssertEqual(canonHex, recordedHex,
                       "Swift canonicalWiFiConfig must byte-match recorded canonicalHex")
    }

    // MARK: - Session-lock constant (design refinement §1)

    func test_pairSessionLockMs_isThirtySeconds() {
        // Mirrors PAIR_SESSION_LOCK_MS in @flagship/protocol — the box
        // rolls keys 30 s after a tap with no claim.
        XCTAssertEqual(PAIR_SESSION_LOCK_MS, 30_000)
    }

    // MARK: - WiFi deposit blob (ePhonePub || ciphertext)

    func test_wifiDepositBlob_roundTrips() throws {
        let phone = Curve25519.KeyAgreement.PrivateKey()
        let ePhonePub = phone.publicKey.rawRepresentation
        let kSession = Data(repeating: 0x42, count: 32)
        let sealed = try sealWiFiConfig(
            WiFiConfig(ssid: "HomeNet", psk: "hunter22", regulatoryRegion: "US", issuedAt: 1_718_000_000_000),
            kSession: kSession
        )
        let blob = try buildWifiDepositBlob(ePhonePub: ePhonePub, sealed: sealed)
        XCTAssertEqual(blob.count, 32 + sealed.ciphertext.count)

        let parsed = try parseWifiDepositBlob(blob)
        XCTAssertEqual(parsed.ePhonePub, ePhonePub)
        XCTAssertEqual(parsed.ciphertext, sealed.ciphertext)

        let opened = try openWiFiConfig(
            SealedWiFiConfig(ciphertext: parsed.ciphertext, nonce: sealed.nonce),
            kSession: kSession
        )
        XCTAssertEqual(opened.ssid, "HomeNet")
    }

    func test_wifiDepositBlob_rejectsWrongSizePub_andShortBlob() throws {
        let sealed = try sealWiFiConfig(
            WiFiConfig(ssid: "x", psk: "", regulatoryRegion: "", issuedAt: 1),
            kSession: Data(repeating: 0, count: 32)
        )
        XCTAssertThrowsError(
            try buildWifiDepositBlob(ePhonePub: Data(repeating: 1, count: 31), sealed: sealed)
        )
        // 47 bytes can't carry pub(32) + AEAD tag(16) — a foreign or
        // truncated deposit dies before any key derivation runs.
        XCTAssertThrowsError(try parseWifiDepositBlob(Data(repeating: 0, count: 47)))
        XCTAssertThrowsError(try parseWifiDepositBlob(Data()))
    }
}
