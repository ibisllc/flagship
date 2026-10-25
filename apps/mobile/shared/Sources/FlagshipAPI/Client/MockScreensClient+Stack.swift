#if DEBUG
import Foundation

/// The mock box's container stack (packages/server-daemon/src/archV2Switch.ts): the same plan,
/// blockers and refusals. `status` nil is a box without the stack screen (404: no card). A real
/// switch answers `restarting`, then the box reads `installing`, `trial` and `done` on later reads.
public final class MockStack: @unchecked Sendable {
    public var status: StackStatus?
    /// The signed bodies the mock box took (tests read them).
    public internal(set) var bodies: [[String: Any]] = []
    var reads = 0

    public init() {}

    public static func classic(blocked: Bool = false) -> StackStatus {
        let gib: Int64 = 1_073_741_824
        return StackStatus(
            stack: "classic", engine: "docker", switchRecord: nil,
            plan: StackPlan(from: "classic", target: "arch-v2",
                            steps: ["Install Podman and the new stack's programs from this server's release",
                                    "Move 4 app image(s) and 3 volume(s) from Docker to Podman (Docker's copy is kept)",
                                    "Restart on the new stack, then check every app comes back within 20 minutes",
                                    "Keep Docker for a 24-hour trial: if the server isn't healthy, it goes back by itself"],
                            images: 4, volumes: 3, needBytes: 6 * gib, freeBytes: blocked ? 3 * gib : 41 * gib,
                            blockers: blocked ? [StackBlocker(code: "no-podman-room", error: "Moving the apps needs about 6.0 GB free on this server; it has 3.0 GB.")] : []))
    }

    func read(now: Int64) -> StackStatus? {
        guard let s = status, let r = s.switchRecord else { return status }
        reads += 1
        if r.state == "installing", reads >= 2 {
            status = StackStatus(stack: r.target, engine: r.target == "arch-v2" ? "podman" : "docker",
                                 switchRecord: StackSwitchRecord(state: "trial", target: r.target, startedAt: r.startedAt, trialUntil: now + 24 * 3_600_000),
                                 plan: StackPlan(from: r.target, target: r.target == "arch-v2" ? "classic" : "arch-v2",
                                                 steps: ["Turn Docker back on, with the apps' images and data from before the move"],
                                                 blockers: [StackBlocker(code: "in-progress", error: "A stack switch is already under way on this server.")]))
        }
        return status
    }
}

extension MockScreensClient {
    private func stackRefuse(_ status: Int, _ obj: [String: Any]) -> ScreensClientError {
        .http(status: status, message: (try? JSONSerialization.data(withJSONObject: obj)).flatMap { String(data: $0, encoding: .utf8) } ?? "")
    }

    public func stackStatus() async throws -> StackStatus {
        if simulatedLatency > 0 { try? await Task.sleep(nanoseconds: UInt64(simulatedLatency * 1_000_000_000)) }
        guard let s = stackMock.read(now: Int64(Date().timeIntervalSince1970 * 1000)) else {
            throw ScreensClientError.http(status: 404, message: #"{"error":"not found"}"#)
        }
        return s
    }

    public func stackSwitch(body: [String: Any]) async throws -> StackSwitchReply {
        if simulatedLatency > 0 { try? await Task.sleep(nanoseconds: UInt64(simulatedLatency * 1_000_000_000)) }
        guard let s = stackMock.status, let o = body["order"] as? [String: Any], let target = o["target"] as? String,
              let domain = o["serverDomain"] as? String else { throw stackRefuse(400, ["error": "malformed switch order"]) }
        guard domain.lowercased() == mockFqdn.lowercased() else { throw stackRefuse(403, ["error": "serverId mismatch"]) }
        try MockOrderSigners.shared.require(.sensitive, kind: "arch-v2-switch", signatureHex: body["signature"] as? String ?? "", payload: o)
        stackMock.bodies.append(body)
        let plan = s.plan.target == target ? s.plan : StackPlan(from: s.stack, target: target, steps: [],
                                                                blockers: [StackBlocker(code: "already", error: "This server already runs that stack.")])
        if body["dryRun"] as? Bool == true {
            GymProbe.note("stack dry-run \(target)")
            return StackSwitchReply(ok: true, dryRun: true, state: nil, plan: plan)
        }
        if let b = plan.blockers.first {
            throw stackRefuse(409, ["error": b.error, "code": b.code])
        }
        GymProbe.note("stack switch \(target)")
        stackMock.reads = 0
        stackMock.status = StackStatus(stack: s.stack, engine: s.engine,
                                       switchRecord: StackSwitchRecord(state: "installing", target: target, startedAt: Int64(Date().timeIntervalSince1970 * 1000)),
                                       plan: StackPlan(from: s.stack, target: target, steps: plan.steps,
                                                       blockers: [StackBlocker(code: "in-progress", error: "A stack switch is already under way on this server.")]))
        return StackSwitchReply(ok: true, dryRun: nil, state: "restarting", plan: plan)
    }
}
#endif
