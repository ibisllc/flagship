import XCTest
import CryptoKit
@testable import FlagshipUI
@testable import FlagshipAPI

@MainActor
final class SecurityControlsControllersTests: XCTestCase {
    private let key = Curve25519.Signing.PrivateKey()
    private let at = Date(timeIntervalSince1970: 1_760_000_000)

    func testApprovingRestoredPermissionsSignsThatAppAndThatDraft() async throws {
        let mock = MockScreensClient()
        mock.restoredDrafts = [
            RestoredAccessDraft(serviceRef: "alice--chess", sha256: String(repeating: "ab", count: 32), people: 2, mode: "restricted", restoredAt: 1),
            RestoredAccessDraft(serviceRef: "alice--other", sha256: String(repeating: "cd", count: 32), people: 1, mode: "open", restoredAt: 1),
        ]
        let c = RestoredAccessController(serviceRef: "alice--chess", client: mock, signer: { _ in self.key }, now: { self.at })
        await c.load()
        XCTAssertEqual(c.draft?.people, 2)
        await c.approve()
        let sent = try XCTUnwrap(mock.restoredApprovals.first)
        XCTAssertEqual(sent.request["serviceRef"] as? String, "alice--chess")
        XCTAssertEqual(sent.request["draftSha256"] as? String, String(repeating: "ab", count: 32))
        let order = RestoredAccessApproveOrder(serviceRef: "alice--chess", draftSha256: String(repeating: "ab", count: 32), issuedAt: 1_760_000_000_000)
        let sig = sent.signatureHex.hexData
        XCTAssertTrue(key.publicKey.isValidSignature(sig, for: try order.canonicalBytes()))
        XCTAssertNil(c.draft)
        XCTAssertEqual(mock.restoredDrafts.map(\.serviceRef), ["alice--other"])
    }

    func testDiscardingRemovesOnlyThisAppsDraftAndNothingIsApproved() async {
        let mock = MockScreensClient()
        mock.restoredDrafts = [RestoredAccessDraft(serviceRef: "alice--chess", sha256: String(repeating: "ab", count: 32), people: 1, mode: "restricted", restoredAt: 1)]
        let c = RestoredAccessController(serviceRef: "alice--chess", client: mock, signer: { _ in self.key })
        await c.load()
        await c.discard()
        XCTAssertEqual(mock.restoredDiscards, ["alice--chess"])
        XCTAssertTrue(mock.restoredApprovals.isEmpty)
        XCTAssertNil(c.draft)
    }

    func testUpdateModeIsReadAndChangedAndAnOlderBoxShowsNothing() async {
        let mock = MockScreensClient()
        mock.updateModes["alice--chess"] = UpdateModeState(mode: "manual", modes: ["manual", "staged", "auto", "frozen"], stagedHoldDays: 7)
        let c = UpdateModeController(serviceId: "alice--chess", client: mock)
        await c.load()
        XCTAssertEqual(c.state?.mode, "manual")
        await c.choose("staged")
        XCTAssertEqual(mock.updateModeSets.first?.mode, "staged")
        XCTAssertEqual(c.state?.mode, "staged")
        let none = UpdateModeController(serviceId: "nobody", client: mock)
        await none.load()
        XCTAssertNil(none.state)
        XCTAssertEqual(SecurityControlWords.updateLabel("manual"), "Ask me each time")
        XCTAssertNil(SecurityControlWords.updateLabel("weekly"))
    }

    func testDelegationSignsThisSessionAppOperationsAndWindowCappedAtADay() async throws {
        let mock = MockScreensClient()
        let c = CompanionDelegationController(sessionId: "0123456789abcdef", client: mock, signer: { _ in self.key }, now: { self.at })
        await c.load()
        XCTAssertTrue(c.rows.isEmpty)
        await c.allow(serviceRef: "alice--chess", ops: ["deploy", "build"], durationMs: 10 * 24 * 3_600_000)
        let sent = try XCTUnwrap(mock.delegationGrants.first)
        XCTAssertEqual(sent.request["sessionId"] as? String, "0123456789abcdef")
        XCTAssertEqual(sent.request["ops"] as? [String], ["build", "deploy"])
        let order = CompanionDelegationOrder(sessionId: "0123456789abcdef", serviceRef: "alice--chess", ops: ["build", "deploy"], issuedAt: 1_760_000_000_000, expiresAt: 1_760_000_000_000 + CompanionDelegationOrder.maxMs)
        XCTAssertTrue(key.publicKey.isValidSignature(sent.signatureHex.hexData, for: try order.canonicalBytes()))
        XCTAssertEqual(c.rows.map(\.serviceRef), ["alice--chess"])
        await c.end(serviceRef: "alice--chess")
        XCTAssertEqual(mock.delegationEnds.first?.serviceRef, "alice--chess")
        XCTAssertTrue(c.rows.isEmpty)
    }

    func testAMalformedDelegationIsNeverSignedOrSent() async {
        let mock = MockScreensClient()
        let c = CompanionDelegationController(sessionId: "short", client: mock, signer: { _ in self.key }, now: { self.at })
        await c.allow(serviceRef: "alice--chess", ops: ["build"], durationMs: 60_000)
        XCTAssertTrue(mock.delegationGrants.isEmpty)
        XCTAssertNotNil(c.error)
    }
}

private extension String {
    var hexData: Data {
        var d = Data(); var i = startIndex
        while i < endIndex { let n = index(i, offsetBy: 2); d.append(UInt8(self[i..<n], radix: 16)!); i = n }
        return d
    }
}
