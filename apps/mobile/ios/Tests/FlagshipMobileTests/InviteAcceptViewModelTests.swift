import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

/// Author-side MANUAL-approve finalize (docs §v2 tier 2). The author submits ONLY
/// `{accept, acceptSig}`; the box fetches the owner's signed create from `.com` by
/// inviteId, so finalize works from ANY device (no local create cache).
@MainActor
final class InviteAcceptViewModelTests: XCTestCase {
    private let server = "home.alice.flagship.services"
    private let serviceRef = "alice--notes"
    private let inviteId = String(repeating: "ea", count: 32)
    private let contactAid = String(repeating: "08", count: 32)
    private let acceptSig = String(repeating: "1c", count: 64) // 128-hex
    private let acceptedAt: Int64 = 1_700_006_000_000

    private func makeVM(_ mock: MockServiceAccessClient) -> InviteAcceptViewModel {
        InviteAcceptViewModel(
            client: mock, serverDomain: server, inviteId: inviteId, serviceRef: serviceRef,
            contactAidHex: contactAid, acceptSigHex: acceptSig, acceptedAt: acceptedAt)
    }

    func testFinalizePostsOnlyTheAcceptance() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock)
        await vm.finalize()
        if case .done(let ref) = vm.phase { XCTAssertEqual(ref, serviceRef) }
        else { XCTFail("expected .done, got \(vm.phase)") }
        XCTAssertEqual(mock.acceptCalls.count, 1)
        let call = mock.acceptCalls[0]
        XCTAssertEqual(call.serverDomain, server)
        // The acceptance carries the consumer's contact AID + the signed bytes —
        // and NOTHING else (no create / createSig; the box fetches that from .com).
        XCTAssertEqual(call.accept["inviteId"], inviteId)
        XCTAssertEqual(call.accept["serviceRef"], serviceRef)
        XCTAssertEqual(call.accept["contactAID"], contactAid)
        XCTAssertEqual(call.acceptSigHex, acceptSig)
    }

    func testFinalizeNeedsNoLocalCache() async {
        // ANY device can finalize — there is no created-it-here precondition.
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock)
        await vm.finalize()
        if case .done = vm.phase {} else { XCTFail("any device should finalize") }
        XCTAssertEqual(mock.acceptCalls.count, 1)
    }

    func testAcceptRejected403Surfaces() async {
        let mock = MockServiceAccessClient()
        mock.nextError = ServiceAccessError.acceptRejected
        let vm = makeVM(mock)
        await vm.finalize()
        if case .failed = vm.phase {} else { XCTFail("expected .failed") }
    }

    func testAcceptNotForThisBoxSurfaces() async {
        let mock = MockServiceAccessClient()
        mock.nextError = ServiceAccessError.acceptNotForThisBox
        let vm = makeVM(mock)
        await vm.finalize()
        if case .failed = vm.phase {} else { XCTFail("expected .failed") }
    }
}
