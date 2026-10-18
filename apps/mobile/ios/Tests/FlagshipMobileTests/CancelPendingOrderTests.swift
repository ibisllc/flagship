import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Cancel order said "Couldn't cancel - the name is still reserved. Check your
/// connection and try again." for every failure, even on a healthy connection.
/// It now says the real reason, drops a row that holds no name without a call,
/// and keeps the order (with "Try cancelling again") when the cancel fails.
@MainActor
final class CancelPendingOrderTests: XCTestCase {
    private let fqdn = "cellar.harry.flagship.services"

    private func key() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
    }

    private func server() -> MockFlagshipServerClient {
        let s = MockFlagshipServerClient()
        s.simulatedLatency = 0
        return s
    }

    private func pod(_ fqdn: String, serial: String? = "ABCD-1234") -> PodInfo {
        PodInfo(podId: "p", name: "cellar", fqdn: fqdn, status: .pending, pendingAuthCodeSerial: serial)
    }

    private func run(_ pod: PodInfo, on s: MockFlagshipServerClient,
                     releaseKey: CancelPendingOrder.ReleaseKey? = nil) async -> CancelPendingOrder.Outcome {
        let k = key()
        return await CancelPendingOrder.run(
            pod: pod, username: "harry", server: s,
            releaseKey: releaseKey ?? { _ in k },
            revokeKey: { _, order in order }
        )
    }

    func test_releasesTheNameThenRevokesTheCode() async {
        let s = server()
        let out = await run(pod(fqdn), on: s)
        XCTAssertEqual(out, .cancelled(releasedName: true))
        XCTAssertEqual(s.releasedServerNames.map(\.request.serverDomain), [fqdn])
    }

    func test_aRowThatNamesNoServerAndUserIsDroppedWithoutACall() async {
        let s = server()
        for ghost in ["server.flagship.services", "flagship.services", "a..flagship.services", "cellar.harry.example.com"] {
            let out = await run(pod(ghost), on: s)
            XCTAssertEqual(out, .cancelled(releasedName: false), ghost)
        }
        XCTAssertTrue(s.releasedServerNames.isEmpty, "no call for a row that holds no name")
    }

    func test_aServerProblemIsSaidAsOneAndKeepsTheName() async {
        let s = server()
        s.shouldFail = true
        guard case .failed(let msg) = await run(pod(fqdn), on: s) else { return XCTFail("expected a failure") }
        XCTAssertTrue(msg.hasPrefix("Couldn't cancel this order."), msg)
        XCTAssertTrue(msg.contains("temporarily unavailable"), msg)
        XCTAssertTrue(msg.hasSuffix("The name stays reserved until it is cancelled."), msg)
        XCTAssertFalse(msg.lowercased().contains("check your connection"), "a healthy connection is not blamed: \(msg)")
        XCTAssertFalse(msg.contains("503"))
    }

    func test_aRefusalShowsTheReasonTheServerSent() async {
        let s = server()
        s.releaseError = ScreensClientError.http(status: 403, message: #"{"error":"Only an admin device can cancel an order."}"#)
        guard case .failed(let msg) = await run(pod(fqdn), on: s) else { return XCTFail("expected a failure") }
        XCTAssertTrue(msg.contains("Only an admin device can cancel an order."), msg)
    }

    func test_aRetryAfterAFailureCancelsTheSameOrder() async {
        let s = server()
        s.releaseError = ScreensClientError.http(status: 502, message: "error code: 1102")
        s.releaseErrorOnce = true
        guard case .failed = await run(pod(fqdn), on: s) else { return XCTFail("the first try fails") }
        XCTAssertTrue(s.releasedServerNames.isEmpty, "a failed cancel released nothing")
        let again = await run(pod(fqdn), on: s)
        XCTAssertEqual(again, .cancelled(releasedName: true))
        XCTAssertEqual(s.releasedServerNames.map(\.request.serverDomain), [fqdn])
    }

    func test_aKeyProblemIsSaidInWords() async {
        let s = server()
        let out = await run(pod(fqdn), on: s, releaseKey: { _ in throw CancellationError() })
        guard case .failed(let msg) = out else { return XCTFail("expected a failure") }
        XCTAssertTrue(msg.hasPrefix("Couldn't cancel this order."), msg)
        XCTAssertTrue(s.releasedServerNames.isEmpty)
    }

    func test_theRetryLabel() {
        XCTAssertEqual(CancelPendingOrder.retryLabel, "Try cancelling again")
        XCTAssertEqual(SetupStoppedCard.cancelLabel(afterFailure: false), "Cancel order and start again")
        XCTAssertEqual(SetupStoppedCard.cancelLabel(afterFailure: true), "Try cancelling again")
    }

    func test_setupStoppedCardExplainsTheStepWithoutALineNumber() {
        let step = ProvisionProgress.failureDetail("Setup stopped while Expanding the disk to 68 GB (line 66)")
        let text = SetupStoppedCard.explanation(step: step, canCancel: true)
        XCTAssertTrue(text.contains("Setup stopped while Expanding the disk to 68 GB."), text)
        XCTAssertFalse(text.contains("line 66"))
        XCTAssertTrue(text.contains("Cancel this order"))
        XCTAssertFalse(SetupStoppedCard.explanation(step: nil, canCancel: false).contains("Cancel this order"))
    }
}

