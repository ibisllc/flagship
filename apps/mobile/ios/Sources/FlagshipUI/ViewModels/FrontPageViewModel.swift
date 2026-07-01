import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Owner-assignable apex ("front page") orchestrator for the server-detail
/// screen. Loads the current assignment + the installed services (both
/// unauthenticated box reads), then signs a `set-front-page` PhoneOrder with
/// the owner IRK — the same key `/api/power` pins — behind a biometric
/// prompt, and POSTs it box-direct over the pinned session.
@Observable
@MainActor
public final class FrontPageViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case signing
        case posting
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    /// Assigned service url-label; nil = default Flagship page.
    public private(set) var current: String?
    /// Whether `current` still resolves to an installed service.
    public private(set) var currentActive = true
    public private(set) var options: [FrontPageOption] = []

    private let client: any FrontPageClient
    private let serverDomain: String
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64

    public init(
        client: any FrontPageClient,
        serverDomain: String,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.client = client
        self.serverDomain = serverDomain
        self.now = now
        // Slice D — set-front-page is a SENSITIVE order: sign with the admin
        // master root when this device holds one, else the legacy owner IRK.
        self.signer = signer ?? { reason in try await Keystore.sensitiveOrderSigningKey(reason: reason) }
    }

    public func load() async {
        phase = .loading
        do {
            async let state = client.getFrontPage(serverDomain: serverDomain)
            async let opts = client.listFrontPageOptions(serverDomain: serverDomain)
            let (s, o) = try await (state, opts)
            current = s.label
            currentActive = s.label == nil || s.active
            options = o
            phase = .ready
        } catch {
            phase = .failed("Couldn't reach the box to load front-page settings.")
        }
    }

    /// Assign `label` (or "" to restore the default page).
    public func save(label: String) async {
        phase = .signing
        let key: Curve25519.Signing.PrivateKey
        do {
            let reason = label.isEmpty
                ? "Reset the front page of \(serverDomain)"
                : "Set the front page of \(serverDomain) to \(label)"
            key = try await signer(reason)
        } catch {
            phase = .failed("Couldn't access your account key: \(error.localizedDescription)")
            return
        }

        let order = SetFrontPageOrder(serverId: serverDomain, label: label, issuedAt: now())
        let signature: Data
        do {
            signature = try order.sign(with: key)
        } catch {
            phase = .failed("Couldn't sign: \(error.localizedDescription)")
            return
        }

        phase = .posting
        do {
            let env = order.envelope(signatureHex: HexUtil.encode(signature))
            try await client.setFrontPage(
                serverDomain: serverDomain,
                request: env["request"] as! [String: Any],
                signatureHex: env["signature"] as! String
            )
        } catch let e as ScreensClientError {
            phase = .failed(e.errorDescription ?? "That didn't work. Try again in a moment.")
            return
        } catch {
            phase = .failed("Couldn't reach the box. Check your connection and try again.")
            return
        }
        current = label.isEmpty ? nil : label
        currentActive = true
        phase = .ready
    }
}
