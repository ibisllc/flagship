import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Phase 3b — INCOMING side of cross-device QR pairing
/// (the collaborator joining a business account, no shared iCloud).
///
/// Entered either from the in-app scanner ("Scan a pairing code") or a
/// universal-link deeplink (`https://flagshipserver.com/join?sid=…&pk=…`
/// → `DeepLink.joinAccount`). Flow:
///   1. `connect(joinUrl:)` — parse the admin's `/join` link, mint a
///      FRESH device (Ed25519) key, derive the SAS/AEAD against the
///      admin's ephemeral pubkey, and SEND the device pubkey (sealed) to
///      the admin over the relay.
///   2. Show the SAS so the user can verify it matches the admin's
///      screen, then AWAIT the admin's sealed bundle.
///   3. AEAD-open the bundle `{ umkSeedHex, admit, admitSig, irkPubHex }`,
///      VERIFY the admit under the carried account IRK pubkey (and the
///      admit's `newDevicePubHex` MUST equal our fresh device pubkey so a
///      captured admit can't be re-aimed at us), then install the UMK into
///      a NEW per-profile slot (never clobbering an existing profile).
///   4. Register a push token + POST `/devices/admit`; surface the 14-day
///      quarantine countdown; hand the host an `AdmittedProfile` to add.
///
/// SAFEGUARDS (incoming side): screenshot protection + invalidate-on-
/// screenshot is driven by the view via `invalidate()`; a clear "you're
/// joining <account> as a quarantined device" warning lives in the
/// screen copy. See docs/login-and-account-redesign.md "Safeguards".
@MainActor
@Observable
public final class JoinAccountViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        /// Parsing + connecting + sending our device pubkey.
        case connecting
        /// SAS shown for the user to compare with the admin's screen,
        /// while we await the admin's sealed bundle.
        case awaitingBundle(matchCode: String)
        /// Verifying + installing the bundle, registering + admitting.
        case admitting
        /// Joined. `account` is the cloud just joined; `quarantineUntil`
        /// is the wall-clock ms the new device stays a non-admin peer.
        case joined(account: String, quarantineUntil: Int64?)
        /// Recoverable failure; the screen offers a retry.
        case failed(String)
        /// The session was invalidated (screenshot / cancel).
        case invalidated(String)
    }

    public private(set) var phase: Phase = .idle

    /// The host (OnboardingFlow / add-profile router) reads this once
    /// `phase == .joined` to call `app.addProfile(_, setActive: true)`.
    public private(set) var admittedProfile: AdmittedProfile?

    /// Slice D §4.2 — true iff the bundle carried a `wrappedAdminRoot` that we
    /// successfully sealed device-local ⇒ this device joined AS an admin. The
    /// host can surface "you're an admin of <account>" copy off this.
    public private(set) var becameAdmin: Bool = false

    public struct AdmittedProfile: Equatable, Sendable {
        public let cloudName: String
        public let deviceLabel: String
        public let quarantineUntil: Int64?
    }

    private let relay: any PairingRelayClient
    private let server: any FlagshipServerClient
    /// Seam: install the recovered UMK into the active (new) profile slot.
    /// Defaults to `Keystore.installUMK`; tests inject a spy.
    private let installUMK: @MainActor (SymmetricKey, String) async throws -> Void
    /// Seam: seal an admin master-root seed device-local. Slice D §4.2 — when
    /// the admin promoted this device at add-time, the bundle carries
    /// `wrappedAdminRoot`; sealing it here makes THIS device a bare-master-root
    /// admin. Defaults to `Keystore.importAdminRoot`; tests inject a spy.
    private let importAdminRoot: @MainActor (Data) async throws -> Void
    /// Seam: the device label for the new device (defaults to a generic
    /// "iPhone"; production wires UIDevice.current.name).
    private let deviceLabel: String

    private var ttlInvalidated = false

    public init(
        relay: any PairingRelayClient,
        server: any FlagshipServerClient,
        deviceLabel: String = "iPhone",
        installUMK: @escaping @MainActor (SymmetricKey, String) async throws -> Void = { seed, reason in
            try await Keystore.installUMK(seed, reason: reason)
        },
        importAdminRoot: @escaping @MainActor (Data) async throws -> Void = { seed in
            _ = try await Keystore.importAdminRoot(seed: seed, reason: "Set up your admin key on this device")
        }
    ) {
        self.relay = relay
        self.server = server
        self.deviceLabel = deviceLabel
        self.installUMK = installUMK
        self.importAdminRoot = importAdminRoot
    }

    /// Mint a fresh device key, send our pubkey to the admin, show the
    /// SAS, and await + process the admin's bundle.
    ///
    /// `provideRawPubkeyToRelay` is the Mock seam bridge: the in-process
    /// Mock can't AEAD-open the sealed pubkey frame, so when present it's
    /// handed the RAW pubkey so the admin side's `await` can resolve.
    /// Production passes nil — the live relay forwards opaque ciphertext.
    public func connect(
        joinUrl: String,
        provideRawPubkeyToRelay: ((Data) -> Void)? = nil
    ) async {
        phase = .connecting
        let session: PairingQr.JoinSession
        do {
            session = try PairingQr.parseJoinUrl(joinUrl)
        } catch {
            phase = .failed("This invite link is invalid. Ask the admin to show a new code.")
            return
        }

        // FRESH device handshake key (X25519) — every install is a new
        // device. THIS key's pubkey is BOTH the SAS-derivation input AND
        // the device-identity the admit binds, so the admin binds exactly
        // the pubkey it derived the SAS from (no mismatch possible). A
        // separate fresh Ed25519 key signs the push register (carried;
        // .com doesn't verify it on the admit path).
        let handshakeSk = Curve25519.KeyAgreement.PrivateKey()
        let devicePubHex = HexUtil.encode(handshakeSk.publicKey.rawRepresentation)
        let pushSigningKey = Curve25519.Signing.PrivateKey()

        let material: QrRelay.DerivedMaterial
        do {
            material = try QrRelay.deriveMaterial(
                phonePrivateKey: handshakeSk,
                browserPublicKey: session.adminPublicKey
            )
        } catch {
            phase = .failed("Couldn't establish a secure channel. \(HumanError.humanize(error))")
            return
        }

        // Seal + send our handshake/device pubkey (the admin derives the
        // same shared secret from it AND binds it in the admit). The Mock
        // bridge hands the admin the raw pubkey so its await resolves.
        let devicePubRaw = handshakeSk.publicKey.rawRepresentation
        do {
            let sealed = try QrRelay.seal(payload: devicePubRaw, with: material.aeadKey)
            provideRawPubkeyToRelay?(devicePubRaw)
            let bundleFrame = try await relay.incomingSendPubkeyAwaitBundle(
                sid: session.sid,
                devicePubCiphertextBase64Url: sealed.ciphertextBase64Url,
                devicePubNonceBase64Url: sealed.nonceBase64Url
            )
            phase = .awaitingBundle(matchCode: material.matchCode)
            await processBundle(
                frame: bundleFrame,
                aeadKey: material.aeadKey,
                pushSigningKey: pushSigningKey,
                devicePubHex: devicePubHex
            )
        } catch is PairingRelayError {
            if ttlInvalidated { return }
            phase = .failed("Pairing didn't complete. Ask the admin to show a new code.")
        } catch {
            phase = .failed(HumanError.humanize(error))
        }
    }

    private func processBundle(
        frame: (ciphertextBase64Url: String, nonceBase64Url: String),
        aeadKey: SymmetricKey,
        pushSigningKey: Curve25519.Signing.PrivateKey,
        devicePubHex: String
    ) async {
        phase = .admitting
        // 1 — AEAD-open the bundle.
        let bundle: PairingBundle
        do {
            guard let ct = Base64URL.decode(frame.ciphertextBase64Url),
                  let nonceData = Base64URL.decode(frame.nonceBase64Url) else {
                phase = .failed("The pairing data was malformed.")
                return
            }
            let plaintext = try Self.aeadOpen(ciphertextAndTag: ct, nonce: nonceData, key: aeadKey)
            bundle = try PairingBundle.decode(plaintext)
        } catch {
            phase = .failed("Couldn't decrypt the pairing data — the codes may not have matched.")
            return
        }

        // 2 — The admit MUST bind OUR fresh device pubkey. A captured
        // admit aimed at a different device is rejected here (defense in
        // depth — .com also binds it server-side).
        guard bundle.admit.newDevicePubHex.lowercased() == devicePubHex.lowercased() else {
            phase = .failed("This pairing was for a different device. Try again.")
            return
        }

        // 3 — Verify the admit under the carried account IRK pubkey. .com
        // re-verifies under the IRK it stores, so this is a local fail-fast
        // (a forged carried pubkey can't actually admit a device).
        guard let irkPub = HexUtil.decode(bundle.irkPubHex),
              let admitSig = HexUtil.decode(bundle.admitSig) else {
            phase = .failed("The pairing proof was malformed.")
            return
        }
        let admit = DeviceAdmit(
            username: bundle.admit.username,
            newDevicePubHex: bundle.admit.newDevicePubHex,
            issuedAt: bundle.admit.issuedAt
        )
        guard admit.verify(signature: admitSig, irkPub: irkPub) else {
            phase = .failed("The admin's authorization couldn't be verified. Don't continue.")
            return
        }

        // 4 — Install the UMK into a NEW per-profile slot. Point the
        // keystore at THIS account's slot FIRST so the install never
        // clobbers an existing profile's UMK.
        guard let umkData = HexUtil.decode(bundle.umkSeedHex), umkData.count == 32 else {
            phase = .failed("The account key was malformed.")
            return
        }
        let account = bundle.admit.username
        Keystore.setActiveProfile(account)
        do {
            try await installUMK(SymmetricKey(data: umkData), "Join \(account) on this device")
        } catch {
            phase = .failed("Couldn't install the account key. \(HumanError.humanize(error))")
            return
        }

        // 4b — D-4 promote-at-add: if the admin sealed the master root into
        // the bundle (`wrappedAdminRoot`), unseal it device-local so THIS
        // device becomes a bare-master-root admin — the SAME way the UMK above
        // was carried + installed. The active profile is already this account
        // (set before the UMK install), so the root lands in the right slot.
        // Best-effort: the join itself already succeeded (UMK installed), so a
        // seal failure must NOT unwind it — the device simply joins non-admin
        // and can be promoted again later.
        if let wrappedAdminRootHex = bundle.wrappedAdminRoot,
           let adminSeed = HexUtil.decode(wrappedAdminRootHex),
           adminSeed.count == 32 {
            do {
                try await importAdminRoot(adminSeed)
                becameAdmin = true
            } catch {
                // Non-fatal — see above.
            }
        }

        // 5 — Register push + POST /devices/admit. The incoming device
        // holds no account IRK; it signs the push register with its FRESH
        // device key (carried, NOT verified — the admit is the consent).
        let quarantineUntil: Int64?
        do {
            quarantineUntil = try await registerAndAdmit(
                account: account,
                bundle: bundle,
                pushSigningKey: pushSigningKey
            )
        } catch {
            phase = .failed("Couldn't complete joining \(account). \(HumanError.humanize(error))")
            return
        }

        admittedProfile = AdmittedProfile(
            cloudName: account,
            deviceLabel: deviceLabel,
            quarantineUntil: quarantineUntil
        )
        phase = .joined(account: account, quarantineUntil: quarantineUntil)
        await relay.close()
    }

    private func registerAndAdmit(
        account: String,
        bundle: PairingBundle,
        pushSigningKey: Curve25519.Signing.PrivateKey
    ) async throws -> Int64? {
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let pushKeypair = try Keystore.loadOrCreatePushX25519()
        let pushPubHex = HexUtil.encode(pushKeypair.publicKey.rawRepresentation)
        // The incoming device has no real APNs token at pairing time;
        // use a placeholder provider token (the real token re-registers
        // via PushRegistrar once APNs grants one post-onboarding).
        let providerToken = HexUtil.encode(Data((0..<8).map { _ in UInt8.random(in: 0...255) }))
        let label = deviceLabel
        let inner = PushTokenRegisterRequest.Inner(
            username: account,
            platform: "apns",
            providerToken: providerToken,
            pushX25519Pub: pushPubHex,
            label: label,
            issuedAt: issuedAt
        )
        // Sign the push register with a fresh device-held key (carried;
        // .com does not verify it on the admit path — skipSignatureVerify).
        let bytes = PushTokenRegister.canonicalBytes(
            username: account,
            platform: "apns",
            providerToken: providerToken,
            pushX25519PubHex: pushPubHex,
            label: label,
            issuedAt: issuedAt
        )
        let regSig = try pushSigningKey.signature(for: bytes)

        let req = DeviceAdmitRequest(
            admit: .init(
                username: bundle.admit.username,
                newDevicePubHex: bundle.admit.newDevicePubHex,
                issuedAt: bundle.admit.issuedAt
            ),
            admitSig: bundle.admitSig,
            request: inner,
            signature: HexUtil.encode(Data(regSig))
        )
        let resp = try await server.admitDevice(account: account, body: req)
        try? Keystore.setPushTokenId(resp.tokenId)
        return resp.quarantineUntil
    }

    /// Safeguard #1 — invalidate the pairing session (screenshot / cancel).
    public func invalidate(reason: String = "For your security this pairing was cancelled. Scan the admin's code again to join.") {
        ttlInvalidated = true
        if case .joined = phase { return }
        phase = .invalidated(reason)
        Task { await relay.close() }
    }

    public func cancel() async {
        await relay.close()
    }

    /// AEAD-open `nonce`-keyed `ciphertext||tag` under `key`. Mirrors the
    /// browser side that opens what `QrRelay.seal` produced.
    static func aeadOpen(ciphertextAndTag: Data, nonce: Data, key: SymmetricKey) throws -> Data {
        let n = try AES.GCM.Nonce(data: nonce)
        // SealedBox expects ciphertext + tag split; tag is the last 16
        // bytes (GCM tag length).
        guard ciphertextAndTag.count >= 16 else {
            throw PairingRelayError.transport("ciphertext too short")
        }
        let tag = ciphertextAndTag.suffix(16)
        let ct = ciphertextAndTag.prefix(ciphertextAndTag.count - 16)
        let box = try AES.GCM.SealedBox(nonce: n, ciphertext: ct, tag: tag)
        return try AES.GCM.open(box, using: key)
    }
}
