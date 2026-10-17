import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Orchestrates create-server recipe minting and delivery.
///
/// The user-facing path is design → delivery chooser → builder pairing,
/// file sharing, or copying. The relay phases below remain reusable protocol
/// machinery rather than a homepage-specific onboarding path.
///
/// Cancel collapses any open relay socket + resets to .design.
@Observable
@MainActor
public final class CreateServerViewModel {
    public enum Phase: Sendable {
        case design
        /// After design: how do you want to get the recipe to a builder?
        /// (Pair with the builder app · Save/Share the recipe file · Copy ·
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
    /// box (no login at all). ON (only reachable under Advanced mode) bakes an
    /// admin-signed `flagship/debug-access/v2` grant for `debugSshKey`, ending
    /// 7 days after minting, into the recipe as the UNSIGNED `debugGrant`
    /// sibling (mirroring `swkHex`/`pairingOrder`); the box verifies it under
    /// its pinned admin root and lets that key in as `debug` until it ends
    /// (docs/recipe-delivery-and-remote-install.md "Debug access"). Signed with
    /// the admin root the create already unseals. Snaps back OFF when Advanced
    /// is off.
    public var debugFriendly: Bool = false
    /// The SSH public key a debug-friendly server lets in (pasted).
    public var debugSshKey: String = ""
    public static let debugFriendlyWarning =
        "Anyone with this key can read everything on this server while it's on. It turns off by itself 7 days from now."
    /// The server's backup policy (docs/server-backup-and-clone.md, "Backup
    /// policy"): signed as `flagship/backup-policy/v1` with the sensitive-order
    /// key at mint time and carried beside the pairing order, so the box
    /// adopts it when it pairs. Nothing is preselected: nil until the owner
    /// picks, and the form's Continue stays off until then.
    public var backupPolicy: CreateServerDraftStore.BackupPolicy? = nil {
        didSet { draftStore.setBackupPolicy(backupPolicy) }
    }
    /// Phone-side: the space this phone keeps for the server's backup, which
    /// is also the most the server's apps may hold.
    public var phoneReserveBytes: Int64 = PhoneBackupRetention.defaultReserveBytes(freeBytes: DeviceStorage.freeBytes()) {
        didSet { draftStore.setPhoneReserveBytes(phoneReserveBytes) }
    }
    /// Set when this server is made to restore a backup (Import a backup,
    /// docs/server-backup-and-clone.md): the owner-signed restore order rides
    /// beside the pairing order, so the box waits for exactly that data file.
    public var restore: RestoreTarget?
    public struct RestoreTarget: Equatable, Sendable {
        public let archiveId: String
        public let bytes: Int64
        public let sha256: String
        public init(archiveId: String, bytes: Int64, sha256: String) {
            self.archiveId = archiveId
            self.bytes = bytes
            self.sha256 = sha256
        }
    }
    struct RestoreNeedsPairing: Error, LocalizedError {
        var errorDescription: String? { "This server couldn't be prepared to receive the backup. Try again." }
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
    /// The admin root this device holds (its public key), or nil. A recipe
    /// pins it; a device without one is refused ([AddServerGate]).
    private let adminRootPubHex: @MainActor () -> String?
    /// Unseals the admin root (one biometric) to approve the new server.
    private let adminRootSigner: (String) async throws -> Curve25519.Signing.PrivateKey
    /// A fresh Face ID and the sensitive-order key, for the Debug-friendly grant.
    private let debugGrantKey: (String) async throws -> Curve25519.Signing.PrivateKey
    private let isDemoAccount: Bool

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
        mailbox: any SecretMailboxClient = DefaultClients.secretMailbox(),
        sessionStore: any SessionStoring = SessionStore(),
        adminRootPubHex: @escaping @MainActor () -> String? = { Keystore.hasAdminRoot ? Keystore.adminRootPubHex() : nil },
        adminRootSigner: @escaping (String) async throws -> Curve25519.Signing.PrivateKey = { reason in
            try await Keystore.adminRootKey(reason: reason)
        },
        debugGrantKey: @escaping (String) async throws -> Curve25519.Signing.PrivateKey = { reason in
            try await DebugAccessViewModel.freshSensitiveKey(reason: reason)
        },
        // No default: a flow that forgets it refuses demo accounts (the
        // store reviewers' account) as non-admin devices.
        isDemoAccount: Bool
    ) {
        self.username = username
        self.adminRootPubHex = adminRootPubHex
        self.adminRootSigner = adminRootSigner
        self.debugGrantKey = debugGrantKey
        self.isDemoAccount = isDemoAccount
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
        if let r = draftStore.phoneReserveBytes() { self.phoneReserveBytes = r }
    }

    /// Starts the subdomain field at the address the preview shows ("home",
    /// or the next free homeN), unless the user already typed one.
    public func prefillName(takenLabels: [String]) {
        guard name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        name = ServerLabel.firstFree(taken: takenLabels)
    }

    /// The subdomain must be a valid, non-reserved DNS label — what the user
    /// types IS the subdomain (no slugify), so an invalid entry blocks Next
    /// rather than being silently rewritten.
    public var canAdvanceFromDesign: Bool {
        ServerLabel.isValid(name)
    }

    /// The last design step (Backups) needs a pick before Continue.
    public var canContinueFromBackups: Bool {
        canAdvanceFromDesign && backupPolicy != nil
    }

    /// Inline validation message for the subdomain field — nil when the field
    /// is empty (no error yet) or valid.
    public var nameError: String? {
        ServerLabel.errorMessage(name)
    }

    /// Live "this is the address it becomes" preview under the subdomain field,
    /// so the user sees exactly what they're naming (empty ⇒ the placeholder).
    public var previewFqdn: String {
        let raw = name.trimmingCharacters(in: .whitespaces)
        let label = raw.isEmpty ? "home" : ServerLabel.normalized(name)
        return Endpoints.serverFqdn(server: label, user: username)
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
        guard canContinueFromBackups else { return }
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

    /// Internal (not private) so the builder-pairing flow can reuse the EXACT
    /// minting path (auth-code issue, RCK register, create-time pairing, the
    /// deposit-store bookkeeping) rather than duplicating it — the builder peer
    /// receives a byte-identical `SignedInstallBlob`, just over a different
    /// transport. Configure the design fields, then call this.
    func mintInstallBlob() async throws -> SignedInstallBlob {
        // Only an admin device of the account adds servers, and only opening
        // the account mints an admin root: refuse here, before any prompt or
        // `.com` call, rather than mint a recipe the account's admins don't
        // anchor.
        let adminRootHex = try AddServerGate.recipeAdminRootPin(
            adminRootPubHex: adminRootPubHex(), isDemoAccount: isDemoAccount
        )
        // Phase 2 — the username claim moved to OpenAccountViewModel
        // (the open-account step). By the time we mint a server the
        // account already exists: the UMK was generated and the
        // username claimed at open-account time. We just derive the IRK
        // (UMK is present) for the auth-code + RCK signatures below; we
        // do NOT re-generate the UMK and do NOT re-claim the username.
        // The subdomain IS what the user typed (validated as a DNS label; no
        // slugify). Normalize case only — domains are case-insensitive.
        let serverName = ServerLabel.normalized(name)
        let serverDomain = Endpoints.serverFqdn(server: serverName, user: username)
        // A debug-friendly server needs a usable SSH key: refuse before any prompt.
        // The grant gets its own fresh Face ID (one per grant, never the
        // unlocked session), asked first so a cancel leaves nothing half done.
        var debugGrant: DebugAccess.Grant?
        var debugKey: Curve25519.Signing.PrivateKey?
        if debugFriendly {
            debugGrant = try Self.debugGrant(serverDomain: serverDomain, rawKey: debugSshKey)
            debugKey = try await debugGrantKey("Turn on debug access for \(name)")
        }
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
        // via the AuthCode signature below. Absent only on a demo account
        // (canonical bytes stay byte-identical).
        let authCode = AuthCode(
            serial: SerialGen.random(),
            username: username,
            serverName: serverName,
            serverDomain: serverDomain,
            delegatedPubKey: delegated.publicKey.rawRepresentation,
            userPubKey: irk.publicKey.rawRepresentation,
            issuedAt: acIssuedAt,
            expiresAt: acExpiresAt,
            adminRootPubKey: adminRootHex.flatMap { HexUtil.decode($0) }
        )
        let acSig = try irk.signature(for: authCode.canonicalBytes())
        // Adding a server is admin-only, and `.com` checks it: the admin root
        // approves the AuthCode (which pins it), and the same unsealed key then
        // signs the RCK and any restore order below. A demo account pins no
        // root and signs with the IRK alone.
        let adminKey: Curve25519.Signing.PrivateKey? = adminRootHex == nil
            ? nil
            : try await adminRootSigner("Add \(name) to your account")
        let acAdminSig = try adminKey.map { try $0.signature(for: authCode.adminCanonicalBytes()) }
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
            signature: HexUtil.encode(acSig),
            adminSignature: acAdminSig.map { HexUtil.encode($0) }
        ))

        let rck = Curve25519.Signing.PrivateKey()
        let rckIssuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let rckBytes = RckRegister.canonicalBytes(
            username: username,
            subdomain: serverDomain,
            rckPubHex: HexUtil.encode(rck.publicKey.rawRepresentation),
            issuedAt: rckIssuedAt
        )
        // register-rck is a sensitive routing-authority operation and a step
        // of adding a server: the admin root signs it (a demo account's IRK).
        let rckSig = try (adminKey ?? irk).signature(for: rckBytes)
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
            serverName: serverName,
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
        if let restore {
            guard let json = pairingOrderJson else { throw RestoreNeedsPairing() }
            let order = ServerBackupFormat.RestoreOrder(
                serverDomain: serverDomain, archiveId: restore.archiveId, bytes: restore.bytes,
                sha256: restore.sha256, issuedAt: Int64(Date().timeIntervalSince1970 * 1000)
            )
            // An admin-pinned box takes a restore order only from the admin root.
            let sig = try (adminKey ?? irk).signature(for: try order.canonicalBytes())
            pairingOrderJson = ServerBackupFormat.attachRestore(toPairingJson: json, order: order, signatureHex: HexUtil.encode(sig))
        }
        // The backup policy rides beside the pairing order too, signed like a
        // restore order (the admin root; the IRK only on a demo account).
        if let json = pairingOrderJson, let backupPolicy {
            let order = BackupPolicyOrder.make(serverDomain: serverDomain, draft: backupPolicy, reserveBytes: phoneReserveBytes,
                                               issuedAt: Int64(Date().timeIntervalSince1970 * 1000))
            let sig = try (adminKey ?? irk).signature(for: try order.canonicalBytes())
            pairingOrderJson = ServerBackupFormat.attachBackupPolicy(toPairingJson: json, order: order, signatureHex: HexUtil.encode(sig))
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

        // Debug-friendly server (Advanced): the debug-access grant rides as the
        // UNSIGNED `debugGrant` sibling, signed with the key its own Face ID
        // unsealed above (the admin root; the IRK on a demo account).
        var debugGrantSibling: String?
        if let debugGrant, let debugKey {
            debugGrantSibling = try Self.debugGrantEnvelope(debugGrant, key: debugKey)
        }

        return SignedInstallBlob(
            blob: blob,
            signatureHex: HexUtil.encode(blobSig),
            pairingOrder: embeddedPairingOrder,
            swkHex: embeddedSwkHex,
            debugGrant: debugGrantSibling
        )
    }

    /// The install-time debug grant: the pasted key, from now for 7 days.
    /// Throws the sentence to show when the key is missing or unusable.
    static func debugGrant(
        serverDomain: String,
        rawKey: String,
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) throws -> DebugAccess.Grant {
        try DebugAccess.makeGrant(serverDomain: serverDomain, rawKey: rawKey, issuedAt: now, duration: DebugAccess.maxMs)
    }

    /// The recipe's `debugGrant` sibling: `{grant:{serverDomain,sshPublicKey,
    /// issuedAt,expiresAt}, signatureHex}`, the JSON the box consumes
    /// (`debugAccessGate.ts`).
    static func debugGrantEnvelope(_ grant: DebugAccess.Grant, key: Curve25519.Signing.PrivateKey) throws -> String {
        DebugAccess.envelopeJSON(grant, signatureHex: try DebugAccess.sign(grant, key: key))
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
    /// the builder carries to `/var/flagship/install-blob.json`; the daemon
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
        /// builder carries it into the on-disk install-blob.json. Omitted from
        /// JSON when nil so a non-pairing recipe is byte-identical to before.
        public let pairingOrder: String?
        /// Top-level recipe sibling carrying the box's SWK (hex); the builder
        /// preserves it into the on-disk install-blob.json. Omitted from JSON
        /// when nil so a recipe without it is byte-identical to before.
        public let swkHex: String?
        /// Top-level recipe sibling carrying the owner-IRK-signed debug-access
        /// grant envelope; the builder preserves it into the on-disk
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
        /// builder's RecipeDTO + trailer.ts. The box reads `blob.diskEncryption`
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
        /// Slice D (D-1) — the pinned admin master root pubkey (hex); the builder
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
