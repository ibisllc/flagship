import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// UI copy for the outbound proxy (docs/outbound-proxy.md). Same words on the
/// webapp and Android.
public enum OutboundProxyCopy {
    public static let title = String(localized: "Outbound proxy")
    public static let explainer = String(localized: "Send this server's internet traffic through a proxy, so Flagship and the sites it reaches see the proxy's address instead of yours.")
    public static let address = String(localized: "Proxy address")
    public static let addressPlaceholder = "proxy.example.net or 192.168.1.20"
    public static let port = String(localized: "Port")
    public static let username = String(localized: "Username (optional)")
    public static let password = String(localized: "Password (optional)")
    public static let passwordUnchanged = String(localized: "Unchanged")
    public static let credentialsInRecipe = String(localized: "The username and password are saved in the setup file. Only give the file to people you trust.")
    public static let fallback = String(localized: "If the proxy stops working, connect directly")
    public static let fallbackNote = String(localized: "If this is off and the proxy stops working, the server goes offline until the proxy is back or you change it from the same network.")
    public static let off = String(localized: "Off")
    public static let change = String(localized: "Change")
    public static let turnOff = String(localized: "Turn off")
    public static let save = String(localized: "Save")
    public static let confirmReason = String(localized: "Confirm the proxy change")
    public static let savedOn = String(localized: "Saved. The server is reconnecting through the proxy.")
    public static let savedOff = String(localized: "Saved. The server now connects directly.")
    public static let proNote = String(localized: "An outbound proxy is part of Pro.")
    public static let seePro = String(localized: "See Pro")
    public static let proUrl = URL(string: "https://flagshipserver.com/pro")!

    /// Free accounts can't set a proxy; an unknown plan doesn't block (the box
    /// checks too, once `.com` has told it the plan).
    public static func allowed(tier: String?) -> Bool { tier != "free" }

    /// "SOCKS5 · host:port · needs a password", or "Off".
    public static func summaryLine(_ p: OutboundProxySummary.Proxy?) -> String {
        guard let p, let kind = BoxProxy.Kind(rawValue: p.kind), kind != .none else { return off }
        let host = p.host.contains(":") ? "[\(p.host)]" : p.host
        return "\(kind.label) · \(host):\(p.port)" + (p.auth ? " · needs a password" : "")
    }

    /// The status line, or nil when the box connects directly.
    public static func statusLine(_ s: OutboundProxySummary.Status) -> String? {
        switch s.state {
        case "ok": return String(localized: "Working")
        case "failing", "fallback": return alertLine(state: s.state, code: s.code)
        default: return nil
        }
    }

    /// Why the proxy fails, by the box's code (its English `lastError` is never shown).
    public static func reason(code: String?) -> String {
        switch code {
        case "auth": return String(localized: "The proxy refused the username or password.")
        case "refused": return String(localized: "The proxy refused the connection.")
        case "protocol": return String(localized: "The proxy gave an answer the server doesn't understand.")
        default: return String(localized: "Can't reach the proxy.")
        }
    }

    /// The server page's loud line: red while failing, a warning while connecting around it. Nil otherwise.
    public static func alertLine(state: String, code: String?) -> String? {
        switch state {
        case "failing": return String(localized: "The outbound proxy isn't working: \(reason(code: code))")
        case "fallback": return String(localized: "The outbound proxy isn't working, so this server is connecting directly: \(reason(code: code))")
        default: return nil
        }
    }

    public static let offlineUntilFixed = String(localized: "This server is offline until its proxy works again or you change it.")
    public static let laneSent = String(localized: "Sent. The server picks up the change within a few minutes, even while its proxy is down.")
    public static let laneNoPassword = String(localized: "Flagship never carries proxy passwords. To use a new password, change it from the same network as the server, or turn the proxy off first.")
}

/// The fallback lane through `.com` (docs/outbound-proxy.md): used when the
/// box can't be reached, for orders that carry no new password.
public enum OutboundProxyLane {
    /// Only an order without credentials: turning off, a proxy that needs no
    /// password, or the same proxy keeping the password the box holds.
    public static func allows(credentials: BoxProxyCredentials?) -> Bool { credentials == nil }

    /// The box itself didn't answer (network error or timeout, or the relay
    /// had no box to hand it to), as opposed to an HTTP answer from the box.
    public static func boxUnreachable(_ error: Error) -> Bool {
        if error is URLError { return true }
        if case .http(let status, _)? = error as? ScreensClientError, [502, 504].contains(status),
           ScreensClientError.boxReason(error) == nil { return true }
        return false
    }
}

/// Field rules shared by the create flow and the server page.
public enum OutboundProxyForm {
    public struct Failure: Error, LocalizedError, Equatable {
        public let message: String
        public init(message: String) { self.message = message }
        public var errorDescription: String? { message }
    }

    /// What's wrong with the fields, or nil. Blank credentials are allowed (no
    /// password, or keep the one the box holds).
    public static func error(kind: BoxProxy.Kind, host: String, port: String,
                             username: String, password: String) -> String? {
        guard kind != .none else { return nil }
        if let why = BoxProxy.hostError(BoxProxy.normalizeHost(host)) { return why }
        guard let p = Int(port.trimmingCharacters(in: .whitespaces)), (1...65535).contains(p) else {
            return String(localized: "Enter a port from 1 to 65535.")
        }
        if username.isEmpty && password.isEmpty { return nil }
        if username.isEmpty || password.isEmpty { return String(localized: "Enter both the username and the password, or neither.") }
        return BoxProxy.credentialsError(username: username, password: password)
    }
}

/// The sensitive-order key behind a biometric that always shows: a proxy
/// change is confirmed with Face ID / Touch ID / passcode every time.
public typealias OutboundProxySigner = @MainActor (_ reason: String) async throws -> Curve25519.Signing.PrivateKey

/// The server page's "Outbound proxy" section: what the box uses, and the
/// owner's signed changes.
@Observable
@MainActor
public final class OutboundProxyController {
    public private(set) var summary: OutboundProxySummary?
    public private(set) var isSaving = false
    public private(set) var errorMessage: String?
    public private(set) var savedMessage: String?

    // The edit sheet's fields.
    public var kind: BoxProxy.Kind = .socks5 {
        didSet {
            guard kind != oldValue else { return }
            let defaults = BoxProxy.Kind.allCases.compactMap { $0.defaultPort.map(String.init) }
            if port.isEmpty || defaults.contains(port) { port = kind.defaultPort.map(String.init) ?? "" }
        }
    }
    public var host = ""
    public var port = "1080"
    public var username = ""
    public var password = ""
    public var fallbackDirect = false

    private let serverDomain: String
    private let client: any ScreensClient
    private let lane: (any FlagshipServerClient)?
    private let signer: OutboundProxySigner
    private let now: () -> Int64
    /// The box can't be reached (its proxy keeps it offline): send through `.com` at once.
    public var boxUnreachable = false
    /// The last change went through `.com`'s lane, not to the box.
    public private(set) var sentByLane = false

    public init(serverDomain: String, summary: OutboundProxySummary?, client: any ScreensClient,
                lane: (any FlagshipServerClient)? = nil, boxUnreachable: Bool = false,
                signer: OutboundProxySigner? = nil,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.serverDomain = serverDomain
        self.summary = summary
        self.client = client
        self.lane = lane
        self.boxUnreachable = boxUnreachable
        self.signer = signer ?? Self.defaultSigner
        self.now = now
    }

    public func update(summary: OutboundProxySummary?) {
        self.summary = summary
    }

    /// The box holds a password for exactly the proxy in the fields.
    public var keepsCredentials: Bool {
        guard let p = summary?.proxy, summary?.hasCredentials == true, p.auth else { return false }
        return p.kind == kind.rawValue && p.host == BoxProxy.normalizeHost(host) && String(p.port) == port
    }

    public var fieldError: String? {
        OutboundProxyForm.error(kind: kind, host: host, port: port, username: username, password: password)
    }

    /// Fill the sheet from what the box uses now.
    public func beginEdit() {
        errorMessage = nil
        savedMessage = nil
        username = ""
        password = ""
        if let p = summary?.proxy, let k = BoxProxy.Kind(rawValue: p.kind), k != .none {
            kind = k
            host = p.host
            port = String(p.port)
            fallbackDirect = p.fallbackDirect
        } else {
            kind = .socks5
            host = ""
            port = "1080"
            fallbackDirect = false
        }
    }

    /// Sign and send the sheet's proxy. True when the box took it.
    public func save() async -> Bool {
        if kind == .none { return await turnOff() }
        if let why = fieldError {
            errorMessage = why
            return false
        }
        let typed = !(username.isEmpty && password.isEmpty)
        let auth = typed || keepsCredentials
        let creds = typed ? BoxProxyCredentials(username: username, password: password) : nil
        return await send(kind: kind, host: host, port: Int(port) ?? 0, auth: auth,
                          fallbackDirect: fallbackDirect, credentials: creds)
    }

    public func turnOff() async -> Bool {
        await send(kind: .none, host: "", port: 0, auth: false, fallbackDirect: false, credentials: nil)
    }

    private func send(kind: BoxProxy.Kind, host: String, port: Int, auth: Bool,
                      fallbackDirect: Bool, credentials: BoxProxyCredentials?) async -> Bool {
        guard !isSaving else { return false }
        isSaving = true
        errorMessage = nil
        savedMessage = nil
        sentByLane = false
        defer { isSaving = false }
        if boxUnreachable && !OutboundProxyLane.allows(credentials: credentials) {
            errorMessage = OutboundProxyCopy.laneNoPassword
            return false
        }
        let domain = boxUnreachable ? serverDomain : ((await client.boxDomain()) ?? serverDomain)
        let order = BoxProxy.make(serverDomain: domain, kind: kind, host: host, port: port, auth: auth,
                                  fallbackDirect: fallbackDirect, now: now())
        let signature: String
        do {
            signature = try order.sign(with: try await signer(OutboundProxyCopy.confirmReason))
        } catch {
            errorMessage = BiometricGate.GateError.from(error) == .userCancelled
                ? String(localized: "The proxy wasn't changed.")
                : String(localized: "Couldn't sign the change: \(error.localizedDescription)")
            return false
        }
        if boxUnreachable { return await sendByLane(order.fields, signature: signature, domain: domain) }
        do {
            let r = try await client.outboundProxySet(
                OutboundProxySetRequest(proxy: order.fields, signature: signature, credentials: credentials))
            if let s = r.outboundProxy { summary = s }
            savedMessage = kind == .none ? OutboundProxyCopy.savedOff : OutboundProxyCopy.savedOn
            return true
        } catch where OutboundProxyLane.boxUnreachable(error) && lane != nil {
            guard OutboundProxyLane.allows(credentials: credentials) else {
                errorMessage = OutboundProxyCopy.laneNoPassword
                return false
            }
            return await sendByLane(order.fields, signature: signature, domain: domain)
        } catch {
            errorMessage = Self.message(for: error)
            return false
        }
    }

    /// The same signed order to `.com`, no credentials ever.
    private func sendByLane(_ fields: BoxProxyFields, signature: String, domain: String) async -> Bool {
        guard let lane else {
            errorMessage = ScreensClientError.userFacing(URLError(.cannotConnectToHost))
            return false
        }
        do {
            try await lane.sendProxyOrderLane(serverDomain: domain, OutboundProxyLaneRequest(proxy: fields, signature: signature))
            sentByLane = true
            savedMessage = OutboundProxyCopy.laneSent
            return true
        } catch {
            errorMessage = Self.message(for: error)
            return false
        }
    }

    static func message(for error: Error) -> String {
        if let reason = ScreensClientError.boxReason(error) { return reason }
        return ScreensClientError.userFacing(error)
    }

    public static let defaultSigner: OutboundProxySigner = { reason in
        let context = try await BiometricGate().evaluateReturningContext(reason: reason)
        Keystore.cacheSessionUMK(authenticatedBy: context)
        if Keystore.hasAdminRoot { return try Keystore.adminRootKey(authenticatedBy: context) }
        if let irk = Keystore.sessionIRKIfCached() { return irk }
        return try await Keystore.deriveIRK(reason: reason)
    }
}
