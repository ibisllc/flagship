import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipCore

/// Drives the deliberate, biometric-gated trust OVERRIDE for one failing cert.
///
/// The owner taps a failing line in the red trust sliver → confirms → Face ID
/// (inside `signer`, exactly like `LockPowerViewModel`) → we sign a
/// `TrustException` scoped to that cert-hash with the device IRK and record the
/// override in the `TrustCenter`. Recording un-halts backend traffic for that
/// cert; the red line PERSISTS so the degraded state stays visible.
///
/// The signed envelope is also handed back so the caller can propagate it via
/// `.com`'s directory (safe: device-key-signed + cert-hash-scoped — `.com`
/// can't forge it and replaying "accept cert X" is harmless). Propagation is a
/// follow-up wire; recording the local override is what un-sticks THIS device.
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

    private let failure: TrustFailure
    private let center: TrustCenter
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64

    public init(
        failure: TrustFailure,
        center: TrustCenter,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.failure = failure
        self.center = center
        self.now = now
        self.signer = signer ?? { reason in try await Keystore.deriveIRK(reason: reason) }
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

        signedEnvelope = exception.envelope(signatureHex: HexUtil.encode(signature))
        center.recordOverride(certHash: failure.certHash)
        phase = .done
    }
}
