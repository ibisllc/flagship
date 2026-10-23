import Foundation

// Three owner controls from the 0.3 security work, one wire each:
//  - permissions a restore held back (N09): approve the exact draft, or discard it;
//  - how an app takes updates (N11): manual (default), staged, automatic or frozen;
//  - letting one Remote browser session build or deploy one app (SEC-AUTH-002).
// Words match the webapp's lib/restoredAccess.js, lib/updateMode.js and lib/companionDelegation.js.

public struct RestoredAccessDraft: Codable, Equatable, Sendable, Identifiable {
    public let serviceRef: String
    public let sha256: String
    public let people: Int
    public let mode: String
    public let restoredAt: Int64
    public var id: String { serviceRef }
    public init(serviceRef: String, sha256: String, people: Int, mode: String, restoredAt: Int64) {
        self.serviceRef = serviceRef; self.sha256 = sha256; self.people = people; self.mode = mode; self.restoredAt = restoredAt
    }
}

public struct RestoredAccessList: Codable, Equatable, Sendable {
    public let drafts: [RestoredAccessDraft]
    public init(drafts: [RestoredAccessDraft]) { self.drafts = drafts }
}

public struct UpdateModeState: Codable, Equatable, Sendable {
    public let mode: String
    public let modes: [String]
    public let stagedHoldDays: Int
    public init(mode: String, modes: [String], stagedHoldDays: Int) { self.mode = mode; self.modes = modes; self.stagedHoldDays = stagedHoldDays }
}

public struct CompanionDelegationRow: Codable, Equatable, Sendable, Identifiable {
    public let serviceRef: String
    public let ops: [String]
    public let expiresAt: Int64?
    public var id: String { serviceRef }
    public init(serviceRef: String, ops: [String], expiresAt: Int64?) { self.serviceRef = serviceRef; self.ops = ops; self.expiresAt = expiresAt }
}

public struct CompanionDelegationList: Codable, Equatable, Sendable {
    public let delegations: [CompanionDelegationRow]
    public init(delegations: [CompanionDelegationRow]) { self.delegations = delegations }
}

public enum SecurityControlWords {
    public static let restoredTitle = "Restored permissions"
    public static let restoredIntro = "This app came back from a backup. Until an admin approves, nobody from the old list can open it."
    public static let restoredApprove = "Approve this list"
    public static let restoredDiscard = "Discard it"
    public static let restoredAdminOnly = "Only an admin device can approve restored permissions."

    public static let updatesTitle = "Updates"
    public static func updateLabel(_ mode: String) -> String? {
        switch mode {
        case "manual": return "Ask me each time"
        case "staged": return "Wait a week, then update"
        case "auto": return "Update automatically"
        case "frozen": return "Never update"
        default: return nil
        }
    }
    public static func updateNote(_ mode: String) -> String? {
        switch mode {
        case "manual": return "You approve every update."
        case "staged": return "A verified update from the same publisher is held for a week, then goes in. Anything that asks for more access still waits for you."
        case "auto": return "A verified update from the same publisher goes in at once. Anything that asks for more access still waits for you."
        case "frozen": return "This app stays on the version it is on."
        default: return nil
        }
    }

    public static let delegateOpen = "Let it build…"
    public static let delegateTitle = "Let this browser build an app"
    public static let delegateIntro = "A browser docked through Remote can only look. This lets it change one app you pick, for a short time. It ends on its own, or when you end it, or when the session ends."
    public static let delegateBuild = "Change the app (build)"
    public static let delegateDeploy = "Put changes live (deploy)"
    public static let delegateAllow = "Allow"
    public static let delegateEnd = "End it"
    public static let delegateAdminOnly = "Only an admin device can let a browser build."
}
