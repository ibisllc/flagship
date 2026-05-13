import XCTest
import CryptoKit
@testable import Flagship

final class RecoveryTests: XCTestCase {

    func test_wrapThenUnwrap_recoversOriginalUmkSeed() throws {
        let umk = SymmetricKey(size: .bits256)
        let prf = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let env = try Recovery.wrap(umkSeed: umk, prfSecret: prf)
        let recovered = try Recovery.unwrap(
            ciphertextBase64: env.ciphertextBase64,
            nonceBase64: env.nonceBase64,
            prfSecret: prf
        )
        XCTAssertEqual(
            umk.withUnsafeBytes { Data($0) },
            recovered.withUnsafeBytes { Data($0) }
        )
    }

    func test_unwrap_failsWithWrongPrf() throws {
        let umk = SymmetricKey(size: .bits256)
        let prf = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let env = try Recovery.wrap(umkSeed: umk, prfSecret: prf)
        let wrong = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        XCTAssertThrowsError(try Recovery.unwrap(
            ciphertextBase64: env.ciphertextBase64,
            nonceBase64: env.nonceBase64,
            prfSecret: wrong
        ))
    }

    func test_unwrap_failsWithBase64Garbage() {
        let prf = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        XCTAssertThrowsError(try Recovery.unwrap(
            ciphertextBase64: "!!!not base64!!!",
            nonceBase64: "alsoNotBase64",
            prfSecret: prf
        ))
    }
}
