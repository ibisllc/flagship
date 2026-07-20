import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Phase 3b — ADMIN side of cross-device QR pairing
/// (collaborators, no shared iCloud). Backs Settings → Devices → Add
/// device.
///
/// Flow:
///   1. `start()` — mint an ephemeral X25519 keypair + a relay session
///      id, derive the SAS/AEAD material seam, and publish a pairing QR
///      that encodes a UNIVERSAL LINK
///      `https://flagshipserver.com/join?sid=…&pk=<adminPubB64u>`.
///   2. Open the relay as the originator and AWAIT the incoming device's
///      sealed fresh-device-pubkey hello.
///   3. On hello, derive + show the 6-digit SAS; the admin verifies it
///      matches the incoming screen and taps "Confirm codes match".
///   4. Build a `DeviceAdmit{ username:<thisAccount>, newDevicePubHex,
///      issuedAt }`, sign it with the account's CURRENT IRK
///      (`Keystore.deriveIRK`), AEAD-seal `{ umkSeedHex, admit, admitSig }`
///      and DELIVER it over the relay.
///
/// SAFEGUARDS (admin side): a 90s single-use session TTL; the QR is
/// blanked under screen capture + the session is invalidated on
/// screenshot (driven by the view via `invalidate()`); a prominent risk
/// warning lives in the screen copy. See docs/login-and-account-redesign.md
/// "Safeguards (required for Phase 3b)".
@MainActor
@Observable
public final class AddDeviceViewModel {

    /// Single-use pairing session TTL (seconds). A leaked still of the
    /// QR is useless once this elapses.
    public static let sessionTtlSeconds: TimeInterval = 90

    public enum Phase: Equatable, Sendable {
        /// QR is showing; waiting for the incoming device to connect +
        /// push its device pubkey.
        case waitingForDevice(qrUrl: String)
        /// The incoming device connected; show the SAS. `gateExpired`
        /// flips true after a 600ms anti-double-tap gate so the
        /// "Confirm codes match" button can't be reflexively tapped.
        case confirmMatch(qrUrl: String, matchCode: String, gateExpired: Bool)
        /// Sealing + delivering the UMK bundle to the incoming device.
        case admitting
        /// The incoming device received the bundle. Done.
        case admitted(deviceLabelHint: String?)
        /// Recoverable failure; the screen offers a retry.
        case failed(String)
        /// The session was invalidated (screenshot / TTL / cancel).
        case invalidated(String)
    }

    public private(set) var phase: Phase = .failed("Not started")

    /// D-4 — the assurance-gated "Also make this device an admin" toggle.
    /// Default OFF. Bound by `AddDeviceScreen`, and offered ONLY here (the
    /// synchronous, admin-initiated, SAS-confirmed ceremony — join stories
    /// 1–2). It is NEVER surfaced on the async approve-a-request path
    /// (`JoinAccountViewModel` incoming / secret-request approvals — story 3),
    /// which has no `AddDeviceViewModel` and thus no toggle at all: the gate
    /// is STRUCTURAL. When ON (and this device holds the master root), the
    /// bundle carries `wrappedAdminRoot` so the new device becomes an admin.
    public var promoteNewDeviceToAdmin: Bool = false

    /// True iff THIS device currently holds the admin master root — only such
    /// a device can seal the root to another (§8.2). The screen hides / greys
    /// the promote toggle when false, and `confirmMatch` refuses to attach
    /// `wrappedAdminRoot` without it regardless of the toggle.
    public let canPromoteToAdmin: Bool

    private let account: String
    private let relay: any PairingRelayClient
    /// Seam so tests can supply the account IRK without piercing the
    /// Secure Enclave. Defaults to `Keystore.deriveIRK` (the account's
    /// CURRENT IRK — the vouch authority).
    private let deriveIRK: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    /// Seam so tests can supply the UMK seed (the bundle payload)
    /// without piercing the Secure Enclave. Defaults to reading the
    /// active profile's UMK from the Keystore.
    private let currentUMKHex: @MainActor (String) async throws -> String
    /// Seam so tests can supply the ADMIN MASTER ROOT private seed (lowercased
    /// hex) without piercing the Secure Enclave. Called ONLY when promote is
    /// ON + `canPromoteToAdmin`. Defaults to unsealing the active profile's
    /// admin root (`Keystore.adminRootKey`) and hex-encoding its raw seed.
    private let adminRootSeedHex: @MainActor (String) async throws -> String

    private var ephemeralSk: Curve25519.KeyAgreement.PrivateKey?
    private var aeadKey: SymmetricKey?
    private var sid: String?
    private var incomingDevicePubHex: String?
    private var incomingDeviceId: String?
    private var ttlTask: Task<Void, Never>?

    public init(
        account: String,
        relay: any PairingRelayClient,
        deriveIRK: @escaping @MainActor (String) async throws -> Curve25519.Signing.PrivateKey = { reason in
            try await Keystore.deriveIRK(reason: reason)
        },
        currentUMKHex: @escaping @MainActor (String) async throws -> String = { reason in
            let umk = try await Keystore.currentUMK(reason: reason)
            return HexUtil.encode(umk.withUnsafeBytes { Data($0) })
        },
        canPromoteToAdmin: Bool = GymSeams.forceAdminRoot || Keystore.hasAdminRoot,
        adminRootSeedHex: @escaping @MainActor (String) async throws -> String = { reason in
            let key = try await Keystore.adminRootKey(reason: reason)
            return HexUtil.encode(key.rawRepresentation)
        }
    ) {
        self.account = account
        self.relay = relay
        self.deriveIRK = deriveIRK
        self.currentUMKHex = currentUMKHex
        self.canPromoteToAdmin = canPromoteToAdmin
        self.adminRootSeedHex = adminRootSeedHex
    }

    /// Mint the session + show the QR, then await the incoming device.
    ///
    /// The admin mints an ephemeral X25519 keypair and a relay session
    /// id, shows the QR (its public key + sid), then opens the relay and
    /// AWAITS the incoming device's fresh device pubkey. The SAS + AEAD
    /// key are symmetric in `X25519(adminSk, incomingPk)`, so they're
    /// derived only once the incoming pubkey arrives — and the SAME key
    /// then seals the UMK bundle back. The bundle is sealed ONLY after
    /// the human confirms the SAS.
    public func start() async {
        let sk = Curve25519.KeyAgreement.PrivateKey()
        let session = SerialGen.random()
        ephemeralSk = sk
        sid = session
        let qr = PairingQr.joinUrl(sid: session, adminEphemeralPub: sk.publicKey.rawRepresentation)
        phase = .waitingForDevice(qrUrl: qr)
        startTtl()

        do {
            let devicePubRaw = try await relay.adminAwaitDevicePubkey(
                sid: session,
                aeadKey: SymmetricKey(size: .bits256)
            )
            guard devicePubRaw.count == 48 else {
                phase = .failed("The other device sent an invalid key.")
                return
            }
            let publicKey = Data(devicePubRaw.prefix(32))
            let deviceIdBytes = Data(devicePubRaw.suffix(16))
            // Derive the real shared material against the incoming device
            // pubkey — the SAS the human compares + the AEAD seal key.
            let material = try QrRelay.deriveMaterial(
                phonePrivateKey: sk,
                browserPublicKey: publicKey
            )
            aeadKey = material.aeadKey
            incomingDevicePubHex = HexUtil.encode(publicKey)
            incomingDeviceId = HexUtil.encode(deviceIdBytes)
            phase = .confirmMatch(qrUrl: qr, matchCode: material.matchCode, gateExpired: false)
            // 600ms anti-double-tap gate.
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 600_000_000)
                guard let self else { return }
                if case .confirmMatch(let q, let m, _) = self.phase {
                    self.phase = .confirmMatch(qrUrl: q, matchCode: m, gateExpired: true)
                }
            }
        } catch is PairingRelayError {
            if case .invalidated = phase { return }
            phase = .failed("Pairing didn't complete. Show a new code and try again.")
        } catch {
            phase = .failed(HumanError.humanize(error))
        }
    }

    /// The admin verified the SAS visually and tapped "Confirm codes
    /// match". Builds + signs the DeviceAdmit, seals the bundle, and
    /// delivers it. No-op until the anti-double-tap gate has elapsed.
    public func confirmMatch() async {
        guard case .confirmMatch(_, _, true) = phase,
              let sid, let aeadKey, let devicePubHex = incomingDevicePubHex,
              let deviceId = incomingDeviceId
        else { return }
        phase = .admitting
        do {
            let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
            let admit = DeviceAdmit(
                username: account,
                deviceId: deviceId,
                newDevicePubHex: devicePubHex,
                issuedAt: issuedAt
            )
            let irk = try await deriveIRK("Add a device to your Flagship account")
            let admitSig = try admit.sign(with: irk)
            let umkHex = try await currentUMKHex("Share your account key with the new device")

            // D-4 promote-at-add: seal the admin master root INTO the bundle
            // (carried like `umkSeedHex`, wrapped by the outer AEAD seal) ONLY
            // when the admin flipped the toggle AND this device actually holds
            // the master root. Absent otherwise ⇒ the new device joins as a
            // non-admin peer.
            var wrappedAdminRoot: String? = nil
            if promoteNewDeviceToAdmin && canPromoteToAdmin {
                wrappedAdminRoot = try await adminRootSeedHex("Make the new device an admin")
            }

            let bundle = PairingBundle(
                umkSeedHex: umkHex,
                admit: .init(
                    username: account,
                    deviceId: deviceId,
                    newDevicePubHex: devicePubHex,
                    issuedAt: issuedAt
                ),
                admitSig: HexUtil.encode(admitSig),
                irkPubHex: HexUtil.encode(irk.publicKey.rawRepresentation),
                wrappedAdminRoot: wrappedAdminRoot
            )
            let payload = try bundle.encoded()
            let sealed = try QrRelay.seal(payload: payload, with: aeadKey)
            try await relay.adminDeliverBundle(
                sid: sid,
                ciphertextBase64Url: sealed.ciphertextBase64Url,
                nonceBase64Url: sealed.nonceBase64Url
            )
            ttlTask?.cancel()
            phase = .admitted(deviceLabelHint: nil)
            await relay.close()
        } catch {
            phase = .failed("Couldn't add the device. \(HumanError.humanize(error))")
        }
    }

    /// Safeguard #1 — invalidate the pairing session (screenshot taken,
    /// TTL elapsed, or the user backed out). Tears down the relay so a
    /// leaked QR still can't complete a pairing.
    public func invalidate(reason: String = "For your security this pairing code was cancelled. Start again to add a device.") {
        ttlTask?.cancel()
        // Don't clobber a successful admit.
        if case .admitted = phase { return }
        phase = .invalidated(reason)
        Task { await relay.close() }
    }

    public func cancel() async {
        ttlTask?.cancel()
        await relay.close()
    }

    private func startTtl() {
        ttlTask?.cancel()
        ttlTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.sessionTtlSeconds * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            switch self.phase {
            case .admitted, .invalidated, .admitting:
                return
            default:
                self.invalidate(reason: "This pairing code expired. Start again to add a device.")
            }
        }
    }

    /// Test surface — drive the SAS-confirm gate without the 600ms wait.
    func _forceGateExpiredForTests() {
        if case .confirmMatch(let q, let m, _) = phase {
            phase = .confirmMatch(qrUrl: q, matchCode: m, gateExpired: true)
        }
    }
}
