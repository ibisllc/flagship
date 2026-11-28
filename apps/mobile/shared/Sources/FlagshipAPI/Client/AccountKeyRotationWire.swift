import Foundation

// Account master-key rotation (docs/account-key-rotation.md): the wire shapes the apps read.
//
//   POST /api/users/:u/account-key-rotation            { rotation, signatures, pq?, kept, deliveries?, grants?, … }
//   GET  /api/accounts/:u/devices/:id/umk-rotation     (device-signed) { keyEpoch, deliveries, lane }
//   POST /api/accounts/:u/devices/:id/umk-rotation/ack (device-signed) { toEpoch }
//   PUT  /api/accounts/:u/devices/:id/receive-key      (device-signed) { receiveKey, signatureHex }
//   POST /api/accounts/:u/devices/:id/key              { rotate, newKeySignatureHex, adminRootSignatureHex, grant? }
//   GET  /api/screens/account-key/status               (each box) { status: AccountKeyBoxStatus | null }
//
// The bodies are built as JSON objects by FlagshipCore's AccountKeyRotationFlow (they carry nested signed
// envelopes and the hybrid companion) and sent through `FlagshipServerClient.accountKeyCall`.

/// One device's X-Wing receive key as the directory serves it (signed by that device's own key).
public struct DeviceReceiveKeyRecord: Codable, Equatable, Sendable {
    public let deviceId: String
    public let devicePubHex: String
    public let xwingPubHex: String
    public let issuedAt: Int64
    public let signatureHex: String

    public init(deviceId: String, devicePubHex: String, xwingPubHex: String, issuedAt: Int64, signatureHex: String) {
        self.deviceId = deviceId; self.devicePubHex = devicePubHex; self.xwingPubHex = xwingPubHex
        self.issuedAt = issuedAt; self.signatureHex = signatureHex
    }
}

/// What a box verified itself about the account key (`GET /api/screens/account-key/status`).
public struct AccountKeyBoxStatus: Codable, Equatable, Sendable {
    public let trustedEpoch: Int64?
    public let hintedEpoch: Int64?
    public let holdingOwnerKey: Bool
    public let rekeyDue: [String]
    public let lastError: String?
    public let capability: String

    public static let capabilityV1 = "account-key-rotation/v1"

    public init(trustedEpoch: Int64?, hintedEpoch: Int64?, holdingOwnerKey: Bool, rekeyDue: [String], lastError: String?, capability: String) {
        self.trustedEpoch = trustedEpoch; self.hintedEpoch = hintedEpoch; self.holdingOwnerKey = holdingOwnerKey
        self.rekeyDue = rekeyDue; self.lastError = lastError; self.capability = capability
    }

    /// The box can follow a rotation.
    public var canFollow: Bool { capability == Self.capabilityV1 }
}

public struct AccountKeyBoxStatusResponse: Codable, Equatable, Sendable {
    public let status: AccountKeyBoxStatus?
    public init(status: AccountKeyBoxStatus?) { self.status = status }
}

/// `.com`'s refusal body: `{ error, code }`.
public struct AccountKeyRefusal: Error, Equatable, Sendable {
    public let status: Int
    public let code: String

    public init(status: Int, code: String) { self.status = status; self.code = code }

    public init(status: Int, data: Data) {
        let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        self.init(status: status, code: (o?["code"] as? String) ?? (o?["error"] as? String) ?? "")
    }

    /// Another admin's hop, or a changed account: re-read before anything else.
    public var isConflict: Bool { status == 409 }
}

public extension FlagshipServerClient {
    /// JSON object in, JSON object out; any non-2xx becomes `AccountKeyRefusal`.
    func accountKeyJson(method: String, path: String, authorization: AccountDirectoryAuthorization? = nil,
                        body: [String: Any]? = nil) async throws -> [String: Any] {
        let data = try body.map { try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) }
        let (status, out) = try await accountKeyCall(method: method, path: path, authorization: authorization, body: data)
        guard (200..<300).contains(status) else { throw AccountKeyRefusal(status: status, data: out) }
        return ((try? JSONSerialization.jsonObject(with: out)) as? [String: Any]) ?? [:]
    }
}
