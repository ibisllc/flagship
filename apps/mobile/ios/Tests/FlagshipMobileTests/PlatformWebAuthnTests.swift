import XCTest
import Foundation
@testable import FlagshipUI
@testable import FlagshipAPI

@MainActor
final class PlatformWebAuthnTests: XCTestCase {

    func test_register_yieldsStableCredentialIdAcrossCalls() async throws {
        let provider = PlatformWebAuthnProvider()
        let first = try await provider.register()
        let second = try await provider.register()
        // identifierForVendor is stable per install, so credentialID
        // derivation must be stable too.
        XCTAssertEqual(first.credentialId, second.credentialId)
    }

    /// #2 — the registered credentialId is emitted as lowercase HEX so it
    /// satisfies the Worker's ^[0-9a-fA-F]{16,512}$ on the wire.
    func test_register_credentialIdIsLowercaseHex() async throws {
        let provider = PlatformWebAuthnProvider()
        let reg = try await provider.register()
        XCTAssertGreaterThanOrEqual(reg.credentialId.count, 16)
        XCTAssertEqual(reg.credentialId.count % 2, 0)
        XCTAssertTrue(reg.credentialId.allSatisfy { $0.isHexDigit })
        XCTAssertEqual(reg.credentialId, reg.credentialId.lowercased())
    }

    func test_prfAssert_isDeterministicForSameCredential() async throws {
        let provider = PlatformWebAuthnProvider()
        let a = try await provider.prfAssert(credentialId: "cred-x")
        let b = try await provider.prfAssert(credentialId: "cred-x")
        XCTAssertEqual(a, b, "PRF must round-trip the same secret per credential.")
        XCTAssertEqual(a.count, 32)
    }

    func test_prfAssert_differsBetweenCredentials() async throws {
        let provider = PlatformWebAuthnProvider()
        let a = try await provider.prfAssert(credentialId: "cred-a")
        let b = try await provider.prfAssert(credentialId: "cred-b")
        XCTAssertNotEqual(a, b)
    }

    /// #4 — the prfSalt input actually changes the (dev stand-in) PRF
    /// output, so a passphrase-derived salt binds the wrap key.
    func test_prfAssert_differsBetweenSalts() async throws {
        let provider = PlatformWebAuthnProvider()
        let a = try await provider.prfAssert(credentialId: "cred-x", prfSalt: Data(repeating: 1, count: 32))
        let b = try await provider.prfAssert(credentialId: "cred-x", prfSalt: Data(repeating: 2, count: 32))
        XCTAssertNotEqual(a, b)
    }
}
