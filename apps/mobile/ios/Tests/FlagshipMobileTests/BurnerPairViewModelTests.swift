import XCTest
import CryptoKit
@testable import FlagshipUI
@testable import FlagshipAPI
@testable import FlagshipCore

/// BurnerPairViewModel handshake logic, driven by a MockBurnerPairClient.
/// Minting (confirmAndDeliver) needs the Keychain/biometric, so it's not
/// exercised here — the parse → connect → SAS → phone-hello → end paths are.
@MainActor
final class BurnerPairViewModelTests: XCTestCase {

    private func hex(_ s: String) -> Data {
        var d = Data(); var i = s.startIndex
        while i < s.endIndex { let n = s.index(i, offsetBy: 2); d.append(UInt8(s[i..<n], radix: 16)!); i = n }
        return d
    }

    private func makeVM(_ client: MockBurnerPairClient) -> BurnerPairViewModel {
        let minter = CreateServerViewModel(
            username: "tester",
            server: MockFlagshipServerClient(),
            relay: MockQrRelayClient()
        )
        return BurnerPairViewModel(client: client, minter: minter)
    }

    func test_connectsToSessionIdDerivedFromCode() async {
        let client = MockBurnerPairClient()
        let vm = makeVM(client)
        await vm.qrDetected("AEBA-GBAF")
        // 0102030405 → pinned sid.
        XCTAssertEqual(client.connectedSid, "KW3_KaK0uN8rcrQCLmsOJXXfhr9EEpib")
    }

    func test_burnerHelloDerivesSasAndSendsPhoneHello() async throws {
        let client = MockBurnerPairClient()
        let vm = makeVM(client)
        // Typed-code path: no pubkey until burner-hello.
        await vm.qrDetected("AEBA-GBAF")

        let burnerPk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
        client.emit(.burnerHello(burnerPkB64: burnerPk))
        // Let the async handler run.
        try await Task.sleep(nanoseconds: 100_000_000)

        if case .matching(let code, _) = vm.phase {
            XCTAssertEqual(code.count, 6)
        } else {
            XCTFail("expected .matching, got \(vm.phase)")
        }
        // A phone-hello must have been sent to the burner.
        XCTAssertTrue(client.sentJSON.contains { $0.contains("\"phone-hello\"") })
    }

    func test_peerGoneEndsSession() async throws {
        let client = MockBurnerPairClient()
        let vm = makeVM(client)
        await vm.qrDetected("AEBA-GBAF")
        client.emit(.peerGone)
        try await Task.sleep(nanoseconds: 100_000_000)
        if case .failed = vm.phase {} else { XCTFail("expected .failed, got \(vm.phase)") }
    }

    func test_qrPathDerivesImmediately() async throws {
        let client = MockBurnerPairClient()
        let vm = makeVM(client)
        let pk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
        await vm.qrDetected("flagship://burner?c=AEBAGBAF&k=\(pk)")
        try await Task.sleep(nanoseconds: 100_000_000)
        // QR path has the pubkey up front → goes straight to matching + sends hello.
        if case .matching = vm.phase {} else { XCTFail("expected .matching, got \(vm.phase)") }
        XCTAssertTrue(client.sentJSON.contains { $0.contains("\"phone-hello\"") })
    }
}
