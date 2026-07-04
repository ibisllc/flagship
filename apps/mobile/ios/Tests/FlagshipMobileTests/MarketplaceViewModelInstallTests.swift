import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

/// Parity-3 (feat/marketplace): the iOS MarketplaceViewModel gained the
/// install lifecycle (was browse-only). These pin the same contract Android's
/// MarketplaceViewModelTest pins — fetch → hash-verify → sign canonical bytes
/// with the OWNER IRK → POST — plus the paid-app 402 gate and the
/// manifest-hash-mismatch reject.
///
/// NOTE (harness): these run under the iOS test target (xcodebuild), not
/// `swift test --package-path apps/mobile/shared`. Left for the integration
/// xcodebuild pass.
@MainActor
final class MarketplaceViewModelInstallTests: XCTestCase {

    private func key() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
    }

    func test_install_signsCanonicalBytes_andRecordsEnvelope() async {
        let client = MockScreensClient()
        client.simulatedLatency = 0
        let k = key()
        let vm = MarketplaceViewModel(
            client: client,
            signer: { _ in k },
            now: { 1_700_000_000_000 }
        )
        await vm.install(creator: "trent", slug: "scratchpad", serverId: "home.harry.flagship.services")

        guard case .succeeded(let serviceId) = vm.installState else {
            return XCTFail("expected .succeeded, got \(vm.installState)")
        }
        XCTAssertEqual(serviceId, "trent--scratchpad")
        XCTAssertEqual(client.listingFetches.count, 1)
        XCTAssertEqual(client.installCalls.count, 1)
        let recorded = client.installCalls[0]
        XCTAssertEqual(recorded.request.serverId, "home.harry.flagship.services")
        XCTAssertEqual(recorded.request.issuedAt, 1_700_000_000_000)
        XCTAssertTrue(recorded.request.addOwnerToMembership)
        // The signature is over the canonical bytes, not the request JSON.
        let sig = HexUtil.decode(recorded.signature)!
        XCTAssertTrue(k.publicKey.isValidSignature(sig, for: installServiceCanonicalBytes(recorded.request)))
    }

    func test_install_rejectsManifestHashMismatch_withoutPosting() async {
        let client = MockScreensClient()
        client.simulatedLatency = 0
        client.tamperListingManifest = true
        let k = key()
        let vm = MarketplaceViewModel(client: client, signer: { _ in k })
        await vm.install(creator: "trent", slug: "scratchpad", serverId: "home.harry.flagship.services")
        guard case .failed(let msg) = vm.installState else {
            return XCTFail("expected .failed, got \(vm.installState)")
        }
        XCTAssertTrue(msg.lowercased().contains("hash mismatch"))
        XCTAssertEqual(client.installCalls.count, 0, "a tampered manifest must never reach the box")
    }

    func test_install_paidApp_surfacesPaymentRequired() async {
        let client = MockScreensClient()
        client.simulatedLatency = 0
        client.installShouldFail = true
        // The .com paid-app gate returns 402 with a price_usd_cents body.
        client.installFailureStatus = 402
        client.installFailureMessage = #"{"paid":true,"price_usd_cents":499}"#
        let k = key()
        let vm = MarketplaceViewModel(client: client, signer: { _ in k })
        await vm.install(creator: "wendy", slug: "wishlist", serverId: "home.harry.flagship.services")
        guard case .paymentRequired(let cents) = vm.installState else {
            return XCTFail("expected .paymentRequired, got \(vm.installState)")
        }
        XCTAssertEqual(cents, 499)
    }

    func test_install_surfacesDaemonError() async {
        let client = MockScreensClient()
        client.simulatedLatency = 0
        client.installShouldFail = true
        client.installFailureMessage = "manifest signature invalid"
        let k = key()
        let vm = MarketplaceViewModel(client: client, signer: { _ in k })
        await vm.install(creator: "trent", slug: "scratchpad", serverId: "home.harry.flagship.services")
        guard case .failed = vm.installState else {
            return XCTFail("expected .failed, got \(vm.installState)")
        }
    }
}
