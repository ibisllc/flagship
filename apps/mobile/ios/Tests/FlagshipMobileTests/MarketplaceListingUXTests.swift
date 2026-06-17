import XCTest
@testable import FlagshipAPI

/// B7 — marketplace install UX parity with the webapp:
///   1. an app that needs an LLM key resolves the env-var name to prefill in
///      "Configure environment" (never dead-ends at installed-but-broken);
///   2. the scan-grade pill maps A/B→ok, C/D→warn, F→err, NULL→ungraded —
///      the same buckets the webapp's `scanGradePill` uses.
///
/// These pin the SHARED pure logic (`MarketplaceLlmKey`, `ScanGradeBucket`)
/// + the listing's new Codable fields, so the daemon BFF wire shape and all
/// three clients stay aligned. The SwiftUI pill/confirm views are driven by
/// these helpers, so this also guards the rendered UX.
final class MarketplaceListingUXTests: XCTestCase {

    // MARK: - Fix 1: LLM-key env-var resolution

    func test_llmKeyDefaultMatchesContract() {
        // Byte-identical with the daemon BFF + webapp + Android default.
        XCTAssertEqual(MarketplaceLlmKey.defaultEnvVar, "OPENAI_API_KEY")
    }

    func test_llmKeyUsesListingDeclaredName() {
        let l = MarketplaceListing(
            creator: "peggy", slug: "feed-reader", title: "T", summary: "S",
            screenshots: [], installCount: 1, requiresLlmKey: true,
            llmKeyEnvVar: "ANTHROPIC_API_KEY", scanGrade: nil, alreadyInstalled: false
        )
        XCTAssertEqual(MarketplaceLlmKey.envVar(for: l), "ANTHROPIC_API_KEY")
    }

    func test_llmKeyFallsBackToDefaultWhenAbsentOrEmpty() {
        let noName = MarketplaceListing(
            creator: "a", slug: "b", title: "T", summary: "S",
            screenshots: [], installCount: 0, requiresLlmKey: true,
            llmKeyEnvVar: nil, scanGrade: nil, alreadyInstalled: false
        )
        XCTAssertEqual(MarketplaceLlmKey.envVar(for: noName), "OPENAI_API_KEY")
        let emptyName = MarketplaceListing(
            creator: "a", slug: "b", title: "T", summary: "S",
            screenshots: [], installCount: 0, requiresLlmKey: true,
            llmKeyEnvVar: "", scanGrade: nil, alreadyInstalled: false
        )
        XCTAssertEqual(MarketplaceLlmKey.envVar(for: emptyName), "OPENAI_API_KEY")
    }

    // MARK: - Fix 2: scan-grade pill buckets (incl. NULL → ungraded)

    func test_scanGradeBuckets() {
        XCTAssertEqual(ScanGradeBucket.from("A"), .ok)
        XCTAssertEqual(ScanGradeBucket.from("b"), .ok)   // case-insensitive
        XCTAssertEqual(ScanGradeBucket.from("C"), .warn)
        XCTAssertEqual(ScanGradeBucket.from("D"), .warn)
        XCTAssertEqual(ScanGradeBucket.from("F"), .err)
        // The consistent NULL/unknown treatment across all three surfaces.
        XCTAssertEqual(ScanGradeBucket.from(nil), .ungraded)
        XCTAssertEqual(ScanGradeBucket.from(""), .ungraded)
        XCTAssertEqual(ScanGradeBucket.from("Z"), .ungraded)
    }

    func test_scanGradePillLabels() {
        XCTAssertEqual(ScanGradeBucket.pillLabel("a"), "scan A")
        XCTAssertEqual(ScanGradeBucket.pillLabel("F"), "scan F")
        XCTAssertEqual(ScanGradeBucket.pillLabel(nil), "ungraded")
        XCTAssertEqual(ScanGradeBucket.pillLabel("?"), "ungraded")
    }

    // MARK: - Wire shape: new fields decode + tolerate absence

    func test_listingDecodesScanGradeAndLlmKeyEnvVar() throws {
        let json = """
        {"creator":"bob","slug":"game","title":"Game","summary":"y",
         "screenshots":[],"installCount":2,"requiresLlmKey":true,
         "llmKeyEnvVar":"OPENAI_API_KEY","scanGrade":"B","alreadyInstalled":false}
        """.data(using: .utf8)!
        let l = try JSONDecoder().decode(MarketplaceListing.self, from: json)
        XCTAssertEqual(l.scanGrade, "B")
        XCTAssertEqual(l.llmKeyEnvVar, "OPENAI_API_KEY")
        XCTAssertTrue(l.requiresLlmKey)
    }

    func test_listingDecodesWhenOptionalFieldsAbsent() throws {
        // The BFF omits scanGrade / llmKeyEnvVar when .com doesn't supply them.
        let json = """
        {"creator":"alice","slug":"habits","title":"Habits","summary":"x",
         "screenshots":[],"installCount":5,"requiresLlmKey":false,
         "alreadyInstalled":true}
        """.data(using: .utf8)!
        let l = try JSONDecoder().decode(MarketplaceListing.self, from: json)
        XCTAssertNil(l.scanGrade)
        XCTAssertNil(l.llmKeyEnvVar)
        XCTAssertEqual(ScanGradeBucket.from(l.scanGrade), .ungraded)
    }

    // MARK: - The mock exercises both fixes (drives the live-shape UI in tests)

    func test_mockListingsCarryGradeAndLlmKey() async throws {
        let client = MockScreensClient()
        client.simulatedLatency = 0
        let listings = try await client.marketplaceBrowse().listings
        let feed = try XCTUnwrap(listings.first { $0.slug == "feed-reader" })
        XCTAssertTrue(feed.requiresLlmKey)
        XCTAssertEqual(MarketplaceLlmKey.envVar(for: feed), "OPENAI_API_KEY")
        XCTAssertEqual(ScanGradeBucket.from(feed.scanGrade), .warn)   // "C"
        let wishlist = try XCTUnwrap(listings.first { $0.slug == "wishlist" })
        XCTAssertEqual(ScanGradeBucket.from(wishlist.scanGrade), .ungraded) // nil
    }
}
