import Foundation
import CryptoKit
import Observation
import Flagship
import FlagshipAPI
import FlagshipCore

/// The server page's "Debug access" (docs/recipe-delivery-and-remote-install.md
/// "Debug access"): an admin device lets one SSH key in as `debug` for 1 hour,
/// 24 hours or 7 days, renews it, or turns it off. Every change is a signed
/// order the box verifies (`flagship/debug-access/v2`, the revoke v1); other
/// devices see the state read-only. Mirrors the webapp and Android.
@MainActor
@Observable
public final class DebugAccessViewModel {
    public static let warning = "Anyone with this key can read everything on this server while it's on."
    public static let adminOnly = "Only an admin device can turn debug access on or off."

    public typealias Signer = @MainActor (_ reason: String) async throws -> Curve25519.Signing.PrivateKey

    public let serverDomain: String
    public let canManage: Bool
    public private(set) var view: DebugAccessView
    /// The pasted key (prefilled with the last one this device used here).
    public var keyText: String
    public var duration: DebugAccess.Duration = .oneDay
    public private(set) var busy = false
    public private(set) var error: String?
    public private(set) var notice: String?

    private let client: any ScreensClient
    private let signer: Signer
    private let now: () -> Int64
    private let defaults: UserDefaults
    private let onChanged: () async -> Void

    public init(
        serverDomain: String,
        view: DebugAccessView?,
        client: any ScreensClient,
        canManage: Bool = GymSeams.forceAdminRoot || Keystore.hasAdminRoot,
        signer: Signer? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        defaults: UserDefaults = .standard,
        onChanged: @escaping () async -> Void = {}
    ) {
        self.serverDomain = serverDomain
        self.view = view ?? .off
        self.client = client
        self.canManage = canManage
        self.signer = signer ?? { reason in try await ServerOrderSaver.sensitiveOrderKey(reason: reason) }
        self.now = now
        self.defaults = defaults
        self.onChanged = onChanged
        self.keyText = defaults.string(forKey: Self.keyDefaultsKey(serverDomain)) ?? ""
    }

    static func keyDefaultsKey(_ domain: String) -> String { "flagship.debugAccess.key.\(domain.lowercased())" }

    /// The box sent a newer server-detail.
    public func adopt(_ v: DebugAccessView?) {
        view = v ?? .off
    }

    public var isOn: Bool {
        guard view.on, let e = view.expiresAt else { return false }
        return e > now()
    }

    /// "Debug access is on until <time>." or nil when off.
    public var bannerText: String? {
        guard isOn, let e = view.expiresAt else { return nil }
        return Self.banner(expiresAt: e)
    }

    public static func banner(expiresAt: Int64) -> String {
        "Debug access is on until \(time(expiresAt))."
    }

    static func time(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: TimeInterval(ms) / 1000).formatted(date: .abbreviated, time: .shortened)
    }

    /// Turn on, or renew with a new end time (and maybe a new key).
    public func turnOn() async {
        guard canManage, !busy else { return }
        error = nil
        notice = nil
        let grant: DebugAccess.Grant
        do {
            grant = try DebugAccess.makeGrant(serverDomain: serverDomain, rawKey: keyText,
                                              issuedAt: now(), duration: duration.ms)
        } catch {
            self.error = error.localizedDescription
            return
        }
        busy = true
        defer { busy = false }
        do {
            let key = try await signer(isOn ? "Renew debug access" : "Turn on debug access")
            let body = DebugAccess.envelopeJSON(grant, signatureHex: try DebugAccess.sign(grant, key: key))
            let r = try await client.debugAccessGrant(body: body)
            view = r.debugAccess
            defaults.set(grant.sshPublicKey, forKey: Self.keyDefaultsKey(serverDomain))
            keyText = grant.sshPublicKey
            notice = r.debugAccess.expiresAt.map(Self.banner) ?? "Debug access is on."
            await onChanged()
        } catch {
            self.error = Self.message(for: error)
        }
    }

    public func turnOff() async {
        guard canManage, !busy else { return }
        error = nil
        notice = nil
        busy = true
        defer { busy = false }
        do {
            let revoke = DebugAccess.Revoke(serverDomain: serverDomain, issuedAt: now())
            let key = try await signer("Turn off debug access")
            let body = DebugAccess.revokeJSON(revoke, signatureHex: try DebugAccess.sign(revoke, key: key))
            let r = try await client.debugAccessRevoke(body: body)
            view = r.debugAccess
            notice = "Debug access is off."
            await onChanged()
        } catch {
            self.error = Self.message(for: error)
        }
    }

    /// The box's own sentence when it sent one.
    static func message(for error: Error) -> String {
        if BiometricGate.GateError.from(error) == .userCancelled { return "Debug access wasn't changed." }
        if case ScreensClientError.http(_, let body) = error,
           let data = body.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let e = obj["error"] as? String, !e.isEmpty {
            return e
        }
        if let r = error as? DebugAccess.Refusal { return r.localizedDescription }
        return ScreensClientError.userFacing(error)
    }
}
