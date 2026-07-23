import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Covers the export + import view models that drive the `.flagshipkey`
/// backup UI. Crypto byte-compat lives in KeyfileTests; these pin the
/// VM state machines + the seams (UMK read on export, UMK install +
/// takeover re-pair on import).
@MainActor
final class KeyfileViewModelsTests: XCTestCase {

    override func tearDown() async throws {
        // Import installs a UMK and rotates the IRK (persisting the version
        // + pending slots in the real keychain). Clear them so later tests
        // don't inherit a stale IRK version — same hygiene as
        // ReplaceDeviceViewModelTests.
        Keystore.wipe()
        try? Keystore.setPendingIrkRotationVersion(nil)
        try await super.tearDown()
    }

    private func makeServer() -> MockFlagshipServerClient {
        let s = MockFlagshipServerClient()
        s.simulatedLatency = 0
        return s
    }

    final class InstallSpy: @unchecked Sendable {
        private(set) var installed: [SymmetricKey] = []
        func record(_ seed: SymmetricKey) { installed.append(seed) }
        var callCount: Int { installed.count }
    }

    // MARK: - Export

    func test_export_gateRequiresMinimumPassphraseAndControlAcknowledgment() {
        let vm = KeyfileExportViewModel(username: "harry", readUMK: { _ in SymmetricKey(size: .bits256) })
        XCTAssertFalse(vm.canCreate)
        vm.passphrase = "weak"
        vm.confirmPassphrase = "weak"
        XCTAssertFalse(vm.canCreate, "weak passphrase blocks")
        vm.passphrase = "twelveletters"
        vm.confirmPassphrase = "twelveletters"
        XCTAssertTrue(vm.passphraseStrong)
        XCTAssertTrue(vm.passphrasesMatch)
        XCTAssertFalse(vm.canCreate, "acknowledgment still unchecked")
        vm.ackControl = true
        XCTAssertTrue(vm.canCreate)
    }

    func test_export_mismatchedConfirmBlocks() {
        let vm = KeyfileExportViewModel(username: "harry", readUMK: { _ in SymmetricKey(size: .bits256) })
        vm.passphrase = "Str0ng-Passphrase!"
        vm.confirmPassphrase = "Different-One99!"
        vm.ackControl = true
        XCTAssertFalse(vm.passphrasesMatch)
        XCTAssertFalse(vm.canCreate)
    }

    func test_export_producesReadableKeyfile() async throws {
        let umk = SymmetricKey(size: .bits256)
        let vm = KeyfileExportViewModel(username: "harry", accountId: "acct-9", readUMK: { _ in umk })
        vm.passphrase = "Str0ng-Passphrase!"
        vm.confirmPassphrase = "Str0ng-Passphrase!"
        vm.ackControl = true

        await vm.createBackup()

        guard case .ready(let text) = vm.phase else {
            return XCTFail("expected .ready, got \(vm.phase)")
        }
        // The file the export produced unwraps back to the same UMK.
        let (recovered, meta) = try Keyfile.unwrap(fileText: text, passphrase: "Str0ng-Passphrase!")
        XCTAssertEqual(recovered.withUnsafeBytes { Data($0) }, umk.withUnsafeBytes { Data($0) })
        XCTAssertEqual(meta.username, "harry")
        XCTAssertEqual(meta.accountId, "acct-9")
    }

    func test_export_suggestedFilename() {
        XCTAssertEqual(KeyfileExportViewModel(username: "harry").suggestedFilename, "harry.flagshipkey")
        XCTAssertEqual(KeyfileExportViewModel(username: "").suggestedFilename, "account.flagshipkey")
    }

    func test_export_strengthRule() {
        XCTAssertFalse(KeyfileExportViewModel.isStrong("short"))
        XCTAssertFalse(KeyfileExportViewModel.isStrong("elevenchars"))
        XCTAssertTrue(KeyfileExportViewModel.isStrong("twelveletters"))
        XCTAssertTrue(KeyfileExportViewModel.isStrong("aaaaaaaaaaaa"))
    }

    // MARK: - Import

    /// Build a keyfile for `username` so the import VM can unwrap it.
    private func makeKeyfile(username: String, passphrase: String, umk: SymmetricKey) throws -> String {
        let fast = Keyfile.ArgonParams(m: 256, t: 1, p: 1)
        let meta = Keyfile.Meta(username: username, accountId: nil, createdAt: "2026-05-25T00:00:00.000Z")
        return try Keyfile.wrap(umkSeed: umk, passphrase: passphrase, meta: meta, params: fast)
    }

    func test_import_happyPath_installsUmk_initiatesRePair_thenFinalizes() async throws {
        let server = makeServer()
        try await server.claimUsername(.init(
            request: .init(username: "harry", irkPub: "ab", issuedAt: 1), signature: "s"
        ))
        let umk = SymmetricKey(size: .bits256)
        let file = try makeKeyfile(username: "harry", passphrase: "the-right-pass", umk: umk)
        let spy = InstallSpy()
        let vm = KeyfileImportViewModel(server: server, installUMK: { seed, reason in
            spy.record(seed)
            try await Keystore.installUMK(seed, reason: reason)
        })
        vm.passphrase = "the-right-pass"

        await vm.importBackup(fileText: file)

        guard case .completed(let user, _) = vm.phase else {
            return XCTFail("expected .completed, got \(vm.phase)")
        }
        XCTAssertEqual(user, "harry")
        XCTAssertEqual(spy.callCount, 1)
        XCTAssertEqual(
            spy.installed.first?.withUnsafeBytes { Data($0) },
            umk.withUnsafeBytes { Data($0) },
            "the imported UMK seed must be the one installed"
        )
        let last = try XCTUnwrap(server.lastRePairInitiate)
        XCTAssertEqual(last.username, "harry")
        XCTAssertNil(last.body.totpProof, "keyfile import re-pair carries no totpProof")

        // Finalize after grace.
        await vm.completeTakeover()
        guard case .finalized(let finalUser) = vm.phase else {
            return XCTFail("expected .finalized, got \(vm.phase)")
        }
        XCTAssertEqual(finalUser, "harry")
    }

    /// #86 — the keyfile-import re-pair must ROTATE the IRK: it used to send
    /// newIrkPub == oldIrkPub (both = the registered key), which the .com
    /// re-pair handler rejects with 400 "newIrkPub equals current IRK", so
    /// the takeover never started. This pins the rotating envelope (old !=
    /// new), proves the envelope is signed by the NEW key, and that the
    /// rotation is finalized locally on completion — matching the webapp fix
    /// + Android + ReplaceDeviceViewModel.
    func test_import_rotatesIrk_newNeqOld_envelopeVerifies_andFinalizes() async throws {
        let server = makeServer()
        try await server.claimUsername(.init(
            request: .init(username: "harry", irkPub: "ab", issuedAt: 1), signature: "s"
        ))
        let umk = SymmetricKey(size: .bits256)
        let file = try makeKeyfile(username: "harry", passphrase: "the-right-pass", umk: umk)
        // Drive the REAL Keystore install (resets the IRK lineage to v1
        // under the imported UMK) so the rotation is exercised end to end.
        let vm = KeyfileImportViewModel(server: server, installUMK: { seed, reason in
            try await Keystore.installUMK(seed, reason: reason)
        })
        vm.passphrase = "the-right-pass"

        await vm.importBackup(fileText: file)

        guard case .completed = vm.phase else {
            return XCTFail("expected .completed, got \(vm.phase)")
        }

        let last = try XCTUnwrap(server.lastRePairInitiate)
        let req = last.body.request
        XCTAssertFalse(req.newIrkPub.isEmpty)
        // The bug: old == new. The fix rotates.
        XCTAssertNotEqual(req.newIrkPub, req.oldIrkPub,
                          "keyfile-import re-pair must rotate the IRK (old != new)")
        // The OLD pubkey is the registered (v1) key under the recovered UMK.
        let v1 = try await Keystore.deriveIRK(reason: "v1", version: 1)
        XCTAssertEqual(req.oldIrkPub, HexUtil.encode(v1.publicKey.rawRepresentation),
                       "oldIrkPub must be the currently-registered v1 key")

        // The envelope verifies against the NEW pubkey it carries (signed by
        // the rotated key, exactly as the .com handler checks).
        let canonical = RePairInitiate.canonicalBytes(
            username: req.username,
            newIrkPubHex: req.newIrkPub,
            oldIrkPubHex: req.oldIrkPub,
            issuedAt: req.issuedAt
        )
        let newPubKey = try Curve25519.Signing.PublicKey(
            rawRepresentation: try XCTUnwrap(HexUtil.decode(req.newIrkPub)))
        let sig = try XCTUnwrap(HexUtil.decode(last.body.signature))
        XCTAssertTrue(newPubKey.isValidSignature(sig, for: canonical),
                      "the re-pair envelope must verify under the NEW (rotated) IRK")

        // A rotation is staged but NOT yet promoted (promotion is at complete).
        XCTAssertEqual(Keystore.pendingIrkRotationVersion(), 2)
        XCTAssertEqual(Keystore.currentIrkVersion(), 1)

        // Completing the takeover promotes the rotated version locally.
        await vm.completeTakeover()
        guard case .finalized = vm.phase else {
            return XCTFail("expected .finalized, got \(vm.phase)")
        }
        XCTAssertEqual(Keystore.currentIrkVersion(), 2,
                       "completion must finalize the rotated IRK version")
        XCTAssertNil(Keystore.pendingIrkRotationVersion())
    }

    func test_import_wrongPassphrase_failsBeforeInstall() async throws {
        let server = makeServer()
        let umk = SymmetricKey(size: .bits256)
        let file = try makeKeyfile(username: "harry", passphrase: "the-right-pass", umk: umk)
        let spy = InstallSpy()
        let vm = KeyfileImportViewModel(server: server, installUMK: { seed, _ in spy.record(seed) })
        vm.passphrase = "the-wrong-pass"

        await vm.importBackup(fileText: file)

        guard case .failed(let msg) = vm.phase else {
            return XCTFail("expected .failed, got \(vm.phase)")
        }
        XCTAssertEqual(msg, "That passphrase didn't open the file.")
        XCTAssertEqual(spy.callCount, 0, "must not install on a wrong passphrase")
        XCTAssertNil(server.lastRePairInitiate)
    }

    func test_import_notAKeyfile_failsWithKeyfileCopy() async {
        let server = makeServer()
        let vm = KeyfileImportViewModel(server: server, installUMK: { _, _ in })
        vm.passphrase = "whatever-pass"
        await vm.importBackup(fileText: "{\"not\":\"a keyfile\"}")
        guard case .failed(let msg) = vm.phase else {
            return XCTFail("expected .failed, got \(vm.phase)")
        }
        XCTAssertEqual(msg, "This isn't a Flagship key file.")
    }

    func test_import_emptyPassphrase_blocks() async {
        let server = makeServer()
        let vm = KeyfileImportViewModel(server: server, installUMK: { _, _ in })
        XCTAssertFalse(vm.canImport)
        await vm.importBackup(fileText: "{}")
        guard case .failed = vm.phase else {
            return XCTFail("expected .failed for empty passphrase, got \(vm.phase)")
        }
    }
}
