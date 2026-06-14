import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Diagnostics orchestrator for the server-detail screen.
///
/// Signs a `JournalRequest` with the owner IRK — the same key the daemon's
/// `/api/journal` pins — behind a biometric prompt, and POSTs it box-direct
/// over the pinned session. A read, not a mutation, but signing still needs
/// the owner key (so only the owner can read the box's logs) and `.com` never
/// sees the request or the journal.
@Observable
@MainActor
public final class JournalViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case loaded(unit: String, lines: [String])
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

    public func load(unit: String, lines: Int64) async {
        phase = .loading
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await signer("Read the journal on \(serverDomain)")
        } catch {
            phase = .failed("Couldn't access your account key: \(error.localizedDescription)")
            return
        }

        let clamped = max(1, min(JournalUnits.maxLines, lines))
        let request = JournalRequest(serverId: serverDomain, unit: unit, lines: clamped, issuedAt: now())
        let signature: Data
        do {
            signature = try request.sign(with: key)
        } catch {
            phase = .failed("Couldn't sign: \(error.localizedDescription)")
            return
        }

        do {
            let env = request.envelope(signatureHex: HexUtil.encode(signature))
            let result = try await client.readJournal(
                serverDomain: serverDomain,
                request: env["request"] as! [String: Any],
                signatureHex: env["signature"] as! String
            )
            phase = .loaded(unit: result.unit, lines: result.lines)
        } catch let e as ScreensClientError {
            phase = .failed(e.errorDescription ?? "That didn't work. Try again in a moment.")
        } catch {
            phase = .failed("Couldn't reach the box. Check your connection and try again.")
        }
    }
}
