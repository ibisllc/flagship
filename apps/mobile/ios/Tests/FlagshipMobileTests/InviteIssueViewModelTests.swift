import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// P6 — InviteIssueViewModel state machine + wire-shape parity. Asserts
/// the daemon never sees the local label-book fields (displayName /
/// channel / sentTo / notes) and that the local row is persisted on
/// success.
@MainActor
final class InviteIssueViewModelTests: XCTestCase {

    private func makeClient() -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        return c
    }

    func test_issue_happyPath_sendsWireShapeAndPersistsLabel() async {
        let client = makeClient()
        client.appInviteIssueFixture = AppInviteIssueResponse(
            secret: "deadbeefcafebabe1234567890abcdef" + "deadbeefcafebabe1234567890abcdef",
            expiresAt: 1_800_000_000_000
        )
        let book = InMemoryInviteLabelBook()
        let vm = InviteIssueViewModel(
            serviceId: "harry-plants",
            appUrl: "https://plants.harry.flagship.services",
            client: client,
            labelBook: book,
            tagMint: { "0011223344556677" + "8899aabbccddeeff" }
        )
        vm.displayName = "John (work)"
        vm.role = "admin"
        vm.channel = "imessage"
        vm.sentTo = "+1 555 0142"
        vm.contextNote = "from harry's phone"

        await vm.issue()

        guard case let .issued(secret, expiresAt, shareUrl) = vm.phase else {
            XCTFail("expected .issued, got \(vm.phase)"); return
        }
        XCTAssertEqual(secret, "deadbeefcafebabe1234567890abcdef" + "deadbeefcafebabe1234567890abcdef")
        XCTAssertEqual(expiresAt, 1_800_000_000_000)
        XCTAssertEqual(
            shareUrl,
            "https://plants.harry.flagship.services/invite#k=\(secret)&a=harry-plants"
        )

        // Privacy: the wire request carries only the daemon-visible
        // fields — opaqueTag + role + contextNote + serviceId. The
        // local label fields stay in the label book.
        XCTAssertEqual(client.appInviteIssueCalls.count, 1)
        let req = client.appInviteIssueCalls[0]
        XCTAssertEqual(req.serviceId, "harry-plants")
        XCTAssertEqual(req.role, "admin")
        XCTAssertEqual(req.opaqueTag, "00112233445566778899aabbccddeeff")
        XCTAssertEqual(req.contextNote, "from harry's phone")

        // Local row written under the same tag.
        let row = book.get(serviceId: "harry-plants", opaqueTagHex: "00112233445566778899aabbccddeeff")
        XCTAssertEqual(row?.displayName, "John (work)")
        XCTAssertEqual(row?.channel, "imessage")
        XCTAssertEqual(row?.sentTo, "+1 555 0142")
    }

    func test_issue_emptyContext_sendsNullOnTheWire() async {
        let client = makeClient()
        let book = InMemoryInviteLabelBook()
        let vm = InviteIssueViewModel(
            serviceId: "harry-plants",
            appUrl: "https://plants.harry.flagship.services",
            client: client,
            labelBook: book,
            tagMint: { "ab".replicated(16) }
        )
        vm.displayName = "John"
        vm.contextNote = "   "

        await vm.issue()

        XCTAssertEqual(client.appInviteIssueCalls.count, 1)
        XCTAssertNil(client.appInviteIssueCalls[0].contextNote)
    }

    func test_issue_emptyDisplayName_failsLocallyAndSkipsWire() async {
        let client = makeClient()
        let book = InMemoryInviteLabelBook()
        let vm = InviteIssueViewModel(
            serviceId: "harry-plants",
            appUrl: "https://plants.harry.flagship.services",
            client: client,
            labelBook: book
        )
        vm.displayName = "   "
        await vm.issue()
        if case .failed(let msg) = vm.phase {
            XCTAssertTrue(msg.lowercased().contains("label"))
        } else {
            XCTFail("expected .failed, got \(vm.phase)")
        }
        XCTAssertEqual(client.appInviteIssueCalls.count, 0)
    }

    func test_issue_tagIsDistinctPerCall() async {
        let client = makeClient()
        let book = InMemoryInviteLabelBook()
        let vm = InviteIssueViewModel(
            serviceId: "harry-plants",
            appUrl: "https://plants.harry.flagship.services",
            client: client,
            labelBook: book
        )
        vm.displayName = "A"
        await vm.issue()
        let firstTag = vm.lastOpaqueTag
        XCTAssertNotNil(firstTag)
        vm.reset()
        vm.displayName = "B"
        await vm.issue()
        let secondTag = vm.lastOpaqueTag
        XCTAssertNotNil(secondTag)
        XCTAssertNotEqual(firstTag, secondTag)
        XCTAssertEqual(client.appInviteIssueCalls.count, 2)
    }

    func test_issue_clientFailure_landsInFailed() async {
        let client = makeClient()
        client.shouldFail = true
        let vm = InviteIssueViewModel(
            serviceId: "harry-plants",
            appUrl: "https://x.flagship.services",
            client: client,
            labelBook: InMemoryInviteLabelBook()
        )
        vm.displayName = "John"
        await vm.issue()
        if case .failed = vm.phase {
            // expected
        } else {
            XCTFail("expected .failed, got \(vm.phase)")
        }
    }
}

private extension String {
    /// Distinct from the labelbook-tests helper so the symbol doesn't
    /// collide on test-target merge.
    func replicated(_ count: Int) -> String {
        String(repeating: self, count: count)
    }
}
