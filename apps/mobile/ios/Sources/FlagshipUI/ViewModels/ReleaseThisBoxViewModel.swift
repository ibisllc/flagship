import Foundation
import CryptoKit
import Observation
import Flagship
import FlagshipAPI
import FlagshipCore

/// "Release this box" on a retail box's server page (docs/retail-box-setup.md §8.2): the admin
/// root signs `flagship/box-release/v1` after a fresh Face ID, with its hybrid signature when the
/// account has a strict server, and the box wipes itself back to unclaimed. Admin devices only.
@MainActor
@Observable
public final class ReleaseThisBoxViewModel {
    public static let warning = String(localized: "Releasing wipes everything on this box: its apps, their data and its keys. It can't be undone. The box goes back to new, ready for its next owner.")
    public static let suggestion = String(localized: "To keep your data, make a backup first, or transfer the server to its new owner instead.")
    public static let adminOnly = String(localized: "Only an admin device of this account can release this box.")

    public typealias Signer = @MainActor (_ reason: String) async throws -> Curve25519.Signing.PrivateKey
    public typealias PqSigner = @MainActor (_ canonical: Data, _ key: Curve25519.Signing.PrivateKey) async -> PqSignatureWire?

    public let serverDomain: String
    public let username: String
    public let stkPubHex: String
    public let canRelease: Bool
    public private(set) var busy = false
    public private(set) var released = false
    public private(set) var error: String?

    private let client: any ScreensClient
    private let signer: Signer
    private let pqSigner: PqSigner
    private let now: () -> Int64

    public init(
        serverDomain: String,
        username: String,
        stkPubHex: String,
        client: any ScreensClient,
        canRelease: Bool = Keystore.hasAdminRoot,
        signer: Signer? = nil,
        pqSigner: PqSigner? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.serverDomain = serverDomain
        self.username = username
        self.stkPubHex = stkPubHex
        self.client = client
        self.canRelease = canRelease
        self.signer = signer ?? { reason in
            let context = try await BiometricGate().evaluateReturningContext(reason: reason)
            return try Keystore.adminRootKey(authenticatedBy: context)
        }
        self.pqSigner = pqSigner ?? { canonical, key in
            guard QuantumSafetyService.anyStrict(username: username) else { return nil }
            return await QuantumSafetyService.pqSignature(canonical: canonical, edKey: key, role: .adminRoot, username: username)
        }
        self.now = now
    }

    public func release() async {
        guard canRelease, !busy, !released else { return }
        error = nil
        busy = true
        defer { busy = false }
        do {
            let order = ReleaseThisBox.make(serverDomain: serverDomain, stkPubHex: stkPubHex, issuedAt: now())
            let key = try await signer(String(localized: "Release \(serverDomain)"))
            let sig = try ReleaseThisBox.sign(order, adminRoot: key)
            let pq = await pqSigner(try ReleaseThisBox.canonicalBytes(order), key)
            try await client.releaseBox(body: ReleaseThisBox.bodyJSON(order, signatureHex: sig, pqSuite: pq?.suite, pqSignature: pq?.signature))
            released = true
        } catch {
            self.error = Self.message(for: error)
        }
    }

    static func message(for error: Error) -> String {
        if BiometricGate.GateError.from(error) == .userCancelled { return String(localized: "The box wasn't released.") }
        if case ScreensClientError.http(_, let body) = error,
           let obj = try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any],
           let code = (obj["code"] as? String) ?? (obj["error"] as? String), code.hasPrefix("release-") {
            return ReleaseThisBox.refusal(code)
        }
        return ScreensClientError.userFacing(error)
    }
}
