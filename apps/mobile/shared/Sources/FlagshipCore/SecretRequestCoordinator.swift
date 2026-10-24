import Foundation
import CryptoKit
import FlagshipAPI

/// Drives the phone's half of the boot-secret RELAY handshake
/// (docs/security-phone-as-unlock-endpoint.md):
///
///   1. fetchPending — builds an IRK-signed `DeviceEndpointClaim`
///      mailbox-auth credential, POSTs `/api/secret-requests`, and
///      RE-VERIFIES every returned request's signature under the key it names,
///      then weighs that key against this device's pin (docs/first-contact.md):
///      the pinned key, first sight (no pin yet: the server code is computed
///      here from that key, and the enrollment proof must verify when this
///      device made the recipe), or refused (a different key than the pin, or
///      a recipe proof that fails). `.com` is not a trust anchor: its
///      directory only filters to servers of the account.
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
        /// The request names a key other than the one this device pinned.
        case keyChanged(String)
        /// This device made the recipe and the box's enrollment proof is missing or wrong.
        case notFromRecipe(String)
        /// A server not pinned yet was approved where its code was not on screen.
        case codeNotShown(String)
        /// Boot unlock v2 refused under strict (`BootUnlockV2` codes).
        case quantumSafe(String)

        public var errorDescription: String? {
            switch self {
            case .noSealedLuksKey:
                return String(localized: "No sealed disk key is on file for this box yet.")
            case .luksUnsealFailed:
                return String(localized: "Couldn't unseal the disk key with this phone's keys.")
            case .directoryMissingServer(let d):
                return String(localized: "This box (\(d)) isn't registered to your account.")
            case .purposeUnsupported(let p):
                return String(localized: "Unsupported secret request type: \(p).")
            case .noPendingRequest:
                return String(localized: "Your box stopped waiting. Power-cycle it (unplug, plug back in) and it'll ask again.")
            case .keyChanged:
                return FirstContact.keyChangedText
            case .notFromRecipe:
                return FirstContact.notFromRecipeText
            case .codeNotShown:
                return String(localized: "Check this server's code before you approve it. Open Server approvals in Activity.")
            case .quantumSafe("phone-cannot-sign-hybrid"):
                return String(localized: "This server is quantum-safe. Approve it on a device that holds your account key's quantum-resistant half (Settings, Quantum-safe protection).")
            case .quantumSafe:
                return String(localized: "This server is quantum-safe, but it hasn't published its quantum-resistant unlock key. Update the server, or turn quantum-safe protection off for it.")
            }
        }
    }

    /// A request whose signature verified under the key it names, weighed
    /// against this device's pin. Refused ones (`trust.isRefused`) are kept so
    /// the approvals list can say why; they can never be approved.
    public struct VerifiedRequest: Equatable, Sendable, Identifiable {
        public let pending: PendingSecretRequest
        /// The server's STK the request is under (64 lowercase hex): the key it names, or the STK
        /// that vouched for the boot key it was signed with.
        public let stkPubHex: String
        public let trust: FirstContactTrust
        /// Studio reported this exact key from the server's console, under the key this device gave it.
        public let studioConfirmed: Bool
        /// The key a disk-key reply or lease is sealed to: the STK, or (an
        /// unlock request from a box whose disk is still shut) the boot key
        /// the STK vouched for. nil means the STK.
        public var recipientPubHex: String? = nil
        /// Boot unlock v2: the box's verified material and this request's per-boot reply key.
        public var pqMaterial: BootUnlockV2.Material? = nil
        public var replyKemPubHex: String? = nil
        public init(pending: PendingSecretRequest, stkPubHex: String, trust: FirstContactTrust = .pinned,
                    studioConfirmed: Bool = false, recipientPubHex: String? = nil) {
            self.pending = pending
            self.stkPubHex = stkPubHex.lowercased()
            self.trust = trust
            self.studioConfirmed = studioConfirmed
            self.recipientPubHex = recipientPubHex?.lowercased()
        }
        public var id: String { pending.id }
        /// The six-digit code for a first sight, computed here from the request's key.
        public var serverCode: String? {
            if case .firstSight(let code, _) = trust { return code }
            return nil
        }
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
    /// The box keys this device pinned: the only trust anchor for a server's key.
    private let serverKeys: ServerKeyPins
    /// The enrollment secrets this device keeps for servers it created.
    private let firstContactSecrets: FirstContactSecretStore
    private let studioSeen: StudioSeenStore
    /// Where the app-name grant signed at a first blessing is kept until the server takes it.
    private let wildcardGrants: ServerWildcardGrantKeeper
    /// The box keys this device pinned; a reply is never sealed to another.
    private let pins: BoxKeyPins
    /// Boot unlock v2: the owner key's hybrid half on this device (nil when it holds none).
    private let ownerPqProvider: (Curve25519.Signing.PrivateKey) async -> OwnerPqSigner?
    /// Whether the server's policy (as this device replays it) is strict.
    private let strictFor: (String) -> Bool

    /// The owner key's hybrid public key and a signer for it.
    public struct OwnerPqSigner {
        public let publicKey: [UInt8]
        public let sign: BootUnlockV2.OwnerSigner
        public init(publicKey: [UInt8], sign: @escaping BootUnlockV2.OwnerSigner) { self.publicKey = publicKey; self.sign = sign }
    }

    public init(
        mailbox: SecretMailboxClient,
        username: String,
        irkProvider: @escaping () async throws -> Curve25519.Signing.PrivateKey,
        unsealSeedProvider: @escaping (String) async throws -> [Data],
        orderKeyProvider: @escaping () async throws -> Curve25519.Signing.PrivateKey? = { nil },
        watchDelegateKeyProvider: @escaping () -> Curve25519.Signing.PrivateKey? = { nil },
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        nonceGen: @escaping () -> Data = { SecretRequestCoordinator.randomNonce() },
        serverKeys: ServerKeyPins = ServerKeyPins(),
        firstContactSecrets: FirstContactSecretStore = KeychainFirstContactSecrets(),
        studioSeen: StudioSeenStore = .shared,
        wildcardGrants: ServerWildcardGrantKeeper = .shared,
        pins: BoxKeyPins? = nil,
        ownerPqProvider: @escaping (Curve25519.Signing.PrivateKey) async -> OwnerPqSigner? = { _ in nil },
        strictFor: @escaping (String) -> Bool = { _ in false }
    ) {
        // One pin store: the PQ pins are a view of `serverKeys`.
        let boxPins = pins ?? BoxKeyPins(serverKeys: serverKeys)
        self.pins = boxPins
        self.serverKeys = boxPins.serverKeys
        self.firstContactSecrets = firstContactSecrets
        self.studioSeen = studioSeen
        self.wildcardGrants = wildcardGrants
        self.ownerPqProvider = ownerPqProvider
        self.strictFor = strictFor
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

    /// Build the mailbox auth, fetch the account's pending requests, keep
    /// those signed by the key they name for a server of the account, and
    /// weigh each key against this device's pin. A request that fails its
    /// signature is SILENTLY dropped; a refused one is returned marked so.
    public func fetchVerifiedRequests() async throws -> [VerifiedRequest] {
        let irk = try await irkProvider()
        let auth = try buildMailboxAuth(irk: irk)
        let pendingResp = try await mailbox.fetchPendingRequests(auth: auth)
        let directory = try await mailbox.fetchPods(username: username)

        var verified: [VerifiedRequest] = []
        for pending in pendingResp.requests {
            // Only a server of this account. Its listed key is never what gets approved: before a
            // pin it is only the STK a boot key's binding is checked under.
            guard let listedHex = directory.identityPubKey(forServerDomain: pending.serverDomain)?.lowercased(),
                  let echoData = HexUtil.decode(pending.stkPub), echoData.count == 32,
                  let echoKey = try? Curve25519.Signing.PublicKey(rawRepresentation: echoData),
                  let purpose = SecretPurpose(rawValue: pending.purpose),
                  let nonce = HexUtil.decode(pending.requestNonceHex),
                  let sig = HexUtil.decode(pending.requestSignature)
            else { continue }
            // The request names the server's own STK, or (a disk unlock from a box whose disk is
            // still shut) is signed by the boot key that STK vouches for: the pinned STK, or before
            // a pin the listed one, which is the key the reply would go to then anyway. A pinned
            // server whose ML-DSA key changed vouches for no boot key, so its request is refused.
            let echo = HexUtil.encode(echoData)
            let pin = serverKeys.pinnedStkHex(pending.serverDomain)
            let anchor = pin ?? listedHex
            var stkHex = echo
            var recipient: String?
            if echo != anchor {
                var boot: String?
                if pin != nil {
                    if purpose == .unlockKey {
                        boot = await BootKey.forServer(username: username, serverDomain: pending.serverDomain,
                                                       mailbox: mailbox, pins: pins)
                    }
                } else {
                    let wire = try? await mailbox.fetchBootKeyBinding(serverDomain: pending.serverDomain)
                    if purpose == .unlockKey {
                        boot = wire.flatMap { BootKey.verified($0, serverDomain: pending.serverDomain, stkPubHex: anchor) }
                    }
                    // A key the box published as its boot key is never shown or pinned as its STK.
                    if boot != echo, wire?.binding.bootPubHex.lowercased() == echo { continue }
                }
                if let boot, boot == echo {
                    stkHex = anchor
                    recipient = boot
                }
            }
            let request = SecretRequest(
                serverDomain: pending.serverDomain,
                stkPub: echoData,
                purpose: purpose,
                nonce: nonce,
                issuedAt: pending.issuedAt
            )
            // RE-VERIFY the box's request under the key it names; the pin decides from there.
            guard SecretRequest.verify(request, signature: sig, stkPub: echoKey) else { continue }
            var v = VerifiedRequest(
                pending: pending,
                stkPubHex: stkHex,
                trust: trust(for: pending, stkPubHex: stkHex, purpose: purpose),
                studioConfirmed: studioSeen.confirmed(serverDomain: pending.serverDomain, stkPubHex: stkHex),
                recipientPubHex: recipient
            )
            // Boot unlock v2: the box's hybrid material through the pinned STK, then the request's
            // hybrid signature under the boot key's hybrid key. Anything that fails leaves v1.
            if let boot = recipient, let text = pending.pqJSON,
               let material = await BootKey.v2Material(username: username, serverDomain: pending.serverDomain,
                                                       bootPubHex: boot, mailbox: mailbox, pins: pins, now: now()),
               let obj = try? JSONSerialization.jsonObject(with: Data(text.utf8)),
               let kem = try? BootUnlockV2.verifyRequest(serverDomain: pending.serverDomain, bootPubHex: boot, purpose: pending.purpose,
                                                         nonceHex: pending.requestNonceHex, issuedAt: pending.issuedAt, pq: obj, material: material) {
                v.pqMaterial = material
                v.replyKemPubHex = HexUtil.encode(Data(kem))
            }
            verified.append(v)
        }
        return verified
    }

    private func trust(for pending: PendingSecretRequest, stkPubHex: String, purpose: SecretPurpose) -> FirstContactTrust {
        FirstContact.assess(
            serverDomain: pending.serverDomain,
            stkPubHex: stkPubHex,
            purpose: purpose,
            enrollmentProof: pending.deviceInfo?.enrollmentProof,
            pins: serverKeys,
            secrets: firstContactSecrets
        )
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
        guard let stkPubData = HexUtil.decode(verified.stkPubHex), stkPubData.count == 32,
              let nonce = HexUtil.decode(verified.pending.requestNonceHex)
        else {
            throw CoordinatorError.directoryMissingServer(verified.serverDomain)
        }
        // Weigh the key again now: a pin made since the list loaded counts.
        let standing = trust(for: verified.pending, stkPubHex: verified.stkPubHex, purpose: purpose)
        let pinsNow: Bool
        switch standing {
        case .keyChanged: throw CoordinatorError.keyChanged(verified.serverDomain)
        case .notFromRecipe: throw CoordinatorError.notFromRecipe(verified.serverDomain)
        case .pinned: pinsNow = false
        case .firstSight(_, let pinsOnApprove): pinsNow = pinsOnApprove
        }
        let firstSight = standing != .pinned
        // Before any prompt: a pinned server's key must still be the pin.
        if standing == .pinned {
            try pins.require(username: username, serverDomain: verified.serverDomain, reportedHex: verified.stkPubHex)
        }
        // Only a disk unlock goes to the boot key, and only one the STK vouched for: the pinned
        // boot key, or (before a pin) the one checked under the STK at fetch time.
        var recipientData = stkPubData
        let bootRecipient = verified.recipientPubHex.flatMap { $0 != verified.stkPubHex ? $0 : nil }
        if let boot = bootRecipient {
            guard purpose == .unlockKey, let d = HexUtil.decode(boot), d.count == 32 else {
                throw CoordinatorError.directoryMissingServer(verified.serverDomain)
            }
            if standing == .pinned, boot != pins.pinnedBootKey(username: username, serverDomain: verified.serverDomain) {
                throw CoordinatorError.keyChanged(verified.serverDomain)
            }
            recipientData = d
        }
        let request = SecretRequest(
            serverDomain: verified.serverDomain,
            stkPub: stkPubData,
            purpose: purpose,
            nonce: nonce,
            issuedAt: verified.pending.issuedAt
        )
        // The entitlement names the STK; the disk key is sealed to `recipientData`.
        var sealRequest = request
        sealRequest.stkPub = recipientData
        // A watch delegate signs the boot-response header for a plain UNLOCK
        // approval (no auto-lease). That path needs the IRK for NOTHING, so we
        // never call irkProvider() and no biometric prompt fires — the whole
        // point of the feature. The auto-lease deposit uses the IRK and the
        // entitlement mint the admin master root (Slice D) — but every
        // entitlement path still needs the IRK for its mailbox/boot AUTH
        // envelope, and the delegate is scoped to the boot-approval response
        // alone, so we resolve the IRK lazily only when a branch needs it.
        // A first sight is approved on the phone with the account key, never by the watch delegate.
        // A strict server needs the owner key's hybrid signature, so the watch's quick approve
        // (no IRK) does not apply to it either: the phone asks for the account key.
        let strict = strictFor(verified.serverDomain)
        let delegateKey: Curve25519.Signing.PrivateKey? =
            (purpose == .unlockKey && !depositAutoLease && !firstSight && !strict) ? watchDelegateKeyProvider() : nil
        let irk: Curve25519.Signing.PrivateKey? =
            delegateKey == nil ? try await irkProvider() : nil
        func requireIrk() throws -> Curve25519.Signing.PrivateKey {
            // Unreachable when delegateKey != nil — every IRK-consuming branch
            // runs only on the delegate==nil path, where irk was resolved above.
            guard let irk else { throw CoordinatorError.purposeUnsupported("internal: missing IRK") }
            return irk
        }

        // First blessing: pin the key, then everything below is sealed to the pin.
        var orderKeyForGrant: Curve25519.Signing.PrivateKey?
        if pinsNow {
            guard serverKeys.pin(stkPubData, for: verified.serverDomain) else {
                throw CoordinatorError.keyChanged(verified.serverDomain)
            }
            firstContactSecrets.delete(for: verified.serverDomain)
            studioSeen.forget(verified.serverDomain)
            // The boot key checked before the pin is sealed to only once the pinned STK vouches for it.
            if let boot = bootRecipient,
               await BootKey.forServer(username: username, serverDomain: verified.serverDomain, mailbox: mailbox, pins: pins) != boot {
                throw CoordinatorError.keyChanged(verified.serverDomain)
            }
        }

        let sealedHex: String
        var unlockKey: Data?
        switch purpose {
        case .unlockKey:
            let reply = try await buildUnlockReply(request: sealRequest, verified: verified, irk: irk, strict: strict)
            sealedHex = reply.sealedHex
            unlockKey = reply.luksKey
        case .entitlement:
            // Slice D — the RootEntitlement is an admin "authorize this box"
            // order: sign it under the admin master root when present (else the
            // IRK). Resolving the order key here reuses the memoized ceremony
            // key cache, so no extra biometric fires beyond the one that opened
            // the IRK above. The boot-response AUTH envelope below stays IRK.
            let orderKey = try await orderKeyProvider()
            orderKeyForGrant = orderKey
            sealedHex = try buildEntitlementReply(
                request: request, irk: try requireIrk(), orderKey: orderKey
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
        // Not before a pin: a server this device made asks for its entitlement
        // with the enrollment proof, which is what pins it.
        if purpose == .unlockKey, let irk, !(firstSight && !pinsNow) {
            // Slice D — the folded-in entitlement is signed under the admin
            // master root when present (an admin-pinned box rejects an
            // IRK-signed one), else the IRK. Best-effort: the order key is
            // resolved from the same memoized ceremony cache (no extra
            // biometric), and a failure just skips the pre-deposit — the box
            // still gets one via an explicit entitlement request.
            let orderKey = try? await orderKeyProvider()
            orderKeyForGrant = orderKey ?? nil
            try? await depositEntitlement(request: request, irk: irk, orderKey: orderKey ?? nil)
        }

        // The app-name grant, signed in the same biometric session over the
        // PINNED key with the sensitive-order key (admin root where pinned, else
        // the IRK), kept until the server takes it. Best-effort.
        if pinsNow, let key = orderKeyForGrant ?? irk {
            try? wildcardGrants.sign(username: username, serverDomain: verified.serverDomain,
                                     pinnedStk: stkPubData, key: key, issuedAt: now())
            let domain = verified.serverDomain, grants = wildcardGrants, pins = serverKeys
            Task { await grants.deliverKept(domain, pins: pins) }
        }

        // "auto" mode: deposit a box-sealed lease so the box self-unlocks on
        // future reboots (the user's IRK authorizes it here — I2). Only for
        // unlock-key; the key is the one we just recovered, never `.com`-visible.
        if depositAutoLease, purpose == .unlockKey, let key = unlockKey, !(firstSight && !pinsNow) {
            return try await depositAutoUnlockLease(request: sealRequest, luksKey: key, irk: try requireIrk(),
                                                    material: verified.pqMaterial, strict: strict)
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
        depositAutoLease: Bool,
        expectedStkPubHex: String? = nil
    ) async throws -> String? {
        let verified = try await fetchVerifiedRequests()
        let mine = verified
            .filter { $0.serverDomain.lowercased() == serverDomain.lowercased() && $0.purpose == .unlockKey }
            .sorted { $0.pending.postedAt > $1.pending.postedAt }
        guard let live = mine.first(where: { now() <= $0.pending.expiresAt }) else {
            throw CoordinatorError.noPendingRequest(serverDomain)
        }
        try Self.requireShownKey(live, expectedStkPubHex: expectedStkPubHex)
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
    public func approvePendingEntitlement(serverDomain: String, expectedStkPubHex: String? = nil) async throws -> String? {
        let verified = try await fetchVerifiedRequests()
        let mine = verified
            .filter { $0.serverDomain.lowercased() == serverDomain.lowercased() && $0.purpose == .entitlement }
            .sorted { $0.pending.postedAt > $1.pending.postedAt }
        guard let live = mine.first(where: { now() <= $0.pending.expiresAt }) else {
            throw CoordinatorError.noPendingRequest(serverDomain)
        }
        try Self.requireShownKey(live, expectedStkPubHex: expectedStkPubHex)
        return try await confirmAndRespond(live, depositAutoLease: false)
    }

    /// The server card shows the code of the key it expects before Approve; a
    /// request naming any other key is not the server the owner looked at.
    static func requireShownKey(_ live: VerifiedRequest, expectedStkPubHex: String?) throws {
        if live.trust == .keyChanged { throw CoordinatorError.keyChanged(live.serverDomain) }
        if live.trust == .notFromRecipe { throw CoordinatorError.notFromRecipe(live.serverDomain) }
        guard live.trust != .pinned else { return }
        // A first sight is approved only after its code was on screen.
        guard let expected = expectedStkPubHex?.lowercased(), !expected.isEmpty else {
            throw CoordinatorError.codeNotShown(live.serverDomain)
        }
        if expected != live.stkPubHex { throw CoordinatorError.keyChanged(live.serverDomain) }
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

    /// Deposit a long-lived box-sealed lease (the LUKS key sealed for the box's
    /// boot key, or its STK when it has none). Returns the lease id. Private — only reachable right after a
    /// user-confirmed unlock approval, when we hold the recovered key.
    private func depositAutoUnlockLease(
        request: SecretRequest,
        luksKey: Data,
        irk: Curve25519.Signing.PrivateKey,
        material: BootUnlockV2.Material? = nil,
        strict: Bool = false
    ) async throws -> String? {
        let issuedAt = now()
        // A locked server takes no new lease: only an explicit, signed resume re-arms auto-unlock.
        if BootLockStateStore().lastKnownSuspended(request.serverDomain) == true { return nil }
        // With the dead-man switch on, a lease may not outlive the affirmation that keeps it alive
        // (SEC-DEADMAN-001); with no live deadline, no lease at all.
        let dm = DeadManStore()
        guard let expiresAt = DeadManLeaseBound.expiry(
            requested: issuedAt + 365 * 24 * 60 * 60 * 1000,  // ~1 year; renewed on each approve
            enabled: dm.isEnabled(for: request.serverDomain),
            deadline: dm.leaseExpiry(for: request.serverDomain),
            now: issuedAt
        ) else { return nil }
        let leaseId = AutoUnlockLeaseV2.randomLeaseId()
        // Boot unlock v2: a v3 lease is sealed to the box's lease key and signed hybrid inside;
        // the worker still checks the classical outer signature.
        let owner = material != nil ? await ownerPqProvider(irk) : nil
        let leaseVersion: Int
        do {
            leaseVersion = try BootUnlockV2.chooseLeaseVersion(strict: strict, material: material != nil, canSignHybrid: owner != nil)
        } catch let e as BootUnlockV2.Failure { throw CoordinatorError.quantumSafe(e.code) }
        var lease = try AutoUnlockLeaseV2.build(
            serverDomain: request.serverDomain,
            stkPub: request.stkPub,
            leaseId: leaseId,
            luksKey: luksKey,
            issuedAt: issuedAt,
            expiresAt: expiresAt
        )
        if leaseVersion == 3, let material, let owner {
            lease.sealedKey = Data(try BootUnlockV2.sealLease(
                serverDomain: request.serverDomain, bootPubHex: HexUtil.encode(request.stkPub), leaseId: leaseId,
                issuedAt: issuedAt, expiresAt: expiresAt, leaseKemPublicKey: material.leaseKemPublicKey,
                diskKey: [UInt8](luksKey), ownerHybridPublicKey: owner.publicKey, sign: owner.sign))
        }
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
    /// then re-seal it FOR `request.stkPub` (the boot key, or the STK) bound to (nonce, purpose).
    private func buildUnlockReply(request: SecretRequest, verified: VerifiedRequest? = nil,
                                  irk: Curve25519.Signing.PrivateKey? = nil, strict: Bool = false) async throws -> (sealedHex: String, luksKey: Data) {
        let sealedLuks: SealedLuksKeyResponse
        do {
            sealedLuks = try await mailbox.fetchSealedLuksKey(serverDomain: request.serverDomain, username: username)
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

        // Boot unlock v2 (pq-suites.md §19): the box's policy, not the request, decides whether a
        // classical reply is still allowed.
        let owner: OwnerPqSigner? = (verified?.pqMaterial != nil && irk != nil) ? await ownerPqProvider(irk!) : nil
        let version: Int
        do {
            version = try BootUnlockV2.chooseReplyVersion(strict: strict, material: verified?.pqMaterial != nil,
                                                          requestHasPq: verified?.replyKemPubHex != nil, canSignHybrid: owner != nil)
        } catch let e as BootUnlockV2.Failure { throw CoordinatorError.quantumSafe(e.code) }
        if version == 2, let owner, let replyHex = verified?.replyKemPubHex, let reply = HexUtil.decode(replyHex) {
            let sealed = try BootUnlockV2.buildReply(
                serverDomain: request.serverDomain, bootPubHex: HexUtil.encode(request.stkPub), nonceHex: HexUtil.encode(request.nonce),
                replyKemPub: [UInt8](reply), diskKey: [UInt8](key), ownerHybridPublicKey: owner.publicKey, issuedAt: now(), sign: owner.sign)
            return (HexUtil.encode(Data(sealed)), key)
        }
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
