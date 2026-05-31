import XCTest
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
}
