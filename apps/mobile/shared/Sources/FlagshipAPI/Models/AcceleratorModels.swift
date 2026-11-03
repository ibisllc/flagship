import Foundation

/// `GET /api/screens/accelerators` (packages/server-daemon/src/gpu/http.ts): this server's GPUs,
/// which app holds or waits for each, and whether new GPU work is paused. Read-only apart from
/// `POST /api/screens/accelerators/stop {allocationId}`, which a paired session (never a companion)
/// sends to take a GPU back from an app.
public struct AcceleratorsView: Codable, Equatable, Sendable {
    public let available: Bool
    /// `no-accelerators`, `no-gpu-service`, another code from the GPU service, or nil.
    public let reason: String?
    /// Set while the GPU service admits no new work (the running work keeps its device).
    public let admissionPaused: String?
    public let catalog: AcceleratorCatalog
    public let devices: [AcceleratorDevice]
    public let queue: [AcceleratorQueueEntry]
    /// Apps asking to use a GPU: gpud refuses their claims until the owner signs
    /// `flagship/gpu-approval/v2` for these exact terms. Absent on older boxes.
    public let pendingApprovals: [GpuApprovalRequest]
    /// The approvals in force.
    public let approvals: [GpuApprovalRequest]

    public init(available: Bool, reason: String?, admissionPaused: String? = nil,
                catalog: AcceleratorCatalog = AcceleratorCatalog(status: "current", serial: 1),
                devices: [AcceleratorDevice], queue: [AcceleratorQueueEntry] = [],
                pendingApprovals: [GpuApprovalRequest] = [], approvals: [GpuApprovalRequest] = []) {
        self.available = available; self.reason = reason; self.admissionPaused = admissionPaused
        self.catalog = catalog; self.devices = devices; self.queue = queue
        self.pendingApprovals = pendingApprovals; self.approvals = approvals
    }

    private enum CodingKeys: String, CodingKey { case available, reason, admissionPaused, catalog, devices, queue, pendingApprovals, approvals }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? false
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        admissionPaused = try c.decodeIfPresent(String.self, forKey: .admissionPaused)
        catalog = try c.decodeIfPresent(AcceleratorCatalog.self, forKey: .catalog) ?? AcceleratorCatalog(status: "unknown", serial: nil)
        devices = try c.decodeIfPresent([AcceleratorDevice].self, forKey: .devices) ?? []
        queue = try c.decodeIfPresent([AcceleratorQueueEntry].self, forKey: .queue) ?? []
        pendingApprovals = try c.decodeIfPresent([GpuApprovalRequest].self, forKey: .pendingApprovals) ?? []
        approvals = try c.decodeIfPresent([GpuApprovalRequest].self, forKey: .approvals) ?? []
    }

    public func with(devices: [AcceleratorDevice]? = nil, queue: [AcceleratorQueueEntry]? = nil, admissionPaused: String?? = nil,
                     pendingApprovals: [GpuApprovalRequest]? = nil, approvals: [GpuApprovalRequest]? = nil) -> AcceleratorsView {
        AcceleratorsView(available: available, reason: reason, admissionPaused: admissionPaused ?? self.admissionPaused, catalog: catalog,
                         devices: devices ?? self.devices, queue: queue ?? self.queue,
                         pendingApprovals: pendingApprovals ?? self.pendingApprovals, approvals: approvals ?? self.approvals)
    }
}

/// Cooperative sharing's limits on one device, as the owner signs them.
public struct GpuShareLimits: Codable, Equatable, Sendable {
    public let computePercent: Int
    public let memoryMib: Int64
    public init(computePercent: Int, memoryMib: Int64) { self.computePercent = computePercent; self.memoryMib = memoryMib }
}

/// One app installation's GPU terms as the box lists them: what the owner approves (signing
/// `flagship/gpu-approval/v2`) or withdraws (`flagship/gpu-approval-withdraw/v1`).
public struct GpuApprovalRequest: Codable, Equatable, Sendable, Identifiable {
    public let server: String
    public let appId: String
    public let installationId: String
    public let generation: Int64
    /// `nvidia-cuda`, `amd-rocm` or `intel-level-zero`.
    public let backend: String
    public let maxCount: Int
    /// `compute`, `graphics`, `video-encode`, `video-decode`.
    public let caps: [String]
    /// `exclusive`, `partition`, `cooperative`.
    public let policies: [String]
    /// `gvisor-nvproxy` or `vm-passthrough`.
    public let isolation: String
    public let secrecy: Bool
    public let trustDomain: String?
    public let ownerConsent: String?
    /// The one container its GPU claim may run in, and the claim's userspace image, run-time limit
    /// and share: gpud refuses a claim asking for anything other than what the owner signed.
    public let container: String?
    public let userspace: String?
    public let maxRuntimeMs: Int64?
    public let share: GpuShareLimits?
    /// When the owner signed it (granted approvals only).
    public let issuedAt: Int64?

    public var id: String { "\(appId)|\(installationId)|\(generation)" }

    public init(server: String, appId: String, installationId: String, generation: Int64, backend: String, maxCount: Int,
                caps: [String], policies: [String], isolation: String, secrecy: Bool,
                trustDomain: String? = nil, ownerConsent: String? = nil, container: String? = nil, userspace: String? = nil,
                maxRuntimeMs: Int64? = nil, share: GpuShareLimits? = nil, issuedAt: Int64? = nil) {
        self.server = server; self.appId = appId; self.installationId = installationId; self.generation = generation
        self.backend = backend; self.maxCount = maxCount; self.caps = caps; self.policies = policies
        self.isolation = isolation; self.secrecy = secrecy; self.trustDomain = trustDomain
        self.ownerConsent = ownerConsent; self.container = container ?? "flagship-\(appId)"; self.userspace = userspace
        self.maxRuntimeMs = maxRuntimeMs; self.share = share; self.issuedAt = issuedAt
    }

    public func with(server: String? = nil, issuedAt: Int64?? = nil) -> GpuApprovalRequest {
        GpuApprovalRequest(server: server ?? self.server, appId: appId, installationId: installationId, generation: generation,
                           backend: backend, maxCount: maxCount, caps: caps, policies: policies, isolation: isolation,
                           secrecy: secrecy, trustDomain: trustDomain, ownerConsent: ownerConsent, container: container,
                           userspace: userspace, maxRuntimeMs: maxRuntimeMs, share: share, issuedAt: issuedAt ?? self.issuedAt)
    }

    /// The same terms (what a signature covers), whatever `issuedAt` says.
    public func sameTerms(_ o: GpuApprovalRequest) -> Bool { with(issuedAt: .some(nil)) == o.with(issuedAt: .some(nil)) }
}

public struct AcceleratorCatalog: Codable, Equatable, Sendable {
    public let status: String
    public let serial: Int?
    public init(status: String, serial: Int?) { self.status = status; self.serial = serial }
}

public struct AcceleratorDevice: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let model: String
    public let vendor: String
    public let memoryMiB: Int
    /// `free`, `in-use`, `quarantined`, `unqualified` or `display`.
    public let state: String
    public let holders: [AcceleratorHolder]

    public init(id: String, model: String, vendor: String, memoryMiB: Int, state: String, holders: [AcceleratorHolder] = []) {
        self.id = id; self.model = model; self.vendor = vendor; self.memoryMiB = memoryMiB; self.state = state; self.holders = holders
    }
}

public struct AcceleratorHolder: Codable, Equatable, Sendable, Identifiable {
    public let appId: String
    public let allocationId: String
    public let state: String
    public var id: String { allocationId }

    public init(appId: String, allocationId: String, state: String) {
        self.appId = appId; self.allocationId = allocationId; self.state = state
    }
}

public struct AcceleratorQueueEntry: Codable, Equatable, Sendable, Identifiable {
    public let appId: String
    /// How many of the app's requests wait for a device.
    public let waiting: Int
    public var id: String { appId }

    public init(appId: String, waiting: Int) { self.appId = appId; self.waiting = waiting }
}
