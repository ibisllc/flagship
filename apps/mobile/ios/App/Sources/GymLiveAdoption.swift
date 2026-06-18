import Foundation
import CryptoKit
import Flagship
import FlagshipCore
import FlagshipAPI

/// GYM-ONLY identity-adoption seam for the live iOS e2e (the iOS analogue of
/// the webapp's `window.__gymAdopt(seed, username)`).
///
/// A normal sign-in mints a brand-new UMK in the Secure Enclave and pairs by
/// scanning a QR / running the entitlement relay — neither of which a headless
/// XCUITest can do. `tools/live-e2e/provision-for-webapp.ts` already provisions
/// a real gym box whose OWNER IRK is `deriveIRK(<umkSeed>)`; it prints that seed
/// + username + fqdn. This seam takes those launch args and:
///
///   1. installs the printed UMK seed into the Keystore — so `deriveIRK()`
///      derives the box's owner IRK, byte-identical to how the box was
///      provisioned (the same `flagship/irk/v1` HKDF the webapp uses);
///   2. marks the app paired for that username + flips `useLiveClient` on so the
///      real `/pods` reconcile + the live screens client engage;
///   3. mints a box-side paired session: signs an `add-paired-session` PhoneOrder
///      with the just-installed IRK, POSTs it to `<fqdn>/api/orders-from-user`,
///      and persists `(podBaseUrl, sessionToken)` so the screens BFF
///      (`/api/screens/*`, `x-flagship-session`-authed) is reachable.
///
/// GATING — this runs ONLY when the launch contains `-gym-adopt-seed`. A
/// production launch never passes it (`ProcessInfo.arguments` only carries what
/// the launcher set), so the live app is byte-identical and this code path is
/// dead. It is the symmetric inverse of the existing `-apex-host` /
/// `-smoke-mode` launch-arg seams already in `FlagshipApp`.
enum GymLiveAdoption {
    struct Args {
        let umkSeedHex: String
        let username: String
        let fqdn: String
    }

    /// Parse the gym-adopt launch args, or nil if `-gym-adopt-seed` is absent.
    /// Each is the value form (`["-gym-adopt-seed", "<hex>"]`); a bare flag or
    /// a value that looks like another flag is treated as missing.
    static func parse(_ arguments: [String]) -> Args? {
        func value(_ flag: String) -> String? {
            guard let i = arguments.firstIndex(of: flag), i + 1 < arguments.count else { return nil }
            let v = arguments[i + 1]
            guard !v.isEmpty, !v.hasPrefix("-") else { return nil }
            return v
        }
        guard let seed = value("-gym-adopt-seed") else { return nil }
        guard let user = value("-gym-username"), let fqdn = value("-gym-fqdn") else { return nil }
        return Args(umkSeedHex: seed, username: user, fqdn: fqdn)
    }

    /// Returns true iff a gym-adopt launch was requested (so the caller can
    /// skip the normal session-restore path).
    static var isRequested: Bool {
        parse(ProcessInfo.processInfo.arguments) != nil
    }

    enum AdoptError: Error, CustomStringConvertible {
        case badSeed
        case pairingRefused(Int, String)
        case transport(String)
        var description: String {
            switch self {
            case .badSeed: return "gym-adopt: seed must be 64 hex chars (32 bytes)"
            case let .pairingRefused(s, t): return "gym-adopt: box refused add-paired-session: \(s) \(t)"
            case let .transport(m): return "gym-adopt: transport error: \(m)"
            }
        }
    }

    /// Run the full adoption. Installs the UMK, marks paired + live, then mints
    /// the box paired session. Throws on a seed/pairing failure so the test sees
    /// a hard failure rather than a silently-unpaired shell. The `urlSession` is
    /// the SAME box-pinned session the live screens client uses, so the pairing
    /// POST rides the exact production trust path.
    @MainActor
    static func adopt(
        _ args: Args,
        app: AppState,
        dev: DeveloperSettings,
        store: any SessionStoring,
        privacy: PrivacySettings,
        urlSession: URLSession
    ) async throws {
        guard let seed = Data(hexString: args.umkSeedHex), seed.count == 32 else {
            throw AdoptError.badSeed
        }
        // The box's owner IRK is the PROTOCOL (dot-form) IRK — the gym box is
        // provisioned by `@flagship/protocol`'s `deriveIRK`, NOT the iOS Keystore's
        // slash-form. Derive it and install it as the gym IRK override so every
        // box-op signer (journal / power / front-page) signs with the right key.
        guard let protoIrk = ServerKeys.deriveProtocolIrk(umkSeed: seed) else {
            throw AdoptError.badSeed
        }
        Keystore.gymAdoptedIrkOverride = protoIrk

        // 1. Install the UMK seed too — so `Keystore.hasWrappedUMK` is true and
        //    the persisted-session machinery is consistent. (The IRK that signs
        //    box ops is the override above, not the slash-form this would yield.)
        //    On the simulator this lands behind a non-SE wrapping key with no
        //    enrolled-biometric prompt, so it never blocks the headless test.
        let umk = SymmetricKey(data: seed)
        try await Keystore.installUMK(umk, reason: "Gym live e2e adopt")

        // 2. Paired + live + unlocked, just like a restored real session — but
        //    with the live client so the real /pods reconcile + screens client
        //    drive against the box.
        privacy.requireBiometricAtLaunch = false
        app.requireBiometricAtLaunch = false
        app.isUnlocked = true
        app.hasCloudRecovery = true
        if !app.isPaired {
            app.completeOnboarding(username: args.username, pods: [])
        }
        dev.useLiveClient = true

        // 3. Mint the box paired session (IRK-signed add-paired-session order).
        //    serverId == the box FQDN (the daemon enforces it). Sign with the
        //    protocol IRK (the box owner key) — `deriveIRK` would now also return
        //    it via the override, but we use the local var directly for clarity.
        let irk = protoIrk
        let serverId = args.fqdn.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        let token = AddPairedSessionOrder.freshToken()
        let order = AddPairedSessionOrder(
            serverId: serverId,
            token: token,
            issuedAt: Int64(Date().timeIntervalSince1970 * 1000)
        )
        let signature = try order.sign(with: irk)
        let envelope = order.envelope(signatureHex: HexUtil.encode(signature))

        let baseUrl = CompanionTicketURL.podBaseUrl(forFqdn: serverId)
        guard let url = URL(string: baseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/api/orders-from-user") else {
            throw AdoptError.transport("bad pod URL \(baseUrl)")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: envelope, options: [])

        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await urlSession.data(for: req)
        } catch {
            throw AdoptError.transport(String(describing: error))
        }
        guard let http = resp as? HTTPURLResponse else {
            throw AdoptError.transport("no HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw AdoptError.pairingRefused(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }

        // Persist (podBaseUrl, sessionToken). PodSessionSync also writes the
        // base URL once the online pod reconciles, but setting it here makes the
        // screens client usable immediately (and idempotently).
        await store.setPodBaseUrl(baseUrl)
        await store.setSessionToken(token)
    }
}

private extension Data {
    /// Decode a hex string (no `0x`, even length) into bytes; nil on malformed.
    init?(hexString: String) {
        let s = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.count % 2 == 0 else { return nil }
        var out = Data(capacity: s.count / 2)
        var idx = s.startIndex
        while idx < s.endIndex {
            let next = s.index(idx, offsetBy: 2)
            guard let b = UInt8(s[idx..<next], radix: 16) else { return nil }
            out.append(b)
            idx = next
        }
        self = out
    }
}
