import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Combined view-model for ServiceDetailScreen. Owns the service detail
/// response, the list of FQDNs the user owns (filtered to those that
/// belong to this service), and the "Runs on" section (which servers have
/// the app, from each server's own apps list: docs/app-placement.md §4).
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

    // MARK: Internet access (egress)

    public enum EgressPhase: Equatable, Sendable {
        case idle
        case signing
        case posting
        case failed(String)
    }

    public private(set) var egressPhase: EgressPhase = .idle
    /// The box's answer to the last grant, which wins over the loaded detail.
    private var egressOverride: AppEgress?

    /// `{declared, approved}`, or nil when the box doesn't report it (older
    /// box): then the page shows nothing about it.
    public var egress: AppEgress? { egressOverride ?? detail.value?.app.egress }

    public var isChangingEgress: Bool {
        switch egressPhase {
        case .signing, .posting: return true
        default: return false
        }
    }

    /// What the page shows about the app's internet access.
    public struct EgressCard: Equatable, Sendable {
        /// Declared hosts still waiting for the owner's approval.
        public let pending: [String]
        /// Hosts the app may reach now.
        public let approved: [String]
        /// Allow / Stop access buttons (hidden on a restricted profile, which
        /// the box refuses anyway).
        public let canChange: Bool
    }

    /// Nil: nothing to show (no egress reported, or nothing declared or open).
    public static func egressCard(_ egress: AppEgress?, canChange: Bool) -> EgressCard? {
        guard let egress else { return nil }
        let pending = egress.pending
        guard !pending.isEmpty || !egress.approved.isEmpty else { return nil }
        return EgressCard(pending: pending, approved: egress.approved, canChange: canChange)
    }

    public static let egressTitle = "This app wants to reach the internet"
    public static let egressNote = "Until you allow them, the app can't reach any of these. Only allow hosts you expect this app to need."

    /// Allow one declared host (older boxes without access lists): the
    /// grant is what's open now plus this host.
    @discardableResult
    public func allowEgress(host: String) async -> Bool {
        guard let egress else { return false }
        return await sendEgress(hosts: egress.approved + [host], reason: "Allow \(displaySlug) to reach \(host)")
    }

    /// Close the app's internet access (signs an empty host list).
    @discardableResult
    public func stopEgress() async -> Bool {
        await sendEgress(hosts: [], reason: "Stop internet access for \(displaySlug)")
    }

    private var displaySlug: String { detail.value?.app.slug ?? serviceId }

    private func sendEgress(hosts: [String], reason: String) async -> Bool {
        // The box the grant goes to must find its own name in it.
        let boxDomain = await client.boxDomain()
        guard let domain = boxDomain ?? egressServerDomain, !domain.isEmpty else {
            egressPhase = .failed("No server to send this to.")
            return false
        }
        egressPhase = .signing
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await egressSigner(reason)
        } catch {
            egressPhase = .failed("Couldn't access your account key: \(error.localizedDescription)")
            return false
        }
        let grant = AppEgressGrant(serverDomain: domain, serviceId: serviceId, hosts: hosts,
                                   issuedAt: Int64(Date().timeIntervalSince1970 * 1000))
        let signature: Data
        do {
            signature = try key.signature(for: grant.canonicalBytes())
        } catch {
            egressPhase = .failed("Couldn't sign the request: \(error.localizedDescription)")
            return false
        }
        egressPhase = .posting
        do {
            let r = try await client.serviceEgressSet(
                serviceId: serviceId,
                AppEgressSetRequest(grant: grant, signature: HexUtil.encode(signature)))
            egressOverride = r.egress ?? AppEgress(declared: egress?.declared ?? [], approved: grant.hosts)
            egressPhase = .idle
            return true
        } catch {
            egressPhase = .failed(Self.egressError(error))
            return false
        }
    }

    /// The box's refusal in plain words.
    static func egressError(_ error: Error) -> String {
        guard case let ScreensClientError.http(status, _) = error else {
            return ScreensClientError.userFacing(error)
        }
        let reason = ScreensClientError.boxReason(error)
        switch status {
        case 403:
            if reason == "grant is for a different server" {
                return "This approval was for a different server. Open the app from the server it runs on and try again."
            }
            if reason == "stale grant" {
                return "Your phone's clock is too far off from the server's. Check the date and time, then try again."
            }
            return "The server didn't accept your signature. Only the account owner's phone can allow this."
        case 404: return "This app isn't installed on the server any more."
        case 409: return "A newer change is already applied. Reload the page and try again."
        case 422: return reason.map { "The app doesn't declare that host (\($0))." }
            ?? "The app doesn't declare that host."
        case 400: return reason.map { "The server refused the request: \($0)." }
            ?? ScreensClientError.plainLanguage(forStatus: status)
        default: return ScreensClientError.plainLanguage(forStatus: status)
        }
    }

    // MARK: Internet access (access list, §3a)

    /// The app's access list section, once the box reports `access` for it.
    /// Nil on an older box: then the v1 egress card shows instead.
    public private(set) var access: AppAccessController?

    /// The v1 card only when the box sends `egress` but no `access`.
    public var showsLegacyEgress: Bool { access == nil && detail.value?.app.access == nil && egress != nil }

    private func syncAccess(_ app: FlagshipAPI.AppSummary) async {
        guard app.access != nil else { access = nil; return }
        let name = app.slug.capitalized
        if access == nil {
            access = AppAccessController(serviceId: serviceId, appName: name, client: client,
                                         serverDomain: egressServerDomain, canChange: ordersCanChange,
                                         readOnlyNote: accessCanChange ? AdminOrderGate.accessList : nil,
                                         signer: egressSigner)
        } else {
            access?.setAppName(name)
        }
        await access?.load()
    }

    // MARK: API keys (docs/app-apis.md §3)

    /// The app's API keys section. Shown unless the box 404s the list.
    public private(set) var apiKeys: AppApiKeysController?

    public var showsApiKeys: Bool { apiKeys.map { !$0.isHidden } ?? false }

    private func syncApiKeys(_ app: FlagshipAPI.AppSummary) async {
        let name = app.slug.capitalized
        if apiKeys == nil {
            // Same rules as the access list: signed by the sensitive-order
            // key, for the box the client talks to, read-only when restricted.
            apiKeys = AppApiKeysController(serviceId: serviceId, appName: name, client: client,
                                           serverDomain: egressServerDomain, canChange: ordersCanChange,
                                           readOnlyNote: accessCanChange ? AdminOrderGate.apiKeys : AppApiKeysCopy.readOnlyNote,
                                           signer: egressSigner)
        } else {
            apiKeys?.setAppName(name)
        }
        await apiKeys?.load()
    }

    // MARK: Database (docs/app-apis.md §6)

    /// The app's Database entry. Owner only: nil on a restricted profile or
    /// for an app without a Postgres store; hidden when the box refuses
    /// (403) or doesn't have it (404, an older box).
    public private(set) var database: AppDatabaseController?

    /// "Back up now": the box packs the app and hands the archive to this phone.
    public private(set) var backup: AppBackupController?

    public var showsDatabase: Bool {
        guard let database, !database.isHidden else { return false }
        switch database.state {
        case .loaded, .failed: return true
        case .idle, .loading: return false
        }
    }

    /// The app holds at least one Postgres store.
    static func hasPostgres(_ d: AppDetailResponse) -> Bool {
        d.dataLayerInstances.contains { $0.store == "postgres" }
    }

    private func syncDatabase(hasPostgres: Bool) async {
        guard accessCanChange, hasPostgres else { database = nil; return }
        if database == nil { database = AppDatabaseController(serviceId: serviceId, client: client) }
        await database?.load()
    }

    // MARK: Runs on (docs/app-placement.md §4)

    /// Which of the account's servers have the app. Nil without a client
    /// factory (previews) or a known server for this page.
    public private(set) var runsOn: AppRunsOnController?

    private func syncRunsOn(_ app: FlagshipAPI.AppSummary) async {
        guard let clients, let page = serverDomain ?? egressServerDomain, !page.isEmpty else {
            runsOn = nil
            return
        }
        let name = app.slug.capitalized
        if runsOn == nil {
            runsOn = AppRunsOnController(
                serviceId: serviceId, appName: name, pods: allPods, pageFqdn: page, clients: clients,
                uninstallClient: uninstallClient, canChange: ordersCanChange,
                canUninstall: canUninstall,
                readOnlyNote: accessCanChange ? AdminOrderGate.runsOn : AppPlacementCopy.runsOnReadOnly,
                signer: egressSigner, irkSigner: irkSigner)
        } else {
            runsOn?.setAppName(name)
        }
        await runsOn?.load()
    }

    public let serviceId: String
    private let client: any ScreensClient
    /// V2 — flagshipServerClient for service-rename + service-links. Optional
    /// so test fixtures that don't care about WEB DOMAINS keep
    /// compiling against the existing (client, allPods, leader) init.
    private let server: (any FlagshipServerClient)?
    private let username: () -> String?
    private let allPods: [PodInfo]
    /// Clients bound to each of the account's servers, for "Runs on".
    private let clients: PodScreensClientFactory?
    /// Box-direct client for `DELETE /api/services/:id`. Optional + defaulted
    /// to the in-process Mock so existing test/preview construction (and the
    /// WEB-DOMAINS-only call sites) keep compiling unchanged.
    private let uninstallClient: any ServiceUninstallClient
    /// Box FQDN the service runs on — the daemon pins its owner IRK as this
    /// `serverId`. Resolved by the container from the selected/leader pod.
    private let serverDomain: String?
    /// Signs the uninstall: the admin root on an admin device (the box refuses
    /// the IRK once an admin root is pinned), behind the biometric prompt.
    private let irkSigner: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    /// Uninstalling is an admin device's alone (the box enforces it).
    public let canUninstall: Bool
    /// The sensitive-order key (admin root when held, else the owner IRK),
    /// behind Face ID; the same key Delete/Revoke sign with.
    private let egressSigner: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    /// The owner's surfaces (false on a restricted profile).
    private let accessCanChange: Bool
    /// This device may sign admin-only orders ([AdminOrderGate]): access-list
    /// answers, API keys, "Runs on" and data writes.
    public let adminOrders: Bool
    /// Access list, API keys and "Runs on" take orders from this device.
    public var ordersCanChange: Bool { accessCanChange && adminOrders }
    /// Fallback `serverDomain` for the internet grant / access list when the
    /// client can't say which box it talks to: the session pod, never the
    /// leader (the box checks the grant names itself).
    private let egressServerDomain: String?

    public init(
        serviceId: String,
        client: any ScreensClient,
        allPods: [PodInfo],
        clients: PodScreensClientFactory? = nil,
        server: (any FlagshipServerClient)? = nil,
        username: @escaping () -> String? = { nil },
        uninstallClient: (any ServiceUninstallClient)? = nil,
        serverDomain: String? = nil,
        irkSigner: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        egressSigner: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        egressServerDomain: String? = nil,
        accessCanChange: Bool = true,
        adminOrders: Bool = true,
        canUninstall: Bool = true
    ) {
        self.accessCanChange = accessCanChange
        self.adminOrders = adminOrders
        self.canUninstall = canUninstall
        self.egressServerDomain = egressServerDomain ?? serverDomain
        self.serviceId = serviceId
        self.client = client
        self.allPods = allPods
        self.clients = clients
        self.server = server
        self.username = username
        self.uninstallClient = uninstallClient ?? DefaultClients.serviceUninstall()
        self.serverDomain = serverDomain
        self.irkSigner = irkSigner ?? { reason in try await Keystore.sensitiveOrderSigningKey(reason: reason) }
        self.egressSigner = egressSigner ?? { reason in try await Keystore.sensitiveOrderSigningKey(reason: reason) }
    }

    public func load() async {
        detail = .loading
        ownedUrls = .loading
        do {
            async let d = client.appDetail(serviceId: serviceId)
            async let u = client.urlControllerOwned()
            let (di, uo) = try await (d, u)
            detail = .loaded(di)
            if backup == nil { backup = AppBackupController(serviceId: serviceId, client: client) }
            egressOverride = nil
            ownedUrls = .loaded(uo.urls.filter { $0.fqdn.contains(serviceId) })
            async let accessSync: Void = syncAccess(di.app)
            async let keysSync: Void = syncApiKeys(di.app)
            let hasPostgres = Self.hasPostgres(di)
            async let dbSync: Void = syncDatabase(hasPostgres: hasPostgres)
            async let runsOnSync: Void = syncRunsOn(di.app)
            _ = await (accessSync, keysSync, dbSync, runsOnSync)
        } catch {
            // UX-A/UX-B — plain language; a cert-pin mismatch reads as a
            // possible interception warning, not a generic network error.
            detail = .failed(ScreensClientError.userFacing(error))
            ownedUrls = .failed(ScreensClientError.userFacing(error))
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
        } catch {
            appLinks = .failed(ScreensClientError.userFacing(error))
        }
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

    /// Destructive uninstall, an admin device's alone: unlock the admin root
    /// behind the biometric prompt, sign the canonical
    /// `UninstallServiceRequest` bytes, and DELETE box-direct over the pinned
    /// pipe (`DELETE /api/services/:id`) — flagshipserver.com is never in the
    /// path. Returns `true` on a 200 so the container can pop back + refresh.
    ///
    /// The caller is expected to have just shown a confirm dialog; the key
    /// unlock here triggers the Face ID prompt (the second-factor
    /// confirmation), so no extra re-prompt is needed.
    @discardableResult
    public func uninstall() async -> Bool {
        guard canUninstall else {
            removePhase = .failed(AppPlacementCopy.adminOnlyRemove)
            return false
        }
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
}

