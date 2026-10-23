import XCTest
import CryptoKit
@testable import FlagshipUI
@testable import FlagshipAPI

@MainActor
final class SecuritySliverViewModelTests: XCTestCase {
    private func world() -> (MockScreensClient, PublisherTrust) {
        let trust = PublisherTrust(serviceId: "chess", appId: "alice--chess", identityGeneration: 1, oldKeyHex: String(repeating: "a", count: 64), newKeyHex: String(repeating: "b", count: 64), newEpoch: 1, issuedAt: 0)
        let mock = MockScreensClient()
        mock.sliver = SecuritySliverResponse(lines: [
            SliverLine(eventId: "sv1", issueKey: "publisher-key:chess", kind: "publisher-key", severity: "high", target: "chess", state: "active", summary: "A new key signed an update", updatedAt: 1, remainingMs: nil, action: "Review"),
            SliverLine(eventId: "sv2", issueKey: "ca", kind: "ca-expiry", severity: "moderate", target: "server", state: "active", summary: "CA lease ends soon", updatedAt: 1, remainingMs: 86_400_000, action: nil),
        ])
        mock.publisherStates["chess"] = WaitingPublisherResponse(pinned: nil, waiting: .init(continuity: "none", oldFingerprint: "aaaa", newFingerprint: "bbbb", newEpoch: 1, rejected: false, trust: trust))
        return (mock, trust)
    }

    func testEveryLineIsKeptAndOnlyThePublisherKeyLoadsAWaitingCard() async {
        let (mock, _) = world()
        let vm = SecuritySliverViewModel(client: mock, signer: { _ in Curve25519.Signing.PrivateKey() })
        await vm.refresh()
        XCTAssertEqual(vm.lines.map(\.issueKey), ["publisher-key:chess", "ca"])
        XCTAssertEqual(Set(vm.waiting.keys), ["chess"])
    }

    func testTrustingSignsExactlyThatServiceAndChange() async throws {
        let (mock, trust) = world()
        let key = Curve25519.Signing.PrivateKey()
        let vm = SecuritySliverViewModel(client: mock, signer: { _ in key }, now: { Date(timeIntervalSince1970: 1_760_000_000) })
        await vm.refresh()
        await vm.trust(serviceId: "chess")
        let call = try XCTUnwrap(mock.trustCalls.first)
        XCTAssertEqual(call.serviceId, "chess")
        XCTAssertEqual(call.trust.oldKeyHex, trust.oldKeyHex)
        XCTAssertEqual(call.trust.newKeyHex, trust.newKeyHex)
        XCTAssertEqual(call.trust.issuedAt, 1_760_000_000_000)
        let sig = try XCTUnwrap(Data(hex: call.signatureHex))
        XCTAssertTrue(key.publicKey.isValidSignature(sig, for: try call.trust.canonicalBytes()))
        XCTAssertNil(vm.error)
    }

    func testRejectingPausesAndTrustingNothingWaitingSaysSo() async {
        let (mock, _) = world()
        let vm = SecuritySliverViewModel(client: mock, signer: { _ in Curve25519.Signing.PrivateKey() })
        await vm.refresh()
        await vm.reject(serviceId: "chess")
        XCTAssertEqual(mock.rejectCalls, ["chess"])
        await vm.trust(serviceId: "not-waiting")
        XCTAssertEqual(vm.error, "No new key is waiting for this service.")
        XCTAssertTrue(mock.trustCalls.isEmpty)
    }
}

private extension Data {
    init?(hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var d = Data(); var i = hex.startIndex
        while i < hex.endIndex { let n = hex.index(i, offsetBy: 2); guard let b = UInt8(hex[i..<n], radix: 16) else { return nil }; d.append(b); i = n }
        self = d
    }
}
