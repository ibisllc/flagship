import Foundation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Secret-free-recipe SWK delivery, phone side
/// (docs/recipe-delivery-and-remote-install.md).
///
/// When a server is created WITHOUT embedding the SWK in the recipe (the
/// default), the recipe is secret-free of the SWK; the box boots platform-less
/// and registers. This coordinator, fired when the box appears registered in
/// `/pods` (with its identity pub), derives the box's deterministic SWK
/// (`ServerKeys.deriveSwk` — the same DOTS box key as create) under ONE
/// biometric, seals it to the box's REGISTERED identity, IRK-signs the wrapper,
/// and deposits the sealed carrier on `.com`'s blind swk-deposit lane. The box
/// claims it on boot and turns on its service/build platform.
///
/// Best-effort + idempotent: it no-ops unless a deposit is owed
/// (`PendingSwkDepositStore.isPending`), and marks `deposited` only after a 200
/// so a later reconcile never double-deposits. A failure leaves the `pending`
/// marker in place so the next reconcile retries — the box just stays
/// platform-less meanwhile, never bricked. Mirrors the entitlement-deposit
/// pattern (one biometric at deposit time is acceptable).
@MainActor
public struct SwkDepositCoordinator {
    private let username: String
    private let mailbox: any SecretMailboxClient
    private let store: PendingSwkDepositStore
    /// Stash of the create-time pairing order owed per server (secret-free
    /// pairing). Deposited on the SAME pass as the SWK (one biometric → both).
    private let pairingStore: PendingPairingDepositStore
    /// Stash of the CGK deposit owed per server (per-service leadership). The CGK
    /// is the per-CLOUD gossip key, delivered post-boot exactly like the SWK and
    /// on the SAME biometric pass.
    private let cgkStore: PendingCgkDepositStore
    /// Derives (IRK, box SWK hex) under one biometric for the given serverId.
    /// Injectable so tests don't hit the Keychain/biometric.
    private let deriveIrkAndSwk: (_ serverId: String, _ reason: String) async throws -> (irk: Curve25519.Signing.PrivateKey, swkHex: String)
    /// Derives the per-cloud CGK hex (no serverId). Injectable so tests don't hit
    /// the Keychain/biometric. The IRK from `deriveIrkAndSwk` is reused for the
    /// CGK deposit's owner signature, so this returns only the CGK material.
    private let deriveCgkHex: (_ reason: String) async throws -> String
    /// Server-migration seam (docs/server-migration.md invariant 4): which
    /// serverId the SWK for a pod derives from. Injectable so tests don't hit
    /// the network; the default consults the persisted migration holds and only
    /// touches `.com` when one is live.
    private let resolveMigrationSwk: (_ podDomain: String) async -> MigrationSwkResolution
    /// True iff the app already holds an unlocked-session key, so a derive this
    /// pass is silent (no Face ID). The automatic deposit path DEFERS when the
    /// session is cold, so a background refresh never *initiates* a biometric — it
    /// rides an already-unlocked session or waits for the next one. Injectable so
    /// tests run without a Keychain session (default: the real session cache).
    private let hasSessionKey: () -> Bool

    public init(
        username: String,
        mailbox: any SecretMailboxClient,
        store: PendingSwkDepositStore = PendingSwkDepositStore(),
        pairingStore: PendingPairingDepositStore = PendingPairingDepositStore(),
        cgkStore: PendingCgkDepositStore = PendingCgkDepositStore(),
        hasSessionKey: @escaping () -> Bool = { Keystore.hasSessionKey() },
        deriveIrkAndSwk: @escaping (_ serverId: String, _ reason: String) async throws -> (irk: Curve25519.Signing.PrivateKey, swkHex: String) = { serverId, reason in
            let m = try await Keystore.deriveIRKBoxStkAndSwk(serverId: serverId, reason: reason)
            return (m.irk, m.boxSwkHex)
        },
        deriveCgkHex: @escaping (_ reason: String) async throws -> String = { reason in
            let m = try await Keystore.deriveIRKAndCgk(reason: reason)
            return m.cgkHex
        },
        resolveMigrationSwk: ((_ podDomain: String) async -> MigrationSwkResolution)? = nil
    ) {
        self.username = username
        self.mailbox = mailbox
        self.store = store
        self.pairingStore = pairingStore
        self.cgkStore = cgkStore
        self.hasSessionKey = hasSessionKey
        self.deriveIrkAndSwk = deriveIrkAndSwk
        self.deriveCgkHex = deriveCgkHex
        self.resolveMigrationSwk = resolveMigrationSwk ?? { podDomain in
            let holdStore = MigrationHoldStore()
            let holds = holdStore.holds()
            guard !holds.isEmpty else { return .normal }
            let client = LiveServerMigrationClient()
            return await MigrationSwkResolver.resolve(
                podDomain: podDomain,
                holds: holds,
                fetchSession: { try await client.fetchMigration(serverDomain: $0) },
                clearHold: { holdStore.clearHold(for: $0) }
            )
        }
    }

    /// Deposit what's OWED for a box that has registered (carrying
    /// `identityPubKeyHex`): the SWK (turns on the service platform) AND/OR the
    /// secret-free PAIRING order (pairs the creating device with no manual tap).
    /// Both ride ONE biometric (the IRK derived once) and are sealed to the box
    /// identity. No-op when nothing is owed.
    public func depositIfNeeded(
        serverDomain: String,
        identityPubKeyHex: String,
        allowAuthentication: Bool = false
    ) async {
        var swkOwed = store.isPending(for: serverDomain)
        let pairingOrderJson = pairingStore.pendingOrder(for: serverDomain)
        let cgkOwed = cgkStore.isPending(for: serverDomain)
        guard swkOwed || pairingOrderJson != nil || cgkOwed else { return }
        // Never let this automatic (reconcile-driven) deposit INITIATE a Face ID
        // prompt: proceed only when the session is already unlocked, so the derive
        // below is silent. A cold session defers — the pending markers stay and the
        // deposit rides the next pass after the user next authenticates. This is
        // what stops the "random Face ID on the Home screen" the periodic reconcile
        // used to cause when a box left a deposit owed.
        guard allowAuthentication || hasSessionKey() else { return }
        guard let boxIdentityPub = HexUtil.decode(identityPubKeyHex), boxIdentityPub.count == 32 else { return }

        // Server-migration (docs/server-migration.md invariant 4): when this pod
        // is the attached NEW box of a live migration, its SWK MUST derive from
        // the MIGRATING serverDomain (`ServerKeys.deriveSwk` DOTS — so the old
        // box's peer-backup shards decrypt); while a live migration hasn't
        // attached its new box yet, the SWK deposit is DEFERRED (the pending
        // marker stays; a wrong-name SWK would poison the restore). Pairing/CGK
        // are unaffected (per-cloud / not serverId-derived).
        var swkServerId = serverDomain
        if swkOwed {
            switch await resolveMigrationSwk(serverDomain) {
            case .migratingDomain(let migrating):
                swkServerId = migrating
            case .deferDeposit:
                swkOwed = false
            case .normal:
                break
            }
            guard swkOwed || pairingOrderJson != nil || cgkOwed else { return }
        }
        do {
            let (irk, swkHex) = try await deriveIrkAndSwk(swkServerId, "Authorize \(serverDomain) to run apps")

            if swkOwed, let swk = HexUtil.decode(swkHex), swk.count == 32 {
                let body = try SwkDelivery.buildDeposit(
                    username: username,
                    serverDomain: serverDomain,
                    swk: swk,
                    boxIdentityPub: boxIdentityPub,
                    irk: irk
                )
                try await mailbox.depositSwk(serverDomain: serverDomain, body: body)
                // Only flip to `deposited` AFTER `.com` accepted it.
                store.markDeposited(for: serverDomain)
            }

            if let pairingOrderJson {
                let body = try PairingOrderDeposit.buildDeposit(
                    username: username,
                    serverDomain: serverDomain,
                    pairingOrderJson: pairingOrderJson,
                    boxIdentityPub: boxIdentityPub,
                    irk: irk
                )
                try await mailbox.depositPairing(serverDomain: serverDomain, body: body)
                pairingStore.markDeposited(for: serverDomain)
            }

            // CGK delivery — the EXACT twin of the SWK deposit, on the same
            // biometric (the IRK is already in hand). The CGK is per-CLOUD (no
            // serverId), sealed to THIS box's registered identity. Best-effort:
            // a box without a CGK just doesn't gossip yet (never bricked).
            if cgkOwed {
                let cgkHex = try await deriveCgkHex("Authorize \(serverDomain) to join your cloud")
                if let cgk = HexUtil.decode(cgkHex), cgk.count == 32 {
                    let body = try CgkDelivery.buildDeposit(
                        username: username,
                        serverDomain: serverDomain,
                        cgk: cgk,
                        boxIdentityPub: boxIdentityPub,
                        irk: irk
                    )
                    try await mailbox.depositCgk(serverDomain: serverDomain, body: body)
                    cgkStore.markDeposited(for: serverDomain)
                }
            }
        } catch {
            // Leave the `pending` marker(s) so the next reconcile retries.
        }
    }
}
