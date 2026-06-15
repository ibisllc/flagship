import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

/// P7 — TierStatusViewModel + the wire shape it renders.
///
/// Mirrors the canonical webapp `views/tier-status.js`:
///   - `tierStatus()` returns a `TierStatusResponse` with the full
///     tier-status field set (tier / credits / dispatcher usage /
///     custom domains / reserved names).
///   - The VM exposes the response through a `LoadingState`; the
///     screen pivots on it.
///   - `usagePercent(used:quota:)` clamps to 0…100 and mirrors the
///     `pct(used, quota)` helper inline in tier-status.js.
@MainActor
final class TierStatusViewModelTests: XCTestCase {

    private func makeClient() -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        return c
    }

    // MARK: - Default fixture (mirrors the Android default)

    func test_mockFixture_matchesAndroidDefault() async throws {
        let client = makeClient()
        let r = try await client.tierStatus()
        // The Android Mock returns the SAME fixture so the two surfaces
        // render identically against the Mock — guard that here.
        XCTAssertEqual(r.tier, "promo")
        XCTAssertEqual(r.llmCreditsRemainingDay, 38)
        XCTAssertEqual(r.llmCreditsRemainingTotal, 162)
        XCTAssertEqual(r.dispatcherUsageGBmonth, 1.2)
        XCTAssertEqual(r.dispatcherFreeQuotaGBmonth, 50.0)
        XCTAssertEqual(r.customDomains, [])
        XCTAssertEqual(r.reservedNames, ["harry"])
    }

    // MARK: - load()

    func test_load_idle_toLoaded_withDefaultFixture() async {
        let client = makeClient()
        let vm = TierStatusViewModel(client: client)
        await vm.load()
        guard case .loaded(let t) = vm.state else {
            XCTFail("expected loaded, got \(vm.state)"); return
        }
        XCTAssertEqual(t.tier, "promo")
        XCTAssertEqual(t.reservedNames, ["harry"])
    }

    func test_load_pinnedFixture_isReturnedVerbatim() async {
        let client = makeClient()
        client.tierStatusFixture = TierStatusResponse(
            tier: "byok",
            llmCreditsRemainingDay: nil,           // BYOK = no Flagship credits
            llmCreditsRemainingTotal: nil,
            dispatcherUsageGBmonth: 12.5,
            dispatcherFreeQuotaGBmonth: 50.0,
            customDomains: ["wiki.example.com", "plants.example.com"],
            reservedNames: ["harry", "harryco"]
        )
        let vm = TierStatusViewModel(client: client)
        await vm.load()
        guard case .loaded(let t) = vm.state else {
            XCTFail("expected loaded, got \(vm.state)"); return
        }
        XCTAssertEqual(t.tier, "byok")
        XCTAssertNil(t.llmCreditsRemainingDay)
        XCTAssertNil(t.llmCreditsRemainingTotal)
        XCTAssertEqual(t.dispatcherUsageGBmonth, 12.5)
        XCTAssertEqual(t.dispatcherFreeQuotaGBmonth, 50.0)
        XCTAssertEqual(t.customDomains, ["wiki.example.com", "plants.example.com"])
        XCTAssertEqual(t.reservedNames, ["harry", "harryco"])
    }

    func test_load_freeTier_withEmptyCustomDomains() async {
        let client = makeClient()
        client.tierStatusFixture = TierStatusResponse(
            tier: "free",
            llmCreditsRemainingDay: 0,
            llmCreditsRemainingTotal: 0,
            dispatcherUsageGBmonth: 0,
            dispatcherFreeQuotaGBmonth: 50.0,
            customDomains: [],
            reservedNames: []
        )
        let vm = TierStatusViewModel(client: client)
        await vm.load()
        guard case .loaded(let t) = vm.state else {
            XCTFail("expected loaded, got \(vm.state)"); return
        }
        XCTAssertEqual(t.tier, "free")
        XCTAssertTrue(t.customDomains.isEmpty)
        XCTAssertTrue(t.reservedNames.isEmpty)
    }

    func test_load_failure_surfacesAsFailed() async {
        let client = makeClient()
        client.shouldFail = true
        let vm = TierStatusViewModel(client: client)
        await vm.load()
        if case .failed = vm.state {
            // expected
        } else {
            XCTFail("expected .failed, got \(vm.state)")
        }
    }

    // MARK: - usagePercent (mirrors tier-status.js `pct`)

    func test_usagePercent_zero_whenUsedIsNil() {
        XCTAssertEqual(TierStatusViewModel.usagePercent(used: nil, quota: 50), 0)
    }

    func test_usagePercent_zero_whenQuotaIsNil() {
        XCTAssertEqual(TierStatusViewModel.usagePercent(used: 12, quota: nil), 0)
    }

    func test_usagePercent_zero_whenQuotaIsZero() {
        XCTAssertEqual(TierStatusViewModel.usagePercent(used: 12, quota: 0), 0)
    }

    func test_usagePercent_unambiguousRatios() {
        // 12 / 50 = 0.24 → 24%
        XCTAssertEqual(TierStatusViewModel.usagePercent(used: 12, quota: 50), 24)
        // 1 / 4 = 0.25 → 25%
        XCTAssertEqual(TierStatusViewModel.usagePercent(used: 1, quota: 4), 25)
        // Exact integers — no rounding ambiguity.
        XCTAssertEqual(TierStatusViewModel.usagePercent(used: 25, quota: 50), 50)
        XCTAssertEqual(TierStatusViewModel.usagePercent(used: 40, quota: 50), 80)
    }

    func test_usagePercent_clampsAt100() {
        // Over quota — still presented as a full bar, never > 100.
        XCTAssertEqual(TierStatusViewModel.usagePercent(used: 200, quota: 50), 100)
        XCTAssertEqual(TierStatusViewModel.usagePercent(used: 51, quota: 50), 100)
    }

    func test_usagePercent_smallValues() {
        XCTAssertEqual(TierStatusViewModel.usagePercent(used: 0, quota: 50), 0)
        XCTAssertEqual(TierStatusViewModel.usagePercent(used: 1.2, quota: 50.0), 2)
    }
}
