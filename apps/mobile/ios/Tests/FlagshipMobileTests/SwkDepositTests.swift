import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import Flagship
@testable import FlagshipAPI

/// Secret-free recipe (docs/recipe-delivery-and-remote-install.md): the
/// Advanced-mode embed-secrets toggle + the post-registration SWK deposit.
@MainActor
final class CreateServerAdvancedToggleTests: XCTestCase {
    private func makeVM() -> CreateServerViewModel {
        CreateServerViewModel(
            username: "harry",
            server: MockFlagshipServerClient(),
            relay: MockQrRelayClient()
        )
    }

    func test_advancedOffByDefault_embedSecretsOff() {
        let vm = makeVM()
        XCTAssertFalse(vm.advancedMode)
        XCTAssertFalse(vm.embedSecrets, "secret-free recipe is the default")
    }

    func test_turningAdvancedOff_resetsEmbedSecrets() {
        let vm = makeVM()
        vm.advancedMode = true
        vm.embedSecrets = true
        vm.advancedMode = false
        XCTAssertFalse(vm.embedSecrets, "embed-secrets snaps back to secret-free when Advanced is off")
    }
}

/// The PendingSwkDepositStore three-state lifecycle.
final class PendingSwkDepositStoreTests: XCTestCase {
    private func freshStore() -> PendingSwkDepositStore {
        let suite = "flagship.swkDeposit.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return PendingSwkDepositStore(defaults: defaults)
    }

    func test_lifecycle() {
        let store = freshStore()
        let d = "home.harry.flagship.services"
        XCTAssertFalse(store.isPending(for: d))
        XCTAssertFalse(store.isDeposited(for: d))
        store.markPending(for: d)
        XCTAssertTrue(store.isPending(for: d))
        store.markDeposited(for: d)
        XCTAssertFalse(store.isPending(for: d))
        XCTAssertTrue(store.isDeposited(for: d))
        store.clear(for: d)
        XCTAssertFalse(store.isPending(for: d))
        XCTAssertFalse(store.isDeposited(for: d))
    }
}

/// The coordinator: deposits ONLY when a deposit is owed, seals to the box
/// identity + signs under the owner IRK (verifiable by `@flagship/protocol`'s
/// open-and-verify, mirrored here), and is idempotent (marks deposited on 200).
@MainActor
final class SwkDepositCoordinatorTests: XCTestCase {
    private let serverDomain = "kitchen.alice.flagship.services"
    private let serverId = "kitchen.alice.flagship.services"

    private func freshStore() -> PendingSwkDepositStore {
        let suite = "flagship.swkDeposit.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return PendingSwkDepositStore(defaults: defaults)
    }

    // Deterministic owner IRK + box identity for the test.
    private func ownerIrk() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x07, count: 32))
    }
    private let boxSeed = Data(repeating: 0x09, count: 32)
    private func boxIdentityPubHex() -> String {
        HexUtil.encode(try! Curve25519.Signing.PrivateKey(rawRepresentation: boxSeed).publicKey.rawRepresentation)
    }
    // A fixed 32-byte SWK for the test (the production path derives via Keystore).
    private let swk = Data(repeating: 0x33, count: 32)

    private func coordinator(store: PendingSwkDepositStore, mailbox: MockSecretMailboxClient) -> SwkDepositCoordinator {
        let irk = ownerIrk()
        let swkHex = HexUtil.encode(swk)
        return SwkDepositCoordinator(
            username: "alice",
            mailbox: mailbox,
            store: store,
            deriveIrkAndSwk: { _, _ in (irk, swkHex) }
        )
    }

    func test_noOpWhenNothingOwed() async {
        let store = freshStore()
        let mailbox = MockSecretMailboxClient()
        await coordinator(store: store, mailbox: mailbox)
            .depositIfNeeded(serverDomain: serverDomain, identityPubKeyHex: boxIdentityPubHex())
        XCTAssertTrue(mailbox.swkDeposits.isEmpty, "no deposit when none owed")
    }

    func test_depositsWhenPending_sealsToBoxIdentity_verifiesUnderOwnerIrk() async throws {
        let store = freshStore()
        store.markPending(for: serverDomain)
        let mailbox = MockSecretMailboxClient()
        await coordinator(store: store, mailbox: mailbox)
            .depositIfNeeded(serverDomain: serverDomain, identityPubKeyHex: boxIdentityPubHex())

        XCTAssertEqual(mailbox.swkDeposits.count, 1)
        let body = mailbox.swkDeposits[0].body
        XCTAssertEqual(mailbox.swkDeposits[0].serverDomain, serverDomain)
        // The deposit binds the box's REGISTERED identity (I2).
        XCTAssertEqual(body.deposit.stkPub, boxIdentityPubHex())
        XCTAssertEqual(body.deposit.serverDomain, serverDomain)

        // Decode the carrier and re-verify the way the BOX does: owner-IRK
        // signature over canonical bytes + unseal the SWK with the box identity.
        let carrierHex = body.deposit.sealed
        let parsed = try parseCarrier(carrierHex)
        // Signature verifies under the owner IRK.
        let delivery = SwkDelivery.Delivery(
            serverDomain: parsed.serverDomain, sealed: parsed.sealed, issuedAt: parsed.issuedAt
        )
        XCTAssertTrue(ownerIrk().publicKey.isValidSignature(
            parsed.signature, for: try SwkDelivery.canonicalBytes(delivery)
        ))
        // Unseal to the exact SWK with the box X25519 priv.
        let x25519Priv = Curve25519Map.edwardsSeedToMontgomery(boxSeed)
        let opened = try SecretSeal.openWithX25519(blob: parsed.sealed, recipientX25519Priv: x25519Priv)
        XCTAssertEqual(HexUtil.encode(opened), HexUtil.encode(swk))

        // Idempotency: marked deposited, and a second pass does NOT re-deposit.
        XCTAssertTrue(store.isDeposited(for: serverDomain))
        await coordinator(store: store, mailbox: mailbox)
            .depositIfNeeded(serverDomain: serverDomain, identityPubKeyHex: boxIdentityPubHex())
        XCTAssertEqual(mailbox.swkDeposits.count, 1, "no double-deposit")
    }

    func test_failureKeepsPendingForRetry() async {
        let store = freshStore()
        store.markPending(for: serverDomain)
        let mailbox = MockSecretMailboxClient()
        mailbox.swkDepositError = ScreensClientError.http(status: 500, message: "boom")
        await coordinator(store: store, mailbox: mailbox)
            .depositIfNeeded(serverDomain: serverDomain, identityPubKeyHex: boxIdentityPubHex())
        XCTAssertFalse(store.isDeposited(for: serverDomain))
        XCTAssertTrue(store.isPending(for: serverDomain), "stays owed for the next reconcile")
    }

    // Mirror of carrierHexToSwkDelivery for the assertion side.
    private struct ParsedCarrier { let serverDomain: String; let sealed: Data; let issuedAt: Int64; let signature: Data }
    private func parseCarrier(_ hex: String) throws -> ParsedCarrier {
        let data = HexUtil.decode(hex)!
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        return ParsedCarrier(
            serverDomain: obj["serverDomain"] as! String,
            sealed: HexUtil.decode(obj["sealed"] as! String)!,
            issuedAt: Int64((obj["issuedAt"] as! NSNumber).int64Value),
            signature: HexUtil.decode(obj["signature"] as! String)!
        )
    }
}

/// The PendingPairingDepositStore three-state lifecycle (stash → deposited).
final class PendingPairingDepositStoreTests: XCTestCase {
    private func freshStore() -> PendingPairingDepositStore {
        let suite = "flagship.pairingDeposit.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return PendingPairingDepositStore(defaults: defaults)
    }

    func test_lifecycle() {
        let store = freshStore()
        let d = "home.harry.flagship.services"
        let json = "{\"request\":{},\"signature\":\"ab\"}"
        XCTAssertNil(store.pendingOrder(for: d))
        XCTAssertFalse(store.isDeposited(for: d))
        store.markPending(for: d, pairingOrderJson: json)
        XCTAssertEqual(store.pendingOrder(for: d), json)
        store.markDeposited(for: d)
        XCTAssertNil(store.pendingOrder(for: d))
        XCTAssertTrue(store.isDeposited(for: d))
        store.clear(for: d)
        XCTAssertNil(store.pendingOrder(for: d))
        XCTAssertFalse(store.isDeposited(for: d))
    }
}

/// The coordinator's PAIRING branch (riding the same SwkDepositCoordinator):
/// when a pairing order is owed, it seals the order JSON to the box identity +
/// deposits it (the box opens it verbatim); idempotent; failure keeps the stash.
@MainActor
final class PairingDepositCoordinatorTests: XCTestCase {
    private let serverDomain = "kitchen.alice.flagship.services"

    private func ownerIrk() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x07, count: 32))
    }
    private let boxSeed = Data(repeating: 0x09, count: 32)
    private func boxIdentityPubHex() -> String {
        HexUtil.encode(try! Curve25519.Signing.PrivateKey(rawRepresentation: boxSeed).publicKey.rawRepresentation)
    }

    private func freshSwkStore() -> PendingSwkDepositStore {
        let suite = "flagship.swkDeposit.tests.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: suite)!; d.removePersistentDomain(forName: suite)
        return PendingSwkDepositStore(defaults: d)
    }
    private func freshPairingStore() -> PendingPairingDepositStore {
        let suite = "flagship.pairingDeposit.tests.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: suite)!; d.removePersistentDomain(forName: suite)
        return PendingPairingDepositStore(defaults: d)
    }

    private func coordinator(swk: PendingSwkDepositStore, pairing: PendingPairingDepositStore, mailbox: MockSecretMailboxClient) -> SwkDepositCoordinator {
        let irk = ownerIrk()
        return SwkDepositCoordinator(
            username: "alice", mailbox: mailbox, store: swk, pairingStore: pairing,
            deriveIrkAndSwk: { _, _ in (irk, HexUtil.encode(Data(repeating: 0x33, count: 32))) }
        )
    }

    /// Build a stashable order JSON the way the create flow does.
    private func stashedOrderJson(irk: Curve25519.Signing.PrivateKey) throws -> String {
        try CreateTimePairing.build(
            username: "alice", serverDomain: serverDomain, label: "iPhone",
            irk: irk, now: 1_750_000_000_000, token: "ab".repeated(32)
        ).pairingOrderJson
    }

    func test_depositsPairingOrder_sealsToBoxIdentity_opensVerbatim() async throws {
        let swk = freshSwkStore()
        let pairing = freshPairingStore()
        let irk = ownerIrk()
        let json = try stashedOrderJson(irk: irk)
        pairing.markPending(for: serverDomain, pairingOrderJson: json)
        let mailbox = MockSecretMailboxClient()

        await coordinator(swk: swk, pairing: pairing, mailbox: mailbox)
            .depositIfNeeded(serverDomain: serverDomain, identityPubKeyHex: boxIdentityPubHex())

        // No SWK owed here, only the pairing deposit went out.
        XCTAssertTrue(mailbox.swkDeposits.isEmpty)
        XCTAssertEqual(mailbox.pairingDeposits.count, 1)
        let body = mailbox.pairingDeposits[0].body
        XCTAssertEqual(body.deposit.stkPub, boxIdentityPubHex())
        // The box opens deposit.sealed with its identity seed → the exact JSON.
        let sealed = try XCTUnwrap(HexUtil.decode(body.deposit.sealed))
        let plain = try SecretSeal.openWithEd25519Seed(blob: sealed, recipientEd25519Seed: boxSeed)
        XCTAssertEqual(String(data: plain, encoding: .utf8), json)

        // Idempotent: marked deposited, a second pass does NOT re-deposit.
        XCTAssertTrue(pairing.isDeposited(for: serverDomain))
        await coordinator(swk: swk, pairing: pairing, mailbox: mailbox)
            .depositIfNeeded(serverDomain: serverDomain, identityPubKeyHex: boxIdentityPubHex())
        XCTAssertEqual(mailbox.pairingDeposits.count, 1)
    }

    func test_noOpWhenNothingOwed() async {
        let mailbox = MockSecretMailboxClient()
        await coordinator(swk: freshSwkStore(), pairing: freshPairingStore(), mailbox: mailbox)
            .depositIfNeeded(serverDomain: serverDomain, identityPubKeyHex: boxIdentityPubHex())
        XCTAssertTrue(mailbox.pairingDeposits.isEmpty)
        XCTAssertTrue(mailbox.swkDeposits.isEmpty)
    }
}

private extension String {
    func repeated(_ n: Int) -> String { String(repeating: self, count: n) }
}
