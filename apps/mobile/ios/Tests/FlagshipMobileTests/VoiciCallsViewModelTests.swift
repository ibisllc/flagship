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
        XCTAssertTrue(VoiciCallSettings.read(acceptsCalls: 1, callsFrom: "signed-in") == (true, "signed-in"))
        XCTAssertTrue(VoiciCallSettings.read(acceptsCalls: 0, callsFrom: "signed-in") == (false, "signed-in"))
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

    func test_quietHoursAcrossMidnight() {
        let q = CallQuietHours(on: true, startMinute: 22 * 60, endMinute: 7 * 60)
        XCTAssertTrue(q.isQuiet(minuteOfDay: 23 * 60))
        XCTAssertTrue(q.isQuiet(minuteOfDay: 0))
        XCTAssertTrue(q.isQuiet(minuteOfDay: 6 * 60 + 59))
        XCTAssertFalse(q.isQuiet(minuteOfDay: 7 * 60))
        XCTAssertFalse(q.isQuiet(minuteOfDay: 12 * 60))
        XCTAssertTrue(q.isQuiet(minuteOfDay: 22 * 60))
        var off = q
        off.on = false
        XCTAssertFalse(off.isQuiet(minuteOfDay: 23 * 60))
    }

    func test_quietHoursSameDayAndAllDay() {
        let day = CallQuietHours(on: true, startMinute: 9 * 60, endMinute: 17 * 60)
        XCTAssertTrue(day.isQuiet(minuteOfDay: 12 * 60))
        XCTAssertFalse(day.isQuiet(minuteOfDay: 8 * 60))
        XCTAssertFalse(day.isQuiet(minuteOfDay: 17 * 60))
        XCTAssertTrue(CallQuietHours(on: true, startMinute: 600, endMinute: 600).isQuiet(minuteOfDay: 5))
        XCTAssertEqual(CallQuietHours(on: true, startMinute: -60, endMinute: 1500).startMinute, 1380)
    }

    func test_quietHoursAtADate() throws {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let q = CallQuietHours(on: true, startMinute: 22 * 60, endMinute: 7 * 60)
        let lateNight = try XCTUnwrap(cal.date(from: DateComponents(year: 2026, month: 11, day: 15, hour: 23, minute: 30)))
        let noon = try XCTUnwrap(cal.date(from: DateComponents(year: 2026, month: 11, day: 15, hour: 12)))
        XCTAssertTrue(q.isQuiet(at: lateNight, calendar: cal))
        XCTAssertFalse(q.isQuiet(at: noon, calendar: cal))
    }

    func test_settingsStoreRoundTrip() throws {
        let d = try XCTUnwrap(UserDefaults(suiteName: "VoiciCallsViewModelTests"))
        d.removePersistentDomain(forName: "VoiciCallsViewModelTests")
        XCTAssertEqual(CallSettingsStore.quietHours(d), .standard)
        XCTAssertEqual(CallSettingsStore.lastFrom(d), "accepted")
        let q = CallQuietHours(on: true, startMinute: 60, endMinute: 120)
        CallSettingsStore.setQuietHours(q, d)
        CallSettingsStore.setLastFrom("signed-in", d)
        XCTAssertEqual(CallSettingsStore.quietHours(d), q)
        XCTAssertEqual(CallSettingsStore.lastFrom(d), "signed-in")
        CallSettingsStore.setLastFrom("everyone", d)
        XCTAssertEqual(CallSettingsStore.lastFrom(d), "signed-in")
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
    }

    @MainActor
    func test_doNotDisturbKeepsThisDeviceSilent() {
        let c = VoiciCallCenter()
        var cal = Calendar.current
        cal.timeZone = .current
        let now = Date()
        let m = (cal.component(.hour, from: now) * 60 + cal.component(.minute, from: now))
        let at = Int64(now.timeIntervalSince1970 * 1000)
        c.clock = { now }
        c.quietHours = { CallQuietHours(on: true, startMinute: m, endMinute: m + 30) }
        XCTAssertFalse(c.shouldRing(issuedAt: at))
        c.quietHours = { CallQuietHours(on: false, startMinute: m, endMinute: m + 30) }
        XCTAssertTrue(c.shouldRing(issuedAt: at))
        XCTAssertFalse(c.shouldRing(issuedAt: at - VoiciCalls.ringMs - 1))
    }

    // MARK: call hours (the page index's callHours)

    func test_callHoursDraftRoundTrips() {
        let d = VoiciCallHoursDraft("1111100 0900-1730 Europe/Paris")
        XCTAssertEqual(d?.days, [true, true, true, true, true, false, false])
        XCTAssertEqual(d?.startMinute, 540)
        XCTAssertEqual(d?.endMinute, 1050)
        XCTAssertEqual(d?.value, "1111100 0900-1730 Europe/Paris")
        var x = VoiciCallHoursDraft.standard(zone: "UTC")
        XCTAssertEqual(x.value, "1111100 0900-1730 UTC")
        x.days = Array(repeating: false, count: 7)
        XCTAssertNil(x.value, "No day: not a value the index takes.")
        x = .standard(zone: "Mars/Olympus")
        XCTAssertNil(x.value, "An unknown zone isn't published.")
        x = .standard(zone: "UTC")
        x.endMinute = x.startMinute
        XCTAssertNil(x.value)
        x.startMinute = 22 * 60
        x.endMinute = 6 * 60
        XCTAssertEqual(x.value, "1111100 2200-0600 UTC")
        XCTAssertNil(VoiciCallHoursDraft(nil))
    }
}
