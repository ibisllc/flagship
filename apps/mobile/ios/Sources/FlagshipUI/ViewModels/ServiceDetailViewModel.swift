import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Combined view-model for ServiceDetailScreen. Owns the service detail
/// response, the list of FQDNs the user owns (filtered to those that
/// belong to this service), and the local edit buffer for pod placement +
/// per-service lead pod. Save() ships the diff through `orders/send`.
@Observable
@MainActor
public final class ServiceDetailViewModel {
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

    /// Phase machine for the destructive Remove-service ceremony. The button
    /// shows a spinner + disables while `.signing`/`.posting`; the container
    /// pops back + refreshes the list on `.completed`, toasts on `.failed`.
    public private(set) var removePhase: RemovePhase = .idle

    public enum RemovePhase: Equatable, Sendable {
        case idle
        case signing
        case posting
        case completed
        case failed(String)
    }

    public var isRemoving: Bool {
        switch removePhase {
        case .signing, .posting: return true
        default: return false
        }
    }

    /// Pods the service should run on (server-set). Edited locally; reset
    /// by `cancelEdits()` and persisted by `save()`.
    public var runOnPodIds: Set<String> = []
    /// Pod that gets the canonical short domain for this service. nil = use
    /// the global leader.
    public var leadPodId: String?
    /// Draft in the "Set custom domain" field.
    public var customDomainDraft: String = ""
    /// One-at-a-time alert that drives the set-custom-domain flow.
    public var customDomainPrompt: CustomDomainPrompt?
    /// Client-side rate limit: after a successful set, the user must
    /// wait until this instant before changing again. The server also
    /// enforces it (lastChanged column) — this is just the UX mirror.
    public var customDomainCooldownUntil: Date?
    /// Cooldown after a successful custom-domain change.
    public static let customDomainCooldown: TimeInterval = 300
    /// The bound external domain, sourced from the links bundle so the
    /// detail screen and the services list agree. A Replace never clears it.
    public var customDomain: String? { appLinks.value?.customDomain }

    public let serviceId: String
    private let client: any ScreensClient
    /// V2 — flagshipServerClient for service-rename + service-links. Optional
    /// so test fixtures that don't care about WEB DOMAINS keep
    /// compiling against the existing (client, allPods, leader) init.
    private let server: (any FlagshipServerClient)?
    private let username: () -> String?
    private let allPods: [PodInfo]
    private let globalLeaderPodId: String?
    /// Box-direct client for `DELETE /api/services/:id`. Optional + defaulted
    /// to the in-process Mock so existing test/preview construction (and the
    /// WEB-DOMAINS-only call sites) keep compiling unchanged.
    private let uninstallClient: any ServiceUninstallClient
    /// Box FQDN the service runs on — the daemon pins its owner IRK as this
    /// `serverId`. Resolved by the container from the selected/leader pod.
    private let serverDomain: String?
    /// Derives the owner IRK behind the biometric prompt. Injected so tests
    /// can supply a deterministic key; production uses `Keystore.deriveIRK`.
    private let irkSigner: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey

    public init(
        serviceId: String,
        client: any ScreensClient,
        allPods: [PodInfo],
        globalLeaderPodId: String?,
        server: (any FlagshipServerClient)? = nil,
        username: @escaping () -> String? = { nil },
        uninstallClient: (any ServiceUninstallClient)? = nil,
        serverDomain: String? = nil,
        irkSigner: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil
    ) {
        self.serviceId = serviceId
        self.client = client
        self.allPods = allPods
        self.globalLeaderPodId = globalLeaderPodId
        self.server = server
        self.username = username
        self.uninstallClient = uninstallClient ?? MockServiceUninstallClient()
        self.serverDomain = serverDomain
        self.irkSigner = irkSigner ?? { reason in try await Keystore.deriveIRK(reason: reason) }
    }

    public var availablePods: [PodInfo] { allPods }
    public var effectiveLeadPodId: String? { leadPodId ?? globalLeaderPodId }

    public func load() async {
        detail = .loading
        ownedUrls = .loading
        do {
            async let d = client.appDetail(serviceId: serviceId)
            async let u = client.urlControllerOwned()
            let (di, uo) = try await (d, u)
            detail = .loaded(di)
            ownedUrls = .loaded(uo.urls.filter { $0.fqdn.contains(serviceId) })
            // Seed local edits from server state — currently we default
            // to running on the leader-only since the API doesn't yet
            // return a multi-pod policy. When the daemon contract
            // grows a `policy` block we'll seed from that instead.
            if runOnPodIds.isEmpty, let lead = globalLeaderPodId {
                runOnPodIds = [lead]
            }
        } catch {
            // UX-A/UX-B — plain language; a cert-pin mismatch reads as a
            // possible interception warning, not a generic network error.
            detail = .failed(ScreensClientError.userFacing(error))
            ownedUrls = .failed(ScreensClientError.userFacing(error))
        }
    }

    public func togglePod(_ podId: String) {
        if runOnPodIds.contains(podId) { runOnPodIds.remove(podId) }
        else { runOnPodIds.insert(podId) }
        // If we deselected the lead, clear lead so the global leader
        // takes back over.
        if leadPodId == podId && !runOnPodIds.contains(podId) {
            leadPodId = nil
        }
    }

    public func setLead(_ podId: String) {
        runOnPodIds.insert(podId)
        leadPodId = podId
    }

    /// One-at-a-time alert for the set-custom-domain flow.
    public struct CustomDomainPrompt: Identifiable {
        public let id = UUID()
        public let title: String
        public let message: String
        /// When set, the alert shows this button + a Cancel. When nil,
        /// the alert is informational (single dismiss button).
        public let confirmTitle: String?
        public let destructive: Bool
        public let onConfirm: (() -> Void)?
    }

    /// Validates the draft and either raises an explanatory alert or
    /// issues the binding order. `rootDomain` is the user's stub
    /// (`<user>.flagship.services`) shown in the CNAME guidance.
    public func submitCustomDomain(rootDomain: String) async {
        let fqdn = customDomainDraft
            .trimmingCharacters(in: .whitespaces)
            .lowercased()
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !fqdn.isEmpty else { return }

        // Rate limit (client mirror of the server's lastChanged).
        if let until = customDomainCooldownUntil, until > Date() {
            return
        }

        // (a) Apex / no subdomain — fewer than 3 labels means there's
        // no subdomain to CNAME (example.com). Offer the www form.
        // Structural (not a DNS check) so it stays instant + local.
        if fqdn.split(separator: ".").count < 3 {
            let suggested = "www.\(fqdn)"
            customDomainPrompt = CustomDomainPrompt(
                title: "Subdomains only",
                message: "This only supports subdomains — an apex like \(fqdn) can't take a CNAME. Use \(suggested)?",
                confirmTitle: "Use \(suggested)",
                destructive: false,
                onConfirm: { [weak self] in
                    guard let self else { return }
                    self.customDomainDraft = suggested
                    Task { await self.submitCustomDomain(rootDomain: rootDomain) }
                }
            )
            return
        }

        // No phone-side CNAME check: the server re-validates
        // authoritatively anyway, so the phone takes the claim at
        // face value and lets the binding POST test it. A failed
        // CNAME comes back as the POST error below.

        // (b) Replacing an existing binding — confirm first. The swap
        // is destructive and irreversible: this device drops its memory
        // of the old domain immediately, even if the new one never
        // confirms (there's no "forget a domain" affordance otherwise).
        if let existing = customDomain, existing != fqdn {
            customDomainPrompt = CustomDomainPrompt(
                title: "Replace custom domain?",
                message: "This will permanently replace the current custom domain (\(existing)). It can't be undone, even if the new one fails to verify.",
                confirmTitle: "Replace",
                destructive: true,
                onConfirm: { [weak self] in
                    Task { await self?.bindCustomDomain(fqdn) }
                }
            )
            return
        }

        // (c) Clean path — issue the request. Request is DECOUPLED
        // from confirmation: a 200 only means "recorded, .com will
        // verify the CNAME out-of-band and push the outcome later".
        await bindCustomDomain(fqdn)
    }

    private func bindCustomDomain(_ fqdn: String) async {
        guard let server, let user = username(), !user.isEmpty else { return }
        // IRK-sign the canonical attach bytes (mirrors renameApp). The
        // Keystore.deriveIRK call triggers the Face ID prompt that is
        // the second-factor confirmation; the .com verifier checks this
        // signature against the account IRK before recording the order.
        let irk: Curve25519.Signing.PrivateKey
        do {
            irk = try await Keystore.deriveIRK(reason: "Attach a custom domain")
        } catch {
            customDomainPrompt = CustomDomainPrompt(
                title: "Couldn't request custom domain",
                message: "Couldn't access your account keys: \(error.localizedDescription)",
                confirmTitle: nil, destructive: false, onConfirm: nil
            )
            return
        }
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let canonical = SetCustomDomainClaim.canonicalBytes(
            username: user, serviceId: serviceId, fqdn: fqdn, issuedAt: issuedAt,
        )
        let signature: Data
        do {
            signature = try irk.signature(for: canonical)
        } catch {
            customDomainPrompt = CustomDomainPrompt(
                title: "Couldn't request custom domain",
                message: "Couldn't sign the request: \(error.localizedDescription)",
                confirmTitle: nil, destructive: false, onConfirm: nil
            )
            return
        }
        do {
            // 200 = recorded (NOT yet confirmed). We optimistically
            // surface the domain; the set/fail outcome arrives later
            // as a pushed alert (server backend, task #79). No
            // pending/unconfirmed state in the UI by design.
            let r = try await server.setCustomDomain(
                username: user,
                serviceId: serviceId,
                body: SetCustomDomainRequest(
                    request: .init(
                        username: user,
                        serviceId: serviceId,
                        fqdn: fqdn,
                        issuedAt: issuedAt,
                    ),
                    signature: HexUtil.encode(signature),
                ),
            )
            appLinks = .loaded(r)
            customDomainDraft = ""
            recordCustomDomainChangeLocally()
        } catch {
            // Non-200 is the ONLY synchronous denial — rate-limit or
            // server-busy, never a CNAME verdict (that's async). Show
            // the server's reason verbatim.
            customDomainPrompt = CustomDomainPrompt(
                title: "Couldn't request custom domain",
                message: error.localizedDescription,
                confirmTitle: nil,
                destructive: false,
                onConfirm: nil
            )
        }
    }

    /// V2 — fetch the canonical / short / instances triplet from .com.
    /// Called lazily on ServiceDetailScreen first appearance; updated
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
            let r = try await server.getAppLinks(username: user, serviceId: serviceId)
            appLinks = .loaded(r)
            // Rebuild the countdown from the on-device timestamp so it
            // survives an app reload / VM recreation. The server keeps
            // its own rate-limit timer and is the real backstop (429);
            // we don't ask it for this simple numeric field.
            restoreCooldownFromLocal()
        } catch {
            appLinks = .failed(ScreensClientError.userFacing(error))
        }
    }

    private var cdLastChangedKey: String {
        "flagship.customDomain.lastChanged.\(serviceId)"
    }

    /// Persist the request time on-device + start the local cooldown.
    private func recordCustomDomainChangeLocally() {
        UserDefaults.standard.set(
            Date().timeIntervalSince1970, forKey: cdLastChangedKey
        )
        customDomainCooldownUntil = Date()
            .addingTimeInterval(Self.customDomainCooldown)
    }

    /// Reconstruct the cooldown from the on-device timestamp (no
    /// network). Lost local state just means the server 429s instead.
    private func restoreCooldownFromLocal() {
        let ts = UserDefaults.standard.double(forKey: cdLastChangedKey)
        guard ts > 0 else { return }
        let until = Date(timeIntervalSince1970: ts + Self.customDomainCooldown)
        customDomainCooldownUntil = until > Date() ? until : nil
    }

    /// V2 — Replace ceremony. Signs the canonical bytes with the
    /// user's CURRENT IRK, POSTs to /api/users/:u/apps/:serviceId/rename,
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
            irk = try await Keystore.deriveIRK(reason: "Rename service URL stem")
        } catch {
            renamePhase = .failed("Couldn't access your account keys: \(error.localizedDescription)")
            return false
        }
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let canonical = ServiceRenameClaim.canonicalBytes(
            username: user,
            serviceId: serviceId,
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
                serviceId: serviceId,
                body: AppRenameRequest(
                    request: .init(
                        username: user,
                        serviceId: serviceId,
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
                    serviceId: serviceId,
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
            renamePhase = .failed("Another service already uses that name. Pick something else.")
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

    /// Destructive uninstall. Mirrors the env-Save / front-page ceremony: derive
    /// the owner IRK behind the biometric prompt, sign the canonical
    /// `UninstallServiceRequest` bytes, and DELETE box-direct over the pinned
    /// pipe (`DELETE /api/services/:id`) — flagshipserver.com is never in the
    /// path. Returns `true` on a 200 so the container can pop back + refresh.
    ///
    /// The caller is expected to have just shown a confirm dialog; the IRK
    /// derivation here triggers the Face ID prompt (the second-factor
    /// confirmation), so no extra re-prompt is needed.
    @discardableResult
    public func uninstall() async -> Bool {
        // The owner IRK is pinned to a SPECIFIC box (`serverId`); without
        // knowing which box runs this service we can't sign a verifiable order.
        guard let domain = serverDomain, !domain.isEmpty else {
            removePhase = .failed("No server to remove this from.")
            return false
        }
        // Prefer the authoritative creator/slug from the loaded detail; fall
        // back to splitting the serviceId on the `--` delimiter (both halves
        // may carry single dashes — mirrors composeServiceId / parseServiceId,
        // docs/service-addressing-double-dash.md).
        let creator: String
        let slug: String
        if let app = detail.value?.app {
            creator = app.creator
            slug = app.slug
        } else if let delim = serviceId.range(of: "--") {
            creator = String(serviceId[..<delim.lowerBound])
            slug = String(serviceId[delim.upperBound...])
        } else {
            removePhase = .failed("Couldn't identify the service to remove.")
            return false
        }

        removePhase = .signing
        let irk: Curve25519.Signing.PrivateKey
        do {
            irk = try await irkSigner("Remove \(slug)")
        } catch {
            removePhase = .failed("Couldn't access your account key: \(error.localizedDescription)")
            return false
        }
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let order = UninstallServiceOrder(
            serverId: domain, creator: creator, slug: slug, issuedAt: issuedAt,
        )
        let signature: Data
        do {
            signature = try order.sign(with: irk)
        } catch {
            removePhase = .failed("Couldn't sign the request: \(error.localizedDescription)")
            return false
        }

        removePhase = .posting
        do {
            let env = order.envelope(signatureHex: HexUtil.encode(signature))
            try await uninstallClient.uninstallService(
                serverDomain: domain,
                serviceId: serviceId,
                request: env["request"] as! [String: Any],
                signatureHex: env["signature"] as! String,
            )
            removePhase = .completed
            return true
        } catch let e as ScreensClientError {
            removePhase = .failed(e.errorDescription ?? "That didn't work. Try again in a moment.")
            return false
        } catch {
            removePhase = .failed("Couldn't reach the box. Check your connection and try again.")
            return false
        }
    }

    public func save() async throws {
        // Ship the edits as an order envelope. The shape mirrors what
        // packages/server-daemon expects for service-policy updates — a
        // signed canonical-bytes wrapper. For now, mock client accepts
        // any envelope and returns ok=true.
        let payload: [String: Any] = [
            "kind": "service-policy/v1",
            "serviceId": serviceId,
            "runOnPodIds": Array(runOnPodIds),
            "leadPodId": leadPodId as Any,
            "customDomain": customDomain as Any
        ]
        let json = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        let envelope = json.base64EncodedString()
        _ = try await client.ordersSend(.init(envelope: envelope, kind: "service-policy/v1"))
    }
}

