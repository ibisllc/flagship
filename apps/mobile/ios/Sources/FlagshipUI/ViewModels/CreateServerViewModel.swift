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
    /// Per-server cert-autonomy policy (per-user-cert design, `docs/per-user-cert-worklist.md`
    /// Q-A). Picks how long this box may keep renewing its TLS cert while the
    /// phone is offline. Finite windows ⇒ "managed" (a trusted device re-mints);
    /// "Indefinite" ⇒ "autonomous" (the box holds a sealed minting key and renews
    /// itself forever). Carried in the SIGNED InstallBlob — the recipe-JSON plumbing
    /// in trailer.ts reconstructs `certAutonomy` so the daemon's canonical bytes
    /// match the signature. Default = 90-day managed window.
    public var certAutonomy: CertAutonomyChoice = .days90
    /// Draft-only metadata — backup policy the user wants applied to this
    /// server once it's up. NOT signed into the InstallBlob (the audit
    /// against InstallBlob.swift confirmed `backupPolicy` does not appear
    /// in canonical bytes); the box reads this later via an owner-signed
    /// `set-backup-policy` order. Defaults to "phone-only" to match the
    /// webapp's draft schema.
    public var backupPolicy: CreateServerDraftStore.BackupPolicy = .phoneOnly {
        didSet { draftStore.setBackupPolicy(backupPolicy) }
    }
    /// Draft-only metadata — free-text user note about LLM provider
    /// preferences (e.g. "OpenAI gpt-4o for chat, local llama3 for code").
    /// Surfaces later as a hint when the box's apps ask the user to pick a
    /// provider; never reaches the signed blob.
    public var llmPreferences: String = "" {
        didSet { draftStore.setLlmPreferences(llmPreferences) }
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

    public init(
        username: String,
        server: any FlagshipServerClient,
        relay: any QrRelayClient,
        bootUnlock: BootUnlockStore = BootUnlockStore(),
        draftStore: CreateServerDraftStore = CreateServerDraftStore()
    ) {
        self.username = username
        self.server = server
        self.relay = relay
        self.bootUnlock = bootUnlock
        self.draftStore = draftStore
        // Restore the user's last-typed draft so flipping away from the
        // screen mid-fill doesn't wipe their inputs. Hydrate AFTER the
        // stored properties are assigned so the didSet observers don't
        // double-write the same value back.
        self.backupPolicy = draftStore.backupPolicy()
        self.llmPreferences = draftStore.llmPreferences()
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

    private func mintInstallBlob() async throws -> SignedInstallBlob {
        // Phase 2 — the username claim moved to OpenAccountViewModel
        // (the open-account step). By the time we mint a server the
        // account already exists: the UMK was generated and the
        // username claimed at open-account time. We just derive the IRK
        // (UMK is present) for the auth-code + RCK signatures below; we
        // do NOT re-generate the UMK and do NOT re-claim the username.
        let irk = try await Keystore.deriveIRK(reason: "Mint installer for \(name)")
        let serverNameSlug = SlugUtil.slugify(name)
        let serverDomain = "\(serverNameSlug).\(username).flagship.services"

        let delegated = Curve25519.Signing.PrivateKey()
        let acIssuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        // Recipe TTL — single phone-set knob. Defaults to 6h
        // (`defaultRecipeTtlMs`); user can dial it on the design page.
        let acExpiresAt = acIssuedAt + Self.clampedRecipeTtlMs(recipeTtlMs)
        let authCode = AuthCode(
            serial: SerialGen.random(),
            username: username,
            serverName: serverNameSlug,
            serverDomain: serverDomain,
            delegatedPubKey: delegated.publicKey.rawRepresentation,
            userPubKey: irk.publicKey.rawRepresentation,
            issuedAt: acIssuedAt,
            expiresAt: acExpiresAt
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
                expiresAt: authCode.expiresAt
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
            // certAutonomy ALWAYS rides the wire (signature-safe — trailer.ts
            // reconstructs it). days90 ⇒ managed:90; finite ⇒ managed:N;
            // Indefinite ⇒ autonomous.
            certAutonomy: certAutonomy.installBlob
        )
        let blobSig = try irk.signature(for: blob.canonicalBytes())
        return SignedInstallBlob(blob: blob, signatureHex: HexUtil.encode(blobSig))
    }
}

/// Per-server cert-autonomy choice surfaced on the create-server screen.
/// Maps the user-facing "how long can this box run while my phone is offline"
/// question onto the signed `InstallBlob.CertAutonomy`. Every finite choice is
/// "managed" (a trusted device keeps minting); only `.indefinite` hands the box
/// a self-minting key ("autonomous"). Default is `.days90` — a 90-day managed
/// window matching the LE max-validity ceiling discussed in the worklist.
public enum CertAutonomyChoice: String, CaseIterable, Sendable {
    case days3
    case days7
    case days15
    case days30
    case days90
    case indefinite

    /// Short user-facing label for the radio row.
    public var label: String {
        switch self {
        case .days3:      return "3 days"
        case .days7:      return "7 days"
        case .days15:     return "15 days"
        case .days30:     return "30 days"
        case .days90:     return "90 days"
        case .indefinite: return "Indefinite"
        }
    }

    /// The signed-blob value. Finite windows ⇒ managed with N days; Indefinite ⇒
    /// autonomous (the box becomes a minter). Always returns a value so the
    /// recipe carries a cert-autonomy field on every server.
    public var installBlob: InstallBlob.CertAutonomy {
        switch self {
        case .days3:      return .init(mode: "managed", offlineWindowDays: 3)
        case .days7:      return .init(mode: "managed", offlineWindowDays: 7)
        case .days15:     return .init(mode: "managed", offlineWindowDays: 15)
        case .days30:     return .init(mode: "managed", offlineWindowDays: 30)
        case .days90:     return .init(mode: "managed", offlineWindowDays: 90)
        case .indefinite: return .init(mode: "autonomous")
        }
    }
}

public struct SignedInstallBlob: Sendable {
    public let blob: InstallBlob
    public let signatureHex: String

    public struct OnWire: Codable, Sendable {
        public let blob: OnWireBlob
        public let blobSignature: String
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
        /// Per-server cert-autonomy policy. JSON key MUST be `certAutonomy` with
        /// `mode` + `offlineWindowDays`, matching trailer.ts `InstallBlobJson`
        /// so the daemon reconstructs identical canonical bytes. Optional only
        /// for legacy/absent recipes — the phone always emits it.
        public let certAutonomy: OnWireCertAutonomy?
    }
    /// Mirrors trailer.ts `InstallBlobJson.certAutonomy`
    /// (`{ mode, offlineWindowDays? }`). `offlineWindowDays` is omitted from the
    /// JSON when nil (autonomous mode) so the round-trip matches the optional TS
    /// field rather than emitting an explicit `null`.
    public struct OnWireCertAutonomy: Codable, Sendable {
        public let mode: String
        public let offlineWindowDays: Int?
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
                    expiresAt: blob.authCode.expiresAt
                ),
                authCodeUserSignature: HexUtil.encode(blob.authCodeUserSignature),
                installerGitRef: blob.installerGitRef,
                rckPubKey: HexUtil.encode(blob.rckPubKey),
                bootUnlockMode: blob.bootUnlockMode,
                certAutonomy: blob.certAutonomy.map {
                    OnWireCertAutonomy(mode: $0.mode, offlineWindowDays: $0.offlineWindowDays)
                }
            ),
            blobSignature: signatureHex
        )
    }
}
