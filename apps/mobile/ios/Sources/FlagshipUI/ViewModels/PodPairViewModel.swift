import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Pairs THIS device with a server's box so the `/api/screens/*` BFF (the whole
/// server-detail / services / vibe surface) becomes reachable.
///
/// The BFF is gated on a paired-session token in the `x-flagship-session`
/// header; the app never minted one (only tests called `setSessionToken`), so a
/// live-client build left every server page stuck on "Connecting to your
/// server…". This is the iOS mirror of the webapp's `lib/podPair.js`:
///
///   1. generate a fresh 32-byte hex token,
///   2. build + OWNER-IRK-sign an `add-paired-session` order (biometric
///      `deriveIRK`),
///   3. POST `{request, signature}` to `<podBaseUrl>/api/orders-from-user`
///      over the box's pinned session,
///   4. on HTTP 200, persist the token via `setSessionToken` so the BFF auths.
///
/// IDEMPOTENT by default: if the store already holds a session token, `pair()`
/// no-ops. A caller that received a 401 from the box can explicitly replace the
/// rejected token. The biometric fires ONCE per genuine pairing, inside
/// `signer`; the trigger UI must fire `pair()` once per tap (never in a loop).
@Observable
@MainActor
public final class PodPairViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        /// Already paired — `setSessionToken` had a token, so we did nothing.
        case alreadyPaired
        case signing
        case posting
        /// Pairing succeeded; the token is persisted and the caller should
        /// reload the BFF.
        case paired
        case failed(String)
    }

    public private(set) var phase: Phase = .idle

    private let client: any LockPowerClient
    private let store: any SessionStoring
    private let serverDomain: String
    private let label: String
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64
    private let makeToken: () -> String

    public init(
        client: any LockPowerClient,
        store: any SessionStoring,
        serverDomain: String,
        label: String = "iPhone",
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        makeToken: @escaping () -> String = { AddPairedSessionOrder.freshToken() }
    ) {
        self.client = client
        self.store = store
        self.serverDomain = serverDomain
        // The canonical bytes are `|`-separated and the daemon re-derives them
        // under `legacyFieldGuard` (which rejects '|' + control chars), so a
        // device name carrying either would fail verification. Strip them so
        // any `UIDevice.current.name` pairs cleanly; fall back to "iPhone".
        let cleaned = label
            .components(separatedBy: CharacterSet(charactersIn: "|").union(.controlCharacters))
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        self.label = cleaned.isEmpty ? "iPhone" : cleaned
        self.now = now
        self.makeToken = makeToken
        self.signer = signer ?? { reason in try await Keystore.deriveIRK(reason: reason) }
    }

    /// Perform one pairing attempt, advancing `phase` to `.paired` /
    /// `.alreadyPaired` / `.failed`. Fire it once per user tap — the biometric
    /// fires inside `signer`, so never call this in a loop or on appearance.
    public func pair(replacingExistingToken: Bool = false) async {
        // Idempotency — a token already stored FOR THIS POD means this device is
        // paired with this box; do nothing (no re-pair, no biometric). Keyed
        // per-pod (Fix B) so pairing a 2nd box isn't short-circuited by the 1st
        // box's token sitting in the active slot.
        let podId = PodInfo.podId(forFqdn: serverDomain)
        if !replacingExistingToken,
           let existing = await store.sessionToken(forPodId: podId),
           !existing.isEmpty {
            phase = .alreadyPaired
            return
        }

        phase = .signing
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await signer("Pair this device with \(serverDomain)")
        } catch {
            phase = .failed("Couldn't access your account key: \(error.localizedDescription)")
            return
        }

        let token = makeToken()
        let order = AddPairedSessionOrder(
            serverId: serverDomain,
            token: token,
            label: label,
            issuedAt: now()
        )
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
            try await client.pairSession(
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

        // Only persist after the box accepted the order — a token the daemon
        // never stored would auth nothing and would defeat the idempotency
        // guard above on the retry. Persist under THIS pod's id (Fix B) so a
        // 2nd box's pairing never overwrites the 1st box's token, AND mirror it
        // into the active slot so the just-paired box's BFF auths immediately.
        await store.setSessionToken(token, forPodId: podId)
        await store.setSessionToken(token)
        phase = .paired
    }
}
