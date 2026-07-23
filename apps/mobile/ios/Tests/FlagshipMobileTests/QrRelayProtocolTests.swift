import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipCore

final class QrRelayProtocolTests: XCTestCase {

    // MARK: - URL parsing

    func test_parsesCanonicalHttpsUrl() throws {
        let url = "https://flagshipserver.com/qr?s=abc123&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        let s = try QrRelay.parseQrUrl(url)
        XCTAssertEqual(s.sid, "abc123")
        XCTAssertEqual(s.browserPublicKey.count, 32)
    }

    func test_parsesFlagshipDeepLinkForm() throws {
        let url = "flagship://qr?s=xyz789&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        let s = try QrRelay.parseQrUrl(url)
        XCTAssertEqual(s.sid, "xyz789")
    }

    func test_parsesRawQueryFragment() throws {
        let s = try QrRelay.parseQrUrl("s=plain&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        XCTAssertEqual(s.sid, "plain")
    }

    func test_rejectsUrlWithoutSidOrKey() {
        XCTAssertThrowsError(try QrRelay.parseQrUrl("https://flagshipserver.com/qr?x=1"))
        XCTAssertThrowsError(try QrRelay.parseQrUrl(""))
    }

    // MARK: - Demo QR (mock / UI-testing)

    func test_makeDemoQrUrlRoundTripsThroughParse() throws {
        // The mock-mode "Use a demo QR" affordance must produce a URL the real
        // flow accepts (a fresh 32-byte browser key + a non-empty sid), so the
        // full create-server flow runs against the mock backend.
        let url = QrRelay.makeDemoQrUrl()
        XCTAssertTrue(url.hasPrefix("https://flagshipserver.com/qr?s="))
        let s = try QrRelay.parseQrUrl(url)
        XCTAssertFalse(s.sid.isEmpty)
        XCTAssertEqual(s.browserPublicKey.count, 32)
        // Distinct each call (fresh ephemeral key + random sid).
        XCTAssertNotEqual(QrRelay.makeDemoQrUrl(), QrRelay.makeDemoQrUrl())
    }

    func test_demoQrDerivesAMatchCode() throws {
        // It must also drive the local X25519 derivation (the match page).
        let s = try QrRelay.parseQrUrl(QrRelay.makeDemoQrUrl())
        let phoneSk = Curve25519.KeyAgreement.PrivateKey()
        let m = try QrRelay.deriveMaterial(phonePrivateKey: phoneSk, browserPublicKey: s.browserPublicKey)
        XCTAssertEqual(m.matchCode.count, 6)
    }

    func test_rejectsKeyOfWrongLength() {
        XCTAssertThrowsError(try QrRelay.parseQrUrl("s=a&k=AAAA"))
    }

    // MARK: - Crypto round-trip

    func test_phoneAndBrowserDeriveTheSameMatchCodeAndAeadKey() throws {
        let browserSk = Curve25519.KeyAgreement.PrivateKey()
        let phoneSk = Curve25519.KeyAgreement.PrivateKey()

        let phoneDerived = try QrRelay.deriveMaterial(
            phonePrivateKey: phoneSk,
            browserPublicKey: browserSk.publicKey.rawRepresentation
        )

        // The browser does the symmetric derivation against the phone's pubkey.
        let phonePub = phoneSk.publicKey
        let sharedFromBrowser = try browserSk.sharedSecretFromKeyAgreement(with: phonePub)
        let browserAeadKey = sharedFromBrowser.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: QrRelay.relayHkdfSalt,
            sharedInfo: QrRelay.encInfo,
            outputByteCount: 32
        )
        let browserSasBytes = sharedFromBrowser.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: QrRelay.relayHkdfSalt,
            sharedInfo: QrRelay.sasInfo,
            outputByteCount: 4
        ).withUnsafeBytes { Data($0) }
        let u32 = UInt32(browserSasBytes[0]) << 24
               | UInt32(browserSasBytes[1]) << 16
               | UInt32(browserSasBytes[2]) << 8
               | UInt32(browserSasBytes[3])
        let browserMatch = String(format: "%06d", u32 % 1_000_000)

        XCTAssertEqual(phoneDerived.matchCode, browserMatch)
        XCTAssertEqual(
            phoneDerived.aeadKey.withUnsafeBytes { Data($0) },
            browserAeadKey.withUnsafeBytes { Data($0) }
        )
    }

    func test_sealRoundTripDecryptsUnderTheSameKey() throws {
        let key = SymmetricKey(size: .bits256)
        let payload = Data("flagship/install-blob/v1|…".utf8)
        let sealed = try QrRelay.seal(payload: payload, with: key)

        // Reverse the seal exactly the way the browser pairing relay does it.
        let nonceBytes = Base64URL.decode(sealed.nonceBase64Url)!
        let ct = Base64URL.decode(sealed.ciphertextBase64Url)!
        let box = try AES.GCM.SealedBox(combined: nonceBytes + ct)
        let opened = try AES.GCM.open(box, using: key)
        XCTAssertEqual(opened, payload)
    }

    func test_formatMatchCodeInsertsSpaceAfterThreeDigits() {
        XCTAssertEqual(QrRelay.formatMatchCode("123456"), "123 456")
        XCTAssertEqual(QrRelay.formatMatchCode("000007"), "000 007")
    }

    // MARK: - base64url

    func test_base64UrlRoundTrip() {
        let raw = Data((0..<33).map { UInt8($0) })
        let s = Base64URL.encode(raw)
        XCTAssertFalse(s.contains("+"))
        XCTAssertFalse(s.contains("/"))
        XCTAssertFalse(s.contains("="))
        XCTAssertEqual(Base64URL.decode(s), raw)
    }
}
