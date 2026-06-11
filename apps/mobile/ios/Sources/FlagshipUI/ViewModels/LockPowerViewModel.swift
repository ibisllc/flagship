import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Manual lock/power-off orchestrator for the server-detail screen.
///
/// Signs a `power-off` PhoneOrder (mode "off" | "restart") with the owner
/// IRK — the same key the daemon's `/api/power` pins (on this
/// account the box's "PSK" pubkey IS the owner IRK, exactly as the webapp's
/// `add-paired-session` order is IRK-signed) — behind a biometric prompt, and
/// POSTs it box-direct over the pinned session.
///
/// SECURITY: it powers off / locks a box, so the UI gates each tap with an
/// "Are you sure?" confirm AND the biometric prompt fires inside `signer`.
@Observable
@MainActor
public final class LockPowerViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case signing
        case posting
        /// The box was told to power off / restart — the UI reflects this as
        /// "powering off…" → offline.
        case sent(PowerMode)
        case failed(String)
    }

    public private(set) var phase: Phase = .idle

    private let client: any LockPowerClient
    private let serverDomain: String
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64

    public init(
        client: any LockPowerClient,
        serverDomain: String,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.client = client
        self.serverDomain = serverDomain
        self.now = now
        self.signer = signer ?? { reason in try await Keystore.deriveIRK(reason: reason) }
    }

    public func run(mode: PowerMode) async {
        phase = .signing
        let key: Curve25519.Signing.PrivateKey
        do {
            let reason = mode == .off
                ? "Lock and turn off \(serverDomain)"
                : "Lock and restart \(serverDomain)"
            key = try await signer(reason)
        } catch {
            phase = .failed("Couldn't access your account key: \(error.localizedDescription)")
            return
        }

        let order = PowerOffOrder(serverId: serverDomain, mode: mode, issuedAt: now())
        let signature: Data
        do {
            signature = try order.sign(with: key)
        } catch {
            phase = .failed("Couldn't sign: \(error.localizedDescription)")
            return
        }

        phase = .posting
        do {
            let env = order.envelope(signatureHex: HexUtil.encode(signature))
            try await client.sendPowerOff(
                serverDomain: serverDomain,
                request: env["request"] as! [String: Any],
                signatureHex: env["signature"] as! String
            )
        } catch let e as ScreensClientError {
            phase = .failed(e.errorDescription ?? "That didn't work. Try again in a moment.")
            return
        } catch {
            phase = .failed("Couldn't reach the box. Check your connection and try again.")
            return
        }
        phase = .sent(mode)
    }
}
