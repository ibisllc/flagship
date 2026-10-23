import Foundation

/// "Access & permissions" for one app (SECURITY-HARDENING-PLAN.md 18.5, N05): every key, session and
/// grant that can act for it, the work running under each, and the way to end one or all.
public struct ServicePermissionGrant: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let capability: String
    public let issuedAt: Int64
    public let expiresAt: Int64?
    public let secretAccess: Bool
    public let openWork: [String]
    public init(id: String, kind: String, capability: String, issuedAt: Int64, expiresAt: Int64?, secretAccess: Bool, openWork: [String]) {
        self.id = id; self.kind = kind; self.capability = capability; self.issuedAt = issuedAt
        self.expiresAt = expiresAt; self.secretAccess = secretAccess; self.openWork = openWork
    }
}

public struct ServicePermissionOperation: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let state: String
    public init(id: String, kind: String, state: String) { self.id = id; self.kind = kind; self.state = state }
}

public struct ServicePermissions: Codable, Equatable, Sendable {
    public let grants: [ServicePermissionGrant]
    public let pendingOperations: [ServicePermissionOperation]
    public init(grants: [ServicePermissionGrant], pendingOperations: [ServicePermissionOperation] = []) {
        self.grants = grants; self.pendingOperations = pendingOperations
    }
}

public struct PermissionRevokeResult: Codable, Equatable, Sendable {
    public let revoked: Int
    public let stoppedWork: [String]
    public let stuckWork: [String]
    public init(revoked: Int, stoppedWork: [String] = [], stuckWork: [String] = []) {
        self.revoked = revoked; self.stoppedWork = stoppedWork; self.stuckWork = stuckWork
    }
}

public enum PermissionWords {
    public static let title = "Access & permissions"
    public static let none = "Nothing can act for this app right now."
    public static let revoke = "End this access"
    public static let revokeAll = "End all access"
    public static let stuck = "Some work did not stop yet:"

    public static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "owner-session": return "Owner session"
        case "companion-session": return "Browser or companion session"
        case "app-api-key": return "App API key"
        case "mcp-key": return "IDE key"
        case "build-token": return "Build"
        case "share": return "Shared server"
        case "member-invite": return "Invitation"
        case "browser-grant": return "Browser access"
        case "secret-handle": return "Secret"
        case "stream-ticket": return "Stream"
        case "job": return "Background job"
        default: return kind
        }
    }

    public static func outcome(_ r: PermissionRevokeResult) -> String {
        let base = r.revoked == 1 ? "Access ended." : "\(r.revoked) accesses ended."
        return r.stuckWork.isEmpty ? base : "\(base) \(stuck) \(r.stuckWork.joined(separator: ", "))"
    }
}
