import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

@MainActor
final class KnockAuthorizeViewModelTests: XCTestCase {
    private let server = "home.alice.flagship.services"
    private let svc = "notes"
    private let ref = "alice-notes"
    private let page = "cb2421036efeb738c6017d8ee92e7b89"

    private func aid() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 9, count: 32))
    }

    private func makeVM(
        _ mock: MockServiceAccessClient,
        store: any SecuredSessionStoring,
        ref: String? = nil,
        page: String? = nil,
        now: @escaping () -> Int64 = { 1_700_004_000_000 }
    ) -> KnockAuthorizeViewModel {
        let k = aid()
        return KnockAuthorizeViewModel(
            client: mock,
            store: store,
            serverDomain: server,
            svc: svc,
            serviceRef: ref ?? self.ref,
            pageId: page ?? self.page,
            aid: { _ in k },
            now: now)
    }

    func testAuthorizeSuccessPersistsSessionAndPostsSignedAuthorization() async {
        let mock = MockServiceAccessClient()
        mock.authorizeKnockResult = AuthorizeKnockResult(
            secretId: String(repeating: "cd", count: 32),
            serviceRef: ref,
            browserAgent: "Mozilla/5.0 (Macintosh)",
            startedAt: 1_700_004_111_000,
            expiresAt: 1_700_004_999_000)
        let store = InMemorySecuredSessionStore()
        let vm = makeVM(mock, store: store)
        await vm.authorize()

        XCTAssertEqual(vm.phase, .authorized)
        // One authorize call with the expected fields.
        XCTAssertEqual(mock.authorizeKnockCalls.count, 1)
        let call = mock.authorizeKnockCalls[0]
        XCTAssertEqual(call.serverDomain, server)
        XCTAssertEqual(call.authorization["serverId"], server)
        XCTAssertEqual(call.authorization["serviceRef"], ref)
        XCTAssertEqual(call.authorization["pageId"], page)
        XCTAssertEqual(call.authorization["visitorAID"], HexUtil.encode(aid().publicKey.rawRepresentation))

        // The posted signature verifies against the canonical knock bytes the
        // box re-derives (CryptoKit sigs are randomized → verify, don't compare).
        let aidPub = aid().publicKey.rawRepresentation
        let bytes = try! ServiceInvite.canonicalKnock(
            serverId: server, serviceRef: ref, pageId: page,
            visitorAID: aidPub, issuedAt: 1_700_004_000_000)
        let sig = HexUtil.decode(call.signatureHex)!
        XCTAssertTrue(ServiceInvite.verify(sig, bytes, pub: aidPub))

        // The session was persisted with the box-returned secretId + metadata.
        let stored = store.list()
        XCTAssertEqual(stored.count, 1)
        XCTAssertEqual(stored[0].secretId, String(repeating: "cd", count: 32))
        XCTAssertEqual(stored[0].serverId, server)
        XCTAssertEqual(stored[0].serviceRef, ref)
        XCTAssertEqual(stored[0].serviceUrl, "https://notes.\(server)")
        XCTAssertEqual(stored[0].browserAgent, "Mozilla/5.0 (Macintosh)")
        XCTAssertEqual(stored[0].startedAt, 1_700_004_111_000)
    }

    func testDeniedNotAllowed401() async {
        let mock = MockServiceAccessClient()
        mock.nextError = ServiceAccessError.knockNotAllowed
        let store = InMemorySecuredSessionStore()
        let vm = makeVM(mock, store: store)
        await vm.authorize()
        if case .failed(let msg) = vm.phase {
            XCTAssertTrue(msg.contains("don't have access"))
        } else { XCTFail("expected .failed, got \(vm.phase)") }
        XCTAssertTrue(store.list().isEmpty)
    }

    func testBadRequest403() async {
        let mock = MockServiceAccessClient()
        mock.nextError = ServiceAccessError.knockBadRequest
        let vm = makeVM(mock, store: InMemorySecuredSessionStore())
        await vm.authorize()
        if case .failed(let msg) = vm.phase {
            XCTAssertTrue(msg.contains("refreshing"))
        } else { XCTFail("expected .failed") }
    }

    func testPageExpired404() async {
        let mock = MockServiceAccessClient()
        mock.nextError = ServiceAccessError.knockPageExpired
        let vm = makeVM(mock, store: InMemorySecuredSessionStore())
        await vm.authorize()
        if case .failed(let msg) = vm.phase {
            XCTAssertTrue(msg.contains("expired"))
        } else { XCTFail("expected .failed") }
    }

    func testMalformedRejectedBeforeNetwork() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, store: InMemorySecuredSessionStore(), ref: "")
        await vm.authorize()
        if case .failed = vm.phase {} else { XCTFail("expected .failed") }
        XCTAssertTrue(mock.authorizeKnockCalls.isEmpty)
    }

    func testServiceUrlFallsBackToApexWhenSvcEmpty() {
        let vm = KnockAuthorizeViewModel(
            client: MockServiceAccessClient(),
            store: InMemorySecuredSessionStore(),
            serverDomain: server, svc: "", serviceRef: ref, pageId: page,
            aid: { _ in self.aid() })
        XCTAssertEqual(vm.serviceUrl, "https://\(server)")
    }
}
