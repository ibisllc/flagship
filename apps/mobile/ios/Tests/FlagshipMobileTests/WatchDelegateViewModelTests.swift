import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipUI

/// Phase iOS-C — the "Quick approve from Apple Watch" toggle orchestration.
/// All crypto + local-store side effects are injected so the test never
/// touches the real Keystore; the Mock server captures the wire so we can
/// assert the VM minted with the delegate key + the right scope/TTL.
@MainActor
final class WatchDelegateViewModelTests: XCTestCase {

    private final class GrantBox { var value: String? }

    private let username = "dani"
    private func irk() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x01, count: 32))
    }
    private func delegate() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x05, count: 32))
    }

    private func makeVM(server: MockFlagshipServerClient, grantBox: GrantBox) -> WatchDelegateViewModel {
        WatchDelegateViewModel(
            server: server,
            username: { self.username },
            signer: { _ in self.irk() },
            delegateKeyProvider: { self.delegate() },
            loadGrantId: { grantBox.value },
            saveGrantId: { grantBox.value = $0 },
            now: { 1_000_000 },
            grantIdGen: { "grant-fixed-1" }
        )
    }

    private func mock() -> MockFlagshipServerClient {
        let s = MockFlagshipServerClient()
        s.simulatedLatency = 0
        // Align the Mock's clock with the VM's injected `now` so the
        // 7-day-TTL expiry math is consistent (the Mock rejects an
        // already-expired mint + filters expired rows on list).
        s.nowProvider = { 1_000_000 }
        return s
    }

    func test_enable_mintsDelegate_andPersistsGrantId() async {
        let s = mock()
        let box = GrantBox()
        let vm = makeVM(server: s, grantBox: box)
        await vm.enable()

        XCTAssertEqual(vm.phase, .idle)
        XCTAssertTrue(vm.isEnabled)
        XCTAssertEqual(box.value, "grant-fixed-1")
        // 7-day TTL from the fixed clock.
        XCTAssertEqual(vm.expiresAt, 1_000_000 + WatchDelegateViewModel.defaultTtlMs)

        // The Mock stored exactly the delegate KEY the VM minted with.
        let stored = s.watchDelegatesByUser["dani"] ?? []
        XCTAssertEqual(stored.count, 1)
        XCTAssertEqual(stored.first?.scopes, ["boot-approval"])
        XCTAssertEqual(
            stored.first?.delegatePubKey,
            delegate().publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined()
        )
    }

    func test_disable_revokes_andClearsLocal() async {
        let s = mock()
        let box = GrantBox()
        let vm = makeVM(server: s, grantBox: box)
        await vm.enable()
        XCTAssertTrue(vm.isEnabled)

        await vm.disable()
        XCTAssertEqual(vm.phase, .idle)
        XCTAssertFalse(vm.isEnabled)
        XCTAssertNil(box.value, "the local grantId/key must be cleared on disable")
        let list = try? await s.listWatchDelegates(username: "dani")
        XCTAssertEqual(list?.delegates.count, 0)
    }

    func test_load_reflectsActiveDelegate() async {
        let s = mock()
        let box = GrantBox()
        let vm = makeVM(server: s, grantBox: box)
        // Seed the server with an active delegate (as if minted earlier).
        _ = try? await s.mintWatchDelegate(username: "dani", body: .init(
            grant: .init(grantId: "seed", username: "dani",
                         delegatePubKey: String(repeating: "aa", count: 32),
                         scopes: ["boot-approval"], issuedAt: 0, expiresAt: 9_000_000),
            signature: String(repeating: "bb", count: 64)))
        await vm.load()
        XCTAssertTrue(vm.isEnabled)
        XCTAssertEqual(vm.expiresAt, 9_000_000)
    }

    func test_load_emptyServer_isDisabled() async {
        let s = mock()
        let box = GrantBox()
        let vm = makeVM(server: s, grantBox: box)
        await vm.load()
        XCTAssertFalse(vm.isEnabled)
    }

    func test_disable_withoutGrantId_isNoOp_butClearsLocal() async {
        let s = mock()
        let box = GrantBox() // no grantId stored
        let vm = makeVM(server: s, grantBox: box)
        await vm.disable()
        XCTAssertFalse(vm.isEnabled)
        XCTAssertNil(box.value)
    }
}
