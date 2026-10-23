import Foundation

/// `flagship/ai-repair-consent/v1`: the owner's consent to ONE AI run that spends their key or Flagship
/// Inference credits, signed with the sensitive-order key and sent with the adapt request after the box's
/// estimate was shown (HTTP 428 `{code:"ai-consent", estimate}`). Wire parity with
/// packages/protocol/src/aiRepairConsent.ts; pinned by packages/protocol/test-vectors/ai-repair-consent/vectors.json.
///
///   flagship/ai-repair-consent/v1|<serverDomain lowercase>|<buildId>|<operation>|<provider>|<source>|<highTokens>|<issuedAt>
public struct AiRepairConsent: Equatable, Sendable {
    public static let canonicalTag = "flagship/ai-repair-consent/v1"

    public enum Operation: String, Sendable { case adapt, repair, sync }
    public enum Source: String, Sendable { case byok, promo }
    public struct Invalid: Error, Equatable { public let reason: String }

    public let serverDomain: String
    public let buildId: String
    public let operation: Operation
    public let provider: String
    public let source: Source
    public let highTokens: Int64
    public let issuedAt: Int64

    public init(serverDomain: String, buildId: String, operation: Operation, provider: String, source: Source, highTokens: Int64, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.buildId = buildId
        self.operation = operation
        self.provider = provider
        self.source = source
        self.highTokens = highTokens
        self.issuedAt = issuedAt
    }

    private static func clean(_ s: String) -> Bool {
        !s.isEmpty && !s.unicodeScalars.contains(where: { $0.value == 0x7c || $0.value <= 0x1f || $0.value == 0x7f })
    }

    public func canonicalBytes() throws -> Data {
        guard Self.clean(serverDomain) else { throw Invalid(reason: "serverDomain") }
        guard Self.clean(provider) else { throw Invalid(reason: "provider") }
        guard buildId.count == 16, buildId.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) }) else { throw Invalid(reason: "buildId") }
        guard highTokens >= 1 else { throw Invalid(reason: "highTokens") }
        guard issuedAt >= 0 else { throw Invalid(reason: "issuedAt") }
        let parts = [Self.canonicalTag, serverDomain.lowercased(), buildId, operation.rawValue, provider, source.rawValue, String(highTokens), String(issuedAt)]
        return Data(parts.joined(separator: "|").utf8)
    }

    /// The `consent` object of the adapt request.
    public func body(signature: Data) -> [String: Any] {
        ["issuedAt": issuedAt, "provider": provider, "source": source.rawValue, "highTokens": highTokens, "signature": signature.map { String(format: "%02x", $0) }.joined()]
    }
}
