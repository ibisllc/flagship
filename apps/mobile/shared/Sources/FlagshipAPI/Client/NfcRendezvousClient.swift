import Foundation

/// C3 — phone client for the NFC rendezvous drop-box on flagshipserver.com.
///
/// Wire shape (see `packages/control-plane/src/nfcRendezvous.ts`):
///
///   POST /api/nfc/rendezvous/:rendezvousId/wifi
///     Body: { "sealedHex": "<hex>", "nonceHex": "<hex>" }
///     → 200 { ok: true, expiresAt: number }
///     → 400 malformed
///     → 429 rate limited
///
/// `sealedHex` is the protocol deposit blob: the phone's ephemeral
/// X25519 public key (32 bytes) followed by the AES-GCM ciphertext
/// sealed under K_session (`buildWifiDepositBlob` in FlagshipCore —
/// the box needs the pub to derive the same key; tampering it in
/// transit fails the AEAD open). The cloud is a pure opaque relay — anyone who
/// guesses both a live `rendezvousId` AND the blob format can deposit
/// garbage, but the box will reject non-genuine deposits when it tries
/// to open them with its independently-derived K_session.
///
/// 8 KB sealed-payload cap enforced server-side; the WiFi-config blob is
/// well under 1 KB so this is just an abuse limit, not an expected size.

public protocol NfcRendezvousClient: Sendable {
    func depositSealedWifi(rendezvousId: String, sealedHex: String, nonceHex: String) async throws
}

public enum NfcRendezvousError: Error, Equatable, Sendable, LocalizedError {
    case badRequest(String)
    case rateLimited
    case http(status: Int, body: String)
    case transport(String)

    public var errorDescription: String? {
        switch self {
        case .badRequest(let m): return "Rendezvous rejected: \(m)"
        case .rateLimited:        return "Too many tries — wait a moment and try again."
        case .http(let s, let b): return "Server returned \(s): \(b)"
        case .transport(let m):   return "Network error: \(m)"
        }
    }
}

// MARK: - Live

public final class LiveNfcRendezvousClient: NfcRendezvousClient, @unchecked Sendable {
    public static let defaultBaseUrl = URL(string: "https://flagshipserver.com")!

    private let urlSession: URLSession
    private let baseUrl: URL

    public init(urlSession: URLSession = .shared, baseUrl: URL = defaultBaseUrl) {
        self.urlSession = urlSession
        self.baseUrl = baseUrl
    }

    public func depositSealedWifi(
        rendezvousId: String,
        sealedHex: String,
        nonceHex: String
    ) async throws {
        // Server-side regex is `^[A-Za-z0-9_-]{8,64}$`; rejecting client-
        // side too gives a clearer error than a 400 from the edge.
        guard rendezvousId.range(of: "^[A-Za-z0-9_-]{8,64}$", options: .regularExpression) != nil else {
            throw NfcRendezvousError.badRequest("rendezvousId must match [A-Za-z0-9_-]{8,64}")
        }
        let encodedId = rendezvousId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? rendezvousId
        let url = baseUrl.appendingPathComponent("/api/nfc/rendezvous/\(encodedId)/wifi")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "sealedHex": sealedHex,
            "nonceHex": nonceHex,
        ])

        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await urlSession.data(for: req)
        } catch {
            throw NfcRendezvousError.transport(error.localizedDescription)
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) { return }
        let body = String(data: data, encoding: .utf8) ?? ""
        switch status {
        case 400: throw NfcRendezvousError.badRequest(body)
        case 429: throw NfcRendezvousError.rateLimited
        default:  throw NfcRendezvousError.http(status: status, body: body)
        }
    }
}

// MARK: - Mock

/// Scriptable mock for tests. Default behavior = success; set `behavior`
/// to throw a specific error. Captures the last call's args so tests can
/// assert wire shape (URL, hex values, retry count).
public final class MockNfcRendezvousClient: NfcRendezvousClient, @unchecked Sendable {
    public enum Behavior: Sendable {
        case ok
        case failure(NfcRendezvousError)
    }
    public var behavior: Behavior = .ok
    public private(set) var lastDeposit: (rendezvousId: String, sealedHex: String, nonceHex: String)?
    public private(set) var callCount: Int = 0

    public init() {}

    public func depositSealedWifi(
        rendezvousId: String,
        sealedHex: String,
        nonceHex: String
    ) async throws {
        callCount += 1
        lastDeposit = (rendezvousId, sealedHex, nonceHex)
        switch behavior {
        case .ok: return
        case .failure(let e): throw e
        }
    }
}
