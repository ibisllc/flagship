import Foundation

/// `GET /api/stack` (packages/server-daemon/src/archV2Switch.ts): the box's container stack, its
/// switch record, and the plan for moving to the other stack.
public struct StackStatus: Codable, Equatable, Sendable {
    /// `classic` or `arch-v2`.
    public let stack: String
    /// `docker` or `podman`.
    public let engine: String?
    public let switchRecord: StackSwitchRecord?
    public let plan: StackPlan

    private enum CodingKeys: String, CodingKey { case stack, engine, switchRecord = "switch", plan }

    public init(stack: String, engine: String?, switchRecord: StackSwitchRecord?, plan: StackPlan) {
        self.stack = stack; self.engine = engine; self.switchRecord = switchRecord; self.plan = plan
    }
}

public struct StackSwitchRecord: Codable, Equatable, Sendable {
    /// `installing`, `trial`, `done` or `reverted`.
    public let state: String
    public let target: String
    public let startedAt: Int64
    public let trialUntil: Int64?
    public let finishedAt: Int64?
    /// The box's sentence when it went back.
    public let reason: String?

    public init(state: String, target: String, startedAt: Int64, trialUntil: Int64? = nil, finishedAt: Int64? = nil, reason: String? = nil) {
        self.state = state; self.target = target; self.startedAt = startedAt
        self.trialUntil = trialUntil; self.finishedAt = finishedAt; self.reason = reason
    }
}

public struct StackPlan: Codable, Equatable, Sendable {
    public let from: String
    public let target: String
    /// The box's own sentences, one per step.
    public let steps: [String]
    public let images: Int
    public let volumes: Int
    public let needBytes: Int64
    public let freeBytes: Int64
    public let blockers: [StackBlocker]

    public init(from: String, target: String, steps: [String], images: Int = 0, volumes: Int = 0,
                needBytes: Int64 = 0, freeBytes: Int64 = 0, blockers: [StackBlocker] = []) {
        self.from = from; self.target = target; self.steps = steps; self.images = images; self.volumes = volumes
        self.needBytes = needBytes; self.freeBytes = freeBytes; self.blockers = blockers
    }
}

public struct StackBlocker: Codable, Equatable, Sendable {
    public let code: String
    public let error: String
    public init(code: String, error: String) { self.code = code; self.error = error }
}

/// `POST /api/stack/switch`: a dry run's plan, or `state: "restarting"` once the move began.
public struct StackSwitchReply: Codable, Equatable, Sendable {
    public let ok: Bool?
    public let dryRun: Bool?
    public let state: String?
    public let plan: StackPlan?
}
