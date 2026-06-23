import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Phase 2 (iOS) of the multi-pod liveness/leadership fix.
///   - Fix A: honest liveness — `/pods` `liveness` drives pod status + the
///     liveness classifier (the phone stops trusting mere registration).
///   - Fix B: per-pod session-token store + legacy-token migration + activate.
///   - Fix C: deterministic, sticky leadership — a new box never seizes the
///     default; a dangling leader re-anchors to the OLDEST remaining pod.
@MainActor
final class MultipodLivenessTests: XCTestCase {

    private func uniqueDefaults() -> UserDefaults {
        UserDefaults(suiteName: "multipod-\(UUID().uuidString)")!
    }

    // MARK: - Fix A — liveness mapping

    func test_reconciler_liveMapsToOnline() async {
        let app = AppState(isPaired: true, currentUser: "harry")
        await runReconcile(app: app, entries: [
            PodDirectoryEntry(serverDomain: "live.harry.flagship.services",
                              identityPubKey: "11", lastReported: 1, liveness: "live", lastSeenMsAgo: 5_000)
        ])
        let pod = app.pods.first { $0.fqdn == "live.harry.flagship.services" }
        XCTAssertEqual(pod?.status, .online)
        XCTAssertEqual(pod?.liveness, .live)
        XCTAssertEqual(app.liveness(for: pod!), .online)
    }

    func test_reconciler_unreachableMapsToOffline_withLastSeen() async {
        let app = AppState(isPaired: true, currentUser: "harry")
        await runReconcile(app: app, entries: [
            PodDirectoryEntry(serverDomain: "stale.harry.flagship.services",
                              identityPubKey: "22", lastReported: 1, liveness: "unreachable",
                              lastSeenMsAgo: 2 * 60 * 60 * 1000)
        ])
        let pod = app.pods.first { $0.fqdn == "stale.harry.flagship.services" }
        XCTAssertEqual(pod?.status, .offline)
        XCTAssertEqual(app.liveness(for: pod!), .offline)
        XCTAssertEqual(pod?.humanizedLastSeen(), "2 hours ago")
    }

    func test_reconciler_neverMapsToComingUp_notDead() async {
        let app = AppState(isPaired: true, currentUser: "harry")
        await runReconcile(app: app, entries: [
            PodDirectoryEntry(serverDomain: "new.harry.flagship.services",
                              identityPubKey: "33", liveness: "never")
        ])
        let pod = app.pods.first { $0.fqdn == "new.harry.flagship.services" }
        XCTAssertEqual(pod?.status, .unknown, "never → unknown (not session-eligible, not offline)")
        XCTAssertEqual(app.liveness(for: pod!), .comingOnline,
                       "a never-checked-in box is still coming up, NOT dead")
    }

    func test_liveness_unreachableWithApprovalReadsWaiting() {
        // A box stuck on an approval that's also gone stale should surface the
        // approval, not merely read offline.
        let pod = PodInfo(podId: "p", name: "P", fqdn: "p", status: .offline, liveness: .unreachable)
        XCTAssertEqual(pod.livenessState(hasLiveUnlockRequest: true), .waitingForApproval)
        XCTAssertEqual(pod.livenessState(hasLiveUnlockRequest: false), .offline)
    }

    func test_liveness_absentFieldFallsBackToLegacy() {
        // No `liveness` field (pre-field Worker): an online+cameOnline pod is
        // still `.online`; a long-registered no-checkin box is still `.dead`.
        let live = PodInfo(podId: "a", name: "A", fqdn: "a", status: .online, cameOnline: true)
        XCTAssertEqual(live.livenessState(hasLiveUnlockRequest: false), .online)
        let dead = PodInfo(podId: "b", name: "B", fqdn: "b", status: .unknown,
                           cameOnline: false, registeredAt: 1)
        XCTAssertEqual(dead.livenessState(hasLiveUnlockRequest: false, now: 10_000_000_000), .dead)
    }

    private func runReconcile(app: AppState, entries: [PodDirectoryEntry]) async {
        let reconciler = PendingServerReconciler(
            app: app,
            fetchPods: { _ in PodsDirectoryResponse(username: "harry", pods: entries, pending: []) }
        )
        await reconciler.reconcile()
    }

    // MARK: - Fix B — per-pod token store + migration

    func test_perPodTokens_doNotOverwriteEachOther() async {
        let s = SessionStore(defaults: uniqueDefaults())
        await s.setSessionToken("token-A", forPodId: "a.harry.flagship.services")
        await s.setSessionToken("token-B", forPodId: "b.harry.flagship.services")
        let a = await s.sessionToken(forPodId: "a.harry.flagship.services")
        let b = await s.sessionToken(forPodId: "b.harry.flagship.services")
        XCTAssertEqual(a, "token-A")
        XCTAssertEqual(b, "token-B", "pairing a 2nd box must NOT clobber the 1st box's token")
        let ids = await s.podTokenIds()
        XCTAssertEqual(Set(ids), ["a.harry.flagship.services", "b.harry.flagship.services"])
    }

    func test_perPodTokens_caseInsensitiveKeying() async {
        let s = SessionStore(defaults: uniqueDefaults())
        await s.setSessionToken("tok", forPodId: "Home.Harry.Flagship.Services")
        let read = await s.sessionToken(forPodId: "home.harry.flagship.services")
        XCTAssertEqual(read, "tok")
    }

    func test_migrateSingleTokenToPod_attributesLegacyToken() async {
        let s = SessionStore(defaults: uniqueDefaults())
        // Simulate the pre-Fix-B world: a single active token, no per-pod entry.
        await s.setSessionToken("legacy-token")
        await s.migrateSingleTokenToPod("anchor.harry.flagship.services")
        let migrated = await s.sessionToken(forPodId: "anchor.harry.flagship.services")
        XCTAssertEqual(migrated, "legacy-token")
    }

    func test_migrate_isIdempotent_andNeverOverwrites() async {
        let s = SessionStore(defaults: uniqueDefaults())
        await s.setSessionToken("per-pod", forPodId: "anchor.harry.flagship.services")
        await s.setSessionToken("legacy")               // a stale legacy single token
        await s.migrateSingleTokenToPod("anchor.harry.flagship.services")
        let token = await s.sessionToken(forPodId: "anchor.harry.flagship.services")
        XCTAssertEqual(token, "per-pod", "migration must NOT overwrite an existing per-pod token")
    }

    func test_activatePod_mirrorsPodTokenIntoActiveSlot() async {
        let s = SessionStore(defaults: uniqueDefaults())
        await s.setSessionToken("token-A", forPodId: "a.harry.flagship.services")
        await s.setSessionToken("token-B", forPodId: "b.harry.flagship.services")
        // Activate A.
        await s.activatePod("a.harry.flagship.services", baseUrl: "https://a.harry.flagship.services")
        var active = await s.sessionToken
        var base = await s.podBaseUrl
        XCTAssertEqual(active, "token-A")
        XCTAssertEqual(base, "https://a.harry.flagship.services")
        // Switch to B.
        await s.activatePod("b.harry.flagship.services", baseUrl: "https://b.harry.flagship.services")
        active = await s.sessionToken
        base = await s.podBaseUrl
        XCTAssertEqual(active, "token-B")
        XCTAssertEqual(base, "https://b.harry.flagship.services")
    }

    func test_activatePod_withNoStoredToken_clearsActiveToken() async {
        let s = SessionStore(defaults: uniqueDefaults())
        await s.setSessionToken("stale-active")   // an unrelated active token
        // A pod with no per-pod token must activate with NO token — never borrow.
        await s.activatePod("untrusted.harry.flagship.services", baseUrl: "https://untrusted.harry.flagship.services")
        let active = await s.sessionToken
        XCTAssertNil(active, "a pod without its own token must not borrow another's")
    }

    func test_keychainStore_perPodTokens() async {
        let s = KeychainSessionStore(defaults: uniqueDefaults())
        await s.setSessionToken("tA", forPodId: "a.harry.flagship.services")
        await s.setSessionToken("tB", forPodId: "b.harry.flagship.services")
        let a = await s.sessionToken(forPodId: "a.harry.flagship.services")
        let b = await s.sessionToken(forPodId: "b.harry.flagship.services")
        XCTAssertEqual(a, "tA")
        XCTAssertEqual(b, "tB")
    }

    // MARK: - Fix B — PodSessionSync targets the pod deterministically

    func test_podSessionSync_targetsPodTokenByFqdn() async {
        let s = SessionStore(defaults: uniqueDefaults())
        let podB = PodInfo(podId: PodInfo.podId(forFqdn: "b.harry.flagship.services"),
                           name: "B", fqdn: "b.harry.flagship.services", status: .online)
        // The per-pod token is keyed on the SAME id PodSessionSync derives —
        // `PodInfo.podId(forFqdn:)` (the "pod-<fqdn>" identity used everywhere).
        await s.setSessionToken("token-B", forPodId: PodInfo.podId(forFqdn: "b.harry.flagship.services"))
        await PodSessionSync.sync(currentPod: podB, store: s)
        let active = await s.sessionToken
        let base = await s.podBaseUrl
        XCTAssertEqual(active, "token-B")
        XCTAssertEqual(base, "https://b.harry.flagship.services")
    }

    func test_podSessionSync_offlinePodStillTargetsForHonestState() async {
        // An unreachable pod still gets its base URL pointed (so the detail can
        // attempt a load and render the honest offline state) — NOT cleared.
        let s = SessionStore(defaults: uniqueDefaults())
        let offline = PodInfo(podId: PodInfo.podId(forFqdn: "x.harry.flagship.services"),
                              name: "X", fqdn: "x.harry.flagship.services",
                              status: .offline, liveness: .unreachable)
        await PodSessionSync.sync(currentPod: offline, store: s)
        let base = await s.podBaseUrl
        XCTAssertEqual(base, "https://x.harry.flagship.services")
    }

    func test_podSessionSync_pendingPodClears() async {
        let s = SessionStore(defaults: uniqueDefaults())
        await s.setPodBaseUrl("https://stale")
        let pending = PodInfo(podId: "p", name: "P", fqdn: "p.harry.flagship.services", status: .pending)
        await PodSessionSync.sync(currentPod: pending, store: s)
        let base = await s.podBaseUrl
        XCTAssertNil(base)
    }

    // MARK: - Fix C — sticky, deterministic leadership

    func test_addPod_neverSeizesLeadership() {
        let oldest = PodInfo(podId: "old", name: "Old", fqdn: "old.harry.flagship.services", status: .online)
        let app = AppState(isPaired: true, currentUser: "harry", pods: [oldest],
                           leaderPodId: "old", currentPodId: "old")
        // A brand-new box appears.
        app.addPod(PodInfo(podId: "frank", name: "frank", fqdn: "frank.harry.flagship.services", status: .online))
        XCTAssertEqual(app.leaderPodId, "old", "a new box must NOT become the leader")
        XCTAssertEqual(app.currentPodId, "old")
        XCTAssertEqual(app.currentPod?.podId, "old")
    }

    func test_addPod_seedsLeaderOnlyWhenNoneSet() {
        let app = AppState(isPaired: true, currentUser: "harry")  // no pods, no leader
        app.addPod(PodInfo(podId: "first", name: "First", fqdn: "first.harry.flagship.services", status: .online))
        XCTAssertEqual(app.leaderPodId, "first", "the genuine first pod seeds leadership")
    }

    func test_danglingLeader_reanchorsToOldest() {
        // `.com` returns oldest-first, so pods[0] is the oldest. Removing the
        // leader must re-anchor to the oldest remaining pod (deterministic),
        // never silently float to whatever is first by some other ordering.
        let app = AppState(
            isPaired: true, currentUser: "harry",
            pods: [
                PodInfo(podId: "a", name: "A", fqdn: "a.harry.flagship.services", status: .online),
                PodInfo(podId: "b", name: "B", fqdn: "b.harry.flagship.services", status: .online),
                PodInfo(podId: "c", name: "C", fqdn: "c.harry.flagship.services", status: .online)
            ],
            leaderPodId: "b", currentPodId: "b"
        )
        app.removePod("b")
        XCTAssertEqual(app.leaderPodId, "a", "re-anchor to the OLDEST remaining pod")
        XCTAssertEqual(app.currentPodId, "a")
    }

    func test_removeNonLeader_leavesLeaderUntouched() {
        let app = AppState(
            isPaired: true, currentUser: "harry",
            pods: [
                PodInfo(podId: "a", name: "A", fqdn: "a.harry.flagship.services", status: .online),
                PodInfo(podId: "b", name: "B", fqdn: "b.harry.flagship.services", status: .online)
            ],
            leaderPodId: "a", currentPodId: "a"
        )
        app.removePod("b")
        XCTAssertEqual(app.leaderPodId, "a", "removing a non-leader must not change leadership")
    }

    func test_currentPod_fallsBackToOldestNotNewest_whenLeaderDangles() {
        // leaderPodId set to a pod that isn't in the list (dangling) and no
        // currentPodId → currentPod must resolve to the OLDEST pod (pods.first),
        // never the last-added box.
        let app = AppState(
            isPaired: true, currentUser: "harry",
            pods: [
                PodInfo(podId: "oldest", name: "Oldest", fqdn: "oldest.harry.flagship.services", status: .online),
                PodInfo(podId: "newest", name: "Newest", fqdn: "newest.harry.flagship.services", status: .online)
            ],
            leaderPodId: "ghost", currentPodId: nil
        )
        XCTAssertEqual(app.currentPod?.podId, "oldest")
    }
}
