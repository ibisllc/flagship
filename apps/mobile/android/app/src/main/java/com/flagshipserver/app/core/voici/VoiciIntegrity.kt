// Play Integrity for Messages enrollment (docs/voici-and-messages.md §9.5): a standard request whose requestHash is
// H(the attestation request's canonical bytes). `.com` decodes the token with Google and keeps the device-recall bits
// (one new Messages account per device a month, a ban covers the device). No token (no Play services, no project
// configured, a failed check) is not a refusal: the request goes out with deviceCheckRef "none" and `.com` puts the
// account on the slower unattested tier.

package com.flagshipserver.app.core.voici

import android.content.Context
import com.flagshipserver.app.BuildConfig
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityManager
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeoutOrNull

fun interface VoiciIntegrity {
    /** A token over [requestHash] (hex), or null when this device can't give one. */
    suspend fun token(requestHash: String): String?

    companion object {
        /** No attestation: the unattested tier. */
        val NONE = VoiciIntegrity { null }
    }
}

class PlayVoiciIntegrity(context: Context, private val projectNumber: Long = BuildConfig.PLAY_INTEGRITY_PROJECT) : VoiciIntegrity {
    private val app = context.applicationContext
    @Volatile private var provider: StandardIntegrityManager.StandardIntegrityTokenProvider? = null

    override suspend fun token(requestHash: String): String? {
        if (projectNumber <= 0) return null
        return withTimeoutOrNull(15_000) {
            runCatching {
                val p = provider ?: IntegrityManagerFactory.createStandard(app)
                    .prepareIntegrityToken(
                        StandardIntegrityManager.PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(projectNumber).build(),
                    ).await().also { provider = it }
                p.request(StandardIntegrityManager.StandardIntegrityTokenRequest.builder().setRequestHash(requestHash).build()).await().token()
            }.getOrNull()
        }
    }
}
