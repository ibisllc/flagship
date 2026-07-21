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

    func test_debugFriendlyOffByDefault() {
        let vm = makeVM()
        XCTAssertFalse(vm.debugFriendly, "production (non-debug) server is the default")
    }

    func test_turningAdvancedOff_resetsDebugFriendly() {
        let vm = makeVM()
        vm.advancedMode = true
        vm.debugFriendly = true
        vm.advancedMode = false
        XCTAssertFalse(vm.debugFriendly, "debug-friendly snaps back off when Advanced is off")
    }

    /// The minter bakes a VERIFIABLE owner-IRK debug-access grant in the EXACT
    /// `{grant:{serverDomain,sshAuthorizedKey,issuedAt},signatureHex}` JSON the
    /// box-side gate (debugAccessGate.ts) consumes.
    func test_debugGrantEnvelope_isVerifiableAndMatchesBoxGateShape() throws {
        let irk = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x07, count: 32))
        let serverDomain = "home.harry.flagship.services"
        let now: Int64 = 1_750_000_000_000
        let envelope = CreateServerViewModel.debugGrantEnvelope(serverDomain: serverDomain, irk: irk, now: now)

        let obj = try JSONSerialization.jsonObject(with: Data(envelope.utf8)) as! [String: Any]
        let grant = obj["grant"] as! [String: Any]
        XCTAssertEqual(grant["serverDomain"] as? String, serverDomain)
        XCTAssertEqual(grant["sshAuthorizedKey"] as? String, "", "console-only grant carries an empty SSH key")
        XCTAssertEqual((grant["issuedAt"] as? NSNumber)?.int64Value, now)
        let sigHex = obj["signatureHex"] as! String

        // The signature verifies under the owner IRK over the canonical bytes —
        // exactly the box-side check.
        let g = DebugAccess.Grant(serverDomain: serverDomain, sshAuthorizedKey: "", issuedAt: now)
        XCTAssertTrue(DebugAccess.verify(g, signatureHex: sigHex, irkPub: irk.publicKey.rawRepresentation))
    }
}

/// The recipe's `debugGrant` sibling is on the wire when present + omitted when
/// absent (mirroring swkHex/pairingOrder), so a non-debug recipe is
/// byte-identical to before.
final class SignedInstallBlobDebugGrantTests: XCTestCase {
    private func signed(debugGrant: String?) -> SignedInstallBlob {
        let auth = AuthCode(
            serial: "01ABCD", username: "harry", serverName: "home",
            serverDomain: "home.harry.flagship.services",
            delegatedPubKey: Data(repeating: 0x11, count: 32),
            userPubKey: Data(repeating: 0x22, count: 32),
            issuedAt: 1_000, expiresAt: 2_000
        )
        let blob = InstallBlob(
            serverDomain: "home.harry.flagship.services", username: "harry", serverName: "home",
            phoneDelegatedPubKey: Data(repeating: 0x33, count: 32),
            authCode: auth, authCodeUserSignature: Data(repeating: 0x44, count: 64),
            rckPubKey: Data(repeating: 0x55, count: 32)
        )
        return SignedInstallBlob(blob: blob, signatureHex: "ab", debugGrant: debugGrant)
    }

    private func json(_ s: SignedInstallBlob) throws -> String {
        String(data: try JSONEncoder().encode(s.onWire()), encoding: .utf8)!
    }

    func test_debugGrantOnWireWhenPresent() throws {
        let j = try json(signed(debugGrant: "{\"grant\":{},\"signatureHex\":\"ab\"}"))
        XCTAssertTrue(j.contains("debugGrant"))
    }

    func test_debugGrantOmittedWhenAbsent() throws {
        let j = try json(signed(debugGrant: nil))
        XCTAssertFalse(j.contains("debugGrant"))
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

    private func freshCgkStore() -> PendingCgkDepositStore {
        let suite = "flagship.cgkDeposit.tests.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: suite)!; d.removePersistentDomain(forName: suite)
        return PendingCgkDepositStore(defaults: d)
    }

    private func coordinator(store: PendingSwkDepositStore, mailbox: MockSecretMailboxClient, hasSession: Bool = true) -> SwkDepositCoordinator {
        let irk = ownerIrk()
        let swkHex = HexUtil.encode(swk)
        return SwkDepositCoordinator(
            username: "alice",
            mailbox: mailbox,
            store: store,
            cgkStore: freshCgkStore(),
            hasSessionKey: { hasSession },
            deriveIrkAndSwk: { _, _ in (irk, swkHex) },
            deriveCgkHex: { _ in HexUtil.encode(Data(repeating: 0x55, count: 32)) }
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

    func test_coldSessionDefersDeposit_noPrompt_staysPending() async {
        // The automatic (reconcile-driven) deposit must NEVER initiate a Face ID
        // prompt: when the session is not already unlocked (`hasSessionKey` false)
        // it defers — no deposit, the pending marker stays for a later pass once
        // the user has authenticated. This is what stops the "random Face ID on
        // the Home screen" a periodic refresh used to cause.
        let store = freshStore()
        store.markPending(for: serverDomain)
        let mailbox = MockSecretMailboxClient()
        await coordinator(store: store, mailbox: mailbox, hasSession: false)
            .depositIfNeeded(serverDomain: serverDomain, identityPubKeyHex: boxIdentityPubHex())
        XCTAssertTrue(mailbox.swkDeposits.isEmpty, "cold session must not deposit")
        XCTAssertTrue(store.isPending(for: serverDomain), "marker stays pending for retry")
        XCTAssertFalse(store.isDeposited(for: serverDomain))
    }

    func test_userInitiatedRepairMayAuthenticateAndDeposit() async {
        let store = freshStore()
        store.markPending(for: serverDomain)
        let mailbox = MockSecretMailboxClient()
        await coordinator(store: store, mailbox: mailbox, hasSession: false)
            .depositIfNeeded(
                serverDomain: serverDomain,
                identityPubKeyHex: boxIdentityPubHex(),
                allowAuthentication: true
            )
        XCTAssertEqual(mailbox.swkDeposits.count, 1)
        XCTAssertTrue(store.isDeposited(for: serverDomain))
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

    /// CGK provisioning: when a CGK deposit is owed, it fires sealed to the box
    /// identity (the EXACT twin of the SWK deposit) and round-trips through the
    /// box-side verify/unseal.
    func test_depositsCgk_whenOwed_sealsToBoxIdentity_opensExact() async throws {
        let swkStore = freshStore()
        let cgkStore = freshCgkStore()
        cgkStore.markPending(for: serverDomain)
        let mailbox = MockSecretMailboxClient()
        let irk = ownerIrk()
        let cgk = Data(repeating: 0x55, count: 32)
        let coord = SwkDepositCoordinator(
            username: "alice", mailbox: mailbox, store: swkStore, cgkStore: cgkStore,
            hasSessionKey: { true },
            deriveIrkAndSwk: { _, _ in (irk, HexUtil.encode(self.swk)) },
            deriveCgkHex: { _ in HexUtil.encode(cgk) }
        )
        await coord.depositIfNeeded(serverDomain: serverDomain, identityPubKeyHex: boxIdentityPubHex())

        XCTAssertEqual(mailbox.cgkDeposits.count, 1)
        XCTAssertTrue(mailbox.swkDeposits.isEmpty, "SWK not owed (only CGK)")
        let body = mailbox.cgkDeposits[0].body
        XCTAssertEqual(body.deposit.stkPub, boxIdentityPubHex())

        let parsed = try parseCarrier(body.deposit.sealed)
        let delivery = CgkDelivery.Delivery(
            serverDomain: parsed.serverDomain, sealed: parsed.sealed, issuedAt: parsed.issuedAt
        )
        XCTAssertTrue(irk.publicKey.isValidSignature(
            parsed.signature, for: try CgkDelivery.canonicalBytes(delivery)
        ))
        let x25519Priv = Curve25519Map.edwardsSeedToMontgomery(boxSeed)
        let opened = try SecretSeal.openWithX25519(blob: parsed.sealed, recipientX25519Priv: x25519Priv)
        XCTAssertEqual(HexUtil.encode(opened), HexUtil.encode(cgk))

        // Idempotency: marked deposited, second pass does not re-deposit.
        XCTAssertTrue(cgkStore.isDeposited(for: serverDomain))
        await coord.depositIfNeeded(serverDomain: serverDomain, identityPubKeyHex: boxIdentityPubHex())
        XCTAssertEqual(mailbox.cgkDeposits.count, 1, "no double-deposit")
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

/// Server-migration SWK contract (docs/server-migration.md invariant 4): the
/// coordinator consults the migration resolver BEFORE deriving, so a
/// migration's provisional new pod gets the MIGRATING domain's SWK (DOTS
/// `flagship.swk.v1|<migrating domain>` — the deriveIRKBoxStkAndSwk path) and
/// an ambiguous pod (live migration, no attached box yet) DEFERS instead of
/// depositing a wrong-name SWK that would poison the restore.
@MainActor
final class SwkDepositMigrationContractTests: XCTestCase {
    private let migratingDomain = "home.alice.flagship.services"
    private let provisionalDomain = "attic.alice.flagship.services"

    private func freshStore() -> PendingSwkDepositStore {
        let suite = "flagship.swkDeposit.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return PendingSwkDepositStore(defaults: defaults)
    }
    private func freshCgkStore() -> PendingCgkDepositStore {
        let suite = "flagship.cgkDeposit.tests.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: suite)!; d.removePersistentDomain(forName: suite)
        return PendingCgkDepositStore(defaults: d)
    }

    private func ownerIrk() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x07, count: 32))
    }
    private let boxSeed = Data(repeating: 0x09, count: 32)
    private func boxIdentityPubHex() -> String {
        HexUtil.encode(try! Curve25519.Signing.PrivateKey(rawRepresentation: boxSeed).publicKey.rawRepresentation)
    }

    private final class DerivedBox { var serverIds: [String] = [] }

    private func coordinator(
        store: PendingSwkDepositStore,
        mailbox: MockSecretMailboxClient,
        resolution: MigrationSwkResolution,
        derived: DerivedBox
    ) -> SwkDepositCoordinator {
        let irk = ownerIrk()
        return SwkDepositCoordinator(
            username: "alice",
            mailbox: mailbox,
            store: store,
            cgkStore: freshCgkStore(),
            hasSessionKey: { true },
            deriveIrkAndSwk: { serverId, _ in
                derived.serverIds.append(serverId)
                return (irk, HexUtil.encode(Data(repeating: 0x33, count: 32)))
            },
            deriveCgkHex: { _ in HexUtil.encode(Data(repeating: 0x55, count: 32)) },
            resolveMigrationSwk: { _ in resolution }
        )
    }

    func test_attachedNewPodDerivesFromMigratingDomain() async {
        let store = freshStore()
        store.markPending(for: provisionalDomain)
        let mailbox = MockSecretMailboxClient()
        let derived = DerivedBox()
        await coordinator(store: store, mailbox: mailbox, resolution: .migratingDomain(migratingDomain), derived: derived)
            .depositIfNeeded(serverDomain: provisionalDomain, identityPubKeyHex: boxIdentityPubHex())

        XCTAssertEqual(derived.serverIds, [migratingDomain], "SWK derives from the MIGRATING domain, not the pod's own name")
        XCTAssertEqual(mailbox.swkDeposits.count, 1)
        // The deposit still ADDRESSES the provisional pod (it claims the blob).
        XCTAssertEqual(mailbox.swkDeposits[0].serverDomain, provisionalDomain)
        XCTAssertEqual(mailbox.swkDeposits[0].body.deposit.serverDomain, provisionalDomain)
        XCTAssertTrue(store.isDeposited(for: provisionalDomain))
    }

    func test_unattachedMigrationDefersDeposit() async {
        let store = freshStore()
        store.markPending(for: provisionalDomain)
        let mailbox = MockSecretMailboxClient()
        let derived = DerivedBox()
        await coordinator(store: store, mailbox: mailbox, resolution: .deferDeposit, derived: derived)
            .depositIfNeeded(serverDomain: provisionalDomain, identityPubKeyHex: boxIdentityPubHex())

        XCTAssertTrue(mailbox.swkDeposits.isEmpty, "no deposit while the migration hasn't attached its new box")
        XCTAssertTrue(derived.serverIds.isEmpty, "nothing owed ⇒ no biometric derivation at all")
        XCTAssertTrue(store.isPending(for: provisionalDomain), "the pending marker stays — the next reconcile retries")
    }

    func test_normalResolutionDerivesFromOwnName() async {
        let store = freshStore()
        store.markPending(for: provisionalDomain)
        let mailbox = MockSecretMailboxClient()
        let derived = DerivedBox()
        await coordinator(store: store, mailbox: mailbox, resolution: .normal, derived: derived)
            .depositIfNeeded(serverDomain: provisionalDomain, identityPubKeyHex: boxIdentityPubHex())

        XCTAssertEqual(derived.serverIds, [provisionalDomain])
        XCTAssertEqual(mailbox.swkDeposits.count, 1)
    }

    func test_deferStillDeliversAnOwedCgk() async {
        // The defer is SWK-scoped: the CGK is per-cloud (not serverId-derived),
        // so an owed CGK still goes out on the same pass.
        let store = freshStore()
        store.markPending(for: provisionalDomain)
        let cgkStore = freshCgkStore()
        cgkStore.markPending(for: provisionalDomain)
        let mailbox = MockSecretMailboxClient()
        let irk = ownerIrk()
        let coord = SwkDepositCoordinator(
            username: "alice", mailbox: mailbox, store: store, cgkStore: cgkStore,
            hasSessionKey: { true },
            deriveIrkAndSwk: { _, _ in (irk, HexUtil.encode(Data(repeating: 0x33, count: 32))) },
            deriveCgkHex: { _ in HexUtil.encode(Data(repeating: 0x55, count: 32)) },
            resolveMigrationSwk: { _ in .deferDeposit }
        )
        await coord.depositIfNeeded(serverDomain: provisionalDomain, identityPubKeyHex: boxIdentityPubHex())

        XCTAssertTrue(mailbox.swkDeposits.isEmpty)
        XCTAssertTrue(store.isPending(for: provisionalDomain))
        XCTAssertEqual(mailbox.cgkDeposits.count, 1)
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
            hasSessionKey: { true },
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
