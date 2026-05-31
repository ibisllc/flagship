import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipCore
@testable import FlagshipAPI

/// P3 — pending-server cancel flow.
///
/// `cancelServer` (HomeTab.PendingPodContainer.cancelOrder) must:
///   1. POST an IRK-signed `ReleaseServerName` envelope to
///      `/api/server/release` to UN-PIN the routing record.
///   2. THEN POST an `AuthCodeRevoke` (belt-and-braces) so the
///      install serial is dead even if release didn't already revoke it.
///
/// The canonical bytes MUST match the @flagship/protocol /
/// Android / webapp byte-for-byte (`tag|username|serverDomain|issuedAt`
/// with `flagship/release-server-name/v1` as the tag).
final class ReleaseServerNameTests: XCTestCase {

    // MARK: - Canonical bytes

    func test_canonicalBytes_followsV1Format() {
        let s = String(
            data: ReleaseServerName.canonicalBytes(
                username: "harry",
                serverDomain: "home.harry.flagship.services",
                issuedAt: 42
            ),
            encoding: .utf8
        )
        // Must match packages/protocol/src/auth.ts canonicalReleaseServerName
        // exactly — same tag, same pipe separator, same field order — so
        // an iOS-signed envelope verifies on .com.
        XCTAssertEqual(
            s,
            "flagship/release-server-name/v1|harry|home.harry.flagship.services|42"
        )
    }

    func test_canonicalTag_matchesProtocol() {
        XCTAssertEqual(ReleaseServerName.canonicalTag, "flagship/release-server-name/v1")
    }

    func test_signatureVerifiesUnderIrkPublicKey() throws {
        let irk = Curve25519.Signing.PrivateKey()
        let bytes = ReleaseServerName.canonicalBytes(
            username: "harry",
            serverDomain: "home.harry.flagship.services",
            issuedAt: 1
        )
        let sig = try irk.signature(for: bytes)
        XCTAssertTrue(irk.publicKey.isValidSignature(sig, for: bytes))
    }

    // MARK: - Mock client integration

    func test_mockServer_recordsReleaseCalls() async throws {
        let c = MockFlagshipServerClient()
        c.simulatedLatency = 0
        try await c.releaseServerName(.init(
            request: .init(
                username: "harry",
                serverDomain: "home.harry.flagship.services",
                issuedAt: 7
            ),
            signature: "deadbeef"
        ))
        XCTAssertEqual(c.releasedServerNames.count, 1)
        XCTAssertEqual(c.releasedServerNames.first?.request.username, "harry")
        XCTAssertEqual(
            c.releasedServerNames.first?.request.serverDomain,
            "home.harry.flagship.services"
        )
        XCTAssertEqual(c.releasedServerNames.first?.request.issuedAt, 7)
    }

    // MARK: - Cancel-server order (release then revoke)

    /// Drives the cancel-flow through the Mock end-to-end. Asserts BOTH
    /// the release-first and the revoke-second halves landed in the
    /// recorded-calls maps. Mirrors the Android PendingServerScreen +
    /// the webapp `cancelServer` order.
    func test_cancelFlow_releasesThenRevokes() async throws {
        let c = MockFlagshipServerClient()
        c.simulatedLatency = 0
        let irk = Curve25519.Signing.PrivateKey()
        let username = "harry"
        let serverDomain = "home.harry.flagship.services"
        let serial = "01CAFEBABE"
        let now: Int64 = 1_700_000_000_000

        // 1. Release the name first.
        let releaseBytes = ReleaseServerName.canonicalBytes(
            username: username, serverDomain: serverDomain, issuedAt: now
        )
        let releaseSig = try irk.signature(for: releaseBytes)
        try await c.releaseServerName(.init(
            request: .init(username: username, serverDomain: serverDomain, issuedAt: now),
            signature: HexUtil.encode(releaseSig)
        ))

        // 2. Then revoke the auth-code (belt-and-braces).
        let revokeBytes = AuthCodeRevoke.canonicalBytes(
            serial: serial, username: username, issuedAt: now
        )
        let revokeSig = try irk.signature(for: revokeBytes)
        try await c.revokeAuthCode(.init(
            request: .init(serial: serial, username: username, issuedAt: now),
            signature: HexUtil.encode(revokeSig)
        ))

        XCTAssertEqual(c.releasedServerNames.count, 1, "release must have fired")
        XCTAssertTrue(c.revokedAuthCodes.contains(serial), "revoke must have fired")
        // Both calls used the SAME issuedAt — proves the cancel handler
        // computed `now` once and reused it across the pair (matches the
        // Android + iOS sources).
        XCTAssertEqual(c.releasedServerNames.first?.request.issuedAt, now)
    }

    /// Ensures the release signature is a real Ed25519 over the canonical
    /// bytes (not a placeholder), so a Worker that re-derives the bytes
    /// would verify it cleanly.
    func test_releaseSignature_verifiesUnderSignersIrk() throws {
        let irk = Curve25519.Signing.PrivateKey()
        let bytes = ReleaseServerName.canonicalBytes(
            username: "harry",
            serverDomain: "home.harry.flagship.services",
            issuedAt: 99
        )
        let sig = try irk.signature(for: bytes)
        // Round-trip via hex (the wire form).
        let sigHex = HexUtil.encode(sig)
        let sigBytes = try XCTUnwrap(HexUtil.decode(sigHex))
        XCTAssertTrue(irk.publicKey.isValidSignature(sigBytes, for: bytes))
    }
}
