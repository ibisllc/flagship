import XCTest
import Security
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Names on a locked phone (docs/voici-locked-caller-names.md §7): the table builder, the locked lookups, the Keychain
/// item's class, and every erasure path. Mirrors Android VoiciLockedNamesTest.
@MainActor
final class VoiciLockedNamesTests: XCTestCase {
    private let day: Int64 = 86_400_000
    private let now: Int64 = 1_900_000_000_000
    private let mom = String(repeating: "a1", count: 32)
    private let dad = String(repeating: "b2", count: 32)
    private let pageA = String(repeating: "3f", count: 16)
    private let pageB = String(repeating: "a1", count: 16)
    private let secret = [UInt8](repeating: 0x2e, count: 32)
    private var memory = MemoryLockedNamesKeychain()

    override func setUp() {
        super.setUp()
        memory = MemoryLockedNamesKeychain()
        VoiciLockedNamesStore.keychain = memory
    }

    override func tearDown() {
        VoiciLockedNamesStore.keychain = SystemLockedNamesKeychain()
        super.tearDown()
    }

    private func call(_ pub: String, at: Int64, _ outcome: VoiciCallRecord.Outcome = .answered, conv: String? = nil) -> VoiciCallRecord {
        VoiciCallRecord(callId: UUID().uuidString, direction: .incoming, outcome: outcome, peer: .visitor(conv: conv ?? String(pub.prefix(32)), pseudonymPub: pub),
                        video: false, at: at)
    }

    private func build(nicknames: [String: String] = [:], blocked: Set<String> = [], forgotten: [String: MessagesState.Forgotten] = [:],
                       records: [VoiciCallRecord] = [], missed: [VoiciMissedCallRow] = [], includeNames: Bool = true,
                       pages: [VoiciLockedNames.RingPage] = [], stops: [String: Int64] = [:], secret: [UInt8]? = nil) -> VoiciLockedNamesTable {
        VoiciLockedNames.build(account: "Alice", now: now, includeNames: includeNames, nicknames: nicknames, blocked: blocked, forgotten: forgotten,
                               records: records, missed: missed, ringPages: pages, stoppedAt: stops, messagesSecret: secret ?? self.secret)
    }

    // MARK: the builder

    func test_aNicknameWithARecentCallIsKeptByAHashOfThePseudonym() {
        let t = build(nicknames: [mom: "Mom", dad: "Dad"], records: [call(mom, at: now - day)])
        XCTAssertEqual(t.account, "alice")
        XCTAssertEqual(t.names, [VoiciRings.lockedNameKey(pseudonymPub: mom): .init(n: "Mom", last: now - day)])
        XCTAssertFalse(String(data: try! JSONEncoder().encode(t), encoding: .utf8)!.contains(mom), "the table never holds the pub")
        XCTAssertEqual(VoiciLockedNames.name(for: mom, in: t, account: "alice", now: now), "Mom")
        XCTAssertNil(VoiciLockedNames.name(for: dad, in: t, account: "alice", now: now), "a nickname without a call")
        XCTAssertNil(VoiciLockedNames.name(for: mom, in: t, account: "bob", now: now), "another account's table")
    }

    func test_aMissedCallCountsAFailedOneDoesNot() {
        let missed = VoiciMissedCallRow(callId: "c1", conv: String(dad.prefix(32)), pseudonymPub: dad, reason: "no-answer", ringingAt: now - 2 * day, video: false)
        let t = build(nicknames: [mom: "Mom", dad: "Dad"], records: [call(mom, at: now - day, .failed)], missed: [missed])
        XCTAssertNil(VoiciLockedNames.name(for: mom, in: t, account: "alice", now: now))
        XCTAssertEqual(VoiciLockedNames.name(for: dad, in: t, account: "alice", now: now), "Dad")
    }

    func test_blockedForgottenAnonymousAndOldCallersAreLeftOut() {
        let anon = "04" + String(repeating: "cd", count: 64)
        let old = String(repeating: "c3", count: 32)
        let gone = String(repeating: "d4", count: 32)
        let t = build(nicknames: [mom: "Mom", anon: "Anon", old: "Old", gone: "Gone"], blocked: [mom],
                      forgotten: ["x": .init(at: now, pseudonymPub: gone)],
                      records: [call(mom, at: now), call(anon, at: now), call(old, at: now - 91 * day), call(gone, at: now)])
        XCTAssertTrue(t.names.isEmpty)
    }

    func test_namesAreOffWithoutTheAnswerSwitch() {
        XCTAssertTrue(build(nicknames: [mom: "Mom"], records: [call(mom, at: now)], includeNames: false).names.isEmpty)
    }

    func test_fiftyNewestOfEachKind() {
        var nicknames: [String: String] = [:], records: [VoiciCallRecord] = [], pages: [VoiciLockedNames.RingPage] = []
        for i in 0..<60 {
            let pub = String(format: "%064x", i + 1)
            nicknames[pub] = "N\(i)"
            records.append(call(pub, at: now - Int64(i) * 1000))
            pages.append(.init(username: "page-\(i)", pageId: String(format: "%032x", i + 1), last: now - Int64(i) * 1000))
        }
        let t = build(nicknames: nicknames, records: records, pages: pages)
        XCTAssertEqual(t.names.count, 50)
        XCTAssertEqual(t.rings.count, 50)
        XCTAssertNotNil(VoiciLockedNames.name(for: String(format: "%064x", 1), in: t, account: "alice", now: now))
        XCTAssertNil(VoiciLockedNames.name(for: String(format: "%064x", 60), in: t, account: "alice", now: now))
    }

    func test_aDeletedNicknameIsGoneAtTheNextRebuild() {
        XCTAssertFalse(build(nicknames: [mom: "Mom"], records: [call(mom, at: now)]).names.isEmpty)
        XCTAssertTrue(build(nicknames: [:], records: [call(mom, at: now)]).names.isEmpty)
    }

    // MARK: ring-backs

    func test_aRingBackIsNamedByItsTagOnly() throws {
        let t = build(pages: [.init(username: "brisk-quartz", pageId: pageA, last: now - day), .init(username: "other", pageId: pageB, last: now)])
        let key = try VoiciRings.deriveRingTagKey(messagesSecret: secret, pageId: pageA)
        XCTAssertEqual(t.rings[CanonicalJson.hex(key)]?.u, "brisk-quartz")
        let ringId = String(repeating: "5c", count: 16)
        let tag = try XCTUnwrap(VoiciRings.ringTag(tagKey: key, ringId: ringId))
        let hit = VoiciLockedNames.ringPage(for: VoiciRingPush(ringId: ringId, hint: "aA==", tag: tag), in: t, now: now)
        XCTAssertEqual(hit?.username, "brisk-quartz")
        XCTAssertEqual(hit?.pageId, pageA)
        XCTAssertNil(VoiciLockedNames.ringPage(for: VoiciRingPush(ringId: String(repeating: "6d", count: 16), hint: "aA==", tag: tag), in: t, now: now),
                     "the tag of another ring")
        XCTAssertNil(VoiciLockedNames.ringPage(for: VoiciRingPush(ringId: ringId, hint: "aA=="), in: t, now: now), "no tag")
        XCTAssertNil(VoiciLockedNames.ringPage(for: VoiciRingPush(ringId: ringId, hint: "aA==", tag: tag), in: t, now: now + 91 * day), "past 90 days")
    }

    func test_stopCallBacksAfterTheLastCallDropsThePage() {
        let p = VoiciLockedNames.RingPage(username: "brisk-quartz", pageId: pageA, last: now - day)
        XCTAssertTrue(build(pages: [p], stops: [pageA: now]).rings.isEmpty)
        XCTAssertEqual(build(pages: [p], stops: [pageA: now - 2 * day]).rings.count, 1, "a call after the stop attached again")
        XCTAssertTrue(build(pages: [.init(username: "brisk-quartz", pageId: pageA, last: now - 91 * day)]).rings.isEmpty)
    }

    func test_ringNames() {
        XCTAssertEqual(VoiciCallCenter.ringName(hint: nil, cached: nil), String(localized: "Someone you wrote to is calling back"))
        XCTAssertEqual(VoiciCallCenter.ringName(hint: nil, cached: ("brisk-quartz", pageA)), String(localized: "voi.ci/\("brisk-quartz") is calling back"))
        let hint = VoiciRingHint(pageId: pageA, username: "brisk-quartz", conv: String(repeating: "22", count: 32), ringId: String(repeating: "5c", count: 16),
                                 media: "audio", issuedAt: 1)
        XCTAssertEqual(VoiciCallCenter.ringName(hint: hint, cached: nil), "voi.ci/brisk-quartz")
    }

    // MARK: the Keychain item

    func test_theItemIsAfterFirstUnlockThisDeviceOnlyWithNoAccessControlOrGroup() {
        let q = VoiciLockedNamesStore.addQuery(username: "Alice", data: Data())
        XCTAssertEqual(q[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertEqual(q[kSecAttrService as String] as? String, "com.flagship.voici.locked-names")
        XCTAssertEqual(q[kSecAttrAccount as String] as? String, "alice")
        XCTAssertNil(q[kSecAttrAccessControl as String])
        XCTAssertNil(q[kSecAttrAccessGroup as String])
        XCTAssertNil(q[kSecAttrSynchronizable as String])
    }

    func test_storeRoundTripAndDelete() throws {
        let t = build(nicknames: [mom: "Mom"], records: [call(mom, at: now)])
        try VoiciLockedNamesStore.save(t)
        XCTAssertEqual(VoiciLockedNamesStore.load(username: "ALICE"), t)
        XCTAssertNil(VoiciLockedNamesStore.load(username: "bob"))
        VoiciLockedNamesStore.delete(username: "alice")
        XCTAssertNil(VoiciLockedNamesStore.load(username: "alice"))
        try VoiciLockedNamesStore.save(t)
        VoiciLockedNamesStore.deleteAll()
        XCTAssertTrue(memory.items.isEmpty)
    }

    // MARK: the store: rebuild and erasure

    private func messagesStore() async -> (MessagesStore, String) {
        GymSeams.adminRootSeed = GymSeams.gymAdminRootSeed
        GymSeams.accountRootSeed = Data(repeating: 0x44, count: 32)
        let user = "names-" + String(UUID().uuidString.prefix(8)).lowercased()
        let mock = MockVoiciComClient()
        mock.keys[user] = VoiciAccountKeys(irkPub: String(repeating: "11", count: 32),
                                           adminRootPub: CanonicalJson.hex(try! CanonicalJson.ed25519PublicKey(seed: Array(GymSeams.gymAdminRootSeed))))
        let s = MessagesStore()
        s.directDelivery = false
        s.configure(client: mock, username: user, deviceId: "e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0", isDemo: false)
        await s.refresh()
        return (s, user)
    }

    private func cleanUp(_ user: String) {
        MessagesStore.forgetLocal(username: user, allProfiles: false)
        VoiciCallHistory.shared.forgetInMemory()
        GymSeams.adminRootSeed = nil
        GymSeams.accountRootSeed = nil
    }

    func test_theSwitchBuildsFromTheUnlockedAccountAndOffErases() async throws {
        let (s, user) = await messagesStore()
        defer { cleanUp(user) }
        s.setShowNamesWhileLocked(true)
        XCTAssertTrue(VoiciLockedNamesSettings.isOn(user))
        XCTAssertNotNil(VoiciLockedNamesStore.load(username: user))
        // A call to a page (it attached the page's call-back) puts the page in the table at once.
        VoiciCallHistory.shared.record(VoiciCallRecord(callId: "o1", direction: .outgoing, outcome: .answered, peer: .page(username: "brisk-quartz", pageId: pageA),
                                                       video: false, at: Int64(Date().timeIntervalSince1970 * 1000)))
        let umk = try XCTUnwrap(Keystore.messagesUMKIfCached())
        let key = try VoiciRings.deriveRingTagKey(messagesSecret: VoiciMessages.deriveMessagesSecret(umk: Array(umk)), pageId: pageA)
        XCTAssertEqual(VoiciLockedNamesStore.load(username: user)?.rings[CanonicalJson.hex(key)]?.u, "brisk-quartz")
        s.setShowNamesWhileLocked(false)
        XCTAssertNil(VoiciLockedNamesStore.load(username: user))
        XCTAssertFalse(VoiciLockedNamesSettings.isOn(user))
    }

    func test_turningOffAnswerWhileLockedTurnsNamesOffAndErases() async {
        let (s, user) = await messagesStore()
        defer { cleanUp(user) }
        s.setShowNamesWhileLocked(true)
        XCTAssertNotNil(VoiciLockedNamesStore.load(username: user))
        await s.revokeCallKey()
        XCTAssertFalse(s.showsNamesWhileLocked)
        XCTAssertNil(VoiciLockedNamesStore.load(username: user))
    }

    func test_signOutRemoveThisDeviceAndWipeErase() async {
        let (s, user) = await messagesStore()
        defer { cleanUp(user) }
        s.setShowNamesWhileLocked(true)
        VoiciLockedNamesSettings.markSheetShown(user)
        // Sign out, Remove this device and account gone all run Keystore.wipe → onWipe → forgetLocal.
        MessagesStore.forgetLocal(username: user, allProfiles: false)
        XCTAssertNil(VoiciLockedNamesStore.load(username: user))
        XCTAssertFalse(VoiciLockedNamesSettings.isOn(user))
        XCTAssertFalse(VoiciLockedNamesSettings.sheetShown(user))
        // A full reset drops every account's table.
        try? VoiciLockedNamesStore.save(build())
        MessagesStore.forgetLocal(username: nil, allProfiles: true)
        XCTAssertTrue(memory.items.isEmpty)
    }

    func test_nothingIsWrittenWhileLocked() async {
        let (s, user) = await messagesStore()
        defer { cleanUp(user) }
        let fresh = MessagesStore()
        fresh.directDelivery = false
        fresh.configure(client: MockVoiciComClient(), username: user, deviceId: "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1", isDemo: false)
        s.setShowNamesWhileLocked(true)
        let before = VoiciLockedNamesStore.load(username: user)
        XCTAssertNotNil(before)
        // A store that never read the state blob this session (a cold start before the unlock) leaves the table alone.
        fresh.rebuildLockedNames()
        XCTAssertEqual(VoiciLockedNamesStore.load(username: user), before)
    }
}

final class MemoryLockedNamesKeychain: LockedNamesKeychain, @unchecked Sendable {
    var items: [String: [String: Any]] = [:]

    func add(_ query: [String: Any]) -> OSStatus {
        let k = "\(query[kSecAttrService as String] as? String ?? "")|\(query[kSecAttrAccount as String] as? String ?? "")"
        if items[k] != nil { return errSecDuplicateItem }
        items[k] = query
        return errSecSuccess
    }

    func read(service: String, account: String) -> Data? { items["\(service)|\(account)"]?[kSecValueData as String] as? Data }

    func delete(service: String, account: String?) {
        if let account { items["\(service)|\(account)"] = nil } else { items = items.filter { !$0.key.hasPrefix("\(service)|") } }
    }
}
