import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipCore

/// W8 — verify that the Keychain wrapper plumbs the iCloud-sync class
/// flag through. On the iOS simulator test bundle there's no Keychain
/// entitlement, so the production keychainWrite falls back to an
/// in-memory store; that fallback records the sync class so this test
/// can assert on it. The same code path on a real device sets
/// `kSecAttrSynchronizable=true` for `.cloudRoot` and `false` for
/// `.deviceLocal` — that's the security invariant the user
/// (correctly) calls out: the cloud ROOT key syncs across the user's
/// Apple-ID devices so iCloud-restore works; per-device DEVICE-IRKs
/// (when we ship them) MUST NOT sync, or restoring to a new iPad
/// clones an existing device's identity.
final class KeychainSyncClassTests: XCTestCase {

    override func setUp() async throws {
        KeystoreTestSupport.wipeInMemory(account: "test.cloudRoot")
        KeystoreTestSupport.wipeInMemory(account: "test.deviceLocal")
    }

    override func tearDown() async throws {
        KeystoreTestSupport.wipeInMemory(account: "test.cloudRoot")
        KeystoreTestSupport.wipeInMemory(account: "test.deviceLocal")
    }

    func test_cloudRootWrite_recordsSynchronizableSyncClass() throws {
        try KeystoreTestSupport.write(
            account: "test.cloudRoot",
            data: Data([0x01, 0x02, 0x03]),
            sync: .cloudRoot
        )
        XCTAssertEqual(
            KeystoreTestSupport.lastWrittenSyncClass(account: "test.cloudRoot"),
            .cloudRoot,
            "Cloud-root keys MUST be flagged so the production path sets kSecAttrSynchronizable=true and iCloud Keychain replicates them."
        )
    }

    func test_deviceLocalWrite_recordsNonSynchronizableSyncClass() throws {
        try KeystoreTestSupport.write(
            account: "test.deviceLocal",
            data: Data([0x09, 0x09]),
            sync: .deviceLocal
        )
        XCTAssertEqual(
            KeystoreTestSupport.lastWrittenSyncClass(account: "test.deviceLocal"),
            .deviceLocal,
            "Device-local keys MUST be flagged so the production path sets kSecAttrSynchronizable=false; otherwise a restored iPad would clone the source iPad's device identity."
        )
    }

    func test_cloudRootAndDeviceLocal_areDistinct() {
        XCTAssertNotEqual(KeychainSyncClass.cloudRoot, KeychainSyncClass.deviceLocal)
    }

    /// Slice D residual-risk #6 (device-admin-tier-spec §9) — the ADMIN MASTER
    /// ROOT is the authority anchor and must be DEVICE-LOCAL: a write that
    /// silently flips any of its three slots to the synced class would hand
    /// admin authority to every iCloud-Keychain device, re-collapsing the
    /// membership-vs-authority custody split. Drives the real
    /// `Keystore.importAdminRoot` and asserts every admin-root account landed
    /// `.deviceLocal`, never `.cloudRoot`.
    func test_adminRootImport_allSlotsAreDeviceLocal_neverSynced() async throws {
        let adminRootAccounts = [
            "com.flagship.adminroot.wrapped",
            "com.flagship.adminroot.ephemeralpub",
            "com.flagship.adminroot.pub",
        ]
        Keystore.setActiveProfile(nil)
        Keystore.wipe()
        defer { Keystore.wipe() }

        let seed = Curve25519.Signing.PrivateKey().rawRepresentation
        _ = try await Keystore.importAdminRoot(seed: seed, reason: "test")

        for account in adminRootAccounts {
            XCTAssertEqual(
                KeystoreTestSupport.lastWrittenSyncClass(account: account),
                .deviceLocal,
                "\(account) MUST be kSecAttrSynchronizable=false — a synced admin root clones authority onto every Apple-ID device."
            )
        }
    }
}
