import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipCore

final class RecoveryTests: XCTestCase {

    func test_wrapThenUnwrap_recoversOriginalUmkSeed() throws {
        let umk = SymmetricKey(size: .bits256)
        let prf = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let wrapped = try Recovery.wrap(umkSeed: umk, prfSecret: prf)
        let recovered = try Recovery.unwrap(wrappedUmkBase64: wrapped, prfSecret: prf)
        XCTAssertEqual(
            umk.withUnsafeBytes { Data($0) },
            recovered.withUnsafeBytes { Data($0) }
        )
    }

    /// `wrap` returns ONE self-contained base64 blob — AES-GCM `.combined`
    /// (nonce‖ct‖tag). It must decode to a valid SealedBox and be longer
    /// than nonce(12) + tag(16) + the 32-byte plaintext.
    func test_wrap_returnsSingleSelfContainedBlob() throws {
        let umk = SymmetricKey(size: .bits256)
        let prf = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let wrapped = try Recovery.wrap(umkSeed: umk, prfSecret: prf)
        let combined = try XCTUnwrap(Data(base64Encoded: wrapped))
        // 12 (nonce) + 32 (ciphertext for a 32-byte plaintext) + 16 (tag).
        XCTAssertEqual(combined.count, 12 + 32 + 16)
        XCTAssertNoThrow(try AES.GCM.SealedBox(combined: combined))
    }

    func test_unwrap_failsWithWrongPrf() throws {
        let umk = SymmetricKey(size: .bits256)
        let prf = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let wrapped = try Recovery.wrap(umkSeed: umk, prfSecret: prf)
        let wrong = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        XCTAssertThrowsError(try Recovery.unwrap(wrappedUmkBase64: wrapped, prfSecret: wrong))
    }

    func test_unwrap_failsWithBase64Garbage() {
        let prf = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        XCTAssertThrowsError(
            try Recovery.unwrap(wrappedUmkBase64: "!!!not base64!!!", prfSecret: prf)
        )
    }
}
