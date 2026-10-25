// Local AI on one server (docs/architecture-v2/local-ai.md): download models, choose the one the
// server runs, see the job queue (who holds each GPU, where a job waits), fine-tune a small model
// on an app's staged sample data, and let apps that ask use the server's model within quotas.
// Starting a fine-tune and allowing an app are owner orders: a biometric, then the sensitive-order
// key signs flagship/local-ai-train/v1 or flagship/local-ai-app-grant/v1. Mirror of iOS and webapp.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.R
import com.flagshipserver.app.api.LocalAiAppGrantWire
import com.flagshipserver.app.api.LocalAiJobDetail
import com.flagshipserver.app.api.LocalAiTrainOrderWire
import com.flagshipserver.app.api.LocalAiView
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.LocalAiOrders
import com.flagshipserver.app.keystore.BiometricAuthority
import com.flagshipserver.app.keystore.BiometricCancelled
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class LocalAiViewModel(
    private val serverDomain: String,
    private val client: ScreensClient,
    /** One biometric per order, even in an unlocked session. */
    private val confirm: suspend (reason: String) -> Unit = { r -> BiometricAuthority.confirmNow(r) },
    /** The sensitive-order key: the admin root, else the IRK. */
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
    private val newJobId: () -> String = { LocalAiOrders.newJobId() },
) : ViewModel() {

    data class State(
        val view: LocalAiView? = null,
        val loading: Boolean = true,
        /** What is being done right now (a model id, a job id, "grant:<app>"), or null. */
        val busy: String? = null,
        val error: String? = null,
        val notice: String? = null,
        val job: LocalAiJobDetail? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    suspend fun load() {
        try {
            val v = client.localAi()
            _state.value = _state.value.copy(view = v, loading = false, error = if (_state.value.busy == null) null else _state.value.error)
        } catch (t: Throwable) {
            _state.value = _state.value.copy(loading = false, error = t.sentence())
        }
    }

    /** Whether something on the screen is moving (a download, a starting server, a running job). */
    fun moving(): Boolean {
        val v = _state.value.view ?: return false
        return v.models.any { it.state in MOVING_MODEL } ||
            v.service.state in setOf("queued", "starting", "stopping") ||
            v.jobs.any { it.kind == "training" && it.state in setOf("queued", "preparing", "running") }
    }

    private suspend fun act(busy: String, notice: String? = null, block: suspend () -> Unit): Boolean {
        _state.value = _state.value.copy(busy = busy, error = null, notice = null)
        return try {
            block()
            _state.value = _state.value.copy(busy = null, notice = notice)
            load()
            true
        } catch (t: Throwable) {
            _state.value = _state.value.copy(busy = null, error = t.sentence())
            false
        }
    }

    suspend fun download(modelId: String) = act(modelId) { client.localAiModel("download", modelId) }
    suspend fun cancelDownload(modelId: String) = act(modelId) { client.localAiModel("cancel", modelId) }
    suspend fun deleteModel(modelId: String) = act(modelId, FSStrings.get(R.string.local_ai_model_deleted)) { client.localAiModel("delete", modelId) }
    suspend fun setUseGpu(on: Boolean) = act("settings") { client.localAiSettings(useGpu = on) }
    suspend fun serve(modelId: String?) = act("settings") {
        if (modelId == null) client.localAiSettings(clearServeModel = true) else client.localAiSettings(serveModel = modelId)
    }
    suspend fun startServer(modelId: String?) = act("service") { client.localAiService(start = true, modelId = modelId) }
    suspend fun stopServer() = act("service") { client.localAiService(start = false) }
    suspend fun cancelJob(jobId: String) = act(jobId) { client.localAiJobAction("cancel", jobId) }
    suspend fun resumeJob(jobId: String) = act(jobId) { client.localAiJobAction("resume", jobId) }
    suspend fun deleteJob(jobId: String): Boolean {
        val ok = act(jobId) { client.localAiJobAction("delete", jobId) }
        if (ok && _state.value.job?.job?.id == jobId) _state.value = _state.value.copy(job = null)
        return ok
    }

    suspend fun openJob(jobId: String) {
        try {
            _state.value = _state.value.copy(job = client.localAiJob(jobId))
        } catch (t: Throwable) {
            _state.value = _state.value.copy(error = t.sentence())
        }
    }

    fun closeJob() {
        _state.value = _state.value.copy(job = null)
    }

    /** Start a fine-tune of [baseModel] on [serviceId]'s staged sample data. A signed order. */
    suspend fun startTraining(serviceId: String, baseModel: String, epochs: Int): Boolean {
        if (epochs !in 1..LocalAiOrders.MAX_EPOCHS) return fail(FSStrings.get(R.string.local_ai_epochs_range, LocalAiOrders.MAX_EPOCHS))
        val order = LocalAiTrainOrderWire(serverDomain, serviceId, newJobId(), baseModel, epochs, now())
        runCatching { LocalAiOrders.trainBytes(order) }.onFailure { return fail(FSStrings.get(R.string.local_ai_order_invalid)) }
        val reason = FSStrings.get(R.string.local_ai_sign_train, serverDomain)
        return act("train", FSStrings.get(R.string.local_ai_training_queued)) {
            confirm(reason)
            client.localAiTrain(LocalAiOrders.signTrain(order, signer(reason)))
        }
    }

    /** Let [serviceId] use the server's model within these daily quotas (all zero withdraws). A signed order. */
    suspend fun grant(serviceId: String, requestsPerDay: Long, tokensPerDay: Long, maxTokensPerRequest: Long): Boolean {
        val g = LocalAiAppGrantWire(serverDomain, serviceId, requestsPerDay, tokensPerDay, maxTokensPerRequest, now())
        runCatching { LocalAiOrders.grantBytes(g) }.onFailure { return fail(FSStrings.get(R.string.local_ai_quota_invalid)) }
        val withdraw = requestsPerDay == 0L
        val reason = if (withdraw) FSStrings.get(R.string.local_ai_sign_withdraw, serverDomain) else FSStrings.get(R.string.local_ai_sign_grant, serverDomain)
        return act("grant:$serviceId", if (withdraw) FSStrings.get(R.string.local_ai_grant_withdrawn) else FSStrings.get(R.string.local_ai_grant_saved)) {
            confirm(reason)
            client.localAiGrant(LocalAiOrders.signGrant(g, signer(reason)))
        }
    }

    suspend fun withdraw(serviceId: String) = grant(serviceId, 0, 0, 0)

    private fun fail(message: String): Boolean {
        _state.value = _state.value.copy(busy = null, error = message, notice = null)
        return false
    }

    private fun Throwable.sentence(): String =
        when (this) {
            is BiometricCancelled -> FSStrings.get(R.string.local_ai_not_changed)
            else -> boxError() ?: userFacing()
        }

    companion object {
        val MOVING_MODEL = setOf("downloading", "verifying", "installing")
    }
}
