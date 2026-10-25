// The words the Local AI screen shows for the box's states (docs/architecture-v2/local-ai.md §4).
// Kept out of the Composables so the unit tests can pin them. Mirror of the webapp and iOS copy.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.api.LocalAiGpu
import com.flagshipserver.app.api.LocalAiJob
import com.flagshipserver.app.api.LocalAiModelRow
import com.flagshipserver.app.api.LocalAiServiceView
import java.text.NumberFormat
import java.util.Locale

object LocalAiCopy {
    /** The privacy line every Local AI surface carries. */
    val PRIVACY get() = FSStrings.get(R.string.local_ai_privacy)
    /** The cost line: local work is never paid for. */
    val COST get() = FSStrings.get(R.string.local_ai_cost_none)

    fun number(n: Long): String = NumberFormat.getIntegerInstance().format(n)

    /** One decimal for speeds under 10 tokens a second, whole numbers above. */
    fun speed(m: LocalAiModelRow): String {
        val tps = m.speed.tokensPerSecond
        val shown = if (tps < 10) String.format(Locale.getDefault(), "%.1f", tps) else number(Math.round(tps))
        val on = if (m.speed.on == "gpu") FSStrings.get(R.string.local_ai_on_gpu) else FSStrings.get(R.string.local_ai_on_cpu)
        return if (m.speed.measured) FSStrings.get(R.string.local_ai_speed_measured, shown, on)
        else FSStrings.get(R.string.local_ai_speed_estimate, shown, on)
    }

    fun modelState(m: LocalAiModelRow): String = when (m.state) {
        "installed" -> FSStrings.get(R.string.local_ai_state_installed)
        "downloading" -> FSStrings.get(R.string.local_ai_state_downloading)
        "verifying" -> FSStrings.get(R.string.local_ai_state_verifying)
        "installing" -> FSStrings.get(R.string.local_ai_state_installing)
        "failed" -> FSStrings.get(R.string.local_ai_state_failed)
        else -> FSStrings.get(R.string.local_ai_state_available)
    }

    /** 0..1 progress of a download, null when unknown. */
    fun progress(m: LocalAiModelRow): Float? {
        val p = m.progress ?: return null
        if (p.totalBytes <= 0) return null
        return (p.receivedBytes.toFloat() / p.totalBytes).coerceIn(0f, 1f)
    }

    fun serviceState(s: LocalAiServiceView): String = when (s.state) {
        "running" -> FSStrings.get(R.string.local_ai_service_running)
        "starting" -> FSStrings.get(R.string.local_ai_service_starting)
        "queued" -> FSStrings.get(R.string.local_ai_service_waiting_gpu)
        "stopping" -> FSStrings.get(R.string.local_ai_service_stopping)
        "failed" -> FSStrings.get(R.string.local_ai_service_failed)
        else -> FSStrings.get(R.string.local_ai_service_stopped)
    }

    /** Where a job runs: "GPU 0, 1", "CPU", or nothing yet. */
    fun device(device: String?, deviceIds: List<String>?): String? = when (device) {
        "gpu" -> FSStrings.get(R.string.local_ai_device_gpu, deviceIds.orEmpty().joinToString(", ").ifEmpty { "?" })
        "cpu" -> FSStrings.get(R.string.local_ai_device_cpu)
        else -> null
    }

    fun jobState(j: LocalAiJob): String = when (j.state) {
        "queued" -> FSStrings.get(R.string.local_ai_job_queued)
        "preparing" -> FSStrings.get(R.string.local_ai_job_preparing)
        "running" -> FSStrings.get(R.string.local_ai_job_running)
        "completed" -> FSStrings.get(R.string.local_ai_job_completed)
        "cancelled" -> FSStrings.get(R.string.local_ai_job_cancelled)
        "failed" -> FSStrings.get(R.string.local_ai_job_failed)
        else -> serviceState(LocalAiServiceView(state = j.state))
    }

    /** "2nd in line" style: the box's own queue position, or null when the job isn't waiting. */
    fun queue(position: Int?): String? = position?.takeIf { it > 0 }?.let { FSStrings.get(R.string.local_ai_queue_position, it) }

    fun jobTitle(j: LocalAiJob): String =
        if (j.kind == "inference") FSStrings.get(R.string.local_ai_job_inference_title, j.modelId ?: "")
        else FSStrings.get(R.string.local_ai_job_training_title, j.appName ?: j.appId ?: "", j.modelId ?: "")

    fun epochs(j: LocalAiJob): String? {
        val total = j.epochs ?: return null
        return FSStrings.get(R.string.local_ai_epochs_progress, j.epochsDone ?: 0, total)
    }

    /** Who holds a GPU right now, by app name ("Local AI" for the box's own model). */
    fun gpuHolders(g: LocalAiGpu): String = when {
        g.holders.isEmpty() -> when (g.state) {
            "quarantined" -> FSStrings.get(R.string.local_ai_gpu_quarantined)
            "unqualified" -> FSStrings.get(R.string.local_ai_gpu_unqualified)
            else -> FSStrings.get(R.string.local_ai_gpu_free)
        }
        else -> FSStrings.get(R.string.local_ai_gpu_used_by, g.holders.joinToString(", ") { it.appName ?: it.appId })
    }
}
