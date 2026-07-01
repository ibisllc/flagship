import Foundation
import CryptoKit
import FlagshipAPI

/// Drives the phone's half of the boot-secret RELAY handshake
/// (docs/security-phone-as-unlock-endpoint.md):
///
///   1. fetchPending — builds an IRK-signed `DeviceEndpointClaim`
///      mailbox-auth credential, POSTs `/api/secret-requests`, and
///      RE-VERIFIES every returned request against the box's STK as
///      INDEPENDENTLY resolved from the directory (`/api/users/:u/pods`).
///      `.com` is not a trust anchor: a request whose STK mismatches the
///      directory (or whose signature fails under it) is dropped, NOT
///      surfaced for confirm.
///   2. confirm — for the verified request the user taps "yes, this is my
///      box" (the device-info backstop). By purpose:
///        - unlock-key:  GET the phone-sealed LUKS key, unseal it with the
///                       phone's existing Ed25519 key material, re-seal it
///                       for the box's STK (nonce/purpose-bound), POST it.
///        - entitlement: sign a root-only `RootEntitlement` under the ADMIN
///                       master root (Slice D; owner-IRK when no admin root is
///                       held), serialize it as the daemon's EntitlementBundle
///                       carrier, hex, POST it.
///
/// The crypto lives in the `Flagship` target; this coordinator only
/// orchestrates + decides. All freshness windows mirror the Worker's
/// ±5-min mailbox-auth window.
@MainActor
public final class SecretRequestCoordinator {

    public enum CoordinatorError: Error, LocalizedError, Equatable {
        case noSealedLuksKey
        case luksUnsealFailed
        case directoryMissingServer(String)
        case purposeUnsupported(String)
        case noPendingRequest(String)

        public var errorDescription: String? {
            switch self {
            case .noSealedLuksKey:
                return "No sealed disk key is on file for this box yet."
            case .luksUnsealFailed:
                return "Couldn't unseal the disk key with this phone's keys."
            case .directoryMissingServer(let d):
                return "This box (\(d)) isn't registered to your account."
            case .purposeUnsupported(let p):
                return "Unsupported secret request type: \(p)."
            case .noPendingRequest:
                return "Your box stopped waiting. Power-cycle it (unplug, plug back in) and it'll ask again."
            }
        }
    }

    /// A request that PASSED directory re-verification, ready to show the
    /// user the device-info confirm sheet. The raw `PendingSecretRequest`
    /// + the resolved STK are retained so confirm doesn't re-resolve.
    public struct VerifiedRequest: Equatable, Sendable, Identifiable {
        public let pending: PendingSecretRequest
        /// The STK as resolved from the DIRECTORY (not the mailbox echo).
        public let directoryStkPubHex: String
        public var id: String { pending.id }
        public var serverDomain: String { pending.serverDomain }
        public var purpose: SecretPurpose? { SecretPurpose(rawValue: pending.purpose) }
        public var deviceInfo: DeviceInfoHint? { pending.deviceInfo }
    }

    private let mailbox: SecretMailboxClient
    private let username: String
    /// Resolves the user IRK private key (biometric-gated). Injectable so
    /// tests don't touch the Keychain / Secure Enclave.
    private let irkProvider: () async throws -> Curve25519.Signing.PrivateKey
    /// Slice D — resolves the ADMIN MASTER ROOT signing key when this device
    /// holds one, else nil. The RootEntitlement this coordinator mints is an
    /// administrative "authorize this box to serve" order: a reburned
    /// admin-pinned box REJECTS an IRK-signed RootEntitlement at HELLO
    /// (`entitlementRelay` gates it under `requireMasterAdmin`), so on an
    /// admin-root account it MUST be signed under the admin root. nil ⇒ legacy /
    /// pre-wipe (no admin root pinned) ⇒ fall back to the owner IRK, which those
    /// boxes still accept. Injectable; defaults to "no admin root" so every
    /// existing call site + test signs under the IRK, byte-for-byte unchanged.
    /// In the memoized boot ceremony this resolves from the SAME
    /// single-biometric key cache as `irkProvider`, so authorizing a box costs
    /// no extra Face ID. Only the entitlement mint uses it — the box-sealed
    /// auto-unlock lease + every boot/mailbox AUTH envelope stay IRK (the boot
    /// worker gates the lease on the owner IRK, not the admin root).
    private let orderKeyProvider: () async throws -> Curve25519.Signing.PrivateKey?
    /// Resolves the phone's candidate Ed25519 unseal SEEDS for a given
    /// serverDomain, in priority order (the per-server BAK first, then the
    /// IRK). Whichever key the installer sealed the LUKS blob against, the
    /// phone opens it. Injectable for tests.
    private let unsealSeedProvider: (String) async throws -> [Data]
    /// Returns the watch-delegate signing key if the user has opted into
    /// quick-approve-from-Watch on THIS device, else nil. When present, a
    /// boot UNLOCK approval signs the boot-worker Authorization header with
    /// the delegate key (role="delegate") instead of the IRK — so no fresh
    /// biometric prompt fires for the header. nil ⇒ today's IRK path.
    /// Injectable; defaults to "no delegate" so every existing call site is
    /// unchanged. (Auto-lease deposit uses the IRK and the entitlement mint the
    /// admin root — the delegate is scoped to the boot-approval response alone.)
    private let watchDelegateKeyProvider: () -> Curve25519.Signing.PrivateKey?
    private let now: () -> Int64
    private let nonceGen: () -> Data

    public init(
        mailbox: SecretMailboxClient,
        username: String,
        irkProvider: @escaping () async throws -> Curve25519.Signing.PrivateKey,
        unsealSeedProvider: @escaping (String) async throws -> [Data],
        orderKeyProvider: @escaping () async throws -> Curve25519.Signing.PrivateKey? = { nil },
        watchDelegateKeyProvider: @escaping () -> Curve25519.Signing.PrivateKey? = { nil },
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        nonceGen: @escaping () -> Data = { SecretRequestCoordinator.randomNonce() }
    ) {
        self.mailbox = mailbox
        self.username = username
        self.irkProvider = irkProvider
        self.unsealSeedProvider = unsealSeedProvider
        self.orderKeyProvider = orderKeyProvider
        self.watchDelegateKeyProvider = watchDelegateKeyProvider
        self.now = now
        self.nonceGen = nonceGen
    }

    public nonisolated static func randomNonce() -> Data {
        var b = Data(count: 32)
        _ = b.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        return b
    }

    // MARK: - 1. Fetch + re-verify

    /// Build the mailbox auth, fetch the account's pending requests, and
    /// keep only those that re-verify against the directory STK. A request
    /// `.com` returns whose STK isn't directory-bound (or whose signature
    /// fails under that STK) is SILENTLY dropped — never offered for
    /// confirm.
    public func fetchVerifiedRequests() async throws -> [VerifiedRequest] {
        let irk = try await irkProvider()
        let auth = try buildMailboxAuth(irk: irk)
        let pendingResp = try await mailbox.fetchPendingRequests(auth: auth)
        let directory = try await mailbox.fetchPods(username: username)

        var verified: [VerifiedRequest] = []
        for pending in pendingResp.requests {
            guard let stkHex = directory.identityPubKey(forServerDomain: pending.serverDomain),
                  let stkPubData = HexUtil.decode(stkHex), stkPubData.count == 32,
                  let stkPub = try? Curve25519.Signing.PublicKey(rawRepresentation: stkPubData)
            else {
                // No directory entry → `.com` cannot vouch for this box.
                continue
            }
            // The mailbox echo MUST equal the directory STK — a relay can't
            // splice in a different stkPub.
            guard pending.stkPub.lowercased() == stkHex.lowercased() else { continue }
            guard let purpose = SecretPurpose(rawValue: pending.purpose),
                  let nonce = HexUtil.decode(pending.requestNonceHex),
                  let sig = HexUtil.decode(pending.requestSignature)
            else { continue }
            let request = SecretRequest(
                serverDomain: pending.serverDomain,
                stkPub: stkPubData,
                purpose: purpose,
                nonce: nonce,
                issuedAt: pending.issuedAt
            )
            // RE-VERIFY the box's request against the DIRECTORY STK.
            guard SecretRequest.verify(request, signature: sig, stkPub: stkPub) else { continue }
            verified.append(VerifiedRequest(pending: pending, directoryStkPubHex: stkHex))
        }
        return verified
    }

    // MARK: - 2. Confirm (one tap = the human backstop)

    /// The user has confirmed "yes, this is my box". Perform the crypto +
    /// post the reply. When `depositAutoLease` is true (the server's chosen
    /// boot-unlock mode is "auto"), ALSO deposit a box-sealed lease so future
    /// boots self-unlock without the phone — returns the lease id (store it
    /// per-server for the kill switch). Otherwise returns nil.
    @discardableResult
    public func confirmAndRespond(
        _ verified: VerifiedRequest,
        depositAutoLease: Bool = false
    ) async throws -> String? {
        guard let purpose = verified.purpose else {
            throw CoordinatorError.purposeUnsupported(verified.pending.purpose)
        }
        guard let stkPubData = HexUtil.decode(verified.directoryStkPubHex), stkPubData.count == 32,
              let nonce = HexUtil.decode(verified.pending.requestNonceHex)
        else {
            throw CoordinatorError.directoryMissingServer(verified.serverDomain)
        }
        let request = SecretRequest(
            serverDomain: verified.serverDomain,
            stkPub: stkPubData,
            purpose: purpose,
            nonce: nonce,
            issuedAt: verified.pending.issuedAt
        )
        // A watch delegate signs the boot-response header for a plain UNLOCK
        // approval (no auto-lease). That path needs the IRK for NOTHING, so we
        // never call irkProvider() and no biometric prompt fires — the whole
        // point of the feature. The auto-lease deposit uses the IRK and the
        // entitlement mint the admin master root (Slice D) — but every
        // entitlement path still needs the IRK for its mailbox/boot AUTH
        // envelope, and the delegate is scoped to the boot-approval response
        // alone, so we resolve the IRK lazily only when a branch needs it.
        let delegateKey: Curve25519.Signing.PrivateKey? =
            (purpose == .unlockKey && !depositAutoLease) ? watchDelegateKeyProvider() : nil
        let irk: Curve25519.Signing.PrivateKey? =
            delegateKey == nil ? try await irkProvider() : nil
        func requireIrk() throws -> Curve25519.Signing.PrivateKey {
            // Unreachable when delegateKey != nil — every IRK-consuming branch
            // runs only on the delegate==nil path, where irk was resolved above.
            guard let irk else { throw CoordinatorError.purposeUnsupported("internal: missing IRK") }
            return irk
        }

        let sealedHex: String
        var unlockKey: Data?
        switch purpose {
        case .unlockKey:
            let reply = try await buildUnlockReply(request: request)
            sealedHex = reply.sealedHex
            unlockKey = reply.luksKey
        case .entitlement:
            // Slice D — the RootEntitlement is an admin "authorize this box"
            // order: sign it under the admin master root when present (else the
            // IRK). Resolving the order key here reuses the memoized ceremony
            // key cache, so no extra biometric fires beyond the one that opened
            // the IRK above. The boot-response AUTH envelope below stays IRK.
            sealedHex = try buildEntitlementReply(
                request: request, irk: try requireIrk(), orderKey: try await orderKeyProvider()
            )
        }

        let body = SecretResponseBody(
            serverDomain: request.serverDomain,
            requestNonceHex: HexUtil.encode(nonce),
            purpose: purpose.rawValue,
            sealed: sealedHex,
            issuedAt: now()
        )
        // The sealed reply goes to the dedicated boot worker (where the box
        // polls), authed via the Flagship-Boot-v1 header — delegate-signed when
        // the user opted into quick-approve, owner-IRK-signed otherwise.
        let respAuth: String
        if let delegateKey {
            respAuth = try BootAuth.delegateHeader(
                serverDomain: request.serverDomain,
                method: "POST",
                path: "/api/boot/response",
                delegateKey: delegateKey,
                now: now(),
                nonce: nonceGen()
            )
        } else {
            respAuth = try BootAuth.ownerHeader(
                serverDomain: request.serverDomain,
                method: "POST",
                path: "/api/boot/response",
                irk: try requireIrk(),
                now: now(),
                nonce: nonceGen()
            )
        }
        try await mailbox.postResponse(response: body, bootAuth: respAuth)

        // Fold "authorize it to serve" INTO this unlock approval: when the owner
        // IRK is in hand (i.e. NOT the watch-delegate quick path, which has no
        // IRK and can't authorize serving), pre-deposit an owner-IRK-signed
        // entitlement for the box's STK so it comes online with no second tap
        // (consent to boot ⇒ consent to serve). Best-effort — a failure never
        // fails the unlock; the box can still fetch one via the relay.
        if purpose == .unlockKey, let irk {
            // Slice D — the folded-in entitlement is signed under the admin
            // master root when present (an admin-pinned box rejects an
            // IRK-signed one), else the IRK. Best-effort: the order key is
            // resolved from the same memoized ceremony cache (no extra
            // biometric), and a failure just skips the pre-deposit — the box
            // still gets one via an explicit entitlement request.
            let orderKey = try? await orderKeyProvider()
            try? await depositEntitlement(request: request, irk: irk, orderKey: orderKey)
        }

        // "auto" mode: deposit a box-sealed lease so the box self-unlocks on
        // future reboots (the user's IRK authorizes it here — I2). Only for
        // unlock-key; the key is the one we just recovered, never `.com`-visible.
        if depositAutoLease, purpose == .unlockKey, let key = unlockKey {
            return try await depositAutoUnlockLease(request: request, luksKey: key, irk: try requireIrk())
        }
        return nil
    }

    /// Mint an admin-root-signed (owner-IRK when no admin root) RootEntitlement
    /// for this box's STK and DEPOSIT it on `.com` so the box claims it on first
    /// boot without a separate "authorize to serve" tap. The carrier is the
    /// PUBLIC entitlement (what the box presents at the hub HELLO), not a secret.
    /// Reuses the relay responder's mint.
    private func depositEntitlement(
        request: SecretRequest,
        irk: Curve25519.Signing.PrivateKey,
        orderKey: Curve25519.Signing.PrivateKey?
    ) async throws {
        let carrierHex = try buildEntitlementReply(request: request, irk: irk, orderKey: orderKey)
        let auth = try buildMailboxAuth(irk: irk)
        let body = PairingDepositBody(
            auth: auth.auth,
            authSignature: auth.authSignature,
            deposit: PairingDepositBody.Deposit(
                serverDomain: request.serverDomain,
                requestNonceHex: HexUtil.encode(nonceGen()),
                stkPub: HexUtil.encode(request.stkPub),
                sealed: carrierHex,
                issuedAt: now()
            )
        )
        try await mailbox.depositEntitlement(serverDomain: request.serverDomain, body: body)
    }

    /// One-tap approval for the directory-driven server card. The pod's cheap
    /// `awaitingUnlock` flag (no biometric) tells the UI a request is pending,
    /// so — unlike the full approvals list — there's no separate "check" step.
    /// This fetches + re-verifies the live unlock-key request for `serverDomain`
    /// and responds, all under ONE biometric when the coordinator's key
    /// providers are memoized (see the card's `makeCoordinator`). Throws
    /// `.noPendingRequest` if the box already gave up between the directory
    /// refresh and the tap. Returns the lease id when an auto lease was
    /// deposited, else nil.
    @discardableResult
    public func approvePendingUnlock(
        serverDomain: String,
        depositAutoLease: Bool
    ) async throws -> String? {
        let verified = try await fetchVerifiedRequests()
        let mine = verified
            .filter { $0.serverDomain.lowercased() == serverDomain.lowercased() && $0.purpose == .unlockKey }
            .sorted { $0.pending.postedAt > $1.pending.postedAt }
        guard let live = mine.first(where: { now() <= $0.pending.expiresAt }) else {
            throw CoordinatorError.noPendingRequest(serverDomain)
        }
        return try await confirmAndRespond(live, depositAutoLease: depositAutoLease)
    }

    /// One-tap approval for the directory-driven ENTITLEMENT card — the Box
    /// Request Inbox's serve-authorization lane (docs/box-request-inbox.md). The
    /// box's pending `entitlement` request is detected by the pod's cheap
    /// `awaitingEntitlement` flag (no biometric); this fetches + re-verifies the
    /// live request and responds (mint the admin-root RootEntitlement carrier,
    /// owner-IRK when no admin root), all under ONE biometric — the admin root
    /// resolves from the same memoized ceremony key cache as the IRK, so no
    /// second Face ID. No lease (entitlement carries no secret). Throws
    /// `.noPendingRequest` if the box gave up between the refresh and the tap.
    @discardableResult
    public func approvePendingEntitlement(serverDomain: String) async throws -> String? {
        let verified = try await fetchVerifiedRequests()
        let mine = verified
            .filter { $0.serverDomain.lowercased() == serverDomain.lowercased() && $0.purpose == .entitlement }
            .sorted { $0.pending.postedAt > $1.pending.postedAt }
        guard let live = mine.first(where: { now() <= $0.pending.expiresAt }) else {
            throw CoordinatorError.noPendingRequest(serverDomain)
        }
        return try await confirmAndRespond(live, depositAutoLease: false)
    }

    /// Kill switch — revoke a server's auto-unlock lease. The box can no
    /// longer self-unlock and falls back to phone-gated approval (a downgrade,
    /// not a brick). `leaseId` is the one returned by confirmAndRespond at
    /// deposit (stored per-server by the caller).
    public func revokeAutoUnlockLease(serverDomain: String, leaseId: String) async throws {
        let irk = try await irkProvider()
        let issuedAt = now()
        // The boot worker's DELETE is authorized by the owner-IRK
        // Flagship-Boot-v1 gate (no separate body signature). The signed
        // path includes the domain + leaseId, so it can't replay elsewhere.
        let auth = try BootAuth.ownerHeader(
            serverDomain: serverDomain,
            method: "DELETE",
            path: "/api/boot/lease/\(serverDomain)/\(leaseId)",
            irk: irk,
            now: issuedAt,
            nonce: nonceGen()
        )
        try await mailbox.revokeBoxSealedLease(
            request: LeaseRevokeWire(serverDomain: serverDomain, leaseId: leaseId, issuedAt: issuedAt),
            bootAuth: auth
        )
    }

    /// Deposit a long-lived box-sealed lease (the LUKS key sealed for the box
    /// STK). Returns the lease id. Private — only reachable right after a
    /// user-confirmed unlock approval, when we hold the recovered key.
    private func depositAutoUnlockLease(
        request: SecretRequest,
        luksKey: Data,
        irk: Curve25519.Signing.PrivateKey
    ) async throws -> String {
        let issuedAt = now()
        let leaseId = AutoUnlockLeaseV2.randomLeaseId()
        let expiresAt = issuedAt + 365 * 24 * 60 * 60 * 1000  // ~1 year; renewed on each approve
        let lease = try AutoUnlockLeaseV2.build(
            serverDomain: request.serverDomain,
            stkPub: request.stkPub,
            leaseId: leaseId,
            luksKey: luksKey,
            issuedAt: issuedAt,
            expiresAt: expiresAt
        )
        let sig = try lease.sign(with: irk)
        let depositAuth = try BootAuth.ownerHeader(
            serverDomain: lease.serverDomain,
            method: "PUT",
            path: "/api/boot/lease",
            irk: irk,
            now: now(),
            nonce: nonceGen()
        )
        try await mailbox.depositBoxSealedLease(
            lease: BoxSealedLeaseWire(
                serverDomain: lease.serverDomain,
                stkPub: HexUtil.encode(lease.stkPub),
                leaseId: lease.leaseId,
                sealedKey: HexUtil.encode(lease.sealedKey),
                issuedAt: lease.issuedAt,
                expiresAt: lease.expiresAt,
                maxUses: lease.maxUses
            ),
            signatureHex: HexUtil.encode(sig),
            bootAuth: depositAuth
        )
        return leaseId
    }

    // MARK: - unlock-key

    /// Fetch the phone-sealed LUKS key, unseal it with the phone's existing
    /// Ed25519 key material (the installer sealed it against one of these),
    /// then re-seal it FOR the box's STK bound to (nonce, purpose).
    private func buildUnlockReply(request: SecretRequest) async throws -> (sealedHex: String, luksKey: Data) {
        let sealedLuks: SealedLuksKeyResponse
        do {
            sealedLuks = try await mailbox.fetchSealedLuksKey(serverDomain: request.serverDomain)
        } catch ScreensClientError.http(let status, _) where status == 404 {
            throw CoordinatorError.noSealedLuksKey
        }
        guard let sealedBlob = HexUtil.decode(sealedLuks.sealedKey), !sealedBlob.isEmpty else {
            throw CoordinatorError.noSealedLuksKey
        }

        // Try each candidate phone key seed until one opens the blob —
        // whichever Ed25519 key the installer sealed against.
        let candidates = try await unsealSeedProvider(request.serverDomain)
        var luksKey: Data?
        for seed in candidates {
            if let opened = try? SecretSeal.openWithEd25519Seed(blob: sealedBlob, recipientEd25519Seed: seed) {
                luksKey = opened
                break
            }
        }
        guard let key = luksKey else { throw CoordinatorError.luksUnsealFailed }

        // Re-seal FOR the box's STK, nonce/purpose-bound. Also hand back the
        // recovered key so an "auto" approval can deposit a box-sealed lease.
        let resp = try SealedSecretResponse.build(secret: key, request: request, now: now)
        return (HexUtil.encode(resp.sealed), key)
    }

    // MARK: - entitlement

    /// Sign a root-only RootEntitlement binding (username, podPubKey =
    /// box STK, podCanonical = serverDomain) and serialize it as the
    /// daemon's EntitlementBundle on-disk carrier, hex-encoded.
    ///
    /// Slice D — the RootEntitlement is an ADMIN "authorize this box to serve"
    /// order, so it signs under the admin master root (`orderKey`) when this
    /// device holds one, else the owner IRK (legacy / pre-wipe boxes still
    /// accept the IRK; a reburned admin-pinned box requires the admin root).
    /// Canonical bytes are IDENTICAL either way — only the signing key changes.
    private func buildEntitlementReply(
        request: SecretRequest,
        irk: Curve25519.Signing.PrivateKey,
        orderKey: Curve25519.Signing.PrivateKey?
    ) throws -> String {
        let cert = RootEntitlement(
            username: username,
            podPubKey: request.stkPub,
            podCanonical: request.serverDomain,
            issuedAt: now()
        )
        let sig = try cert.sign(with: orderKey ?? irk)
        let carrier = EntitlementBundleCarrier.serialize(rootEntitlement: cert, rootEntitlementSig: sig)
        return HexUtil.encode(carrier)
    }

    // MARK: - mailbox auth

    private func buildMailboxAuth(irk: Curve25519.Signing.PrivateKey) throws -> MailboxAuthEnvelope {
        let issuedAt = now()
        let claim = DeviceEndpointClaim(
            username: username,
            // There is no hosted endpoint; "device" is a constant label
            // (the Worker only checks phoneIrkPub == account IRK).
            endpointLabel: "device",
            phoneIrkPub: irk.publicKey.rawRepresentation,
            issuedAt: issuedAt,
            // Short-lived — the claim only needs to live for one fetch/post.
            expiresAt: issuedAt + 120_000,
            nonce: nonceGen()
        )
        let sig = try claim.sign(with: irk)
        return MailboxAuthEnvelope(
            auth: .init(
                username: claim.username,
                endpointLabel: claim.endpointLabel,
                phoneIrkPub: HexUtil.encode(claim.phoneIrkPub),
                issuedAt: claim.issuedAt,
                expiresAt: claim.expiresAt,
                nonce: HexUtil.encode(claim.nonce)
            ),
            authSignature: HexUtil.encode(sig)
        )
    }
}
