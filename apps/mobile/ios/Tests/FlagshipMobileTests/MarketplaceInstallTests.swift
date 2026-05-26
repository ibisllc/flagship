import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import Flagship

/// P0b parity gap (audit 2026-05-26): the iOS marketplace Deploy button
/// was a stub `{}`. Wire-shape must match the webapp's `runInstall` /
/// `installFromMarketplace` in `apps/web/public/webapp/lib/installService.js`
/// byte-for-byte (same `request` fields, same canonical-bytes prefix, same
/// `{request, signature}` envelope, same daemon endpoint `<pod>/api/services`).
///
/// These tests pin:
///   - The canonical-bytes format matches the webapp's `canonicalInstallService`.
///   - The Mock records the install envelope on the wire shape the daemon expects.
///   - A successful install yields the daemon's typical response.
///   - Errors propagate via `ScreensClientError`.
final class MarketplaceInstallTests: XCTestCase {

    // MARK: - Canonical-bytes parity with the webapp

    func test_canonicalBytesShapeMatchesWebapp() {
        let r = InstallServiceRequest(
            serverId: "home.harry.flagship.services",
            creator: "trent",
            slug: "scratchpad",
            manifestJson: #"{"name":"scratchpad","version":"1.0.0"}"#,
            addOwnerToMembership: true,
            issuedAt: 1_700_000_000_000
        )
        let bytes = installServiceCanonicalBytes(r)
        let canonical = String(data: bytes, encoding: .utf8)!
        // 7 pipe-separated fields, in this exact order.
        let parts = canonical.split(separator: "|", omittingEmptySubsequences: false)
        XCTAssertEqual(parts.count, 7)
        XCTAssertEqual(parts[0], "flagship/install-service/v1")
        XCTAssertEqual(parts[1], "home.harry.flagship.services")
        XCTAssertEqual(parts[2], "trent")
        XCTAssertEqual(parts[3], "scratchpad")
        XCTAssertEqual(parts[4], #"{"name":"scratchpad","version":"1.0.0"}"#)
        XCTAssertEqual(parts[5], "1")     // addOwnerToMembership=true ⇒ "1"
        XCTAssertEqual(parts[6], "1700000000000")
    }

    func test_canonicalBytesEncodesFalseMembershipAsZero() {
        let r = InstallServiceRequest(
            serverId: "x.flagship.services",
            creator: "a", slug: "b",
            manifestJson: "{}",
            addOwnerToMembership: false,
            issuedAt: 1
        )
        let canonical = String(data: installServiceCanonicalBytes(r), encoding: .utf8)!
        let parts = canonical.split(separator: "|", omittingEmptySubsequences: false)
        XCTAssertEqual(parts[5], "0")
    }

    // MARK: - Mock records the install envelope

    func test_mockRecordsInstallEnvelopeOnSuccess() async throws {
        let client = MockScreensClient()
        client.simulatedLatency = 0
        let request = InstallServiceRequest(
            serverId: "home.harry.flagship.services",
            creator: "trent",
            slug: "scratchpad",
            manifestJson: #"{"name":"scratchpad"}"#,
            addOwnerToMembership: true,
            issuedAt: 1_700_000_000_000
        )
        // Real-ish signature using a one-shot keypair — the Mock doesn't
        // verify it, but the test must demonstrate the call site signed the
        // canonical-bytes (not the raw request JSON).
        let key = Curve25519.Signing.PrivateKey()
        let sig = try key.signature(for: installServiceCanonicalBytes(request))
        let envelope = InstallServiceEnvelope(
            request: request,
            signature: HexUtil.encode(sig)
        )
        let resp = try await client.installFromMarketplace(envelope)
        XCTAssertEqual(client.installCalls.count, 1)
        let recorded = client.installCalls[0]
        XCTAssertEqual(recorded.request, request)
        // Signature is the canonical-bytes signature, hex-encoded — 64 bytes
        // × 2 hex chars = 128 chars.
        XCTAssertEqual(recorded.signature.count, 128)
        // Response shape mirrors the daemon's `installService` body.
        XCTAssertTrue(resp.ok)
        XCTAssertEqual(resp.serviceId, "trent--scratchpad")
        XCTAssertEqual(resp.urlLabel, "scratchpad")
    }

    func test_mockFetchListingRecordsCallAndReturnsManifestJson() async throws {
        let client = MockScreensClient()
        client.simulatedLatency = 0
        let detail = try await client.marketplaceFetchListing(creator: "trent", slug: "scratchpad")
        XCTAssertEqual(client.listingFetches.count, 1)
        XCTAssertEqual(client.listingFetches[0].creator, "trent")
        XCTAssertEqual(client.listingFetches[0].slug, "scratchpad")
        XCTAssertFalse(detail.manifestJson.isEmpty)
        XCTAssertEqual(detail.creator, "trent")
        XCTAssertEqual(detail.slug, "scratchpad")
    }

    func test_mockSurfacesErrorOnFailureFlag() async {
        let client = MockScreensClient()
        client.simulatedLatency = 0
        client.installShouldFail = true
        client.installFailureMessage = "manifest signature invalid"
        let envelope = InstallServiceEnvelope(
            request: InstallServiceRequest(
                serverId: "x", creator: "a", slug: "b",
                manifestJson: "{}", addOwnerToMembership: true, issuedAt: 1
            ),
            signature: "00"
        )
        do {
            _ = try await client.installFromMarketplace(envelope)
            XCTFail("expected throw")
        } catch let e as ScreensClientError {
            switch e {
            case .http(let status, let message):
                XCTAssertEqual(status, 400)
                XCTAssertEqual(message, "manifest signature invalid")
            default:
                XCTFail("expected .http, got \(e)")
            }
        } catch {
            XCTFail("expected ScreensClientError, got \(error)")
        }
    }

    // MARK: - Envelope round-trips through JSON unchanged

    func test_envelopeRoundTripsThroughJson() throws {
        let request = InstallServiceRequest(
            serverId: "home.harry.flagship.services",
            creator: "wendy",
            slug: "wishlist",
            manifestJson: #"{"name":"wishlist","version":"0.1.0"}"#,
            addOwnerToMembership: true,
            issuedAt: 1_700_000_000_000
        )
        let envelope = InstallServiceEnvelope(request: request, signature: String(repeating: "ab", count: 64))
        let data = try JSONEncoder().encode(envelope)
        let decoded = try JSONDecoder().decode(InstallServiceEnvelope.self, from: data)
        XCTAssertEqual(decoded, envelope)
        // The encoded JSON must carry the same top-level keys as the webapp
        // wire body: `{ "request": {...}, "signature": "..." }`.
        let asString = String(data: data, encoding: .utf8)!
        XCTAssertTrue(asString.contains("\"request\""))
        XCTAssertTrue(asString.contains("\"signature\""))
        XCTAssertTrue(asString.contains("\"manifestJson\""))
        XCTAssertTrue(asString.contains("\"addOwnerToMembership\""))
    }
}
