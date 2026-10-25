// Wire shapes of the box's Local AI screen (docs/architecture-v2/local-ai.md §4;
// packages/server-daemon/src/localAi/http.ts). Mirror of the webapp and iOS models.

package com.flagshipserver.app.api

import kotlinx.serialization.Serializable

@Serializable
data class LocalAiView(
    val available: Boolean = false,
    val reason: String? = null,
    /** Always "this-server": local work never leaves the box. */
    val privacy: String = "this-server",
    /** Always "none": nothing is paid for local work. */
    val cost: String = "none",
    val settings: LocalAiSettings = LocalAiSettings(),
    val hardware: LocalAiHardware = LocalAiHardware(),
    val budget: LocalAiBudget = LocalAiBudget(),
    val models: List<LocalAiModelRow> = emptyList(),
    val service: LocalAiServiceView = LocalAiServiceView(),
    val jobs: List<LocalAiJob> = emptyList(),
    val apps: List<LocalAiAppRow> = emptyList(),
    val datasets: List<LocalAiDataset> = emptyList(),
    val trainableModels: List<LocalAiTrainable> = emptyList(),
)

@Serializable
data class LocalAiSettings(val useGpu: Boolean = true, val serveModel: String? = null)

@Serializable
data class LocalAiHardware(
    val cpus: Int = 0,
    val memoryMiB: Long = 0,
    val diskFreeBytes: Long? = null,
    val gpuService: Boolean = false,
    val gpus: List<LocalAiGpu> = emptyList(),
)

@Serializable
data class LocalAiGpu(
    val id: String,
    val model: String = "",
    val vendor: String = "",
    val memoryMiB: Long = 0,
    /** free | in-use | quarantined | unqualified */
    val state: String = "unqualified",
    val holders: List<LocalAiGpuHolder> = emptyList(),
)

@Serializable
data class LocalAiGpuHolder(
    val appId: String,
    val appName: String? = null,
    val allocationId: String = "",
    val state: String = "",
)

@Serializable
data class LocalAiBudget(val usedBytes: Long = 0, val budgetBytes: Long = 0)

@Serializable
data class LocalAiLicense(val id: String = "", val url: String = "")

@Serializable
data class LocalAiProgress(val state: String = "downloading", val receivedBytes: Long = 0, val totalBytes: Long = 0)

@Serializable
data class LocalAiSpeed(val tokensPerSecond: Double = 0.0, val measured: Boolean = false, val on: String = "cpu")

@Serializable
data class LocalAiModelRow(
    val id: String,
    val name: String = "",
    val descriptor: String = "",
    val parameters: String = "",
    val quantization: String = "",
    val sizeBytes: Long = 0,
    val license: LocalAiLicense = LocalAiLicense(),
    val contextTokens: Long = 0,
    val tools: Boolean = false,
    /** build | chat | test */
    val purpose: String = "chat",
    val trainable: Boolean = false,
    /** available | downloading | verifying | installing | installed | failed */
    val state: String = "available",
    val progress: LocalAiProgress? = null,
    val reason: String? = null,
    val memoryNeededMiB: Long = 0,
    val fits: Boolean = true,
    val speed: LocalAiSpeed = LocalAiSpeed(),
)

@Serializable
data class LocalAiServiceGpu(val allocationId: String = "", val deviceIds: List<String> = emptyList())

@Serializable
data class LocalAiServiceView(
    /** stopped | queued | starting | running | stopping | failed */
    val state: String = "stopped",
    val jobId: String? = null,
    val modelId: String? = null,
    val device: String? = null,
    val gpu: LocalAiServiceGpu? = null,
    val queuePosition: Int? = null,
    val startedAt: Long? = null,
    val lastUsedAt: Long? = null,
    val inFlight: Int = 0,
    val reason: String? = null,
)

@Serializable
data class LocalAiJobGpu(val deviceIds: List<String> = emptyList())

@Serializable
data class LocalAiJob(
    val id: String,
    /** inference | training */
    val kind: String = "training",
    val appId: String? = null,
    val appName: String? = null,
    val modelId: String? = null,
    val state: String = "queued",
    val device: String? = null,
    val gpu: LocalAiJobGpu? = null,
    val queuePosition: Int? = null,
    val createdAt: Long? = null,
    val startedAt: Long? = null,
    val endedAt: Long? = null,
    val reason: String? = null,
    val epochs: Int? = null,
    val epochsDone: Int? = null,
    val checkpoints: Int? = null,
    val cost: String = "none",
)

@Serializable
data class LocalAiGrantView(
    val serverDomain: String = "",
    val serviceId: String = "",
    val requestsPerDay: Long = 0,
    val tokensPerDay: Long = 0,
    val maxTokensPerRequest: Long = 0,
    val issuedAt: Long = 0,
)

@Serializable
data class LocalAiUsage(val day: String = "", val requests: Long = 0, val tokens: Long = 0)

@Serializable
data class LocalAiAppRow(
    val serviceId: String,
    val name: String = "",
    val grant: LocalAiGrantView? = null,
    val usage: LocalAiUsage = LocalAiUsage(),
)

@Serializable
data class LocalAiDataset(val serviceId: String, val name: String = "", val hasSampleData: Boolean = false)

@Serializable
data class LocalAiTrainable(val id: String, val name: String = "", val installed: Boolean = false, val memoryNeededMiB: Long = 0)

@Serializable
data class LocalAiCheckpoint(
    val epoch: Int,
    val sha256: String = "",
    val sizeBytes: Long = 0,
    val at: Long = 0,
    val loss: Double? = null,
)

@Serializable
data class LocalAiJobDetail(
    val job: LocalAiJob,
    val datasetDigest: String? = null,
    val datasetBytes: Long? = null,
    val checkpoints: List<LocalAiCheckpoint> = emptyList(),
)

/** The signed training order the box takes (`order` of `POST …/train`). */
@Serializable
data class LocalAiTrainOrderWire(
    val serverDomain: String,
    val serviceId: String,
    val jobId: String,
    val baseModel: String,
    val epochs: Int,
    val issuedAt: Long,
)

/** The signed app grant (`order` of `POST …/apps/grant`); all quotas 0 withdraws. */
@Serializable
data class LocalAiAppGrantWire(
    val serverDomain: String,
    val serviceId: String,
    val requestsPerDay: Long,
    val tokensPerDay: Long,
    val maxTokensPerRequest: Long,
    val issuedAt: Long,
)

@Serializable
data class LocalAiTrainBody(val order: LocalAiTrainOrderWire, val signature: String)

@Serializable
data class LocalAiGrantBody(val order: LocalAiAppGrantWire, val signature: String)

@Serializable
data class LocalAiOk(val ok: Boolean = false)
