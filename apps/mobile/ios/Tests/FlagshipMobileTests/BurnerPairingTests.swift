import XCTest
@testable import FlagshipCore

/// Phone-side burner-pairing parse + session-id parity. The session-id +
/// short-code vector is pinned identically on the burner (apps/burner-mac
/// BurnerPairingTests) and the TS reference (apps/com burnerPairingVector).
final class BurnerPairingTests: XCTestCase {

    private func hex(_ s: String) -> Data {
        var d = Data(); var i = s.startIndex
        while i < s.endIndex { let n = s.index(i, offsetBy: 2); d.append(UInt8(s[i..<n], radix: 16)!); i = n }
        return d
    }

    func test_sessionIdVector() {
        let code = hex("0102030405")
        XCTAssertEqual(BurnerPairing.sessionId(forCodeBytes: code), "KW3_KaK0uN8rcrQCLmsOJXXfhr9EEpib")
    }

    func test_base32RoundTrip() {
        XCTAssertEqual(Base32.encode(hex("0102030405")), "AEBAGBAF")
        XCTAssertEqual(Base32.decode("AEBAGBAF"), hex("0102030405"))
        XCTAssertEqual(BurnerPairing.codeBytes(fromHumanCode: "aeba-gbaf"), hex("0102030405"))
        XCTAssertNil(BurnerPairing.codeBytes(fromHumanCode: "nope!!!"))
    }

    func test_parseQrWithPubkey() throws {
        let pk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk" // 32-byte b64url
        let scanned = try BurnerPairing.parse("flagship://burner?c=AEBAGBAF&k=\(pk)")
        XCTAssertEqual(scanned.codeBytes, hex("0102030405"))
        XCTAssertNotNil(scanned.burnerPublicKey)
        XCTAssertEqual(scanned.burnerPublicKey?.count, 32)
    }

    func test_parseTypedCodeOnly() throws {
        let scanned = try BurnerPairing.parse("AEBA-GBAF")
        XCTAssertEqual(scanned.codeBytes, hex("0102030405"))
        XCTAssertNil(scanned.burnerPublicKey)
    }

    func test_looksLikeBurnerCode() {
        XCTAssertTrue(BurnerPairing.looksLikeBurnerCode("flagship://burner?c=AEBAGBAF&k=x"))
        XCTAssertTrue(BurnerPairing.looksLikeBurnerCode("AEBAGBAF"))
        XCTAssertFalse(BurnerPairing.looksLikeBurnerCode("https://flagshipserver.com/qr?s=abc&k=def"))
    }
}
