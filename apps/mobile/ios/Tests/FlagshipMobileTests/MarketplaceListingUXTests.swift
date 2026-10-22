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

    // MARK: - Install-consent gate (F blocks; nil cautions; A–D normal)

    private func listing(grade: String?) -> MarketplaceListing {
        MarketplaceListing(
            creator: "a", slug: "b", title: "T", summary: "S",
            screenshots: [], installCount: 0, requiresLlmKey: false,
            llmKeyEnvVar: nil, scanGrade: grade, alreadyInstalled: false
        )
    }

    func test_scanGate_onlyFBlocksInstall() {
        // F is the sole grade conservative enough to block the normal install.
        XCTAssertTrue(ScanGradeBucket.from("F").blocksInstall)
        XCTAssertTrue(ScanGradeBucket.from("f").blocksInstall)   // case-insensitive
        for ok in ["A", "B", "C", "D", nil, "", "Z"] {
            XCTAssertFalse(ScanGradeBucket.from(ok).blocksInstall,
                           "grade \(ok ?? "nil") must NOT block install")
        }
    }

    func test_scanGate_onlyUngradedCautions() {
        // nil / unknown → caution; every real grade (incl. F) is not a caution.
        XCTAssertTrue(ScanGradeBucket.from(nil).installCaution)
        XCTAssertTrue(ScanGradeBucket.from("").installCaution)
        XCTAssertTrue(ScanGradeBucket.from("Z").installCaution)
        for graded in ["A", "B", "C", "D", "F"] {
            XCTAssertFalse(ScanGradeBucket.from(graded).installCaution,
                           "grade \(graded) is graded, not a caution")
        }
    }

    func test_scanGate_blockAndCautionAreMutuallyExclusive() {
        for g in ["A", "B", "C", "D", "F", nil, "", "?"] {
            let bucket = ScanGradeBucket.from(g)
            XCTAssertFalse(bucket.blocksInstall && bucket.installCaution,
                           "grade \(g ?? "nil") can't both block and caution")
        }
    }

    func test_listing_scanGateBucketReflectsGrade() {
        XCTAssertTrue(listing(grade: "F").scanGateBucket.blocksInstall)
        XCTAssertFalse(listing(grade: "F").scanGateBucket.installCaution)
        XCTAssertTrue(listing(grade: nil).scanGateBucket.installCaution)
        XCTAssertFalse(listing(grade: nil).scanGateBucket.blocksInstall)
        // A clean grade is neither blocked nor cautioned → the normal confirm.
        let a = listing(grade: "A").scanGateBucket
        XCTAssertFalse(a.blocksInstall)
        XCTAssertFalse(a.installCaution)
        // D maps to the warn bucket but STILL installs normally (only F blocks).
        let d = listing(grade: "D").scanGateBucket
        XCTAssertFalse(d.blocksInstall)
        XCTAssertFalse(d.installCaution)
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
