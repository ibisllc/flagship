import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

@Observable
@MainActor
public final class SettingsViewModel {
    /// Peer-class trusted devices on this user's account — the
    /// new "Trusted devices" section the user manages from Settings.
    /// Backed by GET /api/users/:u/devices.
    public private(set) var trustedDevices: LoadingState<[TrustedDevice]> = .idle
    /// Most-recent ETag the Worker returned. Held so the host can
    /// pass it as If-Match on Disconnect / Replace requests, fencing
    /// the device-list-changed-mid-action race (cf. A3).
    public private(set) var devicesEtag: String?
    /// v1.2 Phase 4 — account-type badge state read from
    /// `GET /api/users/:u`. Nil while loading or on failure;
    /// "single" / "multi" otherwise.
    public private(set) var accountType: String?
    /// Per-pod browser sessions on the user's daemon. Kept around for
    /// the existing "Browser sessions" surface; a separate section
    /// from the peer trusted devices.
    public private(set) var browserSessions: LoadingState<[PairedSessionSummary]> = .idle

    private let screens: any ScreensClient
    private let server: any FlagshipServerClient
    /// Closure rather than a stored String so the VM picks up
    /// AppState.currentUser changes (e.g. after sign-out + sign-in)
    /// without a re-init.
    private let currentUsername: @MainActor () -> String?
    /// Owner-IRK signer for the (now-authenticated) push-token revoke —
    /// same injectable seam as JournalViewModel. Defaults to the biometric
    /// `Keystore.deriveIRK`; tests inject a deterministic key.
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64

    public init(
        client: any ScreensClient,
        server: any FlagshipServerClient,
        username: @MainActor @escaping () -> String?,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.screens = client
        self.server = server
        self.currentUsername = username
        self.signer = signer ?? { reason in try await Keystore.deriveIRK(reason: reason) }
        self.now = now
    }

    public func load() async {
        browserSessions = .loading
        trustedDevices = .loading
        do {
            let ss = try await screens.pairedSessionsList()
            browserSessions = .loaded(ss.sessions)
        } catch {
            browserSessions = .failed(error.localizedDescription)
        }
        await loadTrustedDevices()
        await loadAccountType()
    }

    /// v1.2 Phase 4 — read the account-type badge state. Non-fatal:
    /// failures leave the badge as nil and the Settings row falls
    /// back to the "Single-device" default copy.
    public func loadAccountType() async {
        guard let username = currentUsername(), !username.isEmpty else {
            accountType = nil
            return
        }
        do {
            let rec = try await server.getUsernameRecord(username: username)
            accountType = rec.accountType
        } catch {
            accountType = nil
        }
    }

    /// Refresh just the trusted-devices section. Used by pull-to-
    /// refresh + after a Disconnect/Replace settles to pick up the
    /// new ETag.
    public func loadTrustedDevices() async {
        guard let username = currentUsername(), !username.isEmpty else {
            trustedDevices = .loaded([])
            devicesEtag = nil
            return
        }
        do {
            let resp = try await server.listDevices(username: username)
            trustedDevices = .loaded(resp.devices)
            devicesEtag = resp.etag
        } catch {
            trustedDevices = .failed(error.localizedDescription)
        }
    }

    public func revoke(_ session: PairedSessionSummary) async {
        do {
            try await screens.revokePairedSession(tokenPrefix: session.tokenPrefix)
            if case .loaded(var sessions) = browserSessions {
                sessions.removeAll { $0.tokenPrefix == session.tokenPrefix }
                browserSessions = .loaded(sessions)
            }
        } catch {
            // ignore — UI shows the unchanged list until next refresh
        }
    }

    /// **Disconnect** — soft revoke of another trusted device's push
    /// tether. Removes the row at .com so the device stops getting
    /// alerts; the device's UMK in its Secure Enclave is unchanged.
    /// Optimistic removal + revert on failure so the UI is responsive
    /// on flaky networks.
    ///
    /// Returns true on success so the caller can surface a toast.
    @discardableResult
    public func disconnect(_ device: TrustedDevice) async -> Bool {
        guard case .loaded(let original) = trustedDevices else { return false }
        var working = original
        working.removeAll { $0.tokenId == device.tokenId }
        trustedDevices = .loaded(working)
        do {
            // Revoke is IRK-signed (SEC): sign behind the biometric and let
            // .com verify against the token owner's registered IRK before it
            // deletes the tether.
            let irk = try await signer("Disconnect \(device.label)")
            let issuedAt = now()
            let bytes = PushTokenRevoke.canonicalBytes(tokenId: device.tokenId, issuedAt: issuedAt)
            let sig = try irk.signature(for: bytes)
            try await server.revokePushToken(
                PushTokenRevokeRequest(
                    request: .init(tokenId: device.tokenId, issuedAt: issuedAt),
                    signature: HexUtil.encode(Data(sig))
                )
            )
            // Refresh ETag + verify the row really did disappear.
            await loadTrustedDevices()
            return true
        } catch {
            // Revert optimistic state so the row reappears.
            trustedDevices = .loaded(original)
            return false
        }
    }

    // Legacy alias — older call sites read .controlDevices. Kept so
    // SettingsScreen + tests build until B5's renames land.
    public var controlDevices: LoadingState<[PairedSessionSummary]> { browserSessions }
}
