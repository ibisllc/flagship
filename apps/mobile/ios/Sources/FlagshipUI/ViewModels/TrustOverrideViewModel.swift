import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipCore
import FlagshipAPI

/// Drives the deliberate, biometric-gated trust OVERRIDE for one failing cert.
///
/// The owner taps a failing line in the red trust sliver → confirms → Face ID
/// (inside `signer`, exactly like `LockPowerViewModel`) → we sign a
/// `TrustException` scoped to that cert-hash with the device IRK and record the
/// override in the `TrustCenter`. Recording un-halts backend traffic for that
/// cert; the red line PERSISTS so the degraded state stays visible.
///
/// The signed envelope is ALSO transmitted to `.com`'s directory (safe:
/// device-key-signed + cert-hash-scoped — `.com` can't forge it and replaying
/// "accept cert X" is harmless). That transmit is the LOAD-BEARING fan-out:
/// every box the user owns pulls the owner's exception list, so one biometric
/// override here silences the warning on ALL affected servers — not just this
/// device's local trust store.
@Observable
@MainActor
public final class TrustOverrideViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case signing
        case done
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    /// The last signed exception envelope (for directory propagation). nil
    /// until a successful override.
    public private(set) var signedEnvelope: [String: Any]?

    /// Whether the signed exception was accepted by `.com` for fleet-wide
    /// fan-out. nil until a transmit attempt completes; false on any failure
    /// (a failed transmit never undoes the local override — the override still
    /// un-sticks THIS device; propagation is best-effort).
    public private(set) var transmitted: Bool?

    private let failure: TrustFailure
    private let center: TrustCenter
    /// The owner account name — the `:u` in `/api/users/:u/trust-exceptions`.
    /// nil ⇒ skip the transmit (no account context) and only override locally.
    private let username: String?
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    /// Transmit the signed WIRE envelope to `.com`. Returns whether it was
    /// accepted. Injectable for tests; the default POSTs to the control apex.
    private let poster: @Sendable (String, [String: Any]) async -> Bool
    private let now: () -> Int64

    public init(
        failure: TrustFailure,
        center: TrustCenter,
        username: String? = nil,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        poster: (@Sendable (String, [String: Any]) async -> Bool)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.failure = failure
        self.center = center
        self.username = username
        self.now = now
        self.signer = signer ?? { reason in try await Keystore.deriveIRK(reason: reason) }
        self.poster = poster ?? TrustOverrideViewModel.defaultPoster
    }

    /// Default transmit: POST the WIRE envelope to
    /// `<controlApex>/api/users/:u/trust-exceptions`. Best-effort → never
    /// throws; a non-2xx / network error resolves false.
    private static let defaultPoster: @Sendable (String, [String: Any]) async -> Bool = { username, envelope in
        guard let body = try? JSONSerialization.data(withJSONObject: envelope) else { return false }
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        let url = Endpoints.controlBaseUrl.appendingPathComponent("/api/users/\(encoded)/trust-exceptions")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            return (200..<300).contains(status)
        } catch {
            return false
        }
    }

    /// Sign + record the exception. Face ID fires inside `signer`.
    public func confirmOverride() async {
        phase = .signing
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await signer("Continue with an unverified Flagship control server")
        } catch {
            phase = .failed("Couldn't access your account key: \(error.localizedDescription)")
            return
        }

        let devicePub = HexUtil.encode(key.publicKey.rawRepresentation)
        let exception = TrustException(
            certClass: failure.certClass,
            certHash: failure.certHash,
            grantedAt: now(),
            grantedByDevicePub: devicePub
        )
        let signature: Data
        do {
            signature = try exception.sign(with: key)
        } catch {
            phase = .failed("Couldn't sign: \(error.localizedDescription)")
            return
        }

        let signatureHex = HexUtil.encode(signature)
        signedEnvelope = exception.envelope(signatureHex: signatureHex)
        // Record the local override FIRST so this device un-sticks even if the
        // transmit fails.
        center.recordOverride(certHash: failure.certHash)
        phase = .done

        // LOAD-BEARING FAN-OUT: transmit the WIRE envelope to `.com` so every
        // box the user owns pulls this exception and is satisfied on the same
        // cert-hash. Best-effort — a failure leaves the local override intact.
        if let username, !username.isEmpty {
            transmitted = await poster(
                username,
                exception.wireEnvelope(signatureHex: signatureHex)
            )
        }
    }
}
