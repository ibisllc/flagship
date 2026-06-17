import XCTest
@testable import FlagshipCore
@testable import FlagshipAPI

/// Pin the test-account / demo-mode contract on iOS:
///   - activate() leaves AppState in a believable "signed-in" shape
///     for whatever username the Worker confirmed as a test account
///   - the Mock server, when configured with a test-account map,
///     returns the right testAccount block on usernameAvailable
///   - the Mock server, default-configured, exposes NO test accounts
///     (the open-source code is empty by design)
@MainActor
final class DemoFixturesTests: XCTestCase {

    func test_activate_populatesAppStateWithSamplePods() {
        let app = AppState()
        DemoFixtures.activate(app, username: "play-reviewer-q2")
        XCTAssertTrue(app.isPaired)
        XCTAssertEqual(app.currentUser, "play-reviewer-q2")
        XCTAssertEqual(app.pods.count, 3)
        XCTAssertEqual(app.pods.map(\.name), ["Home", "Office", "Music"])
        XCTAssertNotNil(app.leaderPodId)
        XCTAssertEqual(app.leaderPodId, app.currentPodId)
        // FQDNs scoped to the demo username so they're obviously
        // sample data, not collision-able with a real pod.
        XCTAssertTrue(app.pods.allSatisfy { $0.fqdn.contains(".play-reviewer-q2.flagship.services") })
        // Status mix: at least one online + the offline one for the
        // pill-variant exercise.
        XCTAssertTrue(app.pods.contains { $0.status == .online })
        XCTAssertTrue(app.pods.contains { $0.status == .offline })
    }

    func test_samplePods_areUniquePerActivation() {
        // Two activations should mint disjoint podId sets so a
        // sign-out + re-enter doesn't collide with stale ids.
        let a = DemoFixtures.samplePods(username: "harry")
        let b = DemoFixtures.samplePods(username: "harry")
        let aIds = Set(a.map(\.podId))
        let bIds = Set(b.map(\.podId))
        XCTAssertTrue(aIds.intersection(bIds).isEmpty)
    }

    func test_defaultMockServer_hasNoTestAccountsConfigured() async throws {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        // The OSS default ships with an empty testAccounts map; only
        // explicitly-configured tests + the Worker secret enable any
        // accounts.
        let r = try await mock.usernameAvailable("playreview")
        XCTAssertNil(r.testAccount)
    }

    func test_mockServer_surfacesConfiguredTestAccount() async throws {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        mock.testAccounts = [
            "playreview-q2": TestAccountMeta(display: "Play Reviewer (Q2)", ttlHours: 6),
        ]
        let r = try await mock.usernameAvailable("playreview-q2")
        XCTAssertEqual(r.available, false)
        XCTAssertEqual(r.reason, "test account")
        XCTAssertEqual(r.testAccount, TestAccountMeta(display: "Play Reviewer (Q2)", ttlHours: 6))
    }

    func test_testAccountMatch_isCaseInsensitive() async throws {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        mock.testAccounts = [
            "playreview-q2": TestAccountMeta(display: "Play Reviewer", ttlHours: 6),
        ]
        // Worker normalizes to lowercase; mock does the same.
        let r = try await mock.usernameAvailable("PlayReview-Q2")
        XCTAssertEqual(r.testAccount?.display, "Play Reviewer")
    }

    func test_nonConfiguredName_doesNotLeakTestAccountList() async throws {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        mock.testAccounts = [
            "playreview-q2": TestAccountMeta(display: "PR", ttlHours: 6),
            "internal-tester": TestAccountMeta(display: "IT", ttlHours: 24),
        ]
        let r = try await mock.usernameAvailable("harry")
        // A non-matching name returns the normal availability shape
        // with no test-account info.
        XCTAssertEqual(r.available, true)
        XCTAssertNil(r.testAccount)
    }

    // ─── GYM total-gym Tier-1 D5 seed variants (§12-G5) ──────────────────────

    func test_samplePodsWithAwaitingUnlock_appendsAWaitingBox() {
        let pods = DemoFixtures.samplePodsWithAwaitingUnlock(username: "smoketest")
        // The three legacy pods + one waiting box.
        XCTAssertEqual(pods.count, 4)
        XCTAssertEqual(pods.prefix(3).map(\.name), ["Home", "Office", "Music"])
        guard let waiting = pods.first(where: { $0.name == "Cabin" }) else {
            return XCTFail("expected a 'Cabin' awaiting-unlock pod")
        }
        // The directory `awaitingUnlock` flag drives the F1 approve card.
        XCTAssertTrue(waiting.awaitingUnlock)
        XCTAssertFalse(waiting.cameOnline)
        // Liveness classifies it as waitingForApproval (NOT dead) once the
        // account-level signal mirrors the cheap flag.
        XCTAssertEqual(
            waiting.livenessState(hasLiveUnlockRequest: true),
            .waitingForApproval
        )
    }

    func test_samplePodsWithDeadServer_appendsADeadBox() {
        let pods = DemoFixtures.samplePodsWithDeadServer(username: "smoketest")
        XCTAssertEqual(pods.count, 4)
        guard let dead = pods.first(where: { $0.name == "Attic" }) else {
            return XCTFail("expected an 'Attic' dead pod")
        }
        XCTAssertFalse(dead.cameOnline)
        XCTAssertFalse(dead.awaitingUnlock)
        // Registered well past the coming-online grace + no live unlock request
        // ⇒ classified `.dead` (so Home shows the never-online pill).
        XCTAssertGreaterThan(dead.registeredAt, 0)
        XCTAssertEqual(dead.livenessState(hasLiveUnlockRequest: false), .dead)
    }

    func test_activateWithExplicitPods_seedsThatSet() {
        let app = AppState()
        let pods = DemoFixtures.samplePodsWithAwaitingUnlock(username: "smoketest")
        DemoFixtures.activate(app, username: "smoketest", pods: pods)
        XCTAssertTrue(app.isPaired)
        XCTAssertEqual(app.pods.count, 4)
        XCTAssertTrue(app.pods.contains { $0.awaitingUnlock })
    }
}
