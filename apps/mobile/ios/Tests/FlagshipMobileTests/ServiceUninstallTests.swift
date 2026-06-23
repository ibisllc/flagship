import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore
@testable import Flagship

/// `ServiceDetailViewModel.uninstall` — the owner-IRK-signed box-direct service
/// removal that backs the server-detail "Remove service" button. Exercises the
/// canonical-bytes contract + the sign / DELETE / state-machine paths against
/// `MockServiceUninstallClient`, with a deterministic injected IRK signer so no
/// Keychain/biometric is touched (mirrors `FrontPageViewModelTests`).
@MainActor
final class ServiceUninstallTests: XCTestCase {

    private let serverDomain = "home.alice.flagship.services"

    private func key() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
    }

    private func makeVM(
        serviceId: String = "alice--notes",
        username: String? = "alice",
        serverDomain: String? = nil,
        uninstallClient: MockServiceUninstallClient,
        signer: @escaping @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    ) -> ServiceDetailViewModel {
        ServiceDetailViewModel(
            serviceId: serviceId,
            client: MockScreensClient(),
            allPods: [],
            globalLeaderPodId: nil,
            username: { username },
            uninstallClient: uninstallClient,
            serverDomain: serverDomain ?? self.serverDomain,
            irkSigner: signer
        )
    }

    // MARK: - canonical bytes contract

    func test_canonicalBytes_matchProtocolFieldOrder() {
        // Pin the daemon contract (canonicalUninstallService in
        // serviceLifecycle.ts): tag | serverId | creator | slug | issuedAt.
        let order = UninstallServiceOrder(
            serverId: "home.alice.flagship.services",
            creator: "alice",
            slug: "notes",
            issuedAt: 1700000000000
        )
        let s = String(data: order.canonicalBytes(), encoding: .utf8)!
        XCTAssertEqual(
            s,
            "flagship/uninstall-service/v1|home.alice.flagship.services|alice|notes|1700000000000"
        )
    }

    func test_envelope_hasStandaloneRequestShape() {
        // The DELETE body request map carries serverId/creator/slug/issuedAt
        // and NO `type` (uninstall is standalone, not a PhoneOrder).
        let order = UninstallServiceOrder(
            serverId: serverDomain, creator: "alice", slug: "notes", issuedAt: 42
        )
        let env = order.envelope(signatureHex: "ab")
        let request = env["request"] as! [String: Any]
        XCTAssertEqual(request["serverId"] as? String, serverDomain)
        XCTAssertEqual(request["creator"] as? String, "alice")
        XCTAssertEqual(request["slug"] as? String, "notes")
        XCTAssertEqual((request["issuedAt"] as? Int64) ?? Int64(request["issuedAt"] as? Int ?? -1), 42)
        XCTAssertNil(request["type"])
        XCTAssertEqual(env["signature"] as? String, "ab")
    }

    // MARK: - the wiring under test

    func test_uninstall_happyPath_sendsValidlySignedDelete() async {
        let k = key()
        let mock = MockServiceUninstallClient()
        let vm = makeVM(serviceId: "alice--notes", uninstallClient: mock, signer: { _ in k })

        let ok = await vm.uninstall()
        XCTAssertTrue(ok)
        XCTAssertEqual(vm.removePhase, .completed)

        // The mock client received the DELETE for the right service.
        XCTAssertEqual(mock.sent.count, 1)
        let sent = mock.sent[0]
        XCTAssertEqual(sent.serverDomain, serverDomain)
        XCTAssertEqual(sent.serviceId, "alice--notes")
        XCTAssertEqual(sent.request["serverId"], serverDomain)
        XCTAssertEqual(sent.request["creator"], "alice")
        XCTAssertEqual(sent.request["slug"], "notes")

        // The signature is a real 64-byte Ed25519 sig that verifies against
        // the EXACT canonical bytes the daemon will re-derive.
        XCTAssertEqual(sent.signatureHex.count, 128)
        let sig = HexUtil.decode(sent.signatureHex)!
        let issuedAt = Int64(sent.request["issuedAt"]!)!
        let order = UninstallServiceOrder(
            serverId: serverDomain, creator: "alice", slug: "notes", issuedAt: issuedAt
        )
        XCTAssertTrue(k.publicKey.isValidSignature(sig, for: order.canonicalBytes()))
    }

    func test_uninstall_resolvesCreatorSlugFromLoadedDetail() async {
        // After load(), the VM should sign with the detail's creator/slug
        // (the authoritative source), not merely a serviceId split.
        let k = key()
        let mock = MockServiceUninstallClient()
        // MockScreensClient seeds apps whose serviceId is `<creator>--<slug>`;
        // pick one that exists so load() populates detail.
        let client = MockScreensClient()
        let firstId = (try? await client.appsList().apps.first?.serviceId) ?? "alice--notes"
        let parts = firstId.components(separatedBy: "--")
        let vm = ServiceDetailViewModel(
            serviceId: firstId,
            client: client,
            allPods: [],
            globalLeaderPodId: nil,
            username: { "alice" },
            uninstallClient: mock,
            serverDomain: serverDomain,
            irkSigner: { _ in k }
        )
        await vm.load()
        let ok = await vm.uninstall()
        XCTAssertTrue(ok)
        let sent = mock.sent[0]
        XCTAssertEqual(sent.request["creator"], parts[0])
        XCTAssertEqual(sent.request["slug"], parts.count > 1 ? parts[1] : firstId)
    }

    func test_uninstall_noServerDomain_failsWithoutSending() async {
        var signerCalled = false
        let mock = MockServiceUninstallClient()
        let vm = makeVM(
            serverDomain: "",
            uninstallClient: mock,
            signer: { _ in signerCalled = true; return self.key() }
        )
        let ok = await vm.uninstall()
        XCTAssertFalse(ok)
        XCTAssertFalse(signerCalled)
        XCTAssertTrue(mock.sent.isEmpty)
        if case .failed = vm.removePhase {} else { XCTFail("expected .failed, got \(vm.removePhase)") }
    }

    func test_uninstall_signerFailure_surfacesWithoutSending() async {
        struct Nope: Error {}
        let mock = MockServiceUninstallClient()
        let vm = makeVM(uninstallClient: mock, signer: { _ in throw Nope() })
        let ok = await vm.uninstall()
        XCTAssertFalse(ok)
        XCTAssertTrue(mock.sent.isEmpty)
        if case .failed = vm.removePhase {} else { XCTFail("expected .failed, got \(vm.removePhase)") }
    }

    func test_uninstall_daemonError_surfacesFailure() async {
        // The transport rejected the DELETE (e.g. the daemon's 400 on a
        // serviceId / signature mismatch) — the VM must surface it as a
        // humanized .failed (and NOT report success / pop the screen).
        let mock = MockServiceUninstallClient()
        mock.nextError = ScreensClientError.http(status: 400, message: "serviceId mismatch")
        let vm = makeVM(uninstallClient: mock, signer: { _ in self.key() })
        let ok = await vm.uninstall()
        XCTAssertFalse(ok)
        if case .failed(let msg) = vm.removePhase {
            XCTAssertFalse(msg.isEmpty)
        } else {
            XCTFail("expected .failed, got \(vm.removePhase)")
        }
    }

    func test_isRemoving_reflectsInFlightPhase() async {
        let mock = MockServiceUninstallClient()
        let vm = makeVM(uninstallClient: mock, signer: { _ in self.key() })
        XCTAssertFalse(vm.isRemoving)
        await vm.uninstall()
        XCTAssertFalse(vm.isRemoving) // settled back after completion
        XCTAssertEqual(vm.removePhase, .completed)
    }
}
