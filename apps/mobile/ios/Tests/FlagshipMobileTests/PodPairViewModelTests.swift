import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

@MainActor
final class PodPairViewModelTests: XCTestCase {
    private let server = "home.alice.flagship.services"

    private func key() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 9, count: 32))
    }
    private func store() -> SessionStore {
        SessionStore(defaults: UserDefaults(suiteName: "podpair-\(UUID().uuidString)")!)
    }

    /// Token generated → order IRK-signed → POST 200 → token persisted.
    func testPairSignsPostsAndPersistsToken() async {
        let mock = MockLockPowerClient()
        let s = store()
        let k = key()
        let vm = PodPairViewModel(
            client: mock,
            store: s,
            serverDomain: server,
            label: "iPhone",
            signer: { _ in k },
            now: { 1700 },
            makeToken: { "0011aabb" }
        )

        await vm.pair()

        XCTAssertEqual(vm.phase, .paired)
        // Posted to the box's orders endpoint, the add-paired-session shape.
        XCTAssertEqual(mock.sent.count, 1)
        let sent = mock.sent[0]
        XCTAssertEqual(sent.path, "/api/orders-from-user")
        XCTAssertEqual(sent.serverDomain, server)
        XCTAssertEqual(sent.request["type"], "add-paired-session")
        XCTAssertEqual(sent.request["token"], "0011aabb")
        XCTAssertEqual(sent.request["label"], "iPhone")
        // The posted signature verifies against the EXACT canonical bytes.
        let order = AddPairedSessionOrder(serverId: server, token: "0011aabb", label: "iPhone", issuedAt: 1700)
        let sig = Data(HexUtil.decode(sent.signatureHex)!)
        XCTAssertTrue(k.publicKey.isValidSignature(sig, for: order.canonicalBytes()))
        // The token was persisted ONLY after the POST succeeded.
        let token = await s.sessionToken
        XCTAssertEqual(token, "0011aabb")
    }

    /// Idempotent: a token already on disk → no-op, no biometric, no POST.
    func testIdempotentNoOpWhenTokenExists() async {
        let mock = MockLockPowerClient()
        let s = store()
        // Fix B — idempotency is now keyed PER POD, so the existing token must be
        // stored under this server's pod id (not just the legacy active slot).
        await s.setSessionToken("existing-token", forPodId: PodInfo.podId(forFqdn: server))
        var signerCalled = false
        let vm = PodPairViewModel(
            client: mock,
            store: s,
            serverDomain: server,
            signer: { _ in signerCalled = true; return self.key() }
        )

        await vm.pair()

        XCTAssertEqual(vm.phase, .alreadyPaired)
        XCTAssertFalse(signerCalled, "must not derive the IRK (no Face ID) when already paired")
        XCTAssertTrue(mock.sent.isEmpty, "must not POST when already paired")
        // The existing per-pod token is untouched.
        let token = await s.sessionToken(forPodId: PodInfo.podId(forFqdn: server))
        XCTAssertEqual(token, "existing-token")
    }

    /// A non-2xx from the box surfaces as failed AND does NOT persist a token
    /// (so the idempotency guard doesn't later block a real retry).
    func testPostFailureSurfacesAndDoesNotPersist() async {
        let mock = MockLockPowerClient()
        mock.nextError = ScreensClientError.http(status: 403, message: "no")
        let s = store()
        let vm = PodPairViewModel(client: mock, store: s, serverDomain: server, signer: { _ in self.key() })

        await vm.pair()

        if case .failed = vm.phase {} else { XCTFail("expected failed, got \(vm.phase)") }
        let token = await s.sessionToken
        XCTAssertNil(token, "no token should persist on a failed POST")
    }

    /// A signer (biometric) failure surfaces without any POST.
    func testSignerFailureSurfacesWithoutPost() async {
        let mock = MockLockPowerClient()
        struct E: Error {}
        let s = store()
        let vm = PodPairViewModel(client: mock, store: s, serverDomain: server, signer: { _ in throw E() })

        await vm.pair()

        if case .failed = vm.phase {} else { XCTFail("expected failed") }
        XCTAssertTrue(mock.sent.isEmpty, "must not POST when signing fails")
        let token = await s.sessionToken
        XCTAssertNil(token)
    }

    /// A device name carrying the canonical separator is sanitized so the
    /// daemon's `legacyFieldGuard`-on-verify can never reject the order.
    func testLabelSeparatorIsSanitized() async {
        let mock = MockLockPowerClient()
        let s = store()
        let vm = PodPairViewModel(
            client: mock, store: s, serverDomain: server,
            label: "Harry|iPhone", signer: { _ in self.key() }, makeToken: { "tok" }
        )
        await vm.pair()
        XCTAssertEqual(vm.phase, .paired)
        XCTAssertFalse(mock.sent[0].request["label"]!.contains("|"))
    }
}
