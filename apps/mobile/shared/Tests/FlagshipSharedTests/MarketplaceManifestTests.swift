import XCTest
import CryptoKit
@testable import FlagshipAPI

/// Blocker-1 (feat/marketplace): the listing carries the app manifest JSON +
/// its committed hash, and every install client re-checks
/// `sha256(manifestJson) == manifestHash` before installing. These pin the
/// shared pieces the install VM relies on: the hash helper, the mock's carried
/// hash, and the `.com` wrapped-listing → flat-detail decode.
final class MarketplaceManifestTests: XCTestCase {

    func test_manifestSha256Hex_matchesCryptoKit() {
        let s = #"{"name":"scratchpad","version":"1.0.0"}"#
        let expected = SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(manifestSha256Hex(s), expected)
        XCTAssertEqual(manifestSha256Hex(s).count, 64)
    }

    func test_mockListing_carriesMatchingManifestHash() async throws {
        let client = MockScreensClient()
        client.simulatedLatency = 0
        let detail = try await client.marketplaceFetchListing(creator: "trent", slug: "scratchpad")
        XCTAssertFalse(detail.manifestHash.isEmpty)
        XCTAssertEqual(detail.manifestHash, manifestSha256Hex(detail.manifestJson))
    }

    func test_mockTamperFlag_breaksTheHash() async throws {
        let client = MockScreensClient()
        client.simulatedLatency = 0
        client.tamperListingManifest = true
        let detail = try await client.marketplaceFetchListing(creator: "trent", slug: "scratchpad")
        XCTAssertNotEqual(detail.manifestHash, manifestSha256Hex(detail.manifestJson))
    }

    func test_comWrappedListing_decodesToFlatDetail() throws {
        // Shape of the .com single-listing GET: `{ listing: { ...snake... } }`.
        let manifest = #"{"name":"habits","version":"2.0.0"}"#
        let hash = manifestSha256Hex(manifest)
        let json = """
        {"listing":{"creator":"alice","slug":"habit-tracker","name":"Habit Tracker",
        "tagline":"Track daily habits","manifest_hash":"\(hash)",
        "manifest_json":\(String(data: try JSONEncoder().encode(manifest), encoding: .utf8)!),
        "install_count":5,"status":"listed"}}
        """
        let env = try JSONDecoder().decode(ComListingEnvelope.self, from: Data(json.utf8))
        XCTAssertEqual(env.listing.creator, "alice")
        XCTAssertEqual(env.listing.slug, "habit-tracker")
        XCTAssertEqual(env.listing.name, "Habit Tracker")
        XCTAssertEqual(env.listing.manifest_json, manifest)
        XCTAssertEqual(env.listing.manifest_hash, hash)
    }
}
