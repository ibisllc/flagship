import XCTest
@testable import FlagshipCore

/// Phone-side builder-pairing parse + session-id parity. The session-id +
/// short-code vector is pinned identically on the builder (apps/builder-mac
/// BuilderPairingTests) and the TS reference (apps/com builderPairingVector).
final class BuilderPairingTests: XCTestCase {

    private func hex(_ s: String) -> Data {
        var d = Data(); var i = s.startIndex
        while i < s.endIndex { let n = s.index(i, offsetBy: 2); d.append(UInt8(s[i..<n], radix: 16)!); i = n }
        return d
    }

    func test_sessionIdVector() {
        let code = hex("0102030405")
        XCTAssertEqual(BuilderPairing.sessionId(forCodeBytes: code), "F2x43pqWEQ9rjC9jLfItSh4RE0K3Izzb")
    }

    func test_base32RoundTrip() {
        XCTAssertEqual(Base32.encode(hex("0102030405")), "AEBAGBAF")
        XCTAssertEqual(Base32.decode("AEBAGBAF"), hex("0102030405"))
        XCTAssertEqual(BuilderPairing.codeBytes(fromHumanCode: "aeba-gbaf"), hex("0102030405"))
        XCTAssertNil(BuilderPairing.codeBytes(fromHumanCode: "nope!!!"))
    }

    func test_parseQrWithPubkey() throws {
        let pk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk" // 32-byte b64url
        let scanned = try BuilderPairing.parse("flagship://builder?c=AEBAGBAF&k=\(pk)")
        XCTAssertEqual(scanned.codeBytes, hex("0102030405"))
        XCTAssertNotNil(scanned.builderPublicKey)
        XCTAssertEqual(scanned.builderPublicKey?.count, 32)
    }

    func test_parseTypedCodeOnly() throws {
        let scanned = try BuilderPairing.parse("AEBA-GBAF")
        XCTAssertEqual(scanned.codeBytes, hex("0102030405"))
        XCTAssertNil(scanned.builderPublicKey)
    }

    func test_looksLikeBuilderCode() {
        XCTAssertTrue(BuilderPairing.looksLikeBuilderCode("flagship://builder?c=AEBAGBAF&k=x"))
        XCTAssertTrue(BuilderPairing.looksLikeBuilderCode("AEBAGBAF"))
        XCTAssertFalse(BuilderPairing.looksLikeBuilderCode("https://flagshipserver.com/qr?s=abc&k=def"))
    }
}
