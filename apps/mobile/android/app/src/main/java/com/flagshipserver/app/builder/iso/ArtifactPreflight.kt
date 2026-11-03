// Before the phone burns a USB stick, check that the signed box release the
// install will download is published. The bootstrap (SEC-INSTALL-001) fetches
// <control host>/build/iso/flagship-box-<commit12>-<arch>.{tar.gz,manifest.json}
// and stops for good when it is missing (2026-11-02, home.serene-parrot). The
// same rule as the three Studios (vm-core-vectors.json "artifactPreflight").

package com.flagshipserver.app.builder.iso

import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

object ArtifactPreflight {
    enum class Verdict { PUBLISHED, MISSING, UNREACHABLE }

    const val TIMEOUT_SECONDS = 15L

    private val COMMIT = Regex("^[0-9a-f]{40}$")

    /** The manifest the bootstrap will download from [controlBaseUrl] (`https://flagshipserver.com`),
     *  or null when the recipe names no exact commit or the arch is one no box runs. */
    fun manifestUrl(controlBaseUrl: String, commit: String?, arch: String): String? {
        if (commit == null || !COMMIT.matches(commit) || arch !in setOf("amd64", "arm64")) return null
        return "${controlBaseUrl.trimEnd('/')}/build/iso/flagship-box-${commit.take(12)}-$arch.manifest.json"
    }

    /** null status = no answer (timeout, DNS, TLS, offline). */
    fun verdictFor(status: Int?): Verdict = when {
        status == null -> Verdict.UNREACHABLE
        status in 200..299 -> Verdict.PUBLISHED
        status == 404 || status == 410 -> Verdict.MISSING
        else -> Verdict.UNREACHABLE
    }

    /** The refusal for a verdict; null when the burn may go ahead. */
    fun message(verdict: Verdict): String? = when (verdict) {
        Verdict.PUBLISHED -> null
        Verdict.MISSING -> FSStrings.get(R.string.box_release_not_published)
        Verdict.UNREACHABLE -> FSStrings.get(R.string.couldnt_check_box_release)
    }

    /** One HEAD for the manifest of [commit] on [arch]. [head] answers the status (tests fake it). */
    suspend fun check(
        controlBaseUrl: String,
        commit: String?,
        arch: String,
        head: suspend (String) -> Int? = ::headStatus,
    ): Verdict {
        val url = manifestUrl(controlBaseUrl, commit?.trim(), arch) ?: return Verdict.MISSING
        return verdictFor(head(url))
    }

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .addInterceptor(com.flagshipserver.app.core.UpdateLockInterceptor())
            .callTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .build()
    }

    private suspend fun headStatus(url: String): Int? = withContext(Dispatchers.IO) {
        runCatching {
            val req = Request.Builder().url(url).head().header("Cache-Control", "no-cache").build()
            client.newCall(req).execute().use { it.code }
        }.getOrNull()
    }
}
