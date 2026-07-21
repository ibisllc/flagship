import XCTest
import CryptoKit
@testable import FlagshipUI
@testable import FlagshipAPI
@testable import FlagshipCore

/// BuilderPairViewModel handshake logic, driven by a MockBuilderPairClient.
/// One-shot model: parse → connect → SAS → phone-hello → deliver-once. Minting
/// (confirmAndDeliver) needs the Keychain/biometric, so it's not exercised here.
@MainActor
final class BuilderPairViewModelTests: XCTestCase {

    private func makeVM(_ client: MockBuilderPairClient) -> BuilderPairViewModel {
        let minter = CreateServerViewModel(
            username: "tester",
            server: MockFlagshipServerClient(),
            relay: MockQrRelayClient()
        )
        return BuilderPairViewModel(client: client, minter: minter)
    }

    func test_connectsToSessionIdDerivedFromCode() async {
        let client = MockBuilderPairClient()
        let vm = makeVM(client)
        await vm.qrDetected("AEBA-GBAF")
        // 0102030405 → pinned sid.
        XCTAssertEqual(client.connectedSid, "F2x43pqWEQ9rjC9jLfItSh4RE0K3Izzb")
    }

    func test_builderHelloDerivesSasAndSendsPhoneHello() async throws {
        let client = MockBuilderPairClient()
        let vm = makeVM(client)
        // Typed-code path: no pubkey until builder-hello.
        await vm.qrDetected("AEBA-GBAF")

        let builderPk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
        client.emit(.builderHello(builderPkB64: builderPk))
        // Let the async handler run.
        try await Task.sleep(nanoseconds: 100_000_000)

        if case .matching(let code, _) = vm.phase {
            XCTAssertEqual(code.count, 6)
        } else {
            XCTFail("expected .matching, got \(vm.phase)")
        }
        // A phone-hello must have been sent to the builder.
        XCTAssertTrue(client.sentJSON.contains { $0.contains("\"phone-hello\"") })
    }

    func test_peerGoneEndsSession() async throws {
        let client = MockBuilderPairClient()
        let vm = makeVM(client)
        await vm.qrDetected("AEBA-GBAF")
        client.emit(.peerGone)
        try await Task.sleep(nanoseconds: 100_000_000)
        if case .failed = vm.phase {} else { XCTFail("expected .failed, got \(vm.phase)") }
    }

    func test_qrPathDerivesImmediately() async throws {
        let client = MockBuilderPairClient()
        let vm = makeVM(client)
        let pk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
        await vm.qrDetected("flagship://builder?c=AEBAGBAF&k=\(pk)")
        client.emit(.accepted)
        try await Task.sleep(nanoseconds: 100_000_000)
        // QR path has the pubkey up front → goes straight to matching + sends hello.
        if case .matching = vm.phase {} else { XCTFail("expected .matching, got \(vm.phase)") }
        XCTAssertTrue(client.sentJSON.contains { $0.contains("\"phone-hello\"") })
    }

    func test_transientPhoneSocketLossReconnectsSameSession() async throws {
        let client = MockBuilderPairClient()
        let vm = makeVM(client)
        let pk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
        await vm.qrDetected("flagship://builder?c=AEBAGBAF&k=\(pk)")
        client.emit(.accepted)
        try await Task.sleep(nanoseconds: 100_000_000)
        client.emit(.relayError("network connection was lost"))
        try await Task.sleep(nanoseconds: 500_000_000)

        XCTAssertEqual(client.connectCount, 2)
        if case .connecting = vm.phase {} else {
            XCTFail("expected reconnecting connection, got \(vm.phase)")
        }

        client.emit(.accepted)
        try await Task.sleep(nanoseconds: 100_000_000)
        if case .matching = vm.phase {} else {
            XCTFail("expected matching after reconnect, got \(vm.phase)")
        }
    }
}
