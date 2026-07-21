import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

/// Slice B — auto-pair. On unlock the device self-provisions a per-box session
/// token for every visible pod that lacks one, under a SINGLE biometric, reusing
/// PodPairViewModel's canonical bytes + idempotency.
@MainActor
final class AutoPairCoordinatorTests: XCTestCase {
    private func key(_ b: UInt8 = 7) -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: b, count: 32))
    }
    private func store() -> SessionStore {
        SessionStore(defaults: UserDefaults(suiteName: "autopair-\(UUID().uuidString)")!)
    }
    private func pod(_ host: String, status: PodInfo.Status = .online) -> PodInfo {
        PodInfo(podId: PodInfo.podId(forFqdn: host), name: host, fqdn: host, status: status)
    }

    /// Reference counter so the signer can tally biometric derivations.
    private final class Counter { var n = 0 }

    func testPairsAllUnpairedPodsWithOneBiometric() async {
        let mock = MockLockPowerClient()
        let s = store()
        let k = key()
        let counter = Counter()
        let coord = AutoPairCoordinator(client: mock, store: s, signer: { _ in counter.n += 1; return k })

        let pods = [pod("home.alice.flagship.services"), pod("blog.alice.flagship.services")]
        await coord.pairVisiblePods(pods)

        XCTAssertEqual(counter.n, 1, "one biometric for the whole batch")
        XCTAssertEqual(mock.sent.count, 2)
        XCTAssertTrue(mock.sent.allSatisfy { $0.path == "/api/orders-from-user" && $0.request["type"] == "add-paired-session" })
        for p in pods {
            let t = await s.sessionToken(forPodId: PodInfo.podId(forFqdn: p.fqdn))
            XCTAssertNotNil(t)
            XCTAssertFalse(t!.isEmpty)
        }
    }

    func testSkipsAlreadyPairedPodsAndFiresNoBiometric() async {
        let mock = MockLockPowerClient()
        let s = store()
        let counter = Counter()
        let host = "home.alice.flagship.services"
        await s.setSessionToken("already", forPodId: PodInfo.podId(forFqdn: host))

        let coord = AutoPairCoordinator(client: mock, store: s, signer: { _ in counter.n += 1; return self.key() })
        await coord.pairVisiblePods([pod(host)])

        XCTAssertEqual(counter.n, 0, "a fully-paired account triggers no biometric")
        XCTAssertEqual(mock.sent.count, 0)
    }

    func testSkipsPendingPods() async {
        let mock = MockLockPowerClient()
        let s = store()
        let counter = Counter()
        let coord = AutoPairCoordinator(client: mock, store: s, signer: { _ in counter.n += 1; return self.key() })

        await coord.pairVisiblePods([pod("pending.alice.flagship.services", status: .pending)])

        XCTAssertEqual(counter.n, 0)
        XCTAssertEqual(mock.sent.count, 0)
    }

    func testGuardPreventsSecondPassUntilReset() async {
        let mock = MockLockPowerClient()
        let s = store()
        let counter = Counter()
        let k = key()
        let coord = AutoPairCoordinator(client: mock, store: s, signer: { _ in counter.n += 1; return k })

        await coord.pairVisiblePods([pod("home.alice.flagship.services")])
        XCTAssertEqual(counter.n, 1)

        // Same unlock session — guarded off even for a new unpaired pod.
        await coord.pairVisiblePods([pod("blog.alice.flagship.services")])
        XCTAssertEqual(counter.n, 1)

        // A re-lock re-arms it.
        coord.resetForNewUnlock()
        await coord.pairVisiblePods([pod("blog.alice.flagship.services")])
        XCTAssertEqual(counter.n, 2)
    }

    func testNoCandidatesDoesNotConsumeGuard() async {
        let mock = MockLockPowerClient()
        let s = store()
        let counter = Counter()
        let coord = AutoPairCoordinator(client: mock, store: s, signer: { _ in counter.n += 1; return self.key() })

        // First call: pods still loading (empty) — must NOT consume the guard.
        await coord.pairVisiblePods([])
        XCTAssertEqual(counter.n, 0)

        // Pods arrive on a later call — the pass still runs.
        await coord.pairVisiblePods([pod("home.alice.flagship.services")])
        XCTAssertEqual(counter.n, 1)
        XCTAssertEqual(mock.sent.count, 1)
    }
}
