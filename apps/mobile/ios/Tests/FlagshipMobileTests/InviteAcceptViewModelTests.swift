import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

/// Author-side MANUAL-approve finalize (docs §v2 tier 2) + the local signed-create
/// store it depends on.
@MainActor
final class InviteAcceptViewModelTests: XCTestCase {
    private let server = "home.alice.flagship.services"
    private let serviceRef = "alice-notes"
    private let inviteId = String(repeating: "ea", count: 32)
    private let contactAid = String(repeating: "08", count: 32)
    private let acceptSig = String(repeating: "1c", count: 64) // 128-hex
    private let acceptedAt: Int64 = 1_700_006_000_000

    private func storedCreate() -> StoredInviteCreate {
        StoredInviteCreate(
            inviteId: inviteId, authorAidHex: String(repeating: "b4", count: 32), serviceRef: serviceRef,
            secretHash: String(repeating: "4b", count: 32), encryptedBundle: "00", issuedAt: 1_700_000_000_000,
            createSigHex: String(repeating: "aa", count: 64))
    }

    private func makeVM(_ mock: MockServiceAccessClient, store: any InviteCreateStore) -> InviteAcceptViewModel {
        InviteAcceptViewModel(
            client: mock, serverDomain: server, inviteId: inviteId, serviceRef: serviceRef,
            contactAidHex: contactAid, acceptSigHex: acceptSig, acceptedAt: acceptedAt, createStore: store)
    }

    func testFinalizePostsAcceptAndCachedCreate() async {
        let mock = MockServiceAccessClient()
        let store = InMemoryInviteCreateStore()
        store.put(storedCreate())
        let vm = makeVM(mock, store: store)
        XCTAssertTrue(vm.canFinalize)
        await vm.finalize()
        if case .done(let ref) = vm.phase { XCTAssertEqual(ref, serviceRef) }
        else { XCTFail("expected .done, got \(vm.phase)") }
        XCTAssertEqual(mock.acceptCalls.count, 1)
        let call = mock.acceptCalls[0]
        XCTAssertEqual(call.serverDomain, server)
        // The acceptance carries the consumer's contact AID + the signed bytes.
        XCTAssertEqual(call.accept["inviteId"], inviteId)
        XCTAssertEqual(call.accept["serviceRef"], serviceRef)
        XCTAssertEqual(call.accept["contactAID"], contactAid)
        XCTAssertEqual(call.acceptSigHex, acceptSig)
        // The owner's CACHED signed create is replayed (box-as-authority).
        XCTAssertEqual(call.create["inviteId"], inviteId)
        XCTAssertEqual(call.create["secretHash"], storedCreate().secretHash)
        XCTAssertEqual(call.createSigHex, storedCreate().createSigHex)
    }

    func testFinalizeFailsWithoutCachedCreate() async {
        // No cached create (created on another device) ⇒ can't finalize.
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, store: InMemoryInviteCreateStore())
        XCTAssertFalse(vm.canFinalize)
        await vm.finalize()
        if case .failed = vm.phase {} else { XCTFail("must fail without the signed create") }
        XCTAssertTrue(mock.acceptCalls.isEmpty)
    }

    func testFinalizeRejectsServiceMismatch() async {
        let mock = MockServiceAccessClient()
        let store = InMemoryInviteCreateStore()
        // Cached create is for a DIFFERENT service than the reply claims.
        store.put(StoredInviteCreate(
            inviteId: inviteId, authorAidHex: "b4", serviceRef: "alice-other",
            secretHash: "4b", encryptedBundle: "00", issuedAt: 1, createSigHex: "aa"))
        let vm = makeVM(mock, store: store)
        await vm.finalize()
        if case .failed = vm.phase {} else { XCTFail("service mismatch must fail") }
        XCTAssertTrue(mock.acceptCalls.isEmpty)
    }

    func testAcceptRejected403Surfaces() async {
        let mock = MockServiceAccessClient()
        mock.nextError = ServiceAccessError.acceptRejected
        let store = InMemoryInviteCreateStore()
        store.put(storedCreate())
        let vm = makeVM(mock, store: store)
        await vm.finalize()
        if case .failed = vm.phase {} else { XCTFail("expected .failed") }
    }

    // MARK: store

    func testCreateStoreRoundTripsAndRemoves() {
        let store = InMemoryInviteCreateStore()
        store.put(storedCreate())
        XCTAssertNotNil(store.get(inviteId: inviteId))
        // createDict carries numeric issuedAt + the create fields the box parses.
        let dict = store.get(inviteId: inviteId)!.createDict
        XCTAssertEqual(dict["inviteId"] as? String, inviteId)
        XCTAssertEqual(dict["issuedAt"] as? Int64, 1_700_000_000_000)
        store.remove(inviteId: inviteId)
        XCTAssertNil(store.get(inviteId: inviteId))
    }

    func testCreateStoreCarriesGroupCaps() {
        let store = InMemoryInviteCreateStore()
        store.put(StoredInviteCreate(
            inviteId: inviteId, authorAidHex: "b4", serviceRef: serviceRef, secretHash: "4b",
            encryptedBundle: "00", issuedAt: 1, maxRedemptions: 10, expiresAt: 1_700_009_999_999, createSigHex: "aa"))
        let dict = store.get(inviteId: inviteId)!.createDict
        XCTAssertEqual(dict["maxRedemptions"] as? Int, 10)
        XCTAssertEqual(dict["expiresAt"] as? Int64, 1_700_009_999_999)
    }
}
