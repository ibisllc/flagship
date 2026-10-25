import Foundation
import CryptoKit
import Observation
import Flagship
import FlagshipAPI
import FlagshipCore

/// The words of the server page's GPU card (also read by tests). Mirrors the webapp
/// `lib/accelerators.js` and Android `AcceleratorsCopy`.
public enum AcceleratorsCopy {
    public static let title = String(localized: "GPUs")
    public static let paused = String(localized: "New GPU work is paused on this server. Apps that already have a GPU keep it.")
    public static let waitingTitle = String(localized: "Waiting for a GPU")
    public static let serviceError = String(localized: "The GPU service on this server didn't answer. Try again in a moment.")
    public static let stop = String(localized: "Stop")
    public static let stopMessage = String(localized: "The app loses the GPU at once and may stop working until it is started again. The next app waiting gets the GPU.")

    /// An app's name from its id: `<account>--<slug>` shows the slug as the app list does.
    public static func appName(_ appId: String) -> String {
        if appId == "flagship-local-ai" { return String(localized: "Local AI") }
        let slug = appId.components(separatedBy: "--").last ?? appId
        return slug.isEmpty ? appId : slug.capitalized
    }

    public static func device(_ d: AcceleratorDevice) -> String { String(localized: "GPU \(d.id): \(d.model)") }

    public static func memory(_ mib: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(mib) * 1_048_576, countStyle: .memory)
    }

    public static func state(_ s: String) -> String {
        switch s {
        case "free": return String(localized: "Free")
        case "in-use": return String(localized: "In use")
        case "quarantined": return String(localized: "Set aside after a fault")
        case "display": return String(localized: "Drives the screen, so apps can't use it")
        default: return String(localized: "Not qualified on this server")
        }
    }

    public static func holder(_ h: AcceleratorHolder) -> String {
        let app = appName(h.appId)
        switch h.state {
        case "reserved", "admitted", "starting": return String(localized: "Starting for \(app)")
        case "releasing", "stopping": return String(localized: "\(app) is giving it back")
        default: return String(localized: "Used by \(app)")
        }
    }

    public static func waiting(_ q: AcceleratorQueueEntry) -> String {
        let app = appName(q.appId)
        return q.waiting <= 1 ? String(localized: "\(app) is waiting") : String(localized: "\(app) is waiting (\(q.waiting) jobs)")
    }

    public static func stopTitle(_ h: AcceleratorHolder) -> String { String(localized: "Stop \(appName(h.appId)) using the GPU?") }

    public static func stopped(_ h: AcceleratorHolder) -> String { String(localized: "\(appName(h.appId)) no longer has the GPU.") }

    // MARK: Approvals (flagship/gpu-approval/v1)

    public static let approve = String(localized: "Approve")
    public static let decline = String(localized: "Decline")
    public static let withdraw = String(localized: "Withdraw")
    public static let adminOnly = String(localized: "Only an admin device can approve GPU use. This device can see it.")
    public static let otherServer = String(localized: "This request is for another server, so nothing was signed.")
    public static let signApprove = String(localized: "Let an app use this server's GPU")
    public static let signWithdraw = String(localized: "Stop an app using this server's GPU")

    static func vendor(_ backend: String) -> String {
        switch backend {
        case "nvidia-cuda": return "NVIDIA"
        case "amd-rocm": return "AMD"
        case "intel-level-zero": return "Intel"
        default: return backend
        }
    }

    static func capability(_ c: String) -> String {
        switch c {
        case "compute": return String(localized: "computing")
        case "graphics": return String(localized: "graphics")
        case "video-encode": return String(localized: "video encoding")
        case "video-decode": return String(localized: "video decoding")
        default: return c
        }
    }

    static func policy(_ p: String) -> String {
        switch p {
        case "exclusive": return String(localized: "a GPU of its own")
        case "partition": return String(localized: "part of a GPU")
        case "cooperative": return String(localized: "a GPU shared with trusted apps")
        default: return p
        }
    }

    /// What the app gets: "1 × NVIDIA GPU, computing, a GPU of its own, in the app sandbox, kept apart from other apps".
    public static func terms(_ r: GpuApprovalRequest) -> String {
        let order = GpuApprovalOrderNames.capabilities
        var parts = [String(localized: "\(r.maxCount) × \(vendor(r.backend)) GPU")]
        parts += Array(Set(r.caps)).sorted { (order.firstIndex(of: $0) ?? 9) < (order.firstIndex(of: $1) ?? 9) }.map(capability)
        parts += Array(Set(r.policies)).sorted().map(policy)
        parts.append(r.isolation == "vm-passthrough" ? String(localized: "in its own virtual machine") : String(localized: "in the app sandbox"))
        if r.secrecy { parts.append(String(localized: "kept apart from other apps")) }
        return parts.joined(separator: ", ")
    }

    public static func asks(_ r: GpuApprovalRequest) -> String { String(localized: "\(appName(r.appId)) asks to use the GPU: \(terms(r))") }
    public static func allowed(_ r: GpuApprovalRequest) -> String { String(localized: "\(appName(r.appId)) may use the GPU: \(terms(r))") }
    public static func approved(_ r: GpuApprovalRequest) -> String { String(localized: "\(appName(r.appId)) can use the GPU.") }
    public static func declined(_ r: GpuApprovalRequest) -> String { String(localized: "\(appName(r.appId)) won't get a GPU.") }
    public static func withdrawn(_ r: GpuApprovalRequest) -> String { String(localized: "\(appName(r.appId)) can no longer use the GPU.") }
}

/// The capability order the terms line follows.
enum GpuApprovalOrderNames {
    static let capabilities = ["compute", "graphics", "video-encode", "video-decode"]
}

/// Backs the server page's GPU card: which GPUs the box has, which app holds or waits for each,
/// and Stop, which takes a GPU back (`POST /api/screens/accelerators/stop`; a paired session, no
/// signed order). A box without GPUs, or without this screen, shows no card.
@MainActor
@Observable
public final class AcceleratorsViewModel {
    public let serverDomain: String
    public private(set) var view: AcceleratorsView?
    /// The box has no GPU screen (an older release): no card.
    public private(set) var unsupported = false
    public private(set) var loadError: String?
    public private(set) var busy: String?
    public private(set) var notice: String?
    public private(set) var error: String?

    public typealias Signer = @MainActor (_ reason: String) async throws -> Curve25519.Signing.PrivateKey

    private let client: any ScreensClient
    private let signer: Signer
    private let now: () -> Int64

    public init(serverDomain: String, client: any ScreensClient, signer: Signer? = nil,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.serverDomain = serverDomain
        self.client = client
        self.signer = signer ?? { reason in try await ServerOrderSaver.sensitiveOrderKey(reason: reason) }
        self.now = now
    }

    /// The card shows for a box that has, or had, GPU work to show; a box with no GPU stays quiet.
    public var shows: Bool {
        if unsupported { return false }
        guard let v = view else { return loadError != nil }
        if !v.devices.isEmpty || !v.queue.isEmpty || v.admissionPaused != nil || !pending.isEmpty || !v.approvals.isEmpty { return true }
        return !(v.reason == nil || v.reason == "no-accelerators" || v.reason == "no-gpu-service")
    }

    public func load() async {
        do {
            view = try await client.accelerators()
            loadError = nil
            unsupported = false
        } catch ScreensClientError.notImplemented {
            unsupported = true
        } catch ScreensClientError.http(let status, _) where status == 404 || status == 405 {
            unsupported = true
        } catch {
            if view == nil { loadError = AcceleratorsCopy.serviceError }
        }
    }

    /// Approve: the admin root (one Face ID) signs `flagship/gpu-approval/v1` over the terms the box listed.
    public func approve(_ r: GpuApprovalRequest) async {
        await sign(r, reason: AcceleratorsCopy.signApprove, done: AcceleratorsCopy.approved(r)) { server, at, key in
            let terms = GpuApprovalOrder.ownerTerms(r, issuedAt: at)
            let sig = try key.signature(for: GpuApprovalOrder.canonical(server: server, terms, issuedAt: at))
            try await self.client.approveGpu(body: GpuApprovalOrder.body(server: server, terms, issuedAt: at, signatureHex: HexUtil.encode(sig)))
        }
    }

    /// Requests turned down on this device in this session, by server and installation. The box keeps no
    /// refusal: an app that isn't approved simply gets no GPU, so Decline sends nothing and hides the ask.
    private static var declinedIds: Set<String> = []

    /// The requests still to answer (Decline hides one here until the app asks with a new installation).
    public var pending: [GpuApprovalRequest] {
        (view?.pendingApprovals ?? []).filter { !Self.declinedIds.contains("\(serverDomain.lowercased())|\($0.id)") }
    }

    public func decline(_ r: GpuApprovalRequest) async {
        Self.declinedIds.insert("\(serverDomain.lowercased())|\(r.id)")
        error = nil
        notice = AcceleratorsCopy.declined(r)
    }

    public func withdraw(_ r: GpuApprovalRequest) async {
        await withdrawal(r, reason: AcceleratorsCopy.signWithdraw, done: AcceleratorsCopy.withdrawn(r))
    }

    private func withdrawal(_ r: GpuApprovalRequest, reason: String, done: String) async {
        await sign(r, reason: reason, done: done) { server, at, key in
            let sig = try key.signature(for: GpuApprovalOrder.withdrawCanonical(server: server, appId: r.appId, installationId: r.installationId,
                                                                               generation: r.generation, issuedAt: at))
            try await self.client.withdrawGpuApproval(body: GpuApprovalOrder.withdrawBody(r, issuedAt: at, signatureHex: HexUtil.encode(sig)))
        }
    }

    /// Signs only for the box this page talks to, never for another server a listing names.
    private func sign(_ r: GpuApprovalRequest, reason: String, done: String,
                      _ send: @escaping (String, Int64, Curve25519.Signing.PrivateKey) async throws -> Void) async {
        guard busy == nil else { return }
        let server = serverDomain.lowercased()
        notice = nil
        error = nil
        guard r.server.lowercased() == server else {
            error = AcceleratorsCopy.otherServer
            return
        }
        busy = r.id
        defer { busy = nil }
        do {
            let key = try await signer(reason)
            try await send(server, now(), key)
            notice = done
        } catch {
            self.error = BiometricGate.GateError.from(error) == .userCancelled
                ? LocalAiCopy.notChanged
                : (ScreensClientError.boxReason(error) ?? ScreensClientError.userFacing(error))
        }
        await load()
    }

    public func stop(_ h: AcceleratorHolder) async {
        guard busy == nil else { return }
        busy = h.allocationId
        notice = nil
        error = nil
        defer { busy = nil }
        do {
            try await client.stopAccelerator(allocationId: h.allocationId)
            notice = AcceleratorsCopy.stopped(h)
        } catch {
            self.error = ScreensClientError.boxReason(error) ?? ScreensClientError.userFacing(error)
        }
        await load()
    }
}
