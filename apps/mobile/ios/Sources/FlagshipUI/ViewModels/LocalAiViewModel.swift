import Foundation
import CryptoKit
import Observation
import Flagship
import FlagshipAPI
import FlagshipCore

/// The words the Local AI screens share (also read by tests and the model menu).
public enum LocalAiCopy {
    public static let title = String(localized: "Local AI")
    public static let onThisServer = String(localized: "On this server")
    public static let privacy = String(localized: "Runs only on this server. Nothing is sent anywhere.")
    public static let cost = String(localized: "Free: runs on this server")
    public static let summaryNone = String(localized: "No model downloaded yet")
    public static let noModels = String(localized: "No model is downloaded on this server yet. Download one under Local AI on the server's page.")
    public static let unavailable = String(localized: "This server can't run a local model.")
    public static let notChanged = String(localized: "Nothing was changed.")
    public static let signTrain = String(localized: "Start fine-tuning on this server")
    public static let signGrant = String(localized: "Let an app use this server's AI model")
    public static let signWithdraw = String(localized: "Stop an app using this server's AI model")

    static func size(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    static func mib(_ mib: Int) -> String { size(Int64(mib) * 1_048_576) }

    public static func speed(_ s: LocalAiSpeed) -> String {
        let n = s.tokensPerSecond.formatted(.number.precision(.fractionLength(0...1)))
        if s.measured {
            return s.on == "gpu" ? String(localized: "\(n) tokens a second on the GPU (measured)") : String(localized: "\(n) tokens a second on the CPU (measured)")
        }
        return s.on == "gpu" ? String(localized: "About \(n) tokens a second on the GPU (estimate)") : String(localized: "About \(n) tokens a second on the CPU (estimate)")
    }

    public static func device(_ d: String?, gpuIds: [String]?) -> String {
        switch d {
        case "gpu":
            let ids = (gpuIds ?? []).joined(separator: ", ")
            return ids.isEmpty ? String(localized: "GPU") : String(localized: "GPU \(ids)")
        case "cpu": return String(localized: "CPU")
        default: return String(localized: "Not placed yet")
        }
    }

    public static func modelState(_ m: LocalAiModel) -> String {
        switch m.state {
        case "installed": return String(localized: "Downloaded")
        case "downloading": return String(localized: "Downloading")
        case "verifying": return String(localized: "Checking the download")
        case "installing": return String(localized: "Installing")
        case "failed": return m.reason ?? String(localized: "The download failed.")
        default: return String(localized: "Not downloaded")
        }
    }

    public static func jobState(_ s: String) -> String {
        switch s {
        case "queued": return String(localized: "Waiting")
        case "preparing": return String(localized: "Preparing the sample data")
        case "starting": return String(localized: "Starting")
        case "running": return String(localized: "Running")
        case "stopping": return String(localized: "Stopping")
        case "stopped": return String(localized: "Stopped")
        case "completed": return String(localized: "Finished")
        case "cancelled": return String(localized: "Cancelled")
        case "failed": return String(localized: "Failed")
        default: return s
        }
    }

    public static func queue(_ position: Int?) -> String? {
        guard let p = position else { return nil }
        return p <= 1 ? String(localized: "Next in line") : String(localized: "Number \(p) in line")
    }

    public static func gpuState(_ s: String) -> String {
        switch s {
        case "free": return String(localized: "Free")
        case "in-use": return String(localized: "In use")
        case "quarantined": return String(localized: "Set aside after a fault")
        default: return String(localized: "Not qualified on this server")
        }
    }
}

/// Backs the server page's Local AI section and screen (docs/architecture-v2/local-ai.md §4).
/// Mirrors the webapp `views/local-ai.js` and Android `LocalAiScreen.kt`.
@MainActor
@Observable
public final class LocalAiViewModel {
    public typealias Signer = @MainActor (_ reason: String) async throws -> Curve25519.Signing.PrivateKey

    public let serverDomain: String
    public private(set) var view: LocalAiView?
    public private(set) var loadError: String?
    public private(set) var busy: Set<String> = []
    public private(set) var error: String?
    public private(set) var notice: String?
    public private(set) var jobDetail: LocalAiJobDetail?

    // The fine-tune sheet.
    public var trainApp: String = ""
    public var trainModel: String = ""
    public var trainEpochs: Int = 3

    private let client: any ScreensClient
    private let signer: Signer
    private let now: () -> Int64
    private let newJobId: () -> String

    public init(serverDomain: String, client: any ScreensClient, signer: Signer? = nil,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                newJobId: @escaping () -> String = LocalAiOrders.newJobId) {
        self.serverDomain = serverDomain
        self.client = client
        self.signer = signer ?? { reason in try await ServerOrderSaver.sensitiveOrderKey(reason: reason) }
        self.now = now
        self.newJobId = newJobId
    }

    public func load() async {
        do {
            view = try await client.localAi()
            loadError = nil
        } catch {
            loadError = Self.message(error)
        }
    }

    /// Re-read while something moves (a download, a job), for the screen's ticker.
    public var hasActivity: Bool {
        guard let v = view else { return false }
        return v.models.contains(where: \.isBusy)
            || v.jobs.contains { ["queued", "preparing", "running", "starting", "stopping"].contains($0.state) }
    }

    public var installedModels: [LocalAiModel] { view?.models.filter(\.isInstalled) ?? [] }

    public var summary: String {
        guard let v = view else { return "" }
        let installed = v.models.filter(\.isInstalled)
        if installed.isEmpty { return LocalAiCopy.summaryNone }
        let running = v.service.state == "running" ? v.service.modelId.flatMap { id in v.models.first { $0.id == id }?.name } : nil
        if let running { return String(localized: "Serving \(running)") }
        return String(localized: "Models downloaded: \(installed.count)")
    }

    private func run(_ key: String, _ body: () async throws -> String?) async {
        guard !busy.contains(key) else { return }
        busy.insert(key)
        error = nil
        notice = nil
        defer { busy.remove(key) }
        do {
            notice = try await body()
        } catch {
            self.error = Self.message(error)
        }
        await load()
    }

    public func download(_ m: LocalAiModel) async {
        await run("model-\(m.id)") {
            try await client.localAiModel(.download, modelId: m.id)
            return String(localized: "\(m.name) is downloading.")
        }
    }

    public func cancelDownload(_ m: LocalAiModel) async {
        await run("model-\(m.id)") {
            try await client.localAiModel(.cancel, modelId: m.id)
            return nil
        }
    }

    public func delete(_ m: LocalAiModel) async {
        await run("model-\(m.id)") {
            try await client.localAiModel(.delete, modelId: m.id)
            return String(localized: "\(m.name) was deleted from this server.")
        }
    }

    public func setUseGpu(_ on: Bool) async {
        await run("gpu") {
            _ = try await client.localAiSetUseGpu(on)
            return nil
        }
    }

    public func serve(_ modelId: String?) async {
        await run("serve") {
            _ = try await client.localAiSetServeModel(modelId)
            return nil
        }
    }

    public func start(_ modelId: String? = nil) async {
        await run("service") {
            let s = try await client.localAiServiceStart(modelId: modelId)
            return s.state == "running" ? String(localized: "The model is running.") : nil
        }
    }

    public func stop() async {
        await run("service") {
            _ = try await client.localAiServiceStop()
            return String(localized: "The model stopped.")
        }
    }

    // MARK: Fine-tuning

    /// Apps whose staged sample data can be learned from.
    public var trainableApps: [LocalAiDataset] { view?.datasets.filter(\.hasSampleData) ?? [] }
    public var trainBases: [LocalAiTrainable] { view?.trainableModels.filter(\.installed) ?? [] }

    public func prepareTrain() {
        if !trainableApps.contains(where: { $0.serviceId == trainApp }) { trainApp = trainableApps.first?.serviceId ?? "" }
        if !trainBases.contains(where: { $0.id == trainModel }) { trainModel = trainBases.first?.id ?? "" }
        trainEpochs = min(max(trainEpochs, 1), LocalAiOrders.maxEpochs)
    }

    public var canStartTraining: Bool { !trainApp.isEmpty && !trainModel.isEmpty && (1...LocalAiOrders.maxEpochs).contains(trainEpochs) }

    /// Sign `flagship/local-ai-train/v1` (Face ID) and hand it to the box. True when it was taken.
    @discardableResult
    public func startTraining() async -> Bool {
        guard canStartTraining else { return false }
        var ok = false
        await run("train") {
            let order = LocalAiTrainOrder(serverDomain: serverDomain, serviceId: trainApp, jobId: newJobId(),
                                          baseModel: trainModel, epochs: trainEpochs, issuedAt: now())
            let key = try await signer(LocalAiCopy.signTrain)
            let sig = try key.signature(for: order.canonicalBytes())
            _ = try await client.localAiTrain(body: order.body(signatureHex: HexUtil.encode(sig)))
            ok = true
            return String(localized: "Fine-tuning is queued. It runs only on this server.")
        }
        return ok
    }

    public func job(_ action: LocalAiJobAction, _ job: LocalAiJob) async {
        await run("job-\(job.id)") {
            try await client.localAiJob(action, jobId: job.id)
            if action == .delete, jobDetail?.job.id == job.id { jobDetail = nil }
            return nil
        }
    }

    public func closeJob() { jobDetail = nil }

    public func openJob(_ job: LocalAiJob) async {
        do {
            jobDetail = try await client.localAiJobDetail(jobId: job.id)
        } catch {
            self.error = Self.message(error)
        }
    }

    // MARK: App access

    /// Allow (default quotas) or withdraw one app's use of the local model: a signed order either way.
    public func setAppAccess(_ app: LocalAiAppAccess, allowed: Bool) async {
        await run("app-\(app.serviceId)") {
            let at = now()
            let g = allowed
                ? LocalAiAppGrant.allow(serverDomain: serverDomain, serviceId: app.serviceId, issuedAt: at)
                : LocalAiAppGrant.withdraw(serverDomain: serverDomain, serviceId: app.serviceId, issuedAt: at)
            let key = try await signer(allowed ? LocalAiCopy.signGrant : LocalAiCopy.signWithdraw)
            let sig = try key.signature(for: g.canonicalBytes())
            try await client.localAiGrant(body: g.body(signatureHex: HexUtil.encode(sig)))
            return allowed ? String(localized: "\(app.name) can use this server's AI model.") : String(localized: "\(app.name) can no longer use this server's AI model.")
        }
    }

    /// The box's own sentence when it sent one.
    static func message(_ error: Error) -> String {
        if BiometricGate.GateError.from(error) == .userCancelled { return LocalAiCopy.notChanged }
        if case ScreensClientError.http(_, let body) = error,
           let obj = try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any],
           let e = obj["error"] as? String, !e.isEmpty {
            return e
        }
        return ScreensClientError.userFacing(error)
    }
}
