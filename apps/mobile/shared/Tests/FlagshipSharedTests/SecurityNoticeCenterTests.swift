import XCTest
@testable import FlagshipCore
import FlagshipAPI

/// The notice state of an install (docs/security-notices.md section 5 and
/// 6.2): what is shown, what is remembered, what the lock refuses, and that a
/// failure of any kind leaves things as they were.
@MainActor
final class SecurityNoticeCenterTests: XCTestCase {
    private let t0: Int64 = 1_792_000_000_000
    private let lockFrom: Int64 = 1_793_209_600_000
    private let validUntil: Int64 = 1_794_592_000_000

    private var suiteName = ""
    private var defaults: UserDefaults!
    private var storage: SecurityNoticeStorage!
    private var chain: (pin: String, mandates: [[String: Any]])!

    override func setUp() {
        suiteName = "notice-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        storage = SecurityNoticeStorage(defaults: defaults)
        chain = SecurityNoticeGym.throwawayChain()
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
    }

    private final class Clock: @unchecked Sendable {
        var ms: Int64
        init(_ ms: Int64) { self.ms = ms }
        func now() -> Date { Date(timeIntervalSince1970: Double(ms) / 1000) }
    }

    private func make(_ names: [String], at ms: Int64, build: Int64 = 4, protocolLevel: Int64 = 1, pin: String? = nil,
                      lock: UpdateLock = UpdateLock(), clock: Clock? = nil)
        -> (center: SecurityNoticeCenter, feed: SecurityNoticeGym.Feed, clock: Clock, lock: UpdateLock) {
        let clock = clock ?? Clock(ms)
        let feed = SecurityNoticeGym.Feed(SecurityNoticeGym.answers(names, mandates: chain.mandates))
        let center = SecurityNoticeCenter(
            storage: storage, fetcher: feed, lock: lock,
            client: SecurityNoticeClient(platform: "ios", build: build, protocolLevel: protocolLevel),
            pin: pin ?? chain.pin, minInterval: 900, maxJitter: 0, now: { clock.now() }
        )
        return (center, feed, clock, lock)
    }

    func testMaintenanceShowsABannerWithTheLocalDateAndStaysDismissed() async throws {
        let a = make(["maintenance"], at: t0 + 86_400_000)
        await a.center.refresh()
        guard case let .banner(style, notice) = a.center.outcome else { return XCTFail("no banner: \(a.center.outcome)") }
        XCTAssertEqual(style, .maintenance)
        XCTAssertTrue(a.center.bannerVisible)
        let text = notice.text { _ in "Wednesday, October 21 at 9:00 AM" }
        XCTAssertEqual(text, "We will update on Wednesday, October 21 at 9:00 AM. Flagship may be briefly unavailable.")
        XCTAssertFalse(a.lock.isLocked)
        a.center.dismissBanner()
        XCTAssertFalse(a.center.bannerVisible)
        // A new launch (a new center on the same store) remembers it for this seq.
        let b = make([], at: t0 + 86_400_000)
        b.center.evaluate()
        XCTAssertFalse(b.center.bannerVisible)
    }

    func testAnUpdateRequiredNoticeNagsUntilItsLockDateThenLocks() async throws {
        let a = make(["lock"], at: lockFrom - 3_600_000)
        await a.center.refresh()
        guard case let .banner(style, _) = a.center.outcome else { return XCTFail("no nag: \(a.center.outcome)") }
        XCTAssertEqual(style, .update)
        XCTAssertFalse(a.lock.isLocked)
        // Dismissing the nag lasts the launch only.
        a.center.dismissBanner()
        XCTAssertFalse(a.center.bannerVisible)
        let relaunch = make([], at: lockFrom - 3_600_000)
        relaunch.center.evaluate()
        XCTAssertTrue(relaunch.center.bannerVisible)
        // The lock date arrives.
        a.clock.ms = lockFrom
        a.center.evaluate()
        XCTAssertTrue(a.center.isLocked)
        XCTAssertTrue(a.lock.isLocked)
    }

    func testTheLockLiftsWhenTheBuildIsUpdatedTheNoticeEndsOrAnAllClearComes() async throws {
        let locked = make(["lock", "clear", "lock"], at: lockFrom + 3_600_000)
        await locked.center.refresh()
        XCTAssertTrue(locked.lock.isLocked)
        // A signed all clear supersedes it.
        await locked.center.refresh()
        XCTAssertFalse(locked.center.isLocked)
        XCTAssertFalse(locked.lock.isLocked)
        // Replaying the older lock is refused as a rollback.
        let refusal = await locked.center.refresh()
        XCTAssertEqual(refusal, "stale")
        XCTAssertFalse(locked.lock.isLocked)

        storage.clear()
        // The updated build carries the new protocol level too (the notice names both).
        let updated = make(["lock"], at: lockFrom + 3_600_000, build: 12, protocolLevel: 2)
        await updated.center.refresh()
        XCTAssertFalse(updated.lock.isLocked, "a build at the minimum is not locked")

        storage.clear()
        let newBuildOldProtocol = make(["lock"], at: lockFrom + 3_600_000, build: 50, protocolLevel: 1)
        await newBuildOldProtocol.center.refresh()
        XCTAssertTrue(newBuildOldProtocol.lock.isLocked, "a newer build on the old protocol level is still below the minimum")

        storage.clear()
        let ended = make(["lock"], at: lockFrom + 3_600_000)
        await ended.center.refresh()
        XCTAssertTrue(ended.lock.isLocked)
        ended.clock.ms = validUntil
        ended.center.evaluate()
        XCTAssertFalse(ended.lock.isLocked, "a lock is never shown past validUntil, however stale the cache")
    }

    func testFailsOpen() async throws {
        let a = make(["forged", "failed", "junk", "empty"], at: lockFrom + 3_600_000)
        for _ in 0..<4 { await a.center.refresh() }
        XCTAssertEqual(a.center.outcome, .none(why: "kind-none"))
        XCTAssertFalse(a.lock.isLocked)
        XCTAssertEqual(storage.load().highestSeq, 0)
        XCTAssertNil(storage.load().doc)
    }

    func testALockTheBakedPinCannotVouchForLocksNothing() async throws {
        // The real baked pin is not in the throwaway chain's log.
        let a = make(["lock"], at: lockFrom + 3_600_000, pin: MaintainersTrust.bakedPin)
        let refused = await a.center.refresh()
        XCTAssertEqual(refused, "unauthorized-signer")
        XCTAssertFalse(a.lock.isLocked)
        XCTAssertNil(storage.load().doc)
    }

    func testAStoredLockIsReverifiedAndDroppedWhenTheAuthorityCannotBeShown() async throws {
        let a = make(["lock"], at: lockFrom + 3_600_000)
        await a.center.refresh()
        XCTAssertTrue(a.lock.isLocked)
        // Same store, but this launch cannot show the authority (wrong pin).
        let b = make([], at: lockFrom + 3_600_000, pin: MaintainersTrust.bakedPin)
        b.center.evaluate()
        XCTAssertFalse(b.lock.isLocked)
    }

    func testAnOlderMandateChainThanTheNewestSeenIsRefused() async throws {
        let a = make(["lock"], at: lockFrom + 3_600_000)
        await a.center.refresh()
        var state = storage.load()
        XCTAssertGreaterThan(state.tip, 0)
        // Pretend a newer authority mandate was seen before this chain's.
        state.tip += 86_400_000
        state.highestSeq = 0
        storage.save(state)
        let b = make(["lock"], at: lockFrom + 3_600_000)
        let refused = await b.center.refresh()
        XCTAssertEqual(refused, "unauthorized-signer")
    }

    func testAFreshInstallHasNothingAndACorruptStoreReadsAsEmpty() throws {
        XCTAssertEqual(storage.load(), SecurityNoticeStoreState())
        defaults.set(Data("not json".utf8), forKey: SecurityNoticeStorage.key)
        XCTAssertEqual(storage.load(), SecurityNoticeStoreState())
    }

    func testPollsOnForegroundOnlyWhenTheLastAttemptIsFifteenMinutesOld() async throws {
        let a = make(["maintenance", "empty", "empty"], at: t0 + 86_400_000)
        await a.center.refresh()
        XCTAssertEqual(a.center.fetchCount, 1)
        a.center.foreground()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(a.center.fetchCount, 1, "under 15 minutes: no new request")
        a.clock.ms += 15 * 60_000
        a.center.foreground()
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(a.center.fetchCount, 2)
    }

    func testBuildComesFromCFBundleVersionAndAnUnreadableOneNeverLocksByBuild() {
        XCTAssertEqual(SecurityNoticeClient.current(bundle: Bundle(for: Self.self)).platform, "ios")
        XCTAssertEqual(SecurityNoticeClient.current(bundle: Bundle(for: Self.self)).protocolLevel, clientProtocolLevel)
        let none = Bundle(path: NSTemporaryDirectory()) ?? Bundle.main
        let unreadable = SecurityNoticeClient.current(bundle: none)
        XCTAssertTrue(unreadable.build == Int64.max || unreadable.build > 0)
    }

    /// The gym's embedded copies are the vectors', byte for byte.
    func testGymNoticesAreTheSharedVectors() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/security-notice/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                let v = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
                let positive = try XCTUnwrap(v["positive"] as? [[String: Any]])
                func named(_ n: String) throws -> NSDictionary {
                    NSDictionary(dictionary: try XCTUnwrap(positive.first { $0["name"] as? String == n }?["notice"] as? [String: Any]))
                }
                func gym(_ k: String) throws -> NSDictionary {
                    NSDictionary(dictionary: try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(SecurityNoticeGym.notices[k]).utf8)) as? [String: Any]))
                }
                XCTAssertEqual(try gym("maintenance"), try named("maintenance"))
                XCTAssertEqual(try gym("lock"), try named("update-required with a grace window"))
                XCTAssertEqual(try gym("clear"), try named("none (all clear)"))
                let seed = try XCTUnwrap((v["keys"] as? [String: Any])?["authoritySeedHex"] as? String)
                XCTAssertEqual(SecurityNoticeGym.authoritySeedHex, seed)
                return
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found")
    }
}
