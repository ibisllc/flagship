import Foundation
import CryptoKit
import Observation
import Flagship
import FlagshipAPI
import FlagshipCore

/// The server page's "Direct access" (docs/direct-access-and-domains.md §5, §8):
/// an admin device opts the server in (its home address becomes public in DNS),
/// then gives each app one name on the direct domain. Every change is a signed
/// sensitive order: the direct-access order goes to the box and to `.com`, a
/// name order to `.com`, which publishes exactly what was signed. Other devices
/// see the state read-only. Mirrors the webapp's `views/direct-access.js` and
/// Android's `DirectAccessViewModel.kt`.
@MainActor
@Observable
public final class DirectAccessViewModel {
    public typealias Signer = @MainActor (_ reason: String) async throws -> Curve25519.Signing.PrivateKey

    public static let warning = String(localized: "Turning this on puts this server's home IP address in public DNS. Anyone can look it up, and it stays in public DNS history even after you turn it off. The server then takes connections from the whole internet, attacks land on your home connection, and some internet providers don't allow running a server.")
    public static let adminOnly = String(localized: "Only an admin device can change direct access. This device can see it.")
    public static let otherCreator = String(localized: "This app was made by another account, so it can't have a direct name here.")

    /// One app on this server and its direct name.
    public struct Row: Identifiable, Equatable, Sendable {
        public let serviceId: String
        public let appName: String
        /// `<slug>--<creator>.<apex>`; nil when the app's creator isn't this account.
        public let fqdn: String?
        public let state: DirectNameState?
        public var id: String { serviceId }
        public var label: String? { fqdn.flatMap { DirectName.labelOf($0) } }
        public var isOn: Bool { state?.enabled == true }
    }

    /// The name settings being edited.
    public struct NameDraft: Equatable, Sendable {
        public let serviceId: String
        public let fqdn: String
        public var pinCaa: Bool
        public var addressesText: String
    }

    public let serverDomain: String
    public let username: String
    public let canManage: Bool
    public private(set) var supported = true
    public private(set) var loaded = false
    public private(set) var view: DirectAccess.View?
    public private(set) var account: DirectAccountState?
    public private(set) var apps: [AppSummary] = []
    public private(set) var busy = false
    public private(set) var error: String?
    public private(set) var notice: String?
    /// The opt-in form.
    public var editing = false
    public var addressesText = ""
    public var prefixesText = ""
    public var portText = "443"
    public var nameDraft: NameDraft?

    private let box: any ScreensClient
    private let com: any DirectNamesClient
    private let accessSigner: Signer
    private let nameSigner: Signer
    private let now: () -> Int64

    public init(
        serverDomain: String,
        username: String,
        box: any ScreensClient,
        com: any DirectNamesClient,
        canManage: Bool = Keystore.hasAdminRoot,
        accessSigner: Signer? = nil,
        nameSigner: Signer? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.serverDomain = serverDomain.lowercased()
        self.username = username.lowercased()
        self.box = box
        self.com = com
        self.canManage = canManage
        self.accessSigner = accessSigner ?? { reason in try await DebugAccessViewModel.freshSensitiveKey(reason: reason) }
        self.nameSigner = nameSigner ?? { reason in try await ServerOrderSaver.sensitiveOrderKey(reason: reason) }
        self.now = now
    }

    public var apex: String { account?.apex ?? DirectName.apex }

    /// The box's own word first; `.com`'s record when the box can't say.
    public var isOn: Bool { view?.on ?? account?.server(serverDomain)?.on ?? false }

    public var addresses: [String] { view?.addresses ?? account?.server(serverDomain)?.addresses ?? [] }
    public var prefixes: [String] { view?.prefixes ?? account?.server(serverDomain)?.prefixes ?? [] }
    public var port: Int { view?.port ?? account?.server(serverDomain)?.port ?? 443 }
    /// Where the box says it can be reached now.
    public var reported: [String] {
        if let v = view, !v.endpoints.isEmpty { return v.endpoints.map(\.address) }
        return account?.server(serverDomain)?.boxAddresses ?? []
    }

    public var rows: [Row] {
        apps.filter { $0.copying == nil }.map { a in
            let fqdn = a.creator.lowercased() == username ? DirectName.derivedName(slug: a.slug, creator: a.creator, apex: apex) : nil
            return Row(serviceId: a.serviceId, appName: a.displayName, fqdn: fqdn, state: fqdn.flatMap { account?.name($0) })
        }
    }

    public func load() async {
        do {
            view = try await box.directAccess()
        } catch ScreensClientError.notImplemented {
            supported = false
        } catch ScreensClientError.http(404, _) {
            supported = false
        } catch {
            view = nil
        }
        guard supported else { return }
        account = try? await com.state(username: username)
        apps = (try? await box.appsList().apps) ?? apps
        loaded = true
    }

    /// Open the opt-in (or change) form with what is in force.
    public func startEditing() {
        addressesText = addresses.joined(separator: "\n")
        prefixesText = prefixes.joined(separator: "\n")
        portText = String(port)
        error = nil
        notice = nil
        editing = true
    }

    /// Words of a list field, in canonical text; nil with the sentence when one isn't an address.
    static func parseAddresses(_ text: String) -> Result<[String], DirectAccessRefusal> {
        var out: [String] = []
        for w in words(text) {
            guard let c = DirectAccess.canonicalIp(w) else { return .failure(DirectAccessRefusal(status: 0, code: "bad-address")) }
            if !out.contains(c) { out.append(c) }
        }
        return .success(out.sorted())
    }

    static func parsePrefixes(_ text: String) -> Result<[String], DirectAccessRefusal> {
        var out: [String] = []
        for w in words(text) {
            guard let p = DirectAccess.parsePrefix(w) else { return .failure(DirectAccessRefusal(status: 0, code: "bad-prefix")) }
            let c = DirectAccess.formatPrefix(p)
            if !out.contains(c) { out.append(c) }
        }
        return .success(out.sorted())
    }

    private static func words(_ text: String) -> [String] {
        text.split(whereSeparator: { $0.isWhitespace || $0 == "," }).map { String($0).lowercased() }
    }

    /// Turn on, or change the addresses: sign once, send to the box, then to `.com`.
    public func saveAccess() async {
        guard canManage, !busy else { return }
        error = nil
        notice = nil
        let addrs: [String], prefs: [String]
        switch Self.parseAddresses(addressesText) {
        case .success(let a): addrs = a
        case .failure(let r): error = r.localizedDescription; return
        }
        switch Self.parsePrefixes(prefixesText) {
        case .success(let p): prefs = p
        case .failure(let r): error = r.localizedDescription; return
        }
        guard let p = Int(portText.trimmingCharacters(in: .whitespaces)) else {
            error = DirectAccessText.refusal("bad-port")
            return
        }
        let order = DirectAccess.Order(serverDomain: serverDomain, enabled: true, addresses: addrs, prefixes: prefs, port: p, issuedAt: now())
        if let why = DirectAccess.problem(order) {
            error = DirectAccessText.refusal(why)
            return
        }
        let wasOn = isOn
        if await send(order, reason: wasOn ? String(localized: "Change direct access") : String(localized: "Turn on direct access")) {
            editing = false
            notice = wasOn ? String(localized: "Saved.") : String(localized: "Direct access is on.")
        }
    }

    public func turnOff() async {
        guard canManage, !busy else { return }
        error = nil
        notice = nil
        let order = DirectAccess.Order(serverDomain: serverDomain, enabled: false, addresses: [], prefixes: [], port: port, issuedAt: now())
        if await send(order, reason: String(localized: "Turn off direct access")) {
            editing = false
            notice = String(localized: "Direct access is off.")
        }
    }

    private func send(_ order: DirectAccess.Order, reason: String) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            let key = try await accessSigner(reason)
            let signed = DirectAccess.SignedOrder(order: order, signatureHex: try DirectAccess.sign(order, key: key))
            view = try await box.setDirectAccess(signed).directAccess
            try await com.postAccessOrder(username: username, signed: signed)
            account = try? await com.state(username: username)
            return true
        } catch {
            self.error = Self.message(for: error)
            return false
        }
    }

    // MARK: names

    public func editName(_ row: Row) {
        guard let fqdn = row.fqdn else { return }
        nameDraft = NameDraft(serviceId: row.serviceId, fqdn: fqdn, pinCaa: (row.state?.caa ?? "pin") != "off",
                              addressesText: (row.state?.addresses ?? []).joined(separator: "\n"))
        error = nil
        notice = nil
    }

    /// Turn a name on with the defaults (follow this server, CAA pinned).
    public func turnOnName(_ row: Row) async {
        guard let fqdn = row.fqdn else { return }
        await sendName(DirectName.Order(name: fqdn, serverDomain: serverDomain, enabled: true, addresses: [], caa: .pin, issuedAt: now()))
    }

    public func turnOffName(_ row: Row) async {
        guard let fqdn = row.fqdn else { return }
        await sendName(DirectName.Order(name: fqdn, serverDomain: serverDomain, enabled: false, addresses: [],
                                        caa: DirectName.Caa(rawValue: row.state?.caa ?? "pin") ?? .pin, issuedAt: now()))
    }

    public func saveNameDraft() async {
        guard let d = nameDraft else { return }
        switch Self.parseAddresses(d.addressesText) {
        case .success(let addrs):
            if await sendName(DirectName.Order(name: d.fqdn, serverDomain: serverDomain, enabled: true, addresses: addrs,
                                               caa: d.pinCaa ? .pin : .off, issuedAt: now())) {
                nameDraft = nil
            }
        case .failure(let r):
            error = r.localizedDescription
        }
    }

    @discardableResult
    private func sendName(_ order: DirectName.Order) async -> Bool {
        guard canManage, !busy else { return false }
        error = nil
        notice = nil
        if let why = DirectName.problem(order, apex: apex) {
            error = DirectAccessText.refusal(why)
            return false
        }
        busy = true
        defer { busy = false }
        do {
            let key = try await nameSigner(String(localized: "Change a direct name"))
            let signed = DirectName.SignedOrder(order: order, signatureHex: try DirectName.sign(order, key: key))
            try await com.postNameOrder(username: username, signed: signed)
            account = try? await com.state(username: username)
            notice = String(localized: "Saved.")
            return true
        } catch {
            self.error = Self.message(for: error)
            return false
        }
    }

    /// The outside check. Any device of the account may run it; it changes nothing.
    public func probe(_ row: Row) async {
        guard let label = row.label, !busy else { return }
        error = nil
        notice = nil
        busy = true
        defer { busy = false }
        do {
            let p = try await com.probe(username: username, label: label)
            notice = DirectAccessText.probe(p)
            account = try? await com.state(username: username)
        } catch {
            self.error = Self.message(for: error)
        }
    }

    /// A refusal's own sentence by its code, from `.com` or the box.
    static func message(for error: Error) -> String {
        if BiometricGate.GateError.from(error) == .userCancelled { return String(localized: "Direct access wasn't changed.") }
        if let r = error as? DirectAccessRefusal { return r.localizedDescription }
        if case DirectAccessError.refused(let why) = error { return DirectAccessText.refusal(why) }
        if case ScreensClientError.http(let status, let body) = error {
            return DirectAccessRefusal(status: status, body: Data(body.utf8)).localizedDescription
        }
        return ScreensClientError.userFacing(error)
    }

    static func time(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: TimeInterval(ms) / 1000).formatted(date: .abbreviated, time: .shortened)
    }

    /// "Checked <time>: Reachable from outside."
    public static func probeLine(_ p: DirectProbe) -> String {
        guard let at = p.at else { return DirectAccessText.probe(p) }
        return String(localized: "Checked \(time(at)): \(DirectAccessText.probe(p))")
    }
}
