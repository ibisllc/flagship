import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore

/// "This server needs an update" (owner decision 2026-11-02): `/pods`
/// `updateRequired` marks a box from before 0.3; Home and its page say so.
@MainActor
final class UpdateRequiredTests: XCTestCase {
    func testThePodsEntryDecodesUpdateRequired() throws {
        let json = #"{"serverDomain":"a.harry.flagship.services","identityPubKey":"aa","updateRequired":{"reason":"box-too-old","certificateExpiresAt":1767225600000}}"#
        let entry = try JSONDecoder().decode(PodDirectoryEntry.self, from: Data(json.utf8))
        XCTAssertEqual(entry.updateRequired, UpdateRequiredWire(reason: "box-too-old", certificateExpiresAt: 1_767_225_600_000))
    }

    func testAbsentOrGarbledUpdateRequiredIsNil() throws {
        let absent = #"{"serverDomain":"a.harry.flagship.services","identityPubKey":"aa"}"#
        XCTAssertNil(try JSONDecoder().decode(PodDirectoryEntry.self, from: Data(absent.utf8)).updateRequired)
        let garbled = #"{"serverDomain":"a.harry.flagship.services","identityPubKey":"aa","updateRequired":"yes"}"#
        XCTAssertNil(try JSONDecoder().decode(PodDirectoryEntry.self, from: Data(garbled.utf8)).updateRequired)
        let undated = #"{"serverDomain":"a.harry.flagship.services","identityPubKey":"aa","updateRequired":{"reason":"box-too-old","certificateExpiresAt":null}}"#
        XCTAssertEqual(try JSONDecoder().decode(PodDirectoryEntry.self, from: Data(undated.utf8)).updateRequired?.certificateExpiresAt, nil)
    }

    func testTheReconcilerKeepsItPerServerAndClearsItAfterTheUpdate() async {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [])
        let stk = String(repeating: "a1", count: 32)
        let needs = UpdateRequiredWire(reason: "box-too-old", certificateExpiresAt: 1_767_225_600_000)
        var dir = PodsDirectoryResponse(username: "harry", pods: [
            PodDirectoryEntry(serverDomain: "Home.harry.flagship.services", identityPubKey: stk, lastReported: 1,
                              registeredAt: 100, liveness: "live", updateRequired: needs),
        ])
        let store = PendingServerStore(defaults: UserDefaults(suiteName: "upd-\(UUID().uuidString)")!)
        await PendingServerReconciler(app: app, store: store, fetchPods: { _ in dir }).reconcile()
        XCTAssertEqual(app.podsUpdateRequired, ["home.harry.flagship.services": needs])

        dir = PodsDirectoryResponse(username: "harry", pods: [
            PodDirectoryEntry(serverDomain: "home.harry.flagship.services", identityPubKey: stk, lastReported: 2,
                              registeredAt: 100, liveness: "live"),
        ])
        await PendingServerReconciler(app: app, store: store, fetchPods: { _ in dir }).reconcile()
        XCTAssertTrue(app.podsUpdateRequired.isEmpty)
    }

    func testTheBannerLineNamesTheDateWhenKnown() {
        let dated = UpdateRequiredBanner.detail(
            UpdateRequiredWire(certificateExpiresAt: 1_767_225_600_000), locale: Locale(identifier: "en_US"))
        XCTAssertTrue(dated.contains("2026") || dated.contains("2025"), dated)
        XCTAssertTrue(dated.hasPrefix("Its certificate can't be renewed and runs out on"), dated)
        XCTAssertEqual(UpdateRequiredBanner.detail(UpdateRequiredWire(certificateExpiresAt: nil)),
                       String(localized: "Its certificate can't be renewed until it is updated."))
    }
}
