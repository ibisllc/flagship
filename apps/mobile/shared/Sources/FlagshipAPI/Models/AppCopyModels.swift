import Foundation

// Copying an app to another of the owner's servers (docs/app-placement.md §5).
// The phone signs the owner's order and sends it to the TARGET box, which
// fetches the snapshot from the source box itself.
//
// MIRRORS: docs/app-placement.md §5
//          packages/protocol/test-vectors/app-copy/vectors.json (every case
//          runs in AppCopyVectorTests)

/// `flagship/app-copy/v1|<sourceServer>|<targetServer>|<serviceId>|<issuedAt>`.
public struct AppCopyGrant: Codable, Equatable, Sendable {
    public static let canonicalTag = "flagship/app-copy/v1"

    /// The box the app is copied from (its FQDN).
    public let sourceServer: String
    /// The box the request goes to and the copy lands on.
    public let targetServer: String
    public let serviceId: String
    /// Unix ms.
    public let issuedAt: Int64

    public init(sourceServer: String, targetServer: String, serviceId: String, issuedAt: Int64) {
        self.sourceServer = sourceServer
        self.targetServer = targetServer
        self.serviceId = serviceId
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() -> Data {
        Data([Self.canonicalTag, sourceServer, targetServer, serviceId, String(issuedAt)]
            .joined(separator: "|").utf8)
    }
}

/// `POST /api/screens/services/copy` body.
public struct AppCopyRequest: Codable, Equatable, Sendable {
    public let grant: AppCopyGrant
    /// Ed25519 over `grant.canonicalBytes()`, 128 lowercase hex.
    public let signature: String

    public init(grant: AppCopyGrant, signature: String) {
        self.grant = grant
        self.signature = signature
    }
}

/// The 202 answer.
public struct AppCopyStartResponse: Codable, Equatable, Sendable {
    public let copyId: String
    public init(copyId: String) { self.copyId = copyId }
}

/// Where a copy has got to: a fraction (0…1) or a percentage, whichever the
/// box sends; nil when it doesn't say.
public enum AppCopyProgress {
    public static func percent(_ progress: Double?) -> Int? {
        guard let p = progress, p.isFinite, p >= 0 else { return nil }
        let pct = p <= 1 ? p * 100 : p
        return Int(min(100, pct.rounded()))
    }
}

/// One copy onto this box, from `GET /api/screens/services/copies`.
public struct AppCopyEntry: Codable, Equatable, Sendable, Identifiable {
    public let copyId: String
    public let serviceId: String
    public let appName: String
    public let sourceServer: String
    /// `copying` | `installing` | `done` | `failed`.
    public let state: String
    public let progress: Double?
    public let reason: String?
    public let startedAt: Int64
    /// Env names whose values couldn't come along: the owner sets them on
    /// the new copy.
    public let pendingEnv: [String]

    public var id: String { copyId }
    public var isUnderway: Bool { state == "copying" || state == "installing" }

    public init(copyId: String, serviceId: String, appName: String, sourceServer: String, state: String,
                progress: Double? = nil, reason: String? = nil, startedAt: Int64, pendingEnv: [String] = []) {
        self.copyId = copyId
        self.serviceId = serviceId
        self.appName = appName
        self.sourceServer = sourceServer
        self.state = state
        self.progress = progress
        self.reason = reason
        self.startedAt = startedAt
        self.pendingEnv = pendingEnv
    }

    private enum CodingKeys: String, CodingKey {
        case copyId, serviceId, appName, sourceServer, state, progress, reason, startedAt, pendingEnv
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        copyId = try c.decode(String.self, forKey: .copyId)
        serviceId = try c.decode(String.self, forKey: .serviceId)
        appName = try c.decodeIfPresent(String.self, forKey: .appName) ?? serviceId
        sourceServer = try c.decodeIfPresent(String.self, forKey: .sourceServer) ?? ""
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "copying"
        progress = try? c.decodeIfPresent(Double.self, forKey: .progress)
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        startedAt = AppDbNumber.int64(c, .startedAt) ?? 0
        pendingEnv = (try? c.decodeIfPresent([String].self, forKey: .pendingEnv)) ?? []
    }
}

public struct AppCopiesResponse: Codable, Equatable, Sendable {
    public let copies: [AppCopyEntry]
    public init(copies: [AppCopyEntry]) { self.copies = copies }

    private enum CodingKeys: String, CodingKey { case copies }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        copies = try c.decodeIfPresent([AppCopyEntry].self, forKey: .copies) ?? []
    }
}

/// `copying:{state, progress}` on an app the box is still receiving.
public struct AppCopying: Codable, Equatable, Sendable {
    public let state: String
    public let progress: Double?

    public init(state: String, progress: Double? = nil) {
        self.state = state
        self.progress = progress
    }

    private enum CodingKeys: String, CodingKey { case state, progress }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "copying"
        progress = try? c.decodeIfPresent(Double.self, forKey: .progress)
    }
}
