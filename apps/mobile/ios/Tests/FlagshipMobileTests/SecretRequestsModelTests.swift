import XCTest
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

/// The Activity tab's "Server approvals" section lists and answers the pending
/// boot requests in place: loading, empty, failure, a count for the header, the
/// card going at once after an approval, and a 409 "already answered" counting
/// as done.
@MainActor
final class SecretRequestsModelTests: XCTestCase {
    private func request(_ domain: String, nonce: String = "aa") -> SecretRequestCoordinator.VerifiedRequest {
        .init(
            pending: PendingSecretRequest(
                serverDomain: domain, requestNonceHex: nonce, stkPub: "00", purpose: "unlock-key",
                issuedAt: 1, requestSignature: "00", deviceInfo: nil, postedAt: 1, expiresAt: 2
            ),
            directoryStkPubHex: "00"
        )
    }

    private final class Source: ApprovalSource {
        var pending: [SecretRequestCoordinator.VerifiedRequest]
        var fetchError: Error?
        var approveError: Error?
        private(set) var approved: [String] = []
        init(_ pending: [SecretRequestCoordinator.VerifiedRequest]) { self.pending = pending }
        func verifiedRequests() async throws -> [SecretRequestCoordinator.VerifiedRequest] {
            if let fetchError { throw fetchError }
            return pending
        }
        @discardableResult
        func approve(_ request: SecretRequestCoordinator.VerifiedRequest, depositAutoLease: Bool) async throws -> String? {
            if let approveError { throw approveError }
            approved.append(request.id)
            pending.removeAll { $0.id == request.id }
            return "lease"
        }
        @discardableResult
        func approvePendingUnlock(serverDomain: String, depositAutoLease: Bool) async throws -> String? { nil }
        @discardableResult
        func approvePendingEntitlement(serverDomain: String) async throws -> String? { nil }
    }

    private func model(_ source: Source?) -> SecretRequestsModel {
        SecretRequestsModel(
            source: { source },
            bootUnlock: BootUnlockStore(defaults: UserDefaults(suiteName: "approvals-\(UUID().uuidString)")!)
        )
    }

    func test_loadsThePendingRequestsAndCountsThem() async {
        let m = model(Source([request("a.u.flagship.services"), request("b.u.flagship.services")]))
        XCTAssertEqual(m.pendingCount, 0, "nothing counted before it loads")
        await m.loadIfNeeded()
        XCTAssertEqual(m.pendingCount, 2)
    }

    func test_nothingWaitingIsAnEmptyList() async {
        let m = model(Source([]))
        await m.reload()
        guard case .loaded(let r) = m.state else { return XCTFail("expected loaded") }
        XCTAssertTrue(r.isEmpty)
        XCTAssertEqual(m.pendingCount, 0)
        XCTAssertEqual(SecretRequestsModel.emptyText, "Nothing waiting for you")
    }

    func test_aFailedLoadIsASentenceAndTryAgainWorks() async {
        let s = Source([request("a.u.flagship.services")])
        s.fetchError = URLError(.timedOut)
        let m = model(s)
        await m.reload()
        guard case .failed(let msg) = m.state else { return XCTFail("expected failed") }
        XCTAssertEqual(msg, UserErrorText.timeout)
        s.fetchError = nil
        await m.reload()
        XCTAssertEqual(m.pendingCount, 1)
    }

    func test_signedOutSaysSo() async {
        let m = model(nil)
        await m.reload()
        guard case .failed(let msg) = m.state else { return XCTFail("expected failed") }
        XCTAssertEqual(msg, SecretRequestsModel.signInText)
    }

    func test_approvingClearsTheCardAndTheCount() async {
        let a = request("a.u.flagship.services"), b = request("b.u.flagship.services", nonce: "bb")
        let s = Source([a, b])
        let m = model(s)
        await m.reload()
        let out = await m.approve(a)
        XCTAssertEqual(out, .approved(serverDomain: a.serverDomain))
        XCTAssertEqual(s.approved, [a.id])
        XCTAssertEqual(m.pendingCount, 1)
        XCTAssertNil(m.inFlightId)
    }

    func test_theCardGoesEvenIfTheRefreshAfterwardsStillListsIt() async {
        let a = request("a.u.flagship.services")
        let s = Source([a])
        let m = model(s)
        await m.reload()
        // The server is slow to drop it: the card must not linger meanwhile.
        s.pending = [a]
        let out = await m.approve(a)
        XCTAssertEqual(out, .approved(serverDomain: a.serverDomain))
    }

    func test_anAlreadyAnsweredRequestIsDoneWithNoErrorText() async {
        let a = request("a.u.flagship.services")
        let s = Source([a])
        s.approveError = ScreensClientError.http(status: 409, message: "already answered")
        let m = model(s)
        await m.reload()
        s.pending = []
        let out = await m.approve(a)
        XCTAssertEqual(out, .alreadyAnswered)
        XCTAssertEqual(m.pendingCount, 0, "the card is gone")
    }

    func test_otherFailuresKeepTheCardAndSayWhy() async {
        let a = request("a.u.flagship.services")
        let s = Source([a])
        s.approveError = ScreensClientError.http(status: 503, message: "error code: 1102")
        let m = model(s)
        await m.reload()
        let out = await m.approve(a)
        guard case .failed(let msg) = out else { return XCTFail("expected failed") }
        XCTAssertTrue(msg.hasPrefix("Approval failed: "), msg)
        XCTAssertFalse(msg.contains("1102"))
        XCTAssertEqual(m.pendingCount, 1, "still waiting")
    }

    func test_isAlreadyAnswered() {
        XCTAssertTrue(SecretRequestsModel.isAlreadyAnswered(ScreensClientError.http(status: 409, message: "")))
        XCTAssertFalse(SecretRequestsModel.isAlreadyAnswered(ScreensClientError.http(status: 403, message: "")))
        XCTAssertFalse(SecretRequestsModel.isAlreadyAnswered(URLError(.timedOut)))
    }
}
