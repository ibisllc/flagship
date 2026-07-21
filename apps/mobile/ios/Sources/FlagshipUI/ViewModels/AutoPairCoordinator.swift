import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Slice B — AUTO-PAIR. A control device already sees every pod via `/pods`, but
/// the box's `/api/screens/*` BFF is gated on a per-box paired-session token that
/// the app used to mint only when the owner tapped "Pair this device" on each
/// server. This coordinator makes it automatic: on app unlock, with pods loaded,
/// it derives the owner IRK ONCE (a single biometric) and, for EACH visible pod
/// that has NO stored session token, signs + POSTs an `add-paired-session` order
/// and persists the returned token — reusing `PodPairViewModel` for the exact
/// canonical bytes + idempotency guard (no new wire bytes are invented here).
///
/// - IDEMPOTENT: a pod that already has a stored token is skipped, so a fully
///   paired account triggers NO biometric (the candidate set is empty ⇒ we
///   return before deriving the IRK).
/// - SILENT: a per-pod POST failure is swallowed; the pod simply stays a
///   candidate and is retried on the next unlock.
/// - The manual "Pair this device" path (`ServerDetailContainer.onPair`) stays as
///   a fallback for the case a user wants to force a single box.
@MainActor
public final class AutoPairCoordinator {
    private let client: any LockPowerClient
    private let store: any SessionStoring
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey

    /// Guards a SUCCESSFUL derive+pair pass to once per unlock. It's only set once
    /// we actually had candidates and derived the IRK — an early return on "no
    /// candidates yet" (pods still loading) does NOT consume it, so a later pods
    /// update can still trigger the pass. Reset on re-lock via `resetForNewUnlock`.
    private var attemptedThisUnlock = false
    private var running = false

    public init(
        client: any LockPowerClient,
        store: any SessionStoring,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil
    ) {
        self.client = client
        self.store = store
        self.signer = signer ?? { reason in try await Keystore.deriveIRK(reason: reason) }
    }

    /// Call when the app re-locks so the next unlock re-runs a pass.
    public func resetForNewUnlock() {
        attemptedThisUnlock = false
    }

    /// One auto-pair pass over `pods`. Fire on unlock + when the pod list first
    /// loads; the guards make repeat calls cheap and biometric-free once done.
    public func pairVisiblePods(_ pods: [PodInfo]) async {
        guard !attemptedThisUnlock, !running else { return }
        running = true
        defer { running = false }

        // Candidate = a REGISTERED (non-pending) pod with a real FQDN and no
        // stored per-pod token. A pending pod isn't reachable yet; an already-
        // tokened pod is paired. Keyed per-pod (Fix B) exactly like PodPairVM.
        var candidates: [PodInfo] = []
        for pod in pods where pod.status != .pending && !pod.fqdn.isEmpty {
            let podId = PodInfo.podId(forFqdn: pod.fqdn)
            let existing = await store.sessionToken(forPodId: podId)
            if existing?.isEmpty ?? true { candidates.append(pod) }
        }
        // Nothing to do — DON'T consume the once-per-unlock guard: the pod list
        // may still be loading, and a later call should get a chance to pair.
        guard !candidates.isEmpty else { return }

        // ONE biometric for the whole batch: derive the owner IRK up front and
        // hand the SAME key to every per-pod PodPairViewModel via its signer seam
        // (so `deriveIRK`/Face ID fires exactly once).
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await signer("Set up this device on your servers")
        } catch {
            // User cancelled / biometric unavailable — stay silent and retry on
            // the next unlock (don't consume the guard).
            return
        }
        attemptedThisUnlock = true

        for pod in candidates {
            let vm = PodPairViewModel(
                client: client,
                store: store,
                serverDomain: pod.fqdn,
                signer: { _ in key }
            )
            await vm.pair()
            // Per-pod failure is intentionally swallowed: the pod stays untokened
            // and becomes a candidate again next unlock. Success persists the
            // token inside the VM (per-pod + active slot).
        }
    }
}
