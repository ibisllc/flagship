import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Combined view-model for AppDetailScreen. Owns the app detail
/// response, the list of FQDNs the user owns (filtered to those that
/// belong to this app), and the local edit buffer for pod placement +
/// per-app lead pod. Save() ships the diff through `orders/send`.
@Observable
@MainActor
public final class AppDetailViewModel {
    public private(set) var detail: LoadingState<AppDetailResponse> = .idle
    public private(set) var ownedUrls: LoadingState<[OwnedUrl]> = .idle
    /// V2 — { canonical, short, instances } loaded from .com. Drives
    /// the WEB DOMAINS section that replaced the per-tab layout.
    /// `.idle` on first render; `.loading` while the network fetch is
    /// in flight; `.loaded` once .com responds (or a Replace returns).
    public private(set) var appLinks: LoadingState<AppLinksResponse> = .idle
    /// V2 — phase machine for the Replace ceremony. nil = no
    /// rename in flight; .signing → .posting → .completed/.failed.
    public private(set) var renamePhase: RenamePhase = .idle

    public enum RenamePhase: Equatable, Sendable {
        case idle
        case signing
        case posting
        case completed(displayLabel: String, shortUrl: String?)
        case failed(String)
    }

    /// Pods the app should run on (server-set). Edited locally; reset
    /// by `cancelEdits()` and persisted by `save()`.
    public var runOnPodIds: Set<String> = []
    /// Pod that gets the canonical short domain for this app. nil = use
    /// the global leader.
    public var leadPodId: String?
    /// Custom FQDNs the user has added beyond the canonical/per-pod ones.
    public var customUrls: [String] = []
    public var newCustomUrlDraft: String = ""

    public let appId: String
    private let client: any ScreensClient
    /// V2 — flagshipServerClient for app-rename + app-links. Optional
    /// so test fixtures that don't care about WEB DOMAINS keep
    /// compiling against the existing (client, allPods, leader) init.
    private let server: (any FlagshipServerClient)?
    private let username: () -> String?
    private let allPods: [PodInfo]
    private let globalLeaderPodId: String?

    public init(
        appId: String,
        client: any ScreensClient,
        allPods: [PodInfo],
        globalLeaderPodId: String?,
        server: (any FlagshipServerClient)? = nil,
        username: @escaping () -> String? = { nil }
    ) {
        self.appId = appId
        self.client = client
        self.allPods = allPods
        self.globalLeaderPodId = globalLeaderPodId
        self.server = server
        self.username = username
    }

    public var availablePods: [PodInfo] { allPods }
    public var effectiveLeadPodId: String? { leadPodId ?? globalLeaderPodId }

    public func load() async {
        detail = .loading
        ownedUrls = .loading
        do {
            async let d = client.appDetail(appId: appId)
            async let u = client.urlControllerOwned()
            let (di, uo) = try await (d, u)
            detail = .loaded(di)
            ownedUrls = .loaded(uo.urls.filter { $0.fqdn.contains(appId) })
            // Seed local edits from server state — currently we default
            // to running on the leader-only since the API doesn't yet
            // return a multi-pod policy. When the daemon contract
            // grows a `policy` block we'll seed from that instead.
            if runOnPodIds.isEmpty, let lead = globalLeaderPodId {
                runOnPodIds = [lead]
            }
        } catch {
            detail = .failed(error.localizedDescription)
            ownedUrls = .failed(error.localizedDescription)
        }
    }

    /// Verification state for each custom URL the user has added.
    /// Drives the AppDetail UI: pending shows a "Verify" CTA + the
    /// expected TXT record; verified shows a green pill.
    public var customDomainStatus: [String: VerifyCustomDomainResponse] = [:]

    public func togglePod(_ podId: String) {
        if runOnPodIds.contains(podId) { runOnPodIds.remove(podId) }
        else { runOnPodIds.insert(podId) }
        // If we deselected the lead, clear lead so the global leader
        // takes back over.
        if leadPodId == podId && !runOnPodIds.contains(podId) {
            leadPodId = nil
        }
    }

    public func verifyCustomDomain(_ fqdn: String) async {
        do {
            let r = try await client.verifyCustomDomain(.init(fqdn: fqdn))
            customDomainStatus[fqdn] = r
        } catch {
            // surface via a synthetic "failed" status so the UI shows
            // an error pill instead of staying spinning.
            customDomainStatus[fqdn] = VerifyCustomDomainResponse(
                fqdn: fqdn,
                status: .failed,
                expectedTxtRecord: "",
                observedTxtRecord: nil,
                reason: error.localizedDescription
            )
        }
    }

    public func setLead(_ podId: String) {
        runOnPodIds.insert(podId)
        leadPodId = podId
    }

    public func addCustomUrl() {
        let url = newCustomUrlDraft.trimmingCharacters(in: .whitespaces).lowercased()
        guard !url.isEmpty, !customUrls.contains(url) else { return }
        customUrls.append(url)
        newCustomUrlDraft = ""
    }

    public func removeCustomUrl(_ fqdn: String) {
        customUrls.removeAll { $0 == fqdn }
    }

    public func canonicalUrlPreview(for username: String?) -> String? {
        guard let user = username,
              case .loaded(let d) = detail else { return nil }
        return "\(d.app.slug).\(user).flagship.services"
    }

    public func perPodUrlPreview(for username: String?, podName: String) -> String {
        if case .loaded(let d) = detail, let user = username {
            return "\(d.app.slug).\(SlugUtil.slugify(podName)).\(user).flagship.services"
        }
        return ""
    }

    /// V2 — fetch the canonical / short / instances triplet from .com.
    /// Called lazily on AppDetailScreen first appearance; updated
    /// after each successful Replace.
    public func loadAppLinks() async {
        guard let server, let user = username(), !user.isEmpty else {
            // Tests / preview without a real .com fall back to the
            // legacy slug-based canonical so the view still renders
            // something useful.
            return
        }
        appLinks = .loading
        do {
            let r = try await server.getAppLinks(username: user, appId: appId)
            appLinks = .loaded(r)
        } catch {
            appLinks = .failed(error.localizedDescription)
        }
    }

    /// V2 — Replace ceremony. Signs the canonical bytes with the
    /// user's CURRENT IRK, POSTs to /api/users/:u/apps/:appId/rename,
    /// updates `appLinks` from the response on success.
    ///
    /// The caller is expected to have just shown a biometric scare
    /// sheet — the IRK derivation below uses Keystore.deriveIRK
    /// which itself triggers a Face ID prompt, providing the
    /// second-factor confirmation. A subsequent re-prompt isn't
    /// needed.
    public func renameApp(to newLabel: String) async -> Bool {
        guard let server, let user = username(), !user.isEmpty else {
            renamePhase = .failed("No active account on this device.")
            return false
        }
        let trimmed = newLabel.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else {
            renamePhase = .failed("Pick a non-empty label.")
            return false
        }
        renamePhase = .signing
        let irk: Curve25519.Signing.PrivateKey
        do {
            irk = try await Keystore.deriveIRK(reason: "Rename app URL stem")
        } catch {
            renamePhase = .failed("Couldn't access your account keys: \(error.localizedDescription)")
            return false
        }
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let canonical = AppRenameClaim.canonicalBytes(
            username: user,
            appId: appId,
            newDisplayLabel: trimmed,
            issuedAt: issuedAt,
        )
        let signature: Data
        do {
            signature = try irk.signature(for: canonical)
        } catch {
            renamePhase = .failed("Couldn't sign the rename: \(error.localizedDescription)")
            return false
        }
        renamePhase = .posting
        do {
            let resp = try await server.renameApp(
                username: user,
                appId: appId,
                body: AppRenameRequest(
                    request: .init(
                        username: user,
                        appId: appId,
                        newDisplayLabel: trimmed,
                        issuedAt: issuedAt,
                    ),
                    signature: HexUtil.encode(signature),
                ),
            )
            // Reflect the new state in appLinks without a separate
            // network round-trip.
            if let label = resp.displayLabel, let canonical = resp.canonicalUrl {
                appLinks = .loaded(AppLinksResponse(
                    appId: appId,
                    displayLabel: label,
                    canonicalUrl: canonical,
                    // Instances are re-fetched on the next loadAppLinks
                    // call; for now derive a minimal list from what
                    // we know locally. The Replace button itself
                    // triggers loadAppLinks anyway.
                    instances: (appLinks.value?.instances ?? []).map { _ in
                        AppLinkInstance(serverDomain: "", url: canonical)
                    },
                    shortUrl: resp.shortUrl,
                ))
            }
            renamePhase = .completed(displayLabel: trimmed, shortUrl: resp.shortUrl)
            // Refresh links from the server so the instances list
            // catches up with reality.
            await loadAppLinks()
            return true
        } catch ScreensClientError.http(let status, _) where status == 409 {
            renamePhase = .failed("Another app already uses that name. Pick something else.")
            return false
        } catch ScreensClientError.http(let status, _) where status == 400 {
            renamePhase = .failed("That name isn't valid — use lowercase letters, digits, or hyphens (1–40 chars).")
            return false
        } catch ScreensClientError.http(let status, _) where status == 403 {
            renamePhase = .failed("Sign-in is needed. Re-open the app and try again.")
            return false
        } catch {
            renamePhase = .failed("Couldn't rename: \(error.localizedDescription)")
            return false
        }
    }

    public func save() async throws {
        // Ship the edits as an order envelope. The shape mirrors what
        // packages/server-daemon expects for app-policy updates — a
        // signed canonical-bytes wrapper. For now, mock client accepts
        // any envelope and returns ok=true.
        let payload: [String: Any] = [
            "kind": "app-policy/v1",
            "appId": appId,
            "runOnPodIds": Array(runOnPodIds),
            "leadPodId": leadPodId as Any,
            "customUrls": customUrls
        ]
        let json = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        let envelope = json.base64EncodedString()
        _ = try await client.ordersSend(.init(envelope: envelope, kind: "app-policy/v1"))
    }
}

