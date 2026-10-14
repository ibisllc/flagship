import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the phone's CGK derivation to the cross-platform vector
/// (`packages/protocol/tests/cloudGossipVectors.test.ts`, Kotlin
/// `CloudGossipVectorTest.kt`): a drift here breaks every box's gossip.
final class CloudGossipCanonicalTests: XCTestCase {
    private func str(_ d: Data) -> String { String(data: d, encoding: .utf8)! }
    private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

    // MARK: 1. CGK
    func testCGKPinnedVector() {
        let seed = Data(repeating: 0x07, count: 32)
        let cgk = CloudGossip.deriveCGK(umkSeed: seed)
        XCTAssertNotNil(cgk)
        XCTAssertEqual(
            hex(cgk!),
            "1d8e3bc393a91de22edec0b862a0539856bdc73b42ab60a26d7d51fbb091badd"
        )
    }

    func testCGKRejectsNon32() {
        XCTAssertNil(CloudGossip.deriveCGK(umkSeed: Data(repeating: 0x07, count: 31)))
    }
}
