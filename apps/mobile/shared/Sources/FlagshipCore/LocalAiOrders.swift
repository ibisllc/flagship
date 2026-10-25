import Foundation

/// The owner's signed local-AI orders (docs/architecture-v2/local-ai.md §4), signed with the
/// sensitive-order key (admin root, else the IRK). Wire parity with packages/protocol/src/localAi.ts;
/// pinned by packages/protocol/test-vectors/local-ai/vectors.json.
///
///   flagship/local-ai-app-grant/v1|<serverDomain lowercase>|<serviceId>|<requestsPerDay>|<tokensPerDay>|<maxTokensPerRequest>|<issuedAt>
///   flagship/local-ai-train/v1|<serverDomain lowercase>|<serviceId>|<jobId>|<baseModel>|<epochs>|<issuedAt>
public enum LocalAiOrders {
    public static let grantTag = "flagship/local-ai-app-grant/v1"
    public static let trainTag = "flagship/local-ai-train/v1"

    public static let maxRequestsPerDay: Int64 = 100_000
    public static let maxTokensPerDay: Int64 = 100_000_000
    public static let maxTokensPerRequest: Int64 = 32_768
    public static let maxEpochs = 20

    public struct Invalid: Error, Equatable { public let reason: String }

    static func domain(_ d: String) throws -> String {
        guard !d.isEmpty, d.count <= 253,
              !d.unicodeScalars.contains(where: { $0.value == 0x7c || $0.value <= 0x1f || $0.value == 0x7f }) else {
            throw Invalid(reason: "serverDomain")
        }
        return d.lowercased()
    }

    static func serviceIdOk(_ s: String) -> Bool {
        guard let f = s.unicodeScalars.first, s.unicodeScalars.count <= 128 else { return false }
        func lowerAlnum(_ c: Unicode.Scalar) -> Bool { ("a"..."z").contains(c) || ("0"..."9").contains(c) }
        return lowerAlnum(f) && s.unicodeScalars.allSatisfy { lowerAlnum($0) || $0 == "-" }
    }

    /// 16 random lowercase hex: a new training job's id.
    public static func newJobId() -> String {
        (0..<8).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }
}

/// One app may call the box-local model within these daily quotas; all three 0 withdraws it.
public struct LocalAiAppGrant: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let serviceId: String
    public let requestsPerDay: Int64
    public let tokensPerDay: Int64
    public let maxTokensPerRequest: Int64
    public let issuedAt: Int64

    public init(serverDomain: String, serviceId: String, requestsPerDay: Int64, tokensPerDay: Int64, maxTokensPerRequest: Int64, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.serviceId = serviceId
        self.requestsPerDay = requestsPerDay
        self.tokensPerDay = tokensPerDay
        self.maxTokensPerRequest = maxTokensPerRequest
        self.issuedAt = issuedAt
    }

    /// The default allowance the app-access row offers.
    public static func allow(serverDomain: String, serviceId: String, issuedAt: Int64) -> LocalAiAppGrant {
        LocalAiAppGrant(serverDomain: serverDomain, serviceId: serviceId, requestsPerDay: 500, tokensPerDay: 200_000, maxTokensPerRequest: 1024, issuedAt: issuedAt)
    }

    public static func withdraw(serverDomain: String, serviceId: String, issuedAt: Int64) -> LocalAiAppGrant {
        LocalAiAppGrant(serverDomain: serverDomain, serviceId: serviceId, requestsPerDay: 0, tokensPerDay: 0, maxTokensPerRequest: 0, issuedAt: issuedAt)
    }

    public var isWithdrawal: Bool { requestsPerDay == 0 }

    public func canonicalBytes() throws -> Data {
        let d = try LocalAiOrders.domain(serverDomain)
        guard LocalAiOrders.serviceIdOk(serviceId) else { throw LocalAiOrders.Invalid(reason: "serviceId") }
        guard (0...LocalAiOrders.maxRequestsPerDay).contains(requestsPerDay) else { throw LocalAiOrders.Invalid(reason: "requestsPerDay") }
        guard (0...LocalAiOrders.maxTokensPerDay).contains(tokensPerDay) else { throw LocalAiOrders.Invalid(reason: "tokensPerDay") }
        guard (0...LocalAiOrders.maxTokensPerRequest).contains(maxTokensPerRequest) else { throw LocalAiOrders.Invalid(reason: "maxTokensPerRequest") }
        let revoke = requestsPerDay == 0
        guard revoke == (tokensPerDay == 0), revoke == (maxTokensPerRequest == 0) else { throw LocalAiOrders.Invalid(reason: "quotas") }
        guard issuedAt >= 0 else { throw LocalAiOrders.Invalid(reason: "issuedAt") }
        let parts = [LocalAiOrders.grantTag, d, serviceId, String(requestsPerDay), String(tokensPerDay), String(maxTokensPerRequest), String(issuedAt)]
        return Data(parts.joined(separator: "|").utf8)
    }

    /// `{order, signature}` for `POST /api/screens/local-ai/apps/grant`.
    public func body(signatureHex: String) -> [String: Any] {
        ["order": ["serverDomain": serverDomain, "serviceId": serviceId, "requestsPerDay": requestsPerDay,
                   "tokensPerDay": tokensPerDay, "maxTokensPerRequest": maxTokensPerRequest, "issuedAt": issuedAt],
         "signature": signatureHex]
    }
}

/// Fine-tune one trainable catalog model on one app's staged sample data.
public struct LocalAiTrainOrder: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let serviceId: String
    public let jobId: String
    public let baseModel: String
    public let epochs: Int
    public let issuedAt: Int64

    public init(serverDomain: String, serviceId: String, jobId: String, baseModel: String, epochs: Int, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.serviceId = serviceId
        self.jobId = jobId
        self.baseModel = baseModel
        self.epochs = epochs
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        let d = try LocalAiOrders.domain(serverDomain)
        guard LocalAiOrders.serviceIdOk(serviceId) else { throw LocalAiOrders.Invalid(reason: "serviceId") }
        guard jobId.count == 16, jobId.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) }) else {
            throw LocalAiOrders.Invalid(reason: "jobId")
        }
        guard let f = baseModel.unicodeScalars.first, baseModel.unicodeScalars.count <= 64,
              ("a"..."z").contains(f) || ("0"..."9").contains(f),
              baseModel.unicodeScalars.allSatisfy({ ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "." || $0 == "-" }) else {
            throw LocalAiOrders.Invalid(reason: "baseModel")
        }
        guard (1...LocalAiOrders.maxEpochs).contains(epochs) else { throw LocalAiOrders.Invalid(reason: "epochs") }
        guard issuedAt >= 0 else { throw LocalAiOrders.Invalid(reason: "issuedAt") }
        let parts = [LocalAiOrders.trainTag, d, serviceId, jobId, baseModel, String(epochs), String(issuedAt)]
        return Data(parts.joined(separator: "|").utf8)
    }

    /// `{order, signature}` for `POST /api/screens/local-ai/train`.
    public func body(signatureHex: String) -> [String: Any] {
        ["order": ["serverDomain": serverDomain, "serviceId": serviceId, "jobId": jobId, "baseModel": baseModel,
                   "epochs": epochs, "issuedAt": issuedAt],
         "signature": signatureHex]
    }
}
