#if DEBUG
import Foundation

/// The mock box's GPUs: the same rows and sentences as packages/server-daemon/src/gpu/http.ts.
/// `view` nil is a box without the GPU screen (it answers 404, so the server page shows no card).
/// Stop frees the device and, as the GPU service's fair queue does, hands it to the first app waiting.
public final class MockAccelerators: @unchecked Sendable {
    public var view: AcceleratorsView?
    /// The allocations the owner stopped, in order (tests read them).
    public internal(set) var stops: [String] = []
    /// The signed approval and withdrawal bodies the mock box took.
    public internal(set) var approvalBodies: [[String: Any]] = []
    public internal(set) var withdrawBodies: [[String: Any]] = []

    public init() {}

    /// What `-smoke-accelerators` shows: Plants holds the RTX 4090, Wiki waits, the A2000 is free and
    /// the Radeon was set aside after a fault.
    public static func fixture() -> AcceleratorsView {
        AcceleratorsView(
            available: true, reason: nil,
            devices: [
                AcceleratorDevice(id: "0", model: "NVIDIA GeForce RTX 4090", vendor: "nvidia", memoryMiB: 24_564, state: "in-use",
                                  holders: [AcceleratorHolder(appId: "bright-maple--plants", allocationId: "app-bright-maple--plants-k1", state: "running")]),
                AcceleratorDevice(id: "1", model: "NVIDIA RTX A2000", vendor: "nvidia", memoryMiB: 6_138, state: "free"),
                AcceleratorDevice(id: "2", model: "AMD Radeon PRO W7600", vendor: "amd", memoryMiB: 8_176, state: "quarantined"),
            ],
            queue: [AcceleratorQueueEntry(appId: "bright-maple--wiki", waiting: 1)])
    }

    /// What `-smoke-gpu-approvals` adds: Render, Train and Stream (sharing) ask to use a GPU; Photos may already.
    /// `server` is left empty and filled with the box's name when the screen is read.
    public static func approvalsFixture() -> (pending: [GpuApprovalRequest], granted: [GpuApprovalRequest]) {
        let render = GpuApprovalRequest(server: "", appId: "bright-maple--render", installationId: "inst-7f3a", generation: 3,
                                        backend: "nvidia-cuda", maxCount: 1, caps: ["compute"], policies: ["exclusive"],
                                        isolation: "gvisor-nvproxy", secrecy: true)
        let train = GpuApprovalRequest(server: "", appId: "bright-maple--train", installationId: "inst-9", generation: 12,
                                       backend: "amd-rocm", maxCount: 4, caps: ["compute", "graphics"], policies: ["exclusive"],
                                       isolation: "vm-passthrough", secrecy: true)
        let photos = GpuApprovalRequest(server: "", appId: "bright-maple--photos", installationId: "inst-01", generation: 1,
                                        backend: "nvidia-cuda", maxCount: 1, caps: ["video-encode", "compute"],
                                        policies: ["cooperative"], isolation: "gvisor-nvproxy", secrecy: false,
                                        trustDomain: "family", ownerConsent: "consent-2026-10-25", issuedAt: 1_800_000_000_000)
        let stream = GpuApprovalRequest(server: "", appId: "bright-maple--stream", installationId: "inst-5", generation: 2,
                                        backend: "nvidia-cuda", maxCount: 1, caps: ["video-encode"], policies: ["cooperative"],
                                        isolation: "gvisor-nvproxy", secrecy: false)
        return ([render, train, stream], [photos])
    }

    func stop(_ allocationId: String) -> Bool {
        guard let v = view, let i = v.devices.firstIndex(where: { $0.holders.contains { $0.allocationId == allocationId } }) else { return false }
        stops.append(allocationId)
        var devices = v.devices
        var queue = v.queue
        let d = devices[i]
        var holders = d.holders.filter { $0.allocationId != allocationId }
        if holders.isEmpty, let next = queue.first {
            holders = [AcceleratorHolder(appId: next.appId, allocationId: "app-\(next.appId)-q1", state: "reserved")]
            queue = next.waiting > 1 ? [AcceleratorQueueEntry(appId: next.appId, waiting: next.waiting - 1)] + queue.dropFirst() : Array(queue.dropFirst())
        }
        devices[i] = AcceleratorDevice(id: d.id, model: d.model, vendor: d.vendor, memoryMiB: d.memoryMiB,
                                       state: holders.isEmpty ? "free" : "in-use", holders: holders)
        view = v.with(devices: devices, queue: queue)
        return true
    }
}

extension MockScreensClient {
    public func accelerators() async throws -> AcceleratorsView {
        if simulatedLatency > 0 { try? await Task.sleep(nanoseconds: UInt64(simulatedLatency * 1_000_000_000)) }
        guard let v = acceleratorsMock.view else { throw ScreensClientError.http(status: 404, message: #"{"error":"not found"}"#) }
        let me = mockFqdn
        let named = { (r: GpuApprovalRequest) in r.server.isEmpty ? r.with(server: me) : r }
        return v.with(pendingApprovals: v.pendingApprovals.map(named), approvals: v.approvals.map(named))
    }

    private func gpuRefuse(_ status: Int, _ sentence: String) -> ScreensClientError {
        let body = (try? JSONSerialization.data(withJSONObject: ["error": sentence])).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        return .http(status: status, message: body)
    }

    /// As the box: the body's terms must be a pending request's exactly, for this box, signed.
    public func approveGpu(body: [String: Any]) async throws {
        if simulatedLatency > 0 { try? await Task.sleep(nanoseconds: UInt64(simulatedLatency * 1_000_000_000)) }
        guard let v = acceleratorsMock.view, let r = GpuApprovalOrder_request(body) else { throw gpuRefuse(400, "Send the request's terms, issuedAt and signature.") }
        guard r.server.lowercased() == mockFqdn.lowercased() else { throw gpuRefuse(403, "That approval is for another server.") }
        guard let i = v.pendingApprovals.firstIndex(where: { $0.appId == r.appId }),
              v.pendingApprovals[i].installationId == r.installationId, v.pendingApprovals[i].generation == r.generation else {
            throw gpuRefuse(409, "This approval is for another installation or version of the app. Approve it again from this server's page.")
        }
        let want = v.pendingApprovals[i]
        guard want.backend == r.backend, want.maxCount == r.maxCount, want.isolation == r.isolation,
              Set(want.caps) == Set(r.caps), Set(want.policies) == Set(r.policies) else {
            throw gpuRefuse(409, "This approval doesn't match what the app asks for.")
        }
        if r.policies.contains("cooperative"), r.trustDomain == nil || r.ownerConsent == nil {
            throw gpuRefuse(400, "Sharing a GPU between apps needs your consent and a trust domain.")
        }
        try MockOrderSigners.shared.require(.sensitive, kind: "gpu-approval", signatureHex: body["signature"] as? String ?? "", payload: body)
        var pending = v.pendingApprovals
        pending.remove(at: i)
        let granted = r.with(issuedAt: (body["issuedAt"] as? NSNumber)?.int64Value)
        acceleratorsMock.view = v.with(pendingApprovals: pending, approvals: v.approvals + [granted])
        acceleratorsMock.approvalBodies.append(body)
        GymProbe.note("gpu approval \(r.appId)")
    }

    /// Withdraws a granted approval (a request never approved answers 404, as the box does).
    public func withdrawGpuApproval(body: [String: Any]) async throws {
        if simulatedLatency > 0 { try? await Task.sleep(nanoseconds: UInt64(simulatedLatency * 1_000_000_000)) }
        guard let v = acceleratorsMock.view, let app = body["appId"] as? String, let inst = body["installationId"] as? String,
              let gen = (body["generation"] as? NSNumber)?.int64Value else { throw gpuRefuse(400, "Send the installation, issuedAt and signature.") }
        var payload = body
        payload["server"] = mockFqdn
        try MockOrderSigners.shared.require(.sensitive, kind: "gpu-approval-withdraw", signatureHex: body["signature"] as? String ?? "", payload: payload)
        let match = { (r: GpuApprovalRequest) in r.appId == app && r.installationId == inst && r.generation == gen }
        guard v.approvals.contains(where: match) else { throw gpuRefuse(404, "This app has no GPU approval to withdraw.") }
        acceleratorsMock.view = v.with(approvals: v.approvals.filter { !match($0) })
        acceleratorsMock.withdrawBodies.append(body)
        GymProbe.note("gpu approval withdrawn \(app)")
    }

    public func stopAccelerator(allocationId: String) async throws {
        if simulatedLatency > 0 { try? await Task.sleep(nanoseconds: UInt64(simulatedLatency * 1_000_000_000)) }
        guard acceleratorsMock.stop(allocationId) else {
            throw ScreensClientError.http(status: 404, message: #"{"error":"That GPU job is not running."}"#)
        }
        GymProbe.note("accelerator stop \(allocationId)")
    }
}
#endif

#if DEBUG
/// The mock box reads the body back without FlagshipCore (which sits above this module).
func GpuApprovalOrder_request(_ o: [String: Any]) -> GpuApprovalRequest? {
    func i64(_ v: Any?) -> Int64? { (v as? NSNumber)?.int64Value }
    guard let server = o["server"] as? String, let appId = o["appId"] as? String, let inst = o["installationId"] as? String,
          let gen = i64(o["generation"]), let backend = o["backend"] as? String, let n = i64(o["maxCount"]),
          let caps = o["caps"] as? [String], let pol = o["policies"] as? [String], let iso = o["isolation"] as? String,
          let secrecy = o["secrecy"] as? Bool else { return nil }
    return GpuApprovalRequest(server: server, appId: appId, installationId: inst, generation: gen, backend: backend, maxCount: Int(n),
                              caps: caps, policies: pol, isolation: iso, secrecy: secrecy,
                              trustDomain: o["trustDomain"] as? String, ownerConsent: o["ownerConsent"] as? String)
}
#endif
