import Foundation
import FlagshipCore
import FlagshipAPI

/// Keeps the `LiveScreensClient`'s session store pointed at the currently
/// selected, online server's daemon.
///
/// THE BUG THIS FIXES: `podBaseUrl` was only ever meant to be written by the
/// original pairing flow — but that flow never actually called
/// `setPodBaseUrl` (the setter had zero call-sites). A server surfaced by
/// `/pods` reconciliation (`AppState.upsertRegisteredPod`) therefore had no
/// base URL, so `LiveScreensClient` threw `.notPaired` on every load even
/// though the box's daemon BFF was up and reachable. The fix is to derive
/// `podBaseUrl` from `PodInfo.fqdn` the moment we have a current online pod.
///
/// `LiveScreensClient` already authenticates every request with the
/// `x-flagship-session` token, so once the base URL is set the existing
/// signed-request path satisfies the daemon's 401 — nothing else is needed
/// to reach `/api/screens/*`.
///
/// Selection / switch / sign-out all funnel through `sync(currentPod:)`:
///   - current pod is `.online` with a non-empty fqdn → write its base URL;
///   - anything else (no server, pending-only, offline, switching away,
///     signed out) → clear it, so a stale URL never points the screens
///     client at the wrong (or a gone) server.
public enum PodSessionSync {
    /// Reconcile the store's `podBaseUrl` against the current pod.
    /// `currentPod` is the resolved `AppState.currentPod` (the selected
    /// pod, falling back to the leader). Pass `nil` to clear unconditionally
    /// (sign-out / unpaired).
    public static func sync(currentPod: PodInfo?, store: any SessionStoring) async {
        guard let pod = currentPod,
              pod.status == .online,
              !pod.fqdn.isEmpty else {
            await store.setPodBaseUrl(nil)
            return
        }
        await store.setPodBaseUrl(CompanionTicketURL.podBaseUrl(forFqdn: pod.fqdn))
    }
}
