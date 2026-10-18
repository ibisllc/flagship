import XCTest
@testable import FlagshipCore
import FlagshipAPI

/// "This account was removed" (docs/account-gone.md): the 404 contract, the
/// local answers that stop the asking, the quiet toasts, and the words of the
/// admin-key warnings (docs/account-gone.md "exact strings").
final class AccountGoneTests: XCTestCase {
    override func setUp() {
        AccountGoneRegistry.shared.clear()
        AccountGoneRegistry.shared.setOwnNames([])
        AccountGoneRegistry.shared.onChange(nil)
    }

    override func tearDown() {
        AccountGoneRegistry.shared.clear()
        AccountGoneRegistry.shared.setOwnNames([])
        AccountGoneRegistry.shared.onChange(nil)
    }

    private func url(_ path: String) -> URL { URL(string: "https://flagshipserver.com\(path)")! }

    func testTheAccountANamedPathMeans() {
        XCTAssertEqual(AccountGoneRegistry.accountName(in: url("/api/users/Smoketest/pods")), "smoketest")
        XCTAssertEqual(AccountGoneRegistry.accountName(in: url("/api/accounts/smoketest/read-token")), "smoketest")
        XCTAssertEqual(AccountGoneRegistry.accountName(in: url("/api/users/smoketest")), "smoketest")
        XCTAssertNil(AccountGoneRegistry.accountName(in: url("/api/users/check")))
        XCTAssertNil(AccountGoneRegistry.accountName(in: url("/api/health")))
        XCTAssertNil(AccountGoneRegistry.accountName(in: url("/api/account/resolve/smoketest")))
        XCTAssertNil(AccountGoneRegistry.accountName(in: nil))
    }

    func testOnlyA404WithTheCodeForTheOwnAccountFlipsTheState() {
        let r = AccountGoneRegistry()
        r.setOwnNames(["smoketest", nil])
        let body = AccountGoneRegistry.body()
        XCTAssertFalse(r.note(url: url("/api/users/someone-else/pods"), status: 404, body: body), "another account's 404")
        XCTAssertFalse(r.note(url: url("/api/users/smoketest/pods"), status: 404, body: Data(#"{"error":"nope"}"#.utf8)), "no code")
        XCTAssertFalse(r.note(url: url("/api/users/smoketest/pods"), status: 401, body: body), "another status")
        XCTAssertFalse(r.note(url: url("/api/users/smoketest/pods"), status: 404, body: Data("junk".utf8)))
        XCTAssertNil(r.goneName)
        XCTAssertTrue(r.note(url: url("/api/accounts/SmokeTest/read-token"), status: 404, body: body))
        XCTAssertEqual(r.goneName, "smoketest")
        r.clear()
        XCTAssertNil(r.goneName)
    }

    func testASignedOutDeviceNeverFlips() {
        let r = AccountGoneRegistry()
        XCTAssertFalse(r.note(url: url("/api/users/smoketest/pods"), status: 404, body: AccountGoneRegistry.body()))
        XCTAssertNil(r.goneName)
    }

    // MARK: through the one gate

    final class Stub: URLProtocol {
        nonisolated(unsafe) static var seen: [URLRequest] = []
        nonisolated(unsafe) static var gone = true
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            Self.seen.append(request)
            let mine = request.url?.path.contains("/smoketest/") ?? false
            let status = Self.gone && mine ? 404 : 200
            let resp = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: status == 404 ? AccountGoneRegistry.body() : Data("{}".utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
        override func stopLoading() {}
    }

    func testTheFirstAnswerFlipsItAndEveryLaterCallForThatAccountIsAnsweredLocally() async throws {
        Stub.seen = []
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [Stub.self]
        let s = URLSession(configuration: c)
        AccountGoneRegistry.shared.setOwnNames(["smoketest"])

        let (_, first) = try await s.gatedData(for: URLRequest(url: url("/api/users/smoketest/pods")))
        XCTAssertEqual((first as? HTTPURLResponse)?.statusCode, 404)
        XCTAssertEqual(AccountGoneRegistry.shared.goneName, "smoketest")
        XCTAssertEqual(Stub.seen.count, 1)

        for path in ["/api/users/smoketest/pods", "/api/accounts/smoketest/read-token", "/api/users/smoketest/stream"] {
            var req = URLRequest(url: url(path))
            req.httpMethod = path.hasSuffix("read-token") ? "POST" : "GET"
            let (data, resp) = try await s.gatedData(for: req)
            XCTAssertEqual((resp as? HTTPURLResponse)?.statusCode, 404, path)
            XCTAssertEqual(try JSONSerialization.jsonObject(with: data) as? [String: String],
                           ["error": "account-not-found", "code": "account-not-found"], path)
        }
        XCTAssertEqual(Stub.seen.count, 1, "nothing more was sent for that account")

        // Another account's call still goes out.
        _ = try await s.gatedData(for: URLRequest(url: url("/api/users/someone-else/pods")))
        XCTAssertEqual(Stub.seen.count, 2)
    }

    @MainActor
    func testFailedCallsStayQuietWhileTheScreenIsUp() {
        let toasts = ToastCenter()
        toasts.error("Couldn't load")
        XCTAssertEqual(toasts.queue.count, 1)
        toasts.dismiss(toasts.queue[0].id)
        AccountGoneRegistry.shared.setOwnNames(["smoketest"])
        AccountGoneRegistry.shared.note(url: url("/api/users/smoketest/pods"), status: 404, body: AccountGoneRegistry.body())
        toasts.error("Couldn't load")
        toasts.warning("Status paused")
        XCTAssertEqual(toasts.queue.count, 0)
        toasts.success("Saved")
        XCTAssertEqual(toasts.queue.count, 1)
    }

    @MainActor
    func testTheCenterFollowsTheRegistryAndClearsIt() async throws {
        let center = AccountGoneCenter()
        center.setOwnNames(["smoketest"])
        XCTAssertFalse(center.isGone)
        AccountGoneRegistry.shared.note(url: url("/api/users/smoketest/device-grants"), status: 404, body: AccountGoneRegistry.body())
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(center.goneName, "smoketest")
        center.clear()
        XCTAssertFalse(center.isGone)
        XCTAssertFalse(AccountGoneRegistry.shared.isGone)
    }

    // MARK: the admin-key warnings

    func testTheWarningWordsAreTheOwnersExactStrings() {
        let remove = AdminKeyWarning.remove
        XCTAssertEqual(remove.title, "Remove this account from this device?")
        XCTAssertEqual(remove.message, "This also removes this device's admin key, which you need to sign in to your servers. Save a backup of your account key first, or remove anyway.")
        XCTAssertEqual(remove.choices.map(\.label), ["Save my account key first", "Remove anyway"])
        XCTAssertEqual(remove.choices.map(\.role), [.save, .go])

        let notBackedUp = AdminKeyWarning.signOut(backedUp: false)
        XCTAssertEqual(notBackedUp.title, "Sign out?")
        XCTAssertEqual(notBackedUp.message, "Signing out removes this device's admin key. Save a backup of your account key first, or sign out anyway.")
        XCTAssertEqual(notBackedUp.choices.map(\.label), ["Save my account key first", "Sign out anyway"])
        XCTAssertEqual(notBackedUp.choices.map(\.role), [.save, .go])

        let backedUp = AdminKeyWarning.signOut(backedUp: true)
        XCTAssertEqual(backedUp.message, "Signing out removes this device's admin key. You backed up your account key, so keep that file and its passphrase safe.")
        XCTAssertEqual(backedUp.choices.map(\.label), ["Cancel", "Sign out"])
        XCTAssertEqual(backedUp.choices.map(\.role), [.cancel, .go])

        XCTAssertEqual(AdminKeyCopy.unlockFirst, "Unlock first to save your key.")
    }

    func testWhoIsWarned() {
        XCTAssertTrue(AdminKeyWarning.holdsRescueKey(isDemoAccount: false, hasAdminRoot: true, serverSessionCount: 0))
        XCTAssertTrue(AdminKeyWarning.holdsRescueKey(isDemoAccount: false, hasAdminRoot: false, serverSessionCount: 2))
        XCTAssertFalse(AdminKeyWarning.holdsRescueKey(isDemoAccount: false, hasAdminRoot: false, serverSessionCount: 0))
        XCTAssertFalse(AdminKeyWarning.holdsRescueKey(isDemoAccount: true, hasAdminRoot: true, serverSessionCount: 3), "a demo account holds no keys")
    }

    func testKeyBackupStateIsPerAccount() {
        let d = UserDefaults(suiteName: "keybackup-\(UUID().uuidString)")!
        XCTAssertFalse(KeyBackupState.hasBackup(username: "smoketest", defaults: d))
        KeyBackupState.record(username: "SmokeTest", defaults: d)
        XCTAssertTrue(KeyBackupState.hasBackup(username: "smoketest", defaults: d))
        XCTAssertFalse(KeyBackupState.hasBackup(username: "other", defaults: d))
        KeyBackupState.forget(username: "smoketest", defaults: d)
        XCTAssertFalse(KeyBackupState.hasBackup(username: "smoketest", defaults: d))
    }
}
