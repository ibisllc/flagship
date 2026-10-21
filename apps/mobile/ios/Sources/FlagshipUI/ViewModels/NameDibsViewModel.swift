import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// "Claim your .com name" — the dibs flow (docs/naming-recovery-and-name-change.md §7).
///
/// While the one-year window is open, a name matching a registered `.com` is
/// held for whoever controls that domain. The flow:
///   1. load the window (closed ⇒ explain; open ⇒ ask for the name),
///   2. start a claim (IRK-signed) — `.com` returns the record to publish,
///   3. publish it (DNS TXT or HTTPS file), then check (IRK-signed),
///   4. proven ⇒ the name is held for this account; switching to it is the
///      paid name change.
/// Re-starting a pending claim returns the same record, so leaving the screen
/// while DNS propagates is safe.
@MainActor
@Observable
public final class NameDibsViewModel {
    public enum Phase: Equatable {
        case loading
        /// The window isn't open; `opensAt` is set when it's announced but in the future.
        case closed(opensAt: Int64?)
        case enterName(closesAt: Int64?)
        case working
        case publish(DibsClaim)
        case proven(name: String)
        case failed(String)
    }

    public private(set) var phase: Phase = .loading
    /// The last refusal shown inline (e.g. "no proof found yet").
    public private(set) var inlineError: String?

    private let client: any NameDibsClient
    private let username: String
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64
    private var claim: DibsClaim?
    private var lastWindow: DibsWindow?

    public init(
        client: any NameDibsClient,
        username: String,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.client = client
        self.username = username.lowercased()
        self.signer = signer ?? { reason in try await Keystore.deriveIRK(reason: reason) }
        self.now = now
    }

    public func load() async {
        phase = .loading
        do {
            let w = try await client.window()
            lastWindow = w
            if w.open {
                phase = .enterName(closesAt: w.end)
            } else {
                let future = w.configured && (w.start ?? 0) > now()
                phase = .closed(opensAt: future ? w.start : nil)
            }
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Normalize what the user typed ("Acme.com " → "acme").
    public static func normalize(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if s.hasSuffix(".com") { s.removeLast(4) }
        return s
    }

    public func start(name raw: String) async {
        let name = Self.normalize(raw)
        guard !name.isEmpty else { inlineError = "Enter a name."; return }
        inlineError = nil
        let previous = phase
        phase = .working
        do {
            let key = try await signer("Claim \(name).com")
            let request = DibsInitiateRequest(
                username: username,
                name: name,
                irkPubHex: HexUtil.encode(key.publicKey.rawRepresentation),
                issuedAt: now()
            )
            let sig = try key.signature(for: NameDibsInitiate.canonicalBytes(
                username: request.username, name: request.name, irkPubHex: request.irkPubHex, issuedAt: request.issuedAt
            ))
            let c = try await client.initiate(DibsInitiateBody(request: request, signature: HexUtil.encode(sig)))
            claim = c
            phase = c.verified ? .proven(name: c.name) : .publish(c)
        } catch {
            inlineError = error.localizedDescription
            phase = previous
        }
    }

    public func check() async {
        guard let c = claim else { return }
        inlineError = nil
        phase = .working
        do {
            let key = try await signer("Check \(c.name).com")
            let request = DibsVerifyRequest(username: username, name: c.name, nonce: c.nonce, issuedAt: now())
            let sig = try key.signature(for: NameDibsVerify.canonicalBytes(
                username: request.username, name: request.name, nonce: request.nonce, issuedAt: request.issuedAt
            ))
            let r = try await client.verify(DibsVerifyBody(request: request, signature: HexUtil.encode(sig)))
            phase = r.verified ? .proven(name: r.name) : .publish(c)
        } catch {
            inlineError = error.localizedDescription
            phase = .publish(c)
        }
    }

    /// Back from the publish step to pick a different name.
    public func restart() {
        claim = nil
        inlineError = nil
        phase = .enterName(closesAt: lastWindow?.end)
    }

    // MARK: - Home notice

    public static let bannerDismissKey = "flagship.dibs.banner.dismissed.v1"

    /// Show the Home notice iff the window is open and this device hasn't dismissed it.
    public static func shouldShowBanner(window: DibsWindow?, dismissed: Bool) -> Bool {
        (window?.open ?? false) && !dismissed
    }
}
