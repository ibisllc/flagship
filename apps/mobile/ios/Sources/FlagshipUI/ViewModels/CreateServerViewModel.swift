import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Orchestrates the v2 create-server flow.
///
/// User-facing sequence:
///
///   1. design       Name + description.
///   2. scanQr       Camera viewfinder pointing at the QR shown on
///                   flagshipserver.com. A small "Copy the QR link
///                   instead?" link below swaps to pasteQr.
///   3. pasteQr      Input box + Submit. Back button returns to scanQr.
///   4. connecting   Opens the relay WS as role=phone, sends hello.
///   5. matching     Shows the 6-digit SAS match code. 600ms gate
///                   before the Confirm button is tappable.
///   6. minting      Three IRK-signed POSTs to flagshipserver.com.
///   7. delivering   AEAD-seal the InstallBlob, push through the relay.
///   8. delivered    Boot-disk-download placeholder. From here on, the
///                   pod sits in AppState with status=.pending until
///                   the freshly-booted box phones home.
///
/// Cancel collapses any open relay socket + resets to .design.
@Observable
@MainActor
public final class CreateServerViewModel {
    public enum Phase: Sendable {
        case design
        /// After design: how do you want to get the recipe to a burner?
        /// (Pair with the burner app · Save/Share the recipe file · Copy ·
        /// Burn on this device [Android]). Replaces the old "scan the site".
        case deliveryChooser
        case scanQr
        case pasteQr
        case connecting
        case matching(matchCode: String, gateExpired: Bool)
        case minting
        case delivering
        case delivered(serial: String, serverDomain: String)
        case failed(String)
    }

    public var phase: Phase = .design
    public var name: String = ""
    /// Capped at `ServerLimits.maxDescription` on every keystroke so a
    /// long one-liner can't wrap the tight rows it later renders in.
    public var description: String = "" {
        didSet {
            if description.count > ServerLimits.maxDescription {
                description = description.clampedServerDescription()
            }
        }
    }
    public var qrUrl: String = ""
    /// Recipe TTL in MILLISECONDS. The phone signs an auth-code whose
    /// `expiresAt = now + recipeTtlMs`; that's the single deadline
    /// gating "can the freshly-booted daemon register with .com?".
    /// Default 6 hours (`6 * 60 * 60_000`), capped at 24 hours.
    /// Anything outside `[5min, 24h]` is clamped by `setRecipeTtlHours`.
    public var recipeTtlMs: Int64 = 6 * 60 * 60_000  // 6h default
    public static let defaultRecipeTtlMs: Int64 = 6 * 60 * 60_000
    public static let minRecipeTtlMs: Int64 = 5 * 60_000
    public static let maxRecipeTtlMs: Int64 = 24 * 60 * 60_000
    /// Defense-in-depth clamp — applied when minting so an out-of-range
    /// value can't slip past the picker (e.g. via API misuse in tests).
    static func clampedRecipeTtlMs(_ raw: Int64) -> Int64 {
        return min(max(raw, minRecipeTtlMs), maxRecipeTtlMs)
    }
    /// Convenience for the picker — bidirectional binding to a Double
    /// hour count is awkward when the underlying type is millis. The
    /// picker emits whole hours; we clamp here.
    public func setRecipeTtlHours(_ h: Double) {
        let clamped = max(min(h, 24.0), 5.0 / 60.0)
        recipeTtlMs = Int64(clamped * 60 * 60_000)
    }
    /// Boot-unlock policy for this server. "auto" (default) self-unlocks via a
    /// box-sealed lease after the first approved boot; "approve" gates every
    /// boot behind the phone. Persisted to `BootUnlockStore` on delivery so the
    /// approval + kill-switch surfaces know the choice. Only "approve" is
    /// carried on the wire — "auto" is the absent/legacy default (mirrors the
    /// webapp's create-server.js and keeps the recipe bytes identical).
    public var bootUnlockMode: BootUnlockStore.Mode = .auto
    /// Whether this server LUKS-encrypts its data disk. On (default) = "luks":
    /// the box encrypts and unlocks at boot via the cloud-held key. Off =
    /// "none": the disk is plaintext — less safe, but for boxes that can't keep
    /// network at boot (e.g. Wi-Fi-only, where the unlock-key fetch can't run).
    /// Carried in the SIGNED InstallBlob: "none" rides the wire as the trailing
    /// `de=none`; "luks" stays absent so the recipe bytes match the encrypted
    /// default + a pre-diskEncryption verifier still accepts it (absence ⇒
    /// "luks"), mirroring how bootUnlockMode "auto" stays off the wire.
    public var encryptDisk: Bool = true
    /// ADVANCED MODE — one toggle, OFF by default ("for people who know what
    /// they're doing"). On mobile it gates the offline path: embed-secrets (the
    /// SWK in the recipe) so a box can install with NO post-registration phone
    /// step. (Choose-your-own-ISO + debug/local-CLI are website/webapp-only —
    /// they have no mobile analogue.) When OFF, the offline sub-options snap back
    /// to the secret-free default.
    public var advancedMode: Bool = false {
        didSet {
            if !advancedMode { embedSecrets = false; debugFriendly = false }
        }
    }
    /// Whether the recipe EMBEDS the box's SWK (the offline path). Default OFF:
    /// the recipe is secret-free of the SWK and the phone DEPOSITS it after the
    /// box registers (docs/recipe-delivery-and-remote-install.md). ON (only
    /// reachable under Advanced mode) embeds `swkHex` in the recipe so the box
    /// installs fully offline with no later deposit — for air-gapped / offline
    /// installs by people who understand the trade-off (the recipe then carries
    /// a secret).
    public var embedSecrets: Bool = false
    /// ADVANCED — make this a debug-friendly server. Default OFF: a production
    /// box (no console login). ON (only reachable under Advanced mode) bakes an
    /// owner-IRK-signed `flagship/debug-access/v1` grant into the recipe as the
    /// UNSIGNED `debugGrant` sibling (mirroring `swkHex`/`pairingOrder`); the
    /// box-side gate (`debugAccessGate.ts`) verifies it under the config-pinned
    /// owner IRK + this box's FQDN before enabling the debug console user. The
    /// grant carries an EMPTY `sshAuthorizedKey` (console-only) and is signed at
    /// MINT time behind the SAME create biometric — no extra Face ID, no
    /// over-the-session consent round-trip. Snaps back OFF when Advanced is off.
    public var debugFriendly: Bool = false
    /// Draft-only metadata — backup policy the user wants applied to this
    /// server once it's up. NOT signed into the InstallBlob (the audit
    /// against InstallBlob.swift confirmed `backupPolicy` does not appear
    /// in canonical bytes); the box reads this later via an owner-signed
    /// `set-backup-policy` order. Defaults to "phone-only" to match the
    /// webapp's draft schema.
    public var backupPolicy: CreateServerDraftStore.BackupPolicy = .phoneOnly {
        didSet { draftStore.setBackupPolicy(backupPolicy) }
    }
    /// Set after the .delivered transition. Container reads this so
    /// the new pending pod records the auth-code serial that Cancel-
    /// order will revoke.
    public var lastDeliveredSerial: String?

    private let username: String
    private let server: any FlagshipServerClient
    private let relay: any QrRelayClient
    private let bootUnlock: BootUnlockStore
    private let draftStore: CreateServerDraftStore
    private let diskEncryption: DiskEncryptionStore
    /// Secret-free recipe: records that an SWK deposit is OWED for this server
    /// when embed-secrets is OFF, so the Home reconcile deposits it once the box
    /// registers. Untouched (no record) when embed-secrets is ON.
    private let swkDepositStore: PendingSwkDepositStore
    /// Secret-free pairing: stashes the create-time `add-paired-session` order
    /// owed for this server when embed-secrets is OFF, so the Home reconcile
    /// seals + deposits it once the box registers. Untouched when embed-secrets
    /// is ON (the order is baked into the recipe instead).
    private let pairingDepositStore: PendingPairingDepositStore
    /// Per-service leadership: records that a CGK deposit is OWED for this server.
    /// The CGK is NEVER embedded in the recipe (it is the per-cloud gossip secret),
    /// so it is owed on EVERY created server, regardless of embed-secrets. The Home
    /// reconcile seals + deposits it (sealed to the box identity) once the box
    /// registers, on the same biometric pass as the SWK.
    private let cgkDepositStore: PendingCgkDepositStore
    /// `.com` mailbox client — kept for parity with the create flow (the pairing
    /// deposit itself now happens post-registration via SwkDepositCoordinator).
    private let mailbox: any SecretMailboxClient
    /// Pod session store — the create-time pairing token is persisted here so
    /// the BFF authenticates the moment the box claims the order.
    private let sessionStore: any SessionStoring

    public init(
        username: String,
        server: any FlagshipServerClient,
        relay: any QrRelayClient,
        bootUnlock: BootUnlockStore = BootUnlockStore(),
        draftStore: CreateServerDraftStore = CreateServerDraftStore(),
        diskEncryption: DiskEncryptionStore = DiskEncryptionStore(),
        swkDepositStore: PendingSwkDepositStore = PendingSwkDepositStore(),
        pairingDepositStore: PendingPairingDepositStore = PendingPairingDepositStore(),
        cgkDepositStore: PendingCgkDepositStore = PendingCgkDepositStore(),
        mailbox: any SecretMailboxClient = MockSecretMailboxClient(),
        sessionStore: any SessionStoring = SessionStore()
    ) {
        self.username = username
        self.server = server
        self.relay = relay
        self.bootUnlock = bootUnlock
        self.diskEncryption = diskEncryption
        self.swkDepositStore = swkDepositStore
        self.pairingDepositStore = pairingDepositStore
        self.cgkDepositStore = cgkDepositStore
        self.draftStore = draftStore
        self.mailbox = mailbox
        self.sessionStore = sessionStore
        // Restore the user's last-typed draft so flipping away from the
        // screen mid-fill doesn't wipe their inputs. Hydrate AFTER the
        // stored properties are assigned so the didSet observers don't
        // double-write the same value back.
        self.backupPolicy = draftStore.backupPolicy()
    }

    public var canAdvanceFromDesign: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
    }

    public var canSubmitPaste: Bool {
        !qrUrl.trimmingCharacters(in: .whitespaces).isEmpty
    }

    public func continueToScan() {
        guard canAdvanceFromDesign else { return }
        phase = .scanQr
    }

    public func switchToPaste() { phase = .pasteQr }
    public func switchToScan()  { phase = .scanQr }

    public func qrDetected(_ raw: String) async {
        qrUrl = raw
        await connectAndMatch()
    }

    public func submitPaste() async {
        guard canSubmitPaste else { return }
        await connectAndMatch()
    }

    private func connectAndMatch() async {
        phase = .connecting
        do {
            let session = try QrRelay.parseQrUrl(qrUrl)
            let phoneSk = Curve25519.KeyAgreement.PrivateKey()
            let derived = try QrRelay.deriveMaterial(
                phonePrivateKey: phoneSk,
                browserPublicKey: session.browserPublicKey
            )
            let phonePkB64u = Base64URL.encode(phoneSk.publicKey.rawRepresentation)
            try await relay.openAndHello(sid: session.sid, phonePkBase64Url: phonePkB64u)
            phase = .matching(matchCode: derived.matchCode, gateExpired: false)
            pendingBundle = .init(session: session, aeadKey: derived.aeadKey)
            Task {
                try? await Task.sleep(nanoseconds: 600_000_000)
                if case .matching(let m, _) = phase {
                    phase = .matching(matchCode: m, gateExpired: true)
                }
            }
        } catch {
            phase = .failed(error.localizedDescription)
            await relay.close()
        }
    }

    public func confirmAndDeliver() async {
        guard case .matching(_, true) = phase, let bundle = pendingBundle else { return }
        phase = .minting
        do {
            let blob = try await mintInstallBlob()
            phase = .delivering
            let onWire = blob.onWire()
            let payload = try JSONEncoder().encode(onWire)
            let sealed = try QrRelay.seal(payload: payload, with: bundle.aeadKey)
            try await relay.deliver(
                ciphertextBase64Url: sealed.ciphertextBase64Url,
                nonceBase64Url: sealed.nonceBase64Url
            )
            lastDeliveredSerial = blob.blob.authCode.serial
            // Remember the boot-unlock choice locally so the approval screen
            // (deposit-or-not) and server detail (kill switch) can act on it.
            bootUnlock.setMode(bootUnlockMode, for: blob.blob.serverDomain)
            // Remember the disk-encryption choice so the server-detail
            // lock/power buttons can pick the right labels ("Lock and turn
            // off" for LUKS vs "Turn off" for a non-LUKS box).
            diskEncryption.setLuks(encryptDisk, for: blob.blob.serverDomain)
            // Clear the draft-only metadata so a fresh "Add a server" starts
            // empty rather than ghost-restoring yesterday's text.
            draftStore.reset()
            phase = .delivered(
                serial: blob.blob.authCode.serial,
                serverDomain: blob.blob.serverDomain
            )
            await relay.close()
        } catch {
            phase = .failed(error.localizedDescription)
            await relay.close()
        }
    }

    /// After the design step, go to the delivery-method chooser instead of
    /// the old "scan the website QR" path.
    public func proceedToDelivery() {
        guard canAdvanceFromDesign else { return }
        phase = .deliveryChooser
    }

    /// Mint the recipe and return its on-wire JSON for the out-of-band
    /// delivery methods (Save/Share file, Copy to clipboard). Performs the
    /// same post-mint bookkeeping the live paths do.
    public func mintRecipeJSON() async throws -> (json: String, serverDomain: String, serial: String) {
        let blob = try await mintInstallBlob()
        lastDeliveredSerial = blob.blob.authCode.serial
        let data = try JSONEncoder().encode(blob.onWire())
        let json = String(data: data, encoding: .utf8) ?? ""
        recordDeliveredBookkeeping(serverDomain: blob.blob.serverDomain)
        return (json, blob.blob.serverDomain, blob.blob.authCode.serial)
    }

    /// Persist the boot-unlock + disk-encryption choices for this server and
    /// clear the draft — shared by every delivery method (website, pair,
    /// share, copy, burn-on-device).
    func recordDeliveredBookkeeping(serverDomain: String) {
        bootUnlock.setMode(bootUnlockMode, for: serverDomain)
        diskEncryption.setLuks(encryptDisk, for: serverDomain)
        draftStore.reset()
    }

    public func cancel() async {
        await relay.close()
        phase = .design
    }

    public func resetToDesign() {
        Task { await relay.close() }
        phase = .design
    }

    private struct PendingBundle {
        let session: QrRelay.QrSession
        let aeadKey: SymmetricKey
    }
    private var pendingBundle: PendingBundle?

    /// Internal (not private) so the burner-pairing flow can reuse the EXACT
    /// minting path (auth-code issue, RCK register, create-time pairing, the
    /// deposit-store bookkeeping) rather than duplicating it — the burner peer
    /// receives a byte-identical `SignedInstallBlob`, just over a different
    /// transport. Configure the design fields, then call this.
    func mintInstallBlob() async throws -> SignedInstallBlob {
        // Phase 2 — the username claim moved to OpenAccountViewModel
        // (the open-account step). By the time we mint a server the
        // account already exists: the UMK was generated and the
        // username claimed at open-account time. We just derive the IRK
        // (UMK is present) for the auth-code + RCK signatures below; we
        // do NOT re-generate the UMK and do NOT re-claim the username.
        let serverNameSlug = SlugUtil.slugify(name)
        let serverDomain = Endpoints.serverFqdn(server: serverNameSlug, user: username)
        // ONE biometric ceremony yields the IRK AND the new box's STK
        // pubkey. The STK pub is cached in the pin registry so later
        // (biometric-free) /pods refreshes can verify the box's STK-signed
        // daemon-status report and pin its real cert fingerprint (A′
        // phase 4) — the directory's identityPubKey echo is never trusted.
        // ONE biometric also yields the box's SWK (hex). The box can't derive
        // it (no UMK), so the phone provisions it as an UNSIGNED `swkHex` recipe
        // sibling the daemon persists at first boot to turn on the service/build
        // platform. This is the box-side `ServerKeys.deriveSwk` (DOTS) key — the
        // protocol/daemon derivation, same UMK seed + serverId as the STK above —
        // NOT the app-backup `Keystore.deriveSWK` (slashes).
        let mint = try await Keystore.deriveIRKBoxStkAndSwk(
            serverId: serverDomain,
            reason: "Mint installer for \(name)"
        )
        let irk = mint.irk
        let boxSwkHex = mint.boxSwkHex
        CertPinRegistry.shared.registerBoxStk(domain: serverDomain, stkPub: mint.boxStkPub)

        let delegated = Curve25519.Signing.PrivateKey()
        let acIssuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        // Recipe TTL — single phone-set knob. Defaults to 6h
        // (`defaultRecipeTtlMs`); user can dial it on the design page.
        let acExpiresAt = acIssuedAt + Self.clampedRecipeTtlMs(recipeTtlMs)
        // Slice D (D-1) — pin the account's ADMIN MASTER ROOT into the AuthCode so
        // a fresh box learns its authority anchor at first boot. Biometric-free
        // (the pub is device-local but not secret); still IRK-signature-covered
        // via the AuthCode signature below. Absent on pre-D accounts (canonical
        // bytes stay byte-identical).
        let adminRootHex = Keystore.adminRootPubHex()
        let authCode = AuthCode(
            serial: SerialGen.random(),
            username: username,
            serverName: serverNameSlug,
            serverDomain: serverDomain,
            delegatedPubKey: delegated.publicKey.rawRepresentation,
            userPubKey: irk.publicKey.rawRepresentation,
            issuedAt: acIssuedAt,
            expiresAt: acExpiresAt,
            adminRootPubKey: adminRootHex.flatMap { HexUtil.decode($0) }
        )
        let acSig = try irk.signature(for: authCode.canonicalBytes())
        try await server.issueAuthCode(.init(
            code: .init(
                version: authCode.version,
                serial: authCode.serial,
                username: authCode.username,
                serverName: authCode.serverName,
                serverDomain: authCode.serverDomain,
                delegatedPubKey: HexUtil.encode(authCode.delegatedPubKey),
                userPubKey: HexUtil.encode(authCode.userPubKey),
                issuedAt: authCode.issuedAt,
                expiresAt: authCode.expiresAt,
                adminRootPubKey: authCode.adminRootPubKey.map { HexUtil.encode($0) }
            ),
            signature: HexUtil.encode(acSig)
        ))

        let rck = Curve25519.Signing.PrivateKey()
        let rckIssuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let rckBytes = RckRegister.canonicalBytes(
            username: username,
            subdomain: serverDomain,
            rckPubHex: HexUtil.encode(rck.publicKey.rawRepresentation),
            issuedAt: rckIssuedAt
        )
        let rckSig = try irk.signature(for: rckBytes)
        try await server.registerRck(.init(
            request: .init(
                username: username,
                subdomain: serverDomain,
                rckPubKey: HexUtil.encode(rck.publicKey.rawRepresentation),
                issuedAt: rckIssuedAt
            ),
            signature: HexUtil.encode(rckSig)
        ))

        let blob = InstallBlob(
            serverDomain: serverDomain,
            username: username,
            serverName: serverNameSlug,
            phoneDelegatedPubKey: delegated.publicKey.rawRepresentation,
            authCode: authCode,
            authCodeUserSignature: acSig,
            rckPubKey: rck.publicKey.rawRepresentation,
            // Only "approve" rides the wire; "auto" stays absent so the
            // recipe bytes match the webapp + a pre-bootUnlockMode verifier
            // still accepts it. The box treats absence as "auto".
            bootUnlockMode: bootUnlockMode == .approve ? "approve" : nil,
            // Only "none" rides the wire; "luks" (the encrypted default) stays
            // absent so the recipe bytes match a pre-diskEncryption verifier.
            // The box treats absence as "luks".
            diskEncryption: encryptDisk ? nil : "none"
        )
        let blobSig = try irk.signature(for: blob.canonicalBytes())

        // Secret-free pairing: build the owner-IRK-signed `add-paired-session`
        // order at create time (the FIRST recipe carries ZERO pairing secret — no
        // pairing keypair, no `pairingKeyPrivHex`). Reuses the IRK from the single
        // biometric above (no extra Face ID). Persist the token as this device's
        // session token so the BFF auths once the box claims the order. The order
        // JSON is routed by mode below. Best-effort: a build failure leaves the
        // manual pairing path as the fallback and NEVER blocks creation.
        var pairingOrderJson: String?
        do {
            let pairing = try CreateTimePairing.build(
                username: username,
                serverDomain: serverDomain,
                // Matches PodPairViewModel's default; the owner can rename the
                // session later. (A real UIDevice.current.name is a follow-up.)
                label: "iPhone",
                irk: irk
            )
            // Persist under THIS box's pod id (Fix B) so creating a 2nd box doesn't
            // clobber the 1st's token; also seed the active slot for the immediate
            // flow. (Secret-free: the pairing ORDER is deposited later by the Home
            // reconcile, not inline here.)
            await sessionStore.setSessionToken(pairing.token, forPodId: PodInfo.podId(forFqdn: serverDomain))
            await sessionStore.setSessionToken(pairing.token)
            pairingOrderJson = pairing.pairingOrderJson
        } catch {
            pairingOrderJson = nil
        }

        // Secret-free recipe (docs/recipe-delivery-and-remote-install.md).
        //   embed-secrets ON (advanced/offline): bake BOTH the SWK and the
        //     plaintext `pairingOrder` into the recipe; the box self-configures +
        //     self-pairs fully offline with NO post-registration deposit.
        //   embed-secrets OFF (the DEFAULT): the recipe is secret-free; stash the
        //     SWK + the pairing order so the Home reconcile seals + deposits each
        //     once the box registers (one tap then, not now).
        let embeddedSwkHex: String?
        let embeddedPairingOrder: String?
        if embedSecrets {
            embeddedSwkHex = boxSwkHex
            swkDepositStore.clear(for: serverDomain)
            embeddedPairingOrder = pairingOrderJson
            pairingDepositStore.clear(for: serverDomain)
        } else {
            embeddedSwkHex = nil
            swkDepositStore.markPending(for: serverDomain)
            embeddedPairingOrder = nil
            if let pairingOrderJson {
                pairingDepositStore.markPending(for: serverDomain, pairingOrderJson: pairingOrderJson)
            }
        }
        // The CGK is NEVER embedded in the recipe (the per-cloud gossip secret is
        // always post-boot delivered), so it is owed on EVERY created server,
        // independent of the embed-secrets choice.
        cgkDepositStore.markPending(for: serverDomain)

        // Debug-friendly server (Advanced): bake an owner-IRK-signed debug-access
        // grant into the recipe as the UNSIGNED `debugGrant` sibling. Signed here
        // behind the SAME create biometric (the IRK is already in hand) — no
        // extra Face ID, no over-the-session consent round-trip. The box-side
        // gate verifies it under the config-pinned owner IRK + this box's FQDN.
        let debugGrantSibling = debugFriendly
            ? Self.debugGrantEnvelope(serverDomain: serverDomain, irk: irk)
            : nil

        return SignedInstallBlob(
            blob: blob,
            signatureHex: HexUtil.encode(blobSig),
            pairingOrder: embeddedPairingOrder,
            swkHex: embeddedSwkHex,
            debugGrant: debugGrantSibling
        )
    }

    /// Build the recipe's `debugGrant` sibling: an owner-IRK-signed
    /// `flagship/debug-access/v1` grant (console-only — empty `sshAuthorizedKey`)
    /// serialized to the EXACT `{grant:{serverDomain,sshAuthorizedKey,issuedAt},
    /// signatureHex}` JSON the box-side gate consumes (`debugAccessGate.ts`).
    /// No box STK in the canonical bytes, so it's signable at mint.
    static func debugGrantEnvelope(
        serverDomain: String,
        irk: Curve25519.Signing.PrivateKey,
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) -> String {
        let grant = DebugAccess.Grant(serverDomain: serverDomain, sshAuthorizedKey: "", issuedAt: now)
        let sig = (try? DebugAccess.sign(grant, irk: irk)) ?? ""
        return DebugAccess.envelopeJSON(grant, signatureHex: sig)
    }
}

public struct SignedInstallBlob: Sendable {
    public let blob: InstallBlob
    public let signatureHex: String
    /// Secret-free pairing (offline/embed): the plaintext `{request, signature}`
    /// `add-paired-session` order (PairingOrderEnvelope JSON). An UNSIGNED recipe
    /// sibling (never in the signed blob's canonical bytes); the box verifies the
    /// owner-IRK order at boot and adds the session locally. nil in the DEFAULT
    /// online path (the order is sealed + deposited post-registration instead) or
    /// when create-time pairing didn't run.
    public let pairingOrder: String?
    /// The box's deterministic SWK (lowercase hex), an UNSIGNED recipe sibling
    /// the burner carries to `/var/flagship/install-blob.json`; the daemon
    /// persists it at first boot to turn on the service/build platform. nil only
    /// for legacy/mock paths that don't provision it.
    public let swkHex: String?
    /// Debug-friendly server (Advanced): the owner-IRK-signed debug-access grant
    /// envelope (`{grant,signatureHex}` JSON). An UNSIGNED recipe sibling (never
    /// in the signed blob's canonical bytes); the box-side gate verifies it under
    /// the config-pinned owner IRK + this box's FQDN before enabling the debug
    /// console user. nil for the production default (no debug grant).
    public let debugGrant: String?

    public init(blob: InstallBlob, signatureHex: String, pairingOrder: String? = nil, swkHex: String? = nil, debugGrant: String? = nil) {
        self.blob = blob
        self.signatureHex = signatureHex
        self.pairingOrder = pairingOrder
        self.swkHex = swkHex
        self.debugGrant = debugGrant
    }

    public struct OnWire: Codable, Sendable {
        public let blob: OnWireBlob
        public let blobSignature: String
        /// Top-level recipe sibling (alongside `blob`/`blobSignature`); the
        /// burner carries it into the on-disk install-blob.json. Omitted from
        /// JSON when nil so a non-pairing recipe is byte-identical to before.
        public let pairingOrder: String?
        /// Top-level recipe sibling carrying the box's SWK (hex); the burner
        /// preserves it into the on-disk install-blob.json. Omitted from JSON
        /// when nil so a recipe without it is byte-identical to before.
        public let swkHex: String?
        /// Top-level recipe sibling carrying the owner-IRK-signed debug-access
        /// grant envelope; the burner preserves it into the on-disk
        /// install-blob.json as the `debugGrant` sibling. Omitted from JSON when
        /// nil so a non-debug recipe is byte-identical to before.
        public let debugGrant: String?
    }
    public struct OnWireBlob: Codable, Sendable {
        public let version: Int
        public let serverDomain: String
        public let username: String
        public let serverName: String
        public let phoneDelegatedPubKey: String
        public let registrationUrl: String
        public let authCode: OnWireAuthCode
        public let authCodeUserSignature: String
        public let installerGitRef: String
        public let rckPubKey: String
        /// Only present for "approve" servers — nil (omitted from JSON) for the
        /// "auto" default, mirroring the webapp's onWireBlob. The box reads
        /// `blob.bootUnlockMode` from this JSON; absent ⇒ "auto".
        public let bootUnlockMode: String?
        /// Disk-encryption policy. Only present for "none" servers — nil
        /// (omitted from JSON) for the "luks" encrypted default, mirroring the
        /// burner's RecipeDTO + trailer.ts. The box reads `blob.diskEncryption`
        /// from this JSON; absent ⇒ "luks".
        public let diskEncryption: String?
    }
    public struct OnWireAuthCode: Codable, Sendable {
        public let version: Int
        public let serial: String
        public let username: String
        public let serverName: String
        public let serverDomain: String
        public let delegatedPubKey: String
        public let userPubKey: String
        public let issuedAt: Int64
        public let expiresAt: Int64
        /// Slice D (D-1) — the pinned admin master root pubkey (hex); the burner
        /// preserves it into the on-disk install-blob so the daemon loads it into
        /// `ServerConfig.adminRootPub`. Omitted from JSON when nil (a pre-D recipe
        /// serializes byte-identically).
        public let adminRootPubKey: String?
    }

    public func onWire() -> OnWire {
        OnWire(
            blob: OnWireBlob(
                version: blob.version,
                serverDomain: blob.serverDomain,
                username: blob.username,
                serverName: blob.serverName,
                phoneDelegatedPubKey: HexUtil.encode(blob.phoneDelegatedPubKey),
                registrationUrl: blob.registrationUrl,
                authCode: OnWireAuthCode(
                    version: blob.authCode.version,
                    serial: blob.authCode.serial,
                    username: blob.authCode.username,
                    serverName: blob.authCode.serverName,
                    serverDomain: blob.authCode.serverDomain,
                    delegatedPubKey: HexUtil.encode(blob.authCode.delegatedPubKey),
                    userPubKey: HexUtil.encode(blob.authCode.userPubKey),
                    issuedAt: blob.authCode.issuedAt,
                    expiresAt: blob.authCode.expiresAt,
                    adminRootPubKey: blob.authCode.adminRootPubKey.map { HexUtil.encode($0) }
                ),
                authCodeUserSignature: HexUtil.encode(blob.authCodeUserSignature),
                installerGitRef: blob.installerGitRef,
                rckPubKey: HexUtil.encode(blob.rckPubKey),
                bootUnlockMode: blob.bootUnlockMode,
                diskEncryption: blob.diskEncryption
            ),
            blobSignature: signatureHex,
            // Synthesized Codable uses encodeIfPresent for optionals ⇒ omitted
            // when nil, so a non-pairing recipe serializes byte-identically.
            pairingOrder: pairingOrder,
            swkHex: swkHex,
            debugGrant: debugGrant
        )
    }
}
