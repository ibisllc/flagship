import Foundation
import FlagshipCore
import FlagshipAPI

/// Keeps the `LiveScreensClient`'s session store pointed at the pod whose
/// surface is being shown — its deterministic base URL AND its per-pod
/// session token.
///
/// THE BUG THIS FIXES (Fix B, multi-pod): the store used to hold ONE global
/// `podBaseUrl` derived from the single resolved `currentPod`, and ONE active
/// session-token slot. Opening any non-anchor pod's authenticated detail
/// therefore borrowed the WRONG base URL + token → a perpetual "Connecting…".
/// Now:
///   - The base URL is DETERMINISTIC from the pod's fqdn (`https://<fqdn>`),
///     so opening pod X targets X directly — no single-global-anchor dependency.
///   - The active session-token slot is set from the POD-KEYED token store
///     (`sessionToken(forPodId:)`). A pod with no stored token activates with a
///     nil token, so the BFF 401s → "pair this device with this server" — it
///     NEVER borrows another pod's token.
///
/// `LiveScreensClient` still reads the single active `podBaseUrl` /
/// `sessionToken` slots, so the per-pod store is transparent to it.
///
/// Selection / switch / sign-out funnel through `sync(currentPod:)`:
///   - a pod with a non-empty fqdn (any reachability) → target its base URL +
///     activate its token (the detail screen renders the honest state — offline
///     / coming-up / connecting — from the pod's liveness + the load result);
///   - pending-only / no-fqdn / nil (signed out) → clear both, so a stale URL
///     or another pod's token never points the screens client at the wrong box.
public enum PodSessionSync {
    /// Reconcile the store's active slots against `currentPod`. Pass `nil` to
    /// clear unconditionally (sign-out / unpaired).
    public static func sync(currentPod: PodInfo?, store: any SessionStoring) async {
        guard let pod = currentPod,
              pod.status != .pending,
              !pod.fqdn.isEmpty else {
            // No reachable target — clear the active base URL + token. (The
            // per-pod token store is untouched: a pod keeps its token for when
            // it's selected again.)
            await store.activatePod(nil, baseUrl: nil)
            return
        }
        let podId = PodInfo.podId(forFqdn: pod.fqdn)
        // Best-effort: attribute a legacy single token to this pod the first
        // time it's activated (migration for the pre-Fix-B single-slot world).
        await store.migrateSingleTokenToPod(podId)
        let baseUrl = CompanionTicketURL.podBaseUrl(forFqdn: pod.fqdn)
        await store.activatePod(podId, baseUrl: baseUrl)
    }
}
