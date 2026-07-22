import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore

/// Last-device account-deletion ceremony — the iOS dedicated XCTest
/// (docs/account-deletion-and-name-reclaim.md §2/§5). The build-green +
/// cross-platform canonical vectors already cover the envelope bytes; this
/// pins the VIEW-MODEL behaviour the ceremony's safety rests on:
///   - the opt-in checkbox is what decides whether the servers-self-delete
///     order is bundled (never standalone, §5);
///   - the local key wipe + drop-to-Welcome happen ONLY after a 200;
///   - a 403 "last device" (the authoritative backstop) surfaces a plain
///     message and NEVER wipes;
///   - both signed orders verify under the owner IRK.
///
/// The VM is fully injectable, so this runs with NO biometric / Keychain: a
/// fixed signer key, a recording `wipe`, a recording `onWiped`, and the
/// `MockFlagshipServerClient` (which records `selfDeleteBundles` and supports
/// an injected `selfDeleteError` for the failure paths).
@MainActor
final class AccountDeletionViewModelTests: XCTestCase {

    private func makeVM(
        server: MockFlagshipServerClient,
        irk: Curve25519.Signing.PrivateKey,
        username: String? = "alice",
        wiped: @escaping () -> Void,
        onWiped: @escaping () -> Void
    ) -> AccountDeletionViewModel {
        AccountDeletionViewModel(
            server: server,
            username: { username },
            signer: { _ in irk },
            wipe: { wiped() },
            onWiped: { onWiped() }
        )
    }

    func test_optOut_bundlesNoServersOrder_andWipesAfter200() async throws {
        let server = MockFlagshipServerClient(); server.simulatedLatency = 0
        let irk = Curve25519.Signing.PrivateKey()
        var didWipe = false, didLeave = false
        let vm = makeVM(server: server, irk: irk, wiped: { didWipe = true }, onWiped: { didLeave = true })

        await vm.run(alsoDeleteServerContent: false)

        XCTAssertEqual(vm.phase, .completed)
        XCTAssertEqual(server.selfDeleteBundles.count, 1)
        XCTAssertNil(server.selfDeleteBundles[0].serversSelfDelete, "opt-out must NOT bundle a servers order (§5)")
        XCTAssertTrue(didWipe, "the local key wipe must run after a 200")
        XCTAssertTrue(didLeave, "the drop-to-Welcome must run after a 200")
    }

    func test_optIn_bundlesServersOrder_bothSignaturesVerify() async throws {
        let server = MockFlagshipServerClient(); server.simulatedLatency = 0
        let irk = Curve25519.Signing.PrivateKey()
        var didWipe = false
        let vm = makeVM(server: server, irk: irk, wiped: { didWipe = true }, onWiped: {})

        await vm.run(alsoDeleteServerContent: true)

        XCTAssertEqual(vm.phase, .completed)
        let bundle = try XCTUnwrap(server.selfDeleteBundles.first)
        let servers = try XCTUnwrap(bundle.serversSelfDelete, "opt-in must bundle the servers order")
        XCTAssertTrue(didWipe)

        // Both orders re-verify under the owner IRK over the exact canonical bytes.
        let acct = bundle.accountSelfDelete
        let acctBytes = AccountSelfDeleteOrder(
            username: acct.request.username, issuedAt: acct.request.issuedAt
        ).canonicalBytes()
        let acctSig = try XCTUnwrap(HexUtil.decode(acct.signature))
        XCTAssertTrue(irk.publicKey.isValidSignature(acctSig, for: acctBytes))

        let serversBytes = ServersSelfDeleteOrder(
            username: servers.request.username, issuedAt: servers.request.issuedAt
        ).canonicalBytes()
        let serversSig = try XCTUnwrap(HexUtil.decode(servers.signature))
        XCTAssertTrue(irk.publicKey.isValidSignature(serversSig, for: serversBytes))

        // Both orders commit to the same issuedAt (one atomic bundle).
        XCTAssertEqual(acct.request.issuedAt, servers.request.issuedAt)
    }

    func test_403LastDevice_surfacesBackstop_andNeverWipes() async throws {
        let server = MockFlagshipServerClient(); server.simulatedLatency = 0
        server.selfDeleteError = ScreensClientError.http(
            status: 403, message: "not the last device: other active devices exist"
        )
        let irk = Curve25519.Signing.PrivateKey()
        var didWipe = false, didLeave = false
        let vm = makeVM(server: server, irk: irk, wiped: { didWipe = true }, onWiped: { didLeave = true })

        await vm.run(alsoDeleteServerContent: true)

        guard case .failed(let msg) = vm.phase else {
            return XCTFail("expected .failed, got \(vm.phase)")
        }
        XCTAssertTrue(msg.lowercased().contains("another device"), "got: \(msg)")
        XCTAssertFalse(didWipe, "a rejected deletion must NEVER wipe the only key")
        XCTAssertFalse(didLeave)
    }

    func test_403Generic_failsWithoutWiping() async throws {
        let server = MockFlagshipServerClient(); server.simulatedLatency = 0
        server.selfDeleteError = ScreensClientError.http(status: 403, message: "invalid accountSelfDelete signature")
        let irk = Curve25519.Signing.PrivateKey()
        var didWipe = false
        let vm = makeVM(server: server, irk: irk, wiped: { didWipe = true }, onWiped: {})

        await vm.run(alsoDeleteServerContent: false)

        guard case .failed = vm.phase else { return XCTFail("expected .failed, got \(vm.phase)") }
        XCTAssertFalse(didWipe)
    }

    func test_404_alreadyAbsent_completesLocalWipe() async throws {
        let server = MockFlagshipServerClient(); server.simulatedLatency = 0
        server.selfDeleteError = ScreensClientError.http(status: 404, message: "username not registered")
        let irk = Curve25519.Signing.PrivateKey()
        var didWipe = false, didLeave = false
        let vm = makeVM(server: server, irk: irk, wiped: { didWipe = true }, onWiped: { didLeave = true })

        await vm.run(alsoDeleteServerContent: false)

        XCTAssertEqual(vm.phase, .completed)
        XCTAssertTrue(didWipe, "404 proves the account is already gone; the orphaned Keychain identity must be removed")
        XCTAssertTrue(didLeave)
    }

    func test_noActiveAccount_failsAndDoesNotPost() async throws {
        let server = MockFlagshipServerClient(); server.simulatedLatency = 0
        let irk = Curve25519.Signing.PrivateKey()
        var didWipe = false
        let vm = makeVM(server: server, irk: irk, username: nil, wiped: { didWipe = true }, onWiped: {})

        await vm.run(alsoDeleteServerContent: true)

        guard case .failed = vm.phase else { return XCTFail("expected .failed, got \(vm.phase)") }
        XCTAssertTrue(server.selfDeleteBundles.isEmpty, "no username ⇒ nothing posted")
        XCTAssertFalse(didWipe)
    }
}
