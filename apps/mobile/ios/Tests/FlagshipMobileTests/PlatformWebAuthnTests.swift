import XCTest
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
}
