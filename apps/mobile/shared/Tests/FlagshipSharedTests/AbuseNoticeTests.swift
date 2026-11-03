import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore

/// docs/abuse-handling.md §4-§5: the signed "done" note against the shared vectors
/// (packages/protocol/test-vectors/abuse-notice-done), the notices read, the banner and the suspended screen.
final class AbuseNoticeTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/abuse-notice-done/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found")
    }

    private func unhex(_ h: String) -> Data {
        var d = Data(); var i = h.startIndex
        while i < h.endIndex { let n = h.index(i, offsetBy: 2); d.append(UInt8(h[i..<n], radix: 16)!); i = n }
        return d
    }

    private func done(_ o: [String: Any]) -> AbuseNoticeDone {
        AbuseNoticeDone(username: o["username"] as! String, noticeId: o["noticeId"] as! String,
                        note: o["note"] as! String, issuedAt: (o["issuedAt"] as! NSNumber).int64Value)
    }

    func test_vectorsCanonicalBytesAndSignatures() throws {
        let v = try vectors()
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: unhex(v["seedHex"] as! String))
        XCTAssertEqual(key.publicKey.rawRepresentation, unhex(v["pubHex"] as! String))
        for c in v["done"] as! [[String: Any]] {
            let d = done(c["done"] as! [String: Any])
            let bytes = try d.canonicalBytes()
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), c["canonical"] as! String)
            // CryptoKit's Ed25519 adds randomness, so the vector's signature is checked, not reproduced.
            XCTAssertTrue(key.publicKey.isValidSignature(unhex(c["signatureHex"] as! String), for: bytes))
            let req = try d.request(signedWith: key)
            XCTAssertTrue(key.publicKey.isValidSignature(unhex(req.signature), for: bytes))
            XCTAssertEqual(req.request.username, d.username.lowercased())
        }
    }

    func test_vectorsRefusedCases() throws {
        let v = try vectors()
        for r in v["refused"] as! [[String: Any]] {
            XCTAssertThrowsError(try done(r["done"] as! [String: Any]).canonicalBytes(), r["name"] as! String)
        }
    }

    private let sample = """
    {"notices":[{"id":"0123456789abcdef0123456789abcdef","subjectKind":"app","subject":"chess.alice.flagship.services",
    "serviceId":"alice--chess","category":"phishing","action":"take-down","detail":"The login page copies a bank.",
    "deadlineAt":1762100000000,"issuedAt":1762000000000,"doneAt":null,"doneNote":null}],
    "suspension":null}
    """

    func test_decodesTheNoticesRead() throws {
        let r = try JSONDecoder().decode(AbuseNoticesResponse.self, from: Data(sample.utf8))
        XCTAssertEqual(r.notices.count, 1)
        XCTAssertEqual(r.notices[0].action, "take-down")
        XCTAssertNil(r.notices[0].doneAt)
        XCTAssertNil(r.suspension)
        let empty = try JSONDecoder().decode(AbuseNoticesResponse.self, from: Data("{}".utf8))
        XCTAssertEqual(empty, AbuseNoticesResponse())
        let s = try JSONDecoder().decode(AbuseNoticesResponse.self, from: Data("""
        {"notices":[],"suspension":{"suspendedAt":5,"category":"malware","reason":"Serves malware.",
        "appealEmail":"abuse@flagship.services","appealUrl":"https://flagshipserver.com/abuse#appeal"}}
        """.utf8))
        XCTAssertEqual(s.suspension?.category, "malware")
    }

    func test_bannerIsForAdminDevicesOnly_andSaysWhatAndWhen() throws {
        let r = try JSONDecoder().decode(AbuseNoticesResponse.self, from: Data(sample.utf8))
        XCTAssertTrue(AbuseNoticeBannerModel.banners(r.notices, isAdminDevice: false).isEmpty)
        let m = try XCTUnwrap(AbuseNoticeBannerModel.banners(r.notices, isAdminDevice: true, formatDate: { "D\($0)" }).first)
        XCTAssertEqual(m.title, "Action needed on your account")
        XCTAssertEqual(m.reported, "We received a report about chess.alice.flagship.services.")
        XCTAssertEqual(m.reason, "Reason: Phishing")
        XCTAssertEqual(m.todo, "What to do: take it down.")
        XCTAssertEqual(m.deadline, "Deadline: D1762100000000")
        XCTAssertEqual(m.warning, "If it is still there after the deadline, this account can be suspended.")
        XCTAssertEqual(m.detail, "The login page copies a bank.")
        XCTAssertTrue(m.showsDoneButton)
        XCTAssertNil(m.doneLine)
    }

    func test_bannerDoneState() {
        let n = AbuseNoticeWire(id: "0123456789abcdef0123456789abcdef", subjectKind: "page", subject: "https://voi.ci/alice",
                                category: "csam", action: "modify", detail: "  ", deadlineAt: 2, issuedAt: 1, doneAt: 9, doneNote: "gone")
        let m = AbuseNoticeBannerModel(notice: n, formatDate: { "D\($0)" })
        XCTAssertEqual(m.todo, "What to do: change it so it follows our rules.")
        XCTAssertEqual(m.reason, "Reason: Child sexual abuse material")
        XCTAssertNil(m.detail)
        XCTAssertEqual(m.doneLine, "Marked done on D9. We will check it.")
        XCTAssertFalse(m.showsDoneButton)
    }

    func test_categoryLabels() {
        let want = ["spam": "Spam", "phishing": "Phishing", "active-phishing": "Active phishing", "malware": "Malware",
                    "csam": "Child sexual abuse material", "harassment": "Harassment", "impersonation": "Impersonation",
                    "copyright": "Copyright infringement", "illegal": "Illegal content", "other": "Other", "???": "Other"]
        for (k, v) in want { XCTAssertEqual(AbuseCopy.categoryLabel(k), v, k) }
    }

    func test_suspendedModel() {
        let m = AccountSuspendedModel(
            suspension: AbuseSuspensionWire(suspendedAt: 1, category: "active-phishing", reason: "A fake bank login."),
            username: "Alice")
        XCTAssertEqual(m.title, "This account was suspended")
        XCTAssertEqual(m.reason, "Reason: Active phishing")
        XCTAssertEqual(m.operatorReason, "A fake bank login.")
        XCTAssertEqual(m.continueButton, "Continue to my data")
        XCTAssertEqual(m.appealButton, "Appeal")
        XCTAssertEqual(m.appealURL.absoluteString, "mailto:abuse@flagship.services?subject=Appeal%20(alice)")
        XCTAssertTrue(m.data.contains("Your data stays on your own server"))
    }

    @MainActor
    func test_centerReadsSuspends_dismissesForTheSession_andClears() async {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        mock.abuseNoticesResponse = AbuseNoticesResponse(suspension: AbuseSuspensionWire(suspendedAt: 1, category: "malware", reason: "x"))
        let center = AbuseNoticeCenter()
        await center.refresh(username: "alice", client: mock)
        XCTAssertTrue(center.showsSuspendedScreen)
        center.dismissSuspendedScreen()
        XCTAssertFalse(center.showsSuspendedScreen)
        XCTAssertTrue(center.isSuspended)
        await center.refresh(username: "alice", client: mock)
        XCTAssertFalse(center.showsSuspendedScreen, "put aside for the whole session")
        mock.abuseNoticesResponse = AbuseNoticesResponse()
        await center.refresh(username: "alice", client: mock)
        XCTAssertFalse(center.isSuspended)
        // A failed read keeps the last answer.
        mock.abuseNoticesResponse = AbuseNoticesResponse(suspension: AbuseSuspensionWire(suspendedAt: 1, category: "malware", reason: "x"))
        await center.refresh(username: "alice", client: mock)
        mock.shouldFail = true
        await center.refresh(username: "alice", client: mock)
        XCTAssertTrue(center.isSuspended)
        await center.refresh(username: nil, client: mock)
        XCTAssertFalse(center.isSuspended)
    }

    @MainActor
    func test_markDoneSignsAndRecords_andMapsTheRefusal() async throws {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        let id = "0123456789abcdef0123456789abcdef"
        mock.abuseNoticesResponse = AbuseNoticesResponse(notices: [
            AbuseNoticeWire(id: id, subjectKind: "app", subject: "a.alice.flagship.services", category: "spam",
                            action: "modify", deadlineAt: 2, issuedAt: 1),
        ])
        let center = AbuseNoticeCenter()
        await center.refresh(username: "alice", client: mock)
        let key = Curve25519.Signing.PrivateKey()
        let out = await center.markDone(noticeId: id, note: "  fixed it  ", key: key, client: mock, now: 1_762_000_000_000)
        XCTAssertEqual(out, .sent)
        let req = try XCTUnwrap(mock.abuseNoticesDone.first)
        XCTAssertEqual(req.request.note, "fixed it")
        let bytes = try AbuseNoticeDone(username: "alice", noticeId: id, note: "fixed it", issuedAt: 1_762_000_000_000).canonicalBytes()
        XCTAssertTrue(key.publicKey.isValidSignature(unhex(req.signature), for: bytes))
        XCTAssertNotNil(center.notices.first?.doneAt)

        mock.abuseNoticeDoneError = ScreensClientError.http(status: 403, message: #"{"code":"not-admin"}"#)
        let refused = await center.markDone(noticeId: id, note: "", key: key, client: mock)
        XCTAssertEqual(refused, .notAdmin)
        mock.abuseNoticeDoneError = ScreensClientError.http(status: 500, message: "")
        let failed = await center.markDone(noticeId: id, note: "", key: key, client: mock)
        XCTAssertEqual(failed, .failed)
    }

    func test_abuseNoticePushIsRecognised() {
        XCTAssertTrue(PushNotifications.isAbuseNotice(["aps": ["category": "abuse-notice"]]))
        XCTAssertTrue(PushNotifications.isAbuseNotice(["kind": "abuse-notice"]))
        XCTAssertTrue(PushNotifications.isAbuseNotice([:], categoryIdentifier: "abuse-notice"))
        XCTAssertFalse(PushNotifications.isAbuseNotice(["category": "messages"]))
        XCTAssertNil(PushNotifications.link(forPush: ["category": "abuse-notice", "kind": "abuse-notice"]))
    }
}
