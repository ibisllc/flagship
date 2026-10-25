import Foundation

// Local AI on the owner's server (AI02). MIRRORS packages/server-daemon/src/localAi/http.ts
// (`localAiView`, `ModelRow`, `JobRow`) and service.ts (`ServiceView`);
// docs/architecture-v2/local-ai.md §4.

public enum LocalAi {
    /// The provider the model menu sends for "On this server". The box ignores the key and URL:
    /// it resolves its own loopback model server, and never falls back to anything else.
    public static let provider = "flagship-local"
    public static let credential = LlmProviderCredential(provider: provider, apiKey: "local", relay: false)
}

public struct LocalAiSettings: Codable, Equatable, Sendable {
    public var useGpu: Bool
    public var serveModel: String?
    public init(useGpu: Bool, serveModel: String?) { self.useGpu = useGpu; self.serveModel = serveModel }
}

public struct LocalAiHolder: Codable, Equatable, Sendable {
    public let appId: String
    public let appName: String?
    public let allocationId: String
    public let state: String
    public init(appId: String, appName: String?, allocationId: String, state: String) {
        self.appId = appId; self.appName = appName; self.allocationId = allocationId; self.state = state
    }
}

public struct LocalAiGpu: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let model: String
    public let vendor: String
    public let memoryMiB: Int
    /// free | in-use | quarantined | unqualified
    public let state: String
    public let holders: [LocalAiHolder]
    public init(id: String, model: String, vendor: String, memoryMiB: Int, state: String, holders: [LocalAiHolder]) {
        self.id = id; self.model = model; self.vendor = vendor; self.memoryMiB = memoryMiB; self.state = state; self.holders = holders
    }
}

public struct LocalAiHardware: Codable, Equatable, Sendable {
    public let cpus: Int
    public let memoryMiB: Int
    public let diskFreeBytes: Int64?
    public let gpuService: Bool?
    public let gpus: [LocalAiGpu]
    public init(cpus: Int, memoryMiB: Int, diskFreeBytes: Int64?, gpuService: Bool?, gpus: [LocalAiGpu]) {
        self.cpus = cpus; self.memoryMiB = memoryMiB; self.diskFreeBytes = diskFreeBytes; self.gpuService = gpuService; self.gpus = gpus
    }
}

public struct LocalAiBudget: Codable, Equatable, Sendable {
    public let usedBytes: Int64
    public let budgetBytes: Int64
    public init(usedBytes: Int64, budgetBytes: Int64) { self.usedBytes = usedBytes; self.budgetBytes = budgetBytes }
}

public struct LocalAiLicense: Codable, Equatable, Sendable {
    public let id: String
    public let url: String
    public init(id: String, url: String) { self.id = id; self.url = url }
}

public struct LocalAiProgress: Codable, Equatable, Sendable {
    public let state: String
    public let receivedBytes: Int64
    public let totalBytes: Int64
    public init(state: String, receivedBytes: Int64, totalBytes: Int64) {
        self.state = state; self.receivedBytes = receivedBytes; self.totalBytes = totalBytes
    }
    public var fraction: Double { totalBytes > 0 ? min(1, Double(receivedBytes) / Double(totalBytes)) : 0 }
}

public struct LocalAiSpeed: Codable, Equatable, Sendable {
    public let tokensPerSecond: Double
    public let measured: Bool
    /// cpu | gpu
    public let on: String
    public init(tokensPerSecond: Double, measured: Bool, on: String) { self.tokensPerSecond = tokensPerSecond; self.measured = measured; self.on = on }
}

public struct LocalAiModel: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let descriptor: String
    public let parameters: String
    public let quantization: String
    public let sizeBytes: Int64
    public let license: LocalAiLicense
    public let contextTokens: Int
    public let tools: Bool
    /// build | chat | test
    public let purpose: String
    public let trainable: Bool
    /// available | downloading | verifying | installing | installed | failed
    public let state: String
    public let progress: LocalAiProgress?
    public let reason: String?
    public let memoryNeededMiB: Int
    public let fits: Bool
    public let speed: LocalAiSpeed

    public init(id: String, name: String, descriptor: String, parameters: String, quantization: String, sizeBytes: Int64,
                license: LocalAiLicense, contextTokens: Int, tools: Bool, purpose: String, trainable: Bool, state: String,
                progress: LocalAiProgress?, reason: String?, memoryNeededMiB: Int, fits: Bool, speed: LocalAiSpeed) {
        self.id = id; self.name = name; self.descriptor = descriptor; self.parameters = parameters
        self.quantization = quantization; self.sizeBytes = sizeBytes; self.license = license
        self.contextTokens = contextTokens; self.tools = tools; self.purpose = purpose; self.trainable = trainable
        self.state = state; self.progress = progress; self.reason = reason; self.memoryNeededMiB = memoryNeededMiB
        self.fits = fits; self.speed = speed
    }

    public var isInstalled: Bool { state == "installed" }
    public var isBusy: Bool { state == "downloading" || state == "verifying" || state == "installing" }
}

public struct LocalAiServiceGpu: Codable, Equatable, Sendable {
    public let allocationId: String
    public let deviceIds: [String]
    public init(allocationId: String, deviceIds: [String]) { self.allocationId = allocationId; self.deviceIds = deviceIds }
}

public struct LocalAiService: Codable, Equatable, Sendable {
    /// stopped | queued | starting | running | stopping | failed
    public let state: String
    public let jobId: String?
    public let modelId: String?
    public let device: String?
    public let gpu: LocalAiServiceGpu?
    public let queuePosition: Int?
    public let startedAt: Int64?
    public let lastUsedAt: Int64?
    public let inFlight: Int
    public let reason: String?
    public init(state: String, jobId: String? = nil, modelId: String? = nil, device: String? = nil, gpu: LocalAiServiceGpu? = nil,
                queuePosition: Int? = nil, startedAt: Int64? = nil, lastUsedAt: Int64? = nil, inFlight: Int = 0, reason: String? = nil) {
        self.state = state; self.jobId = jobId; self.modelId = modelId; self.device = device; self.gpu = gpu
        self.queuePosition = queuePosition; self.startedAt = startedAt; self.lastUsedAt = lastUsedAt
        self.inFlight = inFlight; self.reason = reason
    }
    public static let stopped = LocalAiService(state: "stopped")
}

public struct LocalAiJobGpu: Codable, Equatable, Sendable {
    public let deviceIds: [String]
    public init(deviceIds: [String]) { self.deviceIds = deviceIds }
}

public struct LocalAiJob: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    /// inference | training
    public let kind: String
    public let appId: String?
    public let appName: String?
    public let modelId: String?
    public let state: String
    public let device: String?
    public let gpu: LocalAiJobGpu?
    public let queuePosition: Int?
    public let createdAt: Int64?
    public let startedAt: Int64?
    public let endedAt: Int64?
    public let reason: String?
    public let epochs: Int?
    public let epochsDone: Int?
    public let checkpoints: Int?
    public let cost: String?

    public init(id: String, kind: String, appId: String? = nil, appName: String? = nil, modelId: String? = nil, state: String,
                device: String? = nil, gpu: LocalAiJobGpu? = nil, queuePosition: Int? = nil, createdAt: Int64? = nil,
                startedAt: Int64? = nil, endedAt: Int64? = nil, reason: String? = nil, epochs: Int? = nil,
                epochsDone: Int? = nil, checkpoints: Int? = nil, cost: String? = "none") {
        self.id = id; self.kind = kind; self.appId = appId; self.appName = appName; self.modelId = modelId
        self.state = state; self.device = device; self.gpu = gpu; self.queuePosition = queuePosition
        self.createdAt = createdAt; self.startedAt = startedAt; self.endedAt = endedAt; self.reason = reason
        self.epochs = epochs; self.epochsDone = epochsDone; self.checkpoints = checkpoints; self.cost = cost
    }

    public var isTraining: Bool { kind == "training" }
    public var canCancel: Bool { isTraining && ["queued", "preparing", "running"].contains(state) }
    public var canResume: Bool { isTraining && (state == "cancelled" || state == "failed") }
    public var canDelete: Bool { isTraining && ["completed", "cancelled", "failed"].contains(state) }
}

public struct LocalAiGrantQuota: Codable, Equatable, Sendable {
    public let requestsPerDay: Int64
    public let tokensPerDay: Int64
    public let maxTokensPerRequest: Int64
    public let issuedAt: Int64?
    public init(requestsPerDay: Int64, tokensPerDay: Int64, maxTokensPerRequest: Int64, issuedAt: Int64? = nil) {
        self.requestsPerDay = requestsPerDay; self.tokensPerDay = tokensPerDay
        self.maxTokensPerRequest = maxTokensPerRequest; self.issuedAt = issuedAt
    }
}

public struct LocalAiUsage: Codable, Equatable, Sendable {
    public let day: String
    public let requests: Int64
    public let tokens: Int64
    public init(day: String, requests: Int64, tokens: Int64) { self.day = day; self.requests = requests; self.tokens = tokens }
}

public struct LocalAiAppAccess: Codable, Equatable, Sendable, Identifiable {
    public let serviceId: String
    public let name: String
    public let grant: LocalAiGrantQuota?
    public let usage: LocalAiUsage?
    public init(serviceId: String, name: String, grant: LocalAiGrantQuota?, usage: LocalAiUsage?) {
        self.serviceId = serviceId; self.name = name; self.grant = grant; self.usage = usage
    }
    public var id: String { serviceId }
}

public struct LocalAiDataset: Codable, Equatable, Sendable, Identifiable {
    public let serviceId: String
    public let name: String
    public let hasSampleData: Bool
    public init(serviceId: String, name: String, hasSampleData: Bool) { self.serviceId = serviceId; self.name = name; self.hasSampleData = hasSampleData }
    public var id: String { serviceId }
}

public struct LocalAiTrainable: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let installed: Bool
    public let memoryNeededMiB: Int
    public init(id: String, name: String, installed: Bool, memoryNeededMiB: Int) {
        self.id = id; self.name = name; self.installed = installed; self.memoryNeededMiB = memoryNeededMiB
    }
}

/// `GET /api/screens/local-ai`.
public struct LocalAiView: Codable, Equatable, Sendable {
    public let available: Bool
    public let reason: String?
    /// "this-server"
    public let privacy: String
    /// "none"
    public let cost: String
    public let settings: LocalAiSettings
    public let hardware: LocalAiHardware
    public let budget: LocalAiBudget
    public let models: [LocalAiModel]
    public let service: LocalAiService
    public let jobs: [LocalAiJob]
    public let apps: [LocalAiAppAccess]
    public let datasets: [LocalAiDataset]
    public let trainableModels: [LocalAiTrainable]

    public init(available: Bool, reason: String?, privacy: String = "this-server", cost: String = "none", settings: LocalAiSettings,
                hardware: LocalAiHardware, budget: LocalAiBudget, models: [LocalAiModel], service: LocalAiService,
                jobs: [LocalAiJob], apps: [LocalAiAppAccess], datasets: [LocalAiDataset], trainableModels: [LocalAiTrainable]) {
        self.available = available; self.reason = reason; self.privacy = privacy; self.cost = cost
        self.settings = settings; self.hardware = hardware; self.budget = budget; self.models = models
        self.service = service; self.jobs = jobs; self.apps = apps; self.datasets = datasets; self.trainableModels = trainableModels
    }
}

public struct LocalAiCheckpoint: Codable, Equatable, Sendable, Identifiable {
    public let epoch: Int
    public let sha256: String
    public let sizeBytes: Int64
    public let at: Int64
    public let loss: Double?
    public init(epoch: Int, sha256: String, sizeBytes: Int64, at: Int64, loss: Double?) {
        self.epoch = epoch; self.sha256 = sha256; self.sizeBytes = sizeBytes; self.at = at; self.loss = loss
    }
    public var id: Int { epoch }
}

/// `GET /api/screens/local-ai/jobs/<jobId>`.
public struct LocalAiJobDetail: Codable, Equatable, Sendable {
    public let job: LocalAiJob
    public let datasetDigest: String?
    public let datasetBytes: Int64?
    public let checkpoints: [LocalAiCheckpoint]
    public init(job: LocalAiJob, datasetDigest: String?, datasetBytes: Int64?, checkpoints: [LocalAiCheckpoint]) {
        self.job = job; self.datasetDigest = datasetDigest; self.datasetBytes = datasetBytes; self.checkpoints = checkpoints
    }
}

/// The routes' POST actions.
public enum LocalAiModelAction: String, Sendable { case download, cancel, delete }
public enum LocalAiJobAction: String, Sendable { case cancel, resume, delete }
