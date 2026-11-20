import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Calls settings, the thread's missed-call rows and the call screen's states (docs/voici-calls.md §6, §8).
final class VoiciCallsViewModelTests: XCTestCase {
    // MARK: settings

    func test_callsFieldsAreV2OnlyWhileOn() {
        XCTAssertTrue(VoiciCallSettings.indexFields(on: true, from: "signed-in") == (1, "signed-in"))
        XCTAssertTrue(VoiciCallSettings.indexFields(on: true, from: "anyone") == (1, "anyone"))
        XCTAssertTrue(VoiciCallSettings.indexFields(on: true, from: "callback") == (1, "callback"))
        XCTAssertTrue(VoiciCallSettings.indexFields(on: true, from: "nobody") == (1, "accepted"))
        XCTAssertEqual(VoiciCallSettings.mode("accepted"), "callback")
        XCTAssertEqual(VoiciCallSettings.mode("anyone"), "anyone")
        XCTAssertTrue(VoiciCallSettings.indexFields(on: false, from: "signed-in") == (nil, nil))
        XCTAssertTrue(VoiciCallSettings.read(acceptsCalls: nil, callsFrom: nil) == (false, "accepted"))
        // "Anyone signed in with Flagship" is no longer offered (owner, 2026-11-20): an index that says so reads as
        // callback, so the next publish (which carries what it reads) writes callback.
        XCTAssertTrue(VoiciCallSettings.read(acceptsCalls: 1, callsFrom: "signed-in") == (true, "callback"))
        XCTAssertTrue(VoiciCallSettings.read(acceptsCalls: 0, callsFrom: "signed-in") == (false, "callback"))
        XCTAssertTrue(VoiciCallSettings.read(acceptsCalls: 1, callsFrom: "anyone") == (true, "anyone"))
    }

    func test_firstPublishDefaultsAndTheModesOffered() {
        XCTAssertTrue(VoiciCallSettings.firstPublish == (true, "callback"))
        XCTAssertEqual(VoiciCallSettings.firstPublishAcceptsMessages, 1)
        XCTAssertEqual(VoiciCallSettings.modes, ["anyone", "callback"], "No \"Anyone signed in with Flagship\" in the picker.")
        XCTAssertEqual(VoiciCallSettings.mode("signed-in"), "callback")
        XCTAssertEqual(VoiciCallSettings.mode("accepted"), "callback")
        XCTAssertTrue(VoiciCallSettings.fromValues.contains("signed-in"), "Old indexes still read.")
    }

    func test_viewState() {
        let admin = VoiciCallSettings.viewState(isAdmin: true, isPublic: true, callsOn: true, noRingMode: false)
        XCTAssertTrue(admin.canEdit)
        XCTAssertTrue(admin.showsWho)
        XCTAssertNil(admin.note)
        XCTAssertFalse(admin.noRingNote)

        let off = VoiciCallSettings.viewState(isAdmin: true, isPublic: true, callsOn: false, noRingMode: false)
        XCTAssertTrue(off.canEdit)
        XCTAssertFalse(off.showsWho)

        let other = VoiciCallSettings.viewState(isAdmin: false, isPublic: true, callsOn: true, noRingMode: false)
        XCTAssertFalse(other.canEdit)
        XCTAssertEqual(other.note, .adminOnly)
        XCTAssertTrue(other.showsWho)

        let unpublished = VoiciCallSettings.viewState(isAdmin: true, isPublic: false, callsOn: false, noRingMode: true)
        XCTAssertFalse(unpublished.canEdit)
        XCTAssertEqual(unpublished.note, .publishFirst)
        XCTAssertTrue(unpublished.noRingNote)
    }

    func test_settingsStoreRoundTrip() throws {
        let d = try XCTUnwrap(UserDefaults(suiteName: "VoiciCallsViewModelTests"))
        d.removePersistentDomain(forName: "VoiciCallsViewModelTests")
        XCTAssertEqual(CallSettingsStore.lastFrom(d), "callback", "Calls turned on by hand start from the first-publish mode.")
        CallSettingsStore.setLastFrom("anyone", d)
        XCTAssertEqual(CallSettingsStore.lastFrom(d), "anyone")
        CallSettingsStore.setLastFrom("everyone", d)
        XCTAssertEqual(CallSettingsStore.lastFrom(d), "anyone")
        // The removed app Do Not Disturb: its old record goes, nothing reads it.
        d.set(Data([1, 2, 3]), forKey: "flagship.voici.calls.quiet")
        CallSettingsStore.forgetRemovedSettings(d)
        XCTAssertNil(d.object(forKey: "flagship.voici.calls.quiet"))
    }

    // MARK: thread

    private func message(_ id: String, at: Int64, owner: Bool = false) -> VoiciThreadMessage {
        VoiciThreadMessage(msgId: id, conv: "c1", fromOwner: owner, from: "p", seq: 1, text: id, replyTo: nil, sentAt: at, receipt: .sent, envelope: .null)
    }

    private func call(_ id: String, at: Int64, conv: String = "c1", video: Bool = false) -> VoiciMissedCallRow {
        VoiciMissedCallRow(callId: id, conv: conv, pseudonymPub: "p", reason: "no-answer", ringingAt: at, video: video)
    }

    func test_timelinePutsEachMissedCallInTimeOrder() {
        let entries = VoiciThreadEntry.timeline(
            messages: [message("a", at: 10), message("b", at: 30, owner: true)],
            calls: [call("late", at: 40), call("mid", at: 20), call("other", at: 15, conv: "c2"), call("first", at: 5)],
            conv: "c1")
        XCTAssertEqual(entries.map(\.id), ["c:first", "m:a", "c:mid", "m:b", "c:late"])
    }

    func test_missedLabel() {
        XCTAssertEqual(VoiciThreadEntry.missedLabel(call("x", at: 1)), "Missed call")
        XCTAssertEqual(VoiciThreadEntry.missedLabel(call("x", at: 1, video: true)), "Missed video call")
    }

    /// The shared vector's missed call opens and checks; a forged one and an unknown inbox key are dropped.
    func test_openMissedCallsFromTheSharedVector() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../../packages/protocol/test-vectors/voici-calls/vectors.json").standardized
        let v = try XCTUnwrap(JSONValue.parse(utf8: Array(try Data(contentsOf: url))))
        let k = try XCTUnwrap(v["keys"]), mc = try XCTUnwrap(v["missedCall"])
        let callId = try XCTUnwrap(mc["entry"]?["request"]?["callId"]?.string)
        let inbox = try CanonicalJson.hexToBytes(try XCTUnwrap(k["inboxSeed"]?.string))
        let pageId = try XCTUnwrap(k["pageId"]?.string), origin = try XCTUnwrap(v["constants"]?["origin"]?.string)
        let ca = [try XCTUnwrap(k["caPub"]?.string)]
        let items = [
            VoiciMissedCallItem(id: "1", callId: callId, sealed: try XCTUnwrap(mc["sealed"]?.string), storedAt: 1),
            VoiciMissedCallItem(id: "2", callId: callId, sealed: try XCTUnwrap(mc["forgedSealed"]?.string), storedAt: 2),
        ]
        let rows = MessagesStore.openMissedCalls(items, seeds: [Array(repeating: 1, count: 32), inbox], pageId: pageId, origin: origin, caKeys: ca)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.conv, k["conv"]?.string)
        XCTAssertEqual(rows.first?.pseudonymPub, k["pseudonymPub"]?.string)
        XCTAssertEqual(rows.first?.reason, "no-answer")
        XCTAssertTrue(MessagesStore.openMissedCalls(items, seeds: [Array(repeating: 1, count: 32)], pageId: pageId, origin: origin, caKeys: ca).isEmpty)
    }

    // MARK: call screen

    func test_callScreenShowsRingingOnlyWithoutCallKit() {
        XCTAssertFalse(VoiciCallScreenModel.visible(.idle, noRingMode: true))
        XCTAssertFalse(VoiciCallScreenModel.visible(.ringing, noRingMode: false))
        XCTAssertTrue(VoiciCallScreenModel.visible(.ringing, noRingMode: true))
        XCTAssertTrue(VoiciCallScreenModel.visible(.needsUnlock, noRingMode: true))
        XCTAssertTrue(VoiciCallScreenModel.visible(.connected, noRingMode: false))
        XCTAssertTrue(VoiciCallScreenModel.visible(.ended("hangup"), noRingMode: false))
    }

    func test_callScreenStatus() {
        XCTAssertEqual(VoiciCallScreenModel.status(.idle), "")
        XCTAssertEqual(VoiciCallScreenModel.status(.needsUnlock), "Unlock Flagship to answer")
        XCTAssertEqual(VoiciCallScreenModel.status(.connected), "Quantum-safe call")
        XCTAssertEqual(VoiciCallScreenModel.status(.ended("answered-elsewhere")), "Answered on another device")
        XCTAssertEqual(VoiciCallScreenModel.status(.ended("media-unavailable")), "This version of Flagship can't connect calls yet.")
        XCTAssertEqual(VoiciCallScreenModel.status(.ended("limit")), "Calls end after 60 minutes.")
        XCTAssertEqual(VoiciCallScreenModel.status(.ended("no-answer")), "Call ended")
        XCTAssertEqual(VoiciCallScreenModel.status(.ended("failed")), "The call couldn't connect.")
    }

    func test_connectingSteps() {
        XCTAssertEqual(VoiciCallScreenModel.status(.connecting), "Connecting…")
        XCTAssertEqual(VoiciCallScreenModel.status(.connecting, step: .route), "Opening your line…")
        XCTAssertEqual(VoiciCallScreenModel.status(.connecting, step: .secure), "Securing the line (quantum-safe)…")
        XCTAssertEqual(VoiciCallScreenModel.status(.connecting, step: .path), "Opening a direct path…")
        XCTAssertEqual(VoiciCallScreenModel.status(.connecting, step: .audio), "Starting audio…")
        var s = VoiciCallConnectSteps()
        XCTAssertTrue(s.advance(to: .route))
        XCTAssertTrue(s.advance(to: .path))
        XCTAssertFalse(s.advance(to: .secure), "a late event never shows an earlier step")
        XCTAssertFalse(s.advance(to: .path))
        XCTAssertTrue(s.advance(to: .audio))
        XCTAssertEqual(VoiciCallConnectSteps.slowSeconds, 20)
        XCTAssertEqual(VoiciCallConnectSteps.limitSeconds, 45)
    }

    /// No Do Not Disturb of the app's own (owner, 2026-11-20): a fresh call rings (CallKit applies the phone's Focus),
    /// a late one doesn't.
    @MainActor
    func test_aFreshCallRingsWithoutAnAppDoNotDisturb() {
        let c = VoiciCallCenter()
        let now = Date()
        let at = Int64(now.timeIntervalSince1970 * 1000)
        c.clock = { now }
        c.ownerHours = { nil }
        XCTAssertTrue(c.shouldRing(issuedAt: at))
        XCTAssertFalse(c.shouldRing(issuedAt: at - VoiciCalls.ringMs - 1))
    }

    // MARK: call hours (the owner's synced setting, never in the page)

    func test_callHoursDraftRoundTrips() {
        let paris = VoiciCallHours(days: "1111100", from: "0900", to: "1730", zone: "Europe/Paris")
        let d = VoiciCallHoursDraft(paris)
        XCTAssertEqual(d?.days, [true, true, true, true, true, false, false])
        XCTAssertEqual(d?.startMinute, 540)
        XCTAssertEqual(d?.endMinute, 1050)
        XCTAssertEqual(d?.hours, paris)
        var x = VoiciCallHoursDraft.standard(zone: "UTC")
        XCTAssertEqual(x.hours, VoiciCallHours(days: "1111100", from: "0900", to: "1730", zone: "UTC"))
        x.days = Array(repeating: false, count: 7)
        XCTAssertNil(x.hours, "No day: not hours the setting takes.")
        XCTAssertNil(VoiciCallHoursDraft.standard(zone: "Mars/Olympus").hours, "An unknown zone isn't saved.")
        x = .standard(zone: "UTC")
        x.endMinute = x.startMinute
        XCTAssertNil(x.hours)
        x.startMinute = 22 * 60
        x.endMinute = 6 * 60
        XCTAssertEqual(x.hours?.to, "0600")
        XCTAssertNil(VoiciCallHoursDraft(nil))
    }

    /// Outside the owner's business hours this device doesn't ring (the call becomes a missed call).
    @MainActor
    func test_theRingingPhoneKeepsTheOwnersHours() {
        let center = VoiciCallCenter.shared
        let saved = (center.clock, center.ownerHours)
        defer { (center.clock, center.ownerHours) = saved }
        let monday10Paris: Int64 = 1_799_053_200_000, monday0859: Int64 = 1_799_049_540_000
        center.ownerHours = { VoiciCallSettingsValue(hours: VoiciCallHours(days: "1111100", from: "0900", to: "1730", zone: "Europe/Paris"), updatedAt: 1) }
        center.clock = { Date(timeIntervalSince1970: TimeInterval(monday10Paris) / 1000) }
        XCTAssertTrue(center.shouldRing(issuedAt: monday10Paris))
        center.clock = { Date(timeIntervalSince1970: TimeInterval(monday0859) / 1000) }
        XCTAssertFalse(center.shouldRing(issuedAt: monday0859))
        center.ownerHours = { nil }
        XCTAssertTrue(center.shouldRing(issuedAt: monday0859), "No hours: calls ring any time.")
    }

    /// The setting syncs through `.com` as ciphertext with compare-and-set; a conflict is a 409 with the stored blob.
    func test_callSettingsSyncThroughTheMock() async throws {
        let client = MockVoiciComClient()
        let key = VoiciCallSettingsSync.deriveKey(umk: Array(repeating: 1, count: 32))
        let a = VoiciCallSettingsValue(hours: VoiciCallHours(days: "1111111", from: "2200", to: "0600", zone: "UTC"), updatedAt: 5)
        try await client.putCallSettings(username: "alice", sealed: try VoiciCallSettingsSync.seal(key: key, username: "alice", version: 1, settings: a),
                                         device: { _, _ in nil })
        let stored = try await client.callSettings(username: "alice")
        XCTAssertEqual(VoiciCallSettingsSync.open(key: key, username: "alice", blob: stored), a)
        do {
            try await client.putCallSettings(username: "alice", sealed: try VoiciCallSettingsSync.seal(key: key, username: "alice", version: 1, settings: a),
                                             device: { _, _ in nil })
            XCTFail("a stale version")
        } catch let e as VoiciComError {
            XCTAssertEqual(e.code, "version-conflict")
            XCTAssertEqual(VoiciCallSettingsSync.version(e.stored), 1)
        }
    }
}
