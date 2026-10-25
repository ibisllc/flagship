#if DEBUG
import Foundation

/// The mock box's Local AI (docs/architecture-v2/local-ai.md §4): the same rows, refusals and
/// sentences as packages/server-daemon/src/localAi/http.ts, so the gym and unit tests see what a
/// real server answers. A download finishes over two reads; a queued training job runs an epoch
/// per read.
public final class MockLocalAi: @unchecked Sendable {
    public var available = true
    public var useGpu = true
    public var serveModel: String?
    public var models: [LocalAiModel] = MockLocalAi.catalog()
    public var gpus: [LocalAiGpu] = [
        LocalAiGpu(id: "0", model: "NVIDIA GeForce RTX 4090", vendor: "nvidia", memoryMiB: 24_564, state: "in-use",
                   holders: [LocalAiHolder(appId: "bright-maple--plants", appName: "Plants", allocationId: "app-bright-maple--plants-k1", state: "running")]),
    ]
    public var service: LocalAiService = .stopped
    public var jobs: [LocalAiJob] = []
    public var checkpoints: [String: [LocalAiCheckpoint]] = [:]
    public var apps: [LocalAiAppAccess] = [
        LocalAiAppAccess(serviceId: "bright-maple--wiki", name: "Wiki", grant: nil, usage: LocalAiUsage(day: "2026-10-24", requests: 0, tokens: 0)),
    ]
    public var datasets: [LocalAiDataset] = [
        LocalAiDataset(serviceId: "bright-maple--wiki", name: "Wiki", hasSampleData: true),
        LocalAiDataset(serviceId: "bright-maple--plants", name: "Plants", hasSampleData: false),
    ]
    /// The last order bodies the mock took (tests read them).
    public internal(set) var trainBodies: [[String: Any]] = []
    public internal(set) var grantBodies: [[String: Any]] = []
    /// When the model server can't start, the box's sentence.
    public var startRefusal: (code: String, sentence: String)?
    /// Training jobs move an epoch per read (off in gym scenes that show a fixed queue).
    public var autoAdvanceTraining = true
    var grantIssuedAt: [String: Int64] = [:]

    public init() {}

    static let gib: Int64 = 1_073_741_824

    public static func catalog() -> [LocalAiModel] {
        func row(_ id: String, _ name: String, _ d: String, _ p: String, _ q: String, _ size: Int64, _ lic: String, _ ctx: Int,
                 tools: Bool, purpose: String, trainable: Bool, mem: Int, tps: Double, state: String = "available") -> LocalAiModel {
            LocalAiModel(id: id, name: name, descriptor: d, parameters: p, quantization: q, sizeBytes: size,
                         license: LocalAiLicense(id: lic, url: "https://huggingface.co/"), contextTokens: ctx, tools: tools,
                         purpose: purpose, trainable: trainable, state: state, progress: nil, reason: nil,
                         memoryNeededMiB: mem, fits: mem <= 6_400, speed: LocalAiSpeed(tokensPerSecond: tps, measured: false, on: "cpu"))
        }
        return [
            row("qwen2.5-coder-7b-q4", "Qwen2.5 Coder 7B", "Best for building apps; wants a GPU", "7B", "Q4_K_M", 4_683_073_536, "apache-2.0", 32_768,
                tools: true, purpose: "build", trainable: false, mem: 5_646, tps: 2.6),
            row("qwen2.5-1.5b-q4", "Qwen2.5 1.5B", "Small and quick; fine for app features", "1.5B", "Q4_K_M", 1_117_320_736, "apache-2.0", 32_768,
                tools: true, purpose: "chat", trainable: false, mem: 1_609, tps: 10.7),
            row("qwen2.5-0.5b-q4", "Qwen2.5 0.5B", "Tiny; runs on any server", "0.5B", "Q4_K_M", 491_400_032, "apache-2.0", 32_768,
                tools: true, purpose: "chat", trainable: false, mem: 923, tps: 24.4, state: "installed"),
            row("stories-15m", "TinyStories 15M", "A small model to fine-tune on an app's sample text", "15M", "F32", 98_357_920, "mit", 256,
                tools: false, purpose: "test", trainable: true, mem: 368, tps: 122),
            row("stories-260k", "TinyStories 260K", "A test model: checks the server works, not for real use", "260K", "F32", 1_185_376, "mit", 128,
                tools: false, purpose: "test", trainable: true, mem: 260, tps: 9999),
        ]
    }

    func refuse(_ status: Int, _ sentence: String, code: String? = nil) -> ScreensClientError {
        var o: [String: Any] = ["error": sentence]
        if let code { o["code"] = code }
        let body = (try? JSONSerialization.data(withJSONObject: o)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        return .http(status: status, message: body)
    }

    /// One read: downloads advance, a queued job runs an epoch.
    func advance(now: Int64) {
        models = models.map { m in
            guard let p = m.progress, m.isBusy else { return m }
            let next = p.receivedBytes + p.totalBytes / 2
            if next >= p.totalBytes {
                return LocalAiModel(id: m.id, name: m.name, descriptor: m.descriptor, parameters: m.parameters, quantization: m.quantization,
                                    sizeBytes: m.sizeBytes, license: m.license, contextTokens: m.contextTokens, tools: m.tools, purpose: m.purpose,
                                    trainable: m.trainable, state: "installed", progress: nil, reason: nil, memoryNeededMiB: m.memoryNeededMiB,
                                    fits: m.fits, speed: m.speed)
            }
            return Self.with(m, state: "downloading", progress: LocalAiProgress(state: "downloading", receivedBytes: next, totalBytes: p.totalBytes))
        }
        if autoAdvanceTraining, let i = jobs.firstIndex(where: { $0.isTraining && ($0.state == "queued" || $0.state == "running") }) {
            let j = jobs[i]
            let done = min((j.epochsDone ?? 0) + 1, j.epochs ?? 1)
            var cps = checkpoints[j.id] ?? []
            cps.append(LocalAiCheckpoint(epoch: done, sha256: String(repeating: String(format: "%x", done % 16), count: 64),
                                         sizeBytes: 98_357_920, at: now, loss: 3.2 / Double(done)))
            checkpoints[j.id] = cps
            let finished = done >= (j.epochs ?? 1)
            jobs[i] = LocalAiJob(id: j.id, kind: j.kind, appId: j.appId, appName: j.appName, modelId: j.modelId,
                                 state: finished ? "completed" : "running", device: "cpu", gpu: nil, queuePosition: nil,
                                 createdAt: j.createdAt, startedAt: j.startedAt ?? now, endedAt: finished ? now : nil, reason: nil,
                                 epochs: j.epochs, epochsDone: done, checkpoints: cps.count)
        }
    }

    public static func with(_ m: LocalAiModel, state: String, progress: LocalAiProgress?) -> LocalAiModel {
        LocalAiModel(id: m.id, name: m.name, descriptor: m.descriptor, parameters: m.parameters, quantization: m.quantization,
                     sizeBytes: m.sizeBytes, license: m.license, contextTokens: m.contextTokens, tools: m.tools, purpose: m.purpose,
                     trainable: m.trainable, state: state, progress: progress, reason: nil, memoryNeededMiB: m.memoryNeededMiB,
                     fits: m.fits, speed: m.speed)
    }

    func view() -> LocalAiView {
        let used = models.filter(\.isInstalled).reduce(Int64(0)) { $0 + $1.sizeBytes }
        var rows: [LocalAiJob] = []
        if service.state != "stopped" || service.jobId != nil {
            rows.append(LocalAiJob(id: service.jobId ?? "service", kind: "inference", modelId: service.modelId, state: service.state,
                                   device: service.device, gpu: service.gpu.map { LocalAiJobGpu(deviceIds: $0.deviceIds) },
                                   queuePosition: service.queuePosition, createdAt: service.startedAt, startedAt: service.startedAt,
                                   reason: service.reason))
        }
        rows += jobs.sorted { ($0.createdAt ?? 0) > ($1.createdAt ?? 0) }
        return LocalAiView(
            available: available, reason: available ? nil : "Local AI runs on a Flagship server, not here.",
            settings: LocalAiSettings(useGpu: useGpu, serveModel: serveModel),
            hardware: LocalAiHardware(cpus: 4, memoryMiB: 8_000, diskFreeBytes: 52 * Self.gib, gpuService: !gpus.isEmpty, gpus: gpus),
            budget: LocalAiBudget(usedBytes: used, budgetBytes: 64 * Self.gib),
            models: models, service: service, jobs: rows, apps: apps, datasets: datasets,
            trainableModels: models.filter(\.trainable).map { LocalAiTrainable(id: $0.id, name: $0.name, installed: $0.isInstalled, memoryNeededMiB: $0.memoryNeededMiB * 4) })
    }

    /// `POST /api/screens/ai/models` for "On this server": what is downloaded here.
    public func menu() -> AiModelsResponse {
        let rows = models.filter(\.isInstalled).map {
            ModelOption(id: $0.id, label: $0.name, contextTokens: min($0.contextTokens, 16_384), vision: false, tools: $0.tools, known: true)
        }
        return AiModelsResponse(provider: LocalAi.provider, kind: "own", listed: true, models: rows,
                                defaultModel: (rows.first { $0.tools == true } ?? rows.first)?.id)
    }
}

extension MockScreensClient {
    private func localTick() async throws {
        if simulatedLatency > 0 { try? await Task.sleep(nanoseconds: UInt64(simulatedLatency * 1_000_000_000)) }
        if shouldFail { throw ScreensClientError.http(status: 503, message: String(localized: "simulated failure")) }
    }

    private static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    public func localAi() async throws -> LocalAiView {
        try await localTick()
        let v = localAiMock.view()
        localAiMock.advance(now: Self.nowMs())
        return v
    }

    public func localAiJobDetail(jobId: String) async throws -> LocalAiJobDetail {
        try await localTick()
        guard let j = localAiMock.jobs.first(where: { $0.id == jobId }) else { throw localAiMock.refuse(404, "No such training job.") }
        return LocalAiJobDetail(job: j, datasetDigest: String(repeating: "d", count: 64), datasetBytes: 4_096,
                                checkpoints: localAiMock.checkpoints[jobId] ?? [])
    }

    public func localAiSetUseGpu(_ useGpu: Bool) async throws -> LocalAiSettings {
        try await localTick()
        localAiMock.useGpu = useGpu
        return LocalAiSettings(useGpu: useGpu, serveModel: localAiMock.serveModel)
    }

    public func localAiSetServeModel(_ modelId: String?) async throws -> LocalAiSettings {
        try await localTick()
        if let modelId, !localAiMock.models.contains(where: { $0.id == modelId }) { throw localAiMock.refuse(400, "Unknown model.") }
        localAiMock.serveModel = modelId
        return LocalAiSettings(useGpu: localAiMock.useGpu, serveModel: modelId)
    }

    public func localAiModel(_ action: LocalAiModelAction, modelId: String) async throws {
        try await localTick()
        let m = localAiMock
        guard let i = m.models.firstIndex(where: { $0.id == modelId }) else {
            if action == .download { throw m.refuse(404, "That model isn't in this server's catalog.", code: "unknown-model") }
            throw m.refuse(404, action == .cancel ? "That model isn't downloading." : "That model isn't on this server.")
        }
        let row = m.models[i]
        switch action {
        case .download:
            if row.isInstalled { throw m.refuse(409, "That model is already on this server.", code: "already-installed") }
            if row.isBusy { throw m.refuse(409, "That model is already downloading.", code: "in-progress") }
            if row.sizeBytes > 52 * MockLocalAi.gib { throw m.refuse(409, "There isn't enough free disk space for that model.", code: "disk-full") }
            m.models[i] = MockLocalAi.with(row, state: "downloading", progress: LocalAiProgress(state: "downloading", receivedBytes: 0, totalBytes: row.sizeBytes))
            GymProbe.note("local-ai download \(modelId)")
        case .cancel:
            guard row.isBusy else { throw m.refuse(404, "That model isn't downloading.") }
            m.models[i] = MockLocalAi.with(row, state: "available", progress: nil)
        case .delete:
            guard row.isInstalled else { throw m.refuse(404, "That model isn't on this server.") }
            if m.service.modelId == modelId { m.service = .stopped }
            if m.serveModel == modelId { m.serveModel = nil }
            m.models[i] = MockLocalAi.with(row, state: "available", progress: nil)
        }
    }

    public func localAiServiceStart(modelId: String?) async throws -> LocalAiService {
        try await localTick()
        let m = localAiMock
        if let r = m.startRefusal { throw m.refuse(503, r.sentence, code: r.code) }
        let installed = m.models.filter(\.isInstalled)
        guard !installed.isEmpty else {
            throw m.refuse(503, "No model is downloaded on this server yet. Download one under Local AI.", code: "no-model")
        }
        let want = modelId ?? m.serveModel
        guard let pick = want.map({ id in installed.first { $0.id == id } }) ?? installed.first else {
            throw m.refuse(503, "That model isn't downloaded on this server.", code: "not-installed")
        }
        let free = m.useGpu ? m.gpus.first { $0.state == "free" } : nil
        GymProbe.note("local-ai start \(pick.id)")
        m.service = LocalAiService(state: "running", jobId: "a1b2c3d4e5f60718", modelId: pick.id, device: free == nil ? "cpu" : "gpu",
                                   gpu: free.map { LocalAiServiceGpu(allocationId: "localai-a1b2c3d4e5f60718", deviceIds: [$0.id]) },
                                   startedAt: Self.nowMs(), lastUsedAt: Self.nowMs())
        return m.service
    }

    public func localAiServiceStop() async throws -> LocalAiService {
        try await localTick()
        localAiMock.service = LocalAiService(state: "stopped", reason: "stopped by the owner")
        return localAiMock.service
    }

    /// This mock box's name (as its server detail reports it, or the paired box's domain).
    private func localAiOwnDomain(_ d: String?) async -> Bool {
        guard let d = d?.lowercased() else { return false }
        if d == mockFqdn.lowercased() { return true }
        let paired = await boxDomain()
        return d == paired?.lowercased()
    }

    private static func exactKeys(_ o: [String: Any], _ keys: Set<String>) -> Bool { Set(o.keys) == keys }

    public func localAiTrain(body: [String: Any]) async throws -> LocalAiJob {
        try await localTick()
        let m = localAiMock
        guard Self.exactKeys(body, ["order", "signature"]), let o = body["order"] as? [String: Any],
              Self.exactKeys(o, ["serverDomain", "serviceId", "jobId", "baseModel", "epochs", "issuedAt"]) else {
            throw m.refuse(400, "Send {order, signature} with exactly the training order's fields.")
        }
        guard await localAiOwnDomain(o["serverDomain"] as? String) else {
            throw m.refuse(403, "That order is for another server.")
        }
        try MockOrderSigners.shared.require(.sensitive, kind: "local-ai-train", signatureHex: body["signature"] as? String ?? "", payload: o)
        let serviceId = o["serviceId"] as? String ?? ""
        guard let ds = m.datasets.first(where: { $0.serviceId == serviceId }) else { throw m.refuse(404, "That app isn't on this server.") }
        let jobId = o["jobId"] as? String ?? ""
        if m.jobs.contains(where: { $0.id == jobId }) { throw m.refuse(409, "That training job already exists.") }
        let base = o["baseModel"] as? String ?? ""
        guard let model = m.models.first(where: { $0.id == base }), model.trainable else {
            throw m.refuse(409, "That model can't be fine-tuned on this server.")
        }
        guard model.isInstalled else { throw m.refuse(409, "Download the base model first.") }
        m.trainBodies.append(body)
        GymProbe.note("local-ai train \(serviceId) \(base)")
        let job = LocalAiJob(id: jobId, kind: "training", appId: serviceId, appName: ds.name, modelId: base, state: "queued",
                             queuePosition: m.jobs.filter { $0.state == "queued" || $0.state == "running" }.count + 1,
                             createdAt: Self.nowMs(), epochs: (o["epochs"] as? NSNumber)?.intValue, epochsDone: 0, checkpoints: 0)
        m.jobs.append(job)
        if !ds.hasSampleData {
            // The real box takes the job, then stops it in its preparing step with this sentence.
            m.jobs[m.jobs.count - 1] = LocalAiJob(id: jobId, kind: "training", appId: serviceId, appName: ds.name, modelId: base, state: "failed",
                                                  createdAt: job.createdAt, endedAt: Self.nowMs(),
                                                  reason: "This app has no staged sample data to learn from. Attach sample data in one of its build chats first.",
                                                  epochs: job.epochs, epochsDone: 0, checkpoints: 0)
        }
        return job
    }

    public func localAiJob(_ action: LocalAiJobAction, jobId: String) async throws {
        try await localTick()
        let m = localAiMock
        guard let i = m.jobs.firstIndex(where: { $0.id == jobId }) else {
            throw m.refuse(action == .cancel ? 404 : 409, action == .cancel ? "That job isn't running or waiting." : action == .resume ? "No such training job." : "Only a stopped job can be deleted.")
        }
        let j = m.jobs[i]
        func set(_ state: String) {
            m.jobs[i] = LocalAiJob(id: j.id, kind: j.kind, appId: j.appId, appName: j.appName, modelId: j.modelId, state: state,
                                   createdAt: j.createdAt, startedAt: j.startedAt, endedAt: state == "queued" ? nil : Self.nowMs(),
                                   epochs: j.epochs, epochsDone: j.epochsDone, checkpoints: j.checkpoints)
        }
        switch action {
        case .cancel:
            guard j.canCancel else { throw m.refuse(404, "That job isn't running or waiting.") }
            set("cancelled")
        case .resume:
            guard j.canResume else { throw m.refuse(409, "Only a stopped job can be resumed.") }
            set("queued")
        case .delete:
            guard j.canDelete else { throw m.refuse(409, "Only a stopped job can be deleted.") }
            m.jobs.remove(at: i)
            m.checkpoints[jobId] = nil
        }
    }

    public func localAiGrant(body: [String: Any]) async throws {
        try await localTick()
        let m = localAiMock
        guard Self.exactKeys(body, ["order", "signature"]), let o = body["order"] as? [String: Any],
              Self.exactKeys(o, ["serverDomain", "serviceId", "requestsPerDay", "tokensPerDay", "maxTokensPerRequest", "issuedAt"]) else {
            throw m.refuse(400, "Send {order, signature} with exactly the grant's fields.")
        }
        guard await localAiOwnDomain(o["serverDomain"] as? String) else {
            throw m.refuse(403, "That order is for another server.")
        }
        try MockOrderSigners.shared.require(.sensitive, kind: "local-ai-app-grant", signatureHex: body["signature"] as? String ?? "", payload: o)
        let id = o["serviceId"] as? String ?? ""
        guard let i = m.apps.firstIndex(where: { $0.serviceId == id }) else { throw m.refuse(404, "That app isn't on this server.") }
        let issued = (o["issuedAt"] as? NSNumber)?.int64Value ?? 0
        if let held = m.grantIssuedAt[id], issued <= held { throw m.refuse(409, "A newer choice is already in place.") }
        m.grantIssuedAt[id] = issued
        m.grantBodies.append(body)
        GymProbe.note("local-ai grant \(id) \((o["requestsPerDay"] as? NSNumber)?.int64Value ?? 0)")
        let r = (o["requestsPerDay"] as? NSNumber)?.int64Value ?? 0
        let grant = r > 0 ? LocalAiGrantQuota(requestsPerDay: r, tokensPerDay: (o["tokensPerDay"] as? NSNumber)?.int64Value ?? 0,
                                              maxTokensPerRequest: (o["maxTokensPerRequest"] as? NSNumber)?.int64Value ?? 0, issuedAt: issued) : nil
        m.apps[i] = LocalAiAppAccess(serviceId: id, name: m.apps[i].name, grant: grant, usage: m.apps[i].usage)
    }
}
#endif
