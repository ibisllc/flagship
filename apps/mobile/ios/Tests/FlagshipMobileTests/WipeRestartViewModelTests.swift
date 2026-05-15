import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore
@testable import Flagship

/// E2 — WipeRestartViewModel end-to-end (against Mock server +
/// MockWebAuthnProvider). The MockWebAuthnProvider returns a stable
/// PRF secret per credentialId, so the wrap step is deterministic
/// for these tests.
@MainActor
final class WipeRestartViewModelTests: XCTestCase {

    override func tearDown() async throws {
        Keystore.wipe()
        try? Keystore.setPendingIrkRotationVersion(nil)
        try await super.tearDown()
    }

    private func makeUMK() async throws {
        try await Keystore.generateUMK(reason: "test")
    }

    func test_happyPath_postsSignedEnvelope_andInstallsNewUMK() async throws {
        try await makeUMK()
        let oldVersion = Keystore.currentIrkVersion()
        let oldIrk = try await Keystore.deriveIRK(reason: "test")
        let oldPubHex = HexUtil.encode(oldIrk.publicKey.rawRepresentation)

        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.wipeRestartBehavior = .ok
        let vm = WipeRestartViewModel(
            server: server,
            webAuthn: MockWebAuthnProvider(),
            username: { "alice" }
        )
        await vm.run(currentEtag: "W/\"snap\"")

        XCTAssertEqual(vm.phase, .completed)
        let last = try XCTUnwrap(server.lastWipeRestart)
        XCTAssertEqual(last.username, "alice")
        XCTAssertEqual(last.ifMatch, "W/\"snap\"")
        XCTAssertEqual(last.body.request.oldIrkPub, oldPubHex)
        XCTAssertFalse(last.body.request.newIrkPub.isEmpty)
        XCTAssertNotEqual(last.body.request.newIrkPub, oldPubHex)
        // Signature is a 64-byte Ed25519 sig encoded as hex (128 chars).
        XCTAssertEqual(last.body.signature.count, 128)
        // Idempotency key is 32 hex chars (16 random bytes).
        XCTAssertEqual(last.body.idempotencyKey.count, 32)
        XCTAssertTrue(last.body.idempotencyKey.allSatisfy { $0.isHexDigit })

        // Post-success: the local UMK has been replaced, so the IRK
        // we derive locally NOW should match the new pub the server
        // received.
        let postWipeIrk = try await Keystore.deriveIRK(reason: "post-wipe")
        let postWipePubHex = HexUtil.encode(postWipeIrk.publicKey.rawRepresentation)
        XCTAssertEqual(postWipePubHex, last.body.request.newIrkPub)
        // Version slot reset to v1 (fresh UMK).
        XCTAssertEqual(Keystore.currentIrkVersion(), 1)
    }

    func test_rateLimit_surfacedAsFailure_andLocalKeysUnchanged() async throws {
        try await makeUMK()
        let oldIrk = try await Keystore.deriveIRK(reason: "test")
        let oldPubHex = HexUtil.encode(oldIrk.publicKey.rawRepresentation)

        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.wipeRestartBehavior = .rateLimited
        let vm = WipeRestartViewModel(
            server: server,
            webAuthn: MockWebAuthnProvider(),
            username: { "alice" }
        )
        await vm.run(currentEtag: nil)

        if case .failed(let msg) = vm.phase {
            XCTAssertTrue(msg.lowercased().contains("rate"))
        } else {
            XCTFail("expected .failed, got \(vm.phase)")
        }
        // Local UMK / IRK UNCHANGED — failed POST must NOT install
        // the new keys locally.
        let stillOld = try await Keystore.deriveIRK(reason: "still-old")
        XCTAssertEqual(HexUtil.encode(stillOld.publicKey.rawRepresentation), oldPubHex)
    }

    func test_staleEtag_surfacedAsRefreshHint() async throws {
        try await makeUMK()
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.wipeRestartBehavior = .staleEtag("W/\"fresh\"")
        let vm = WipeRestartViewModel(
            server: server,
            webAuthn: MockWebAuthnProvider(),
            username: { "alice" }
        )
        await vm.run(currentEtag: "W/\"stale\"")

        if case .failed = vm.phase {} else {
            XCTFail("expected .failed, got \(vm.phase)")
        }
    }

    func test_concurrentRotation_friendlyMessage() async throws {
        try await makeUMK()
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.wipeRestartBehavior = .concurrentRotation
        let vm = WipeRestartViewModel(
            server: server,
            webAuthn: MockWebAuthnProvider(),
            username: { "alice" }
        )
        await vm.run(currentEtag: nil)

        if case .failed(let msg) = vm.phase {
            XCTAssertTrue(msg.lowercased().contains("rotation"))
        } else {
            XCTFail("expected .failed, got \(vm.phase)")
        }
    }

    func test_noUsername_failsImmediately() async {
        let server = MockFlagshipServerClient()
        let vm = WipeRestartViewModel(
            server: server,
            webAuthn: MockWebAuthnProvider(),
            username: { nil }
        )
        await vm.run(currentEtag: nil)
        if case .failed = vm.phase {} else {
            XCTFail("expected .failed, got \(vm.phase)")
        }
    }

    func test_canonicalBytes_matchProtocolFieldOrder() {
        // Pin the WipeRestartClaim field order against the Worker.
        // Worker canonicalWipeRestart joins fields with "|" in this
        // exact order: tag, username, oldIrkPub, newIrkPub,
        // newCredentialIdHex, newWrappedUmkHashHex, issuedAt.
        let bytes = WipeRestartClaim.canonicalBytes(
            username: "alice",
            oldIrkPubHex: "ab",
            newIrkPubHex: "cd",
            newCredentialIdHex: "1234",
            newWrappedUmkHashHex: "abcdef",
            issuedAt: 1700000000000
        )
        let s = String(data: bytes, encoding: .utf8)!
        XCTAssertEqual(s, "flagship/wipe-restart/v1|alice|ab|cd|1234|abcdef|1700000000000")
    }
}
