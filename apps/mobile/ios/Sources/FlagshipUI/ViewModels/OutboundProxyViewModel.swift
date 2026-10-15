import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// UI copy for the outbound proxy (docs/outbound-proxy.md). Same words on the
/// webapp and Android.
public enum OutboundProxyCopy {
    public static let title = "Outbound proxy"
    public static let explainer = "Send this server's internet traffic through a proxy, so Flagship and the sites it reaches see the proxy's address instead of yours."
    public static let address = "Proxy address"
    public static let addressPlaceholder = "proxy.example.net or 192.168.1.20"
    public static let port = "Port"
    public static let username = "Username (optional)"
    public static let password = "Password (optional)"
    public static let passwordUnchanged = "Unchanged"
    public static let credentialsInRecipe = "The username and password are saved in the setup file. Only give the file to people you trust."
    public static let fallback = "If the proxy stops working, connect directly"
    public static let fallbackNote = "If this is off and the proxy stops working, the server goes offline until the proxy is back or you change it from the same network."
    public static let off = "Off"
    public static let change = "Change"
    public static let turnOff = "Turn off"
    public static let save = "Save"
    public static let confirmReason = "Confirm the proxy change"
    public static let savedOn = "Saved. The server is reconnecting through the proxy."
    public static let savedOff = "Saved. The server now connects directly."

    /// "SOCKS5 · host:port · needs a password", or "Off".
    public static func summaryLine(_ p: OutboundProxySummary.Proxy?) -> String {
        guard let p, let kind = BoxProxy.Kind(rawValue: p.kind), kind != .none else { return off }
        let host = p.host.contains(":") ? "[\(p.host)]" : p.host
        return "\(kind.label) · \(host):\(p.port)" + (p.auth ? " · needs a password" : "")
    }

    /// The status line, or nil when the box connects directly.
    public static func statusLine(_ s: OutboundProxySummary.Status) -> String? {
        switch s.state {
        case "ok": return "Working"
        case "failing": return "Not working: \(s.lastError ?? "the proxy isn't answering")"
        case "fallback": return "Using a direct connection: the proxy isn't answering"
        default: return nil
        }
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
            return "Enter a port from 1 to 65535."
        }
        if username.isEmpty && password.isEmpty { return nil }
        if username.isEmpty || password.isEmpty { return "Enter both the username and the password, or neither." }
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
    private let signer: OutboundProxySigner
    private let now: () -> Int64

    public init(serverDomain: String, summary: OutboundProxySummary?, client: any ScreensClient,
                signer: OutboundProxySigner? = nil,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.serverDomain = serverDomain
        self.summary = summary
        self.client = client
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
        defer { isSaving = false }
        let domain = (await client.boxDomain()) ?? serverDomain
        let order = BoxProxy.make(serverDomain: domain, kind: kind, host: host, port: port, auth: auth,
                                  fallbackDirect: fallbackDirect, now: now())
        let signature: String
        do {
            signature = try order.sign(with: try await signer(OutboundProxyCopy.confirmReason))
        } catch {
            errorMessage = BiometricGate.GateError.from(error) == .userCancelled
                ? "The proxy wasn't changed."
                : "Couldn't sign the change: \(error.localizedDescription)"
            return false
        }
        do {
            let r = try await client.outboundProxySet(
                OutboundProxySetRequest(proxy: order.fields, signature: signature, credentials: credentials))
            if let s = r.outboundProxy { summary = s }
            savedMessage = kind == .none ? OutboundProxyCopy.savedOff : OutboundProxyCopy.savedOn
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
