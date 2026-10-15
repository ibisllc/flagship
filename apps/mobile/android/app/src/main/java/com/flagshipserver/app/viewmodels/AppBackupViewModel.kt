// "Back up now" on an app's page, as the webapp's Backup card and iOS do: the
// box packs the app's source and, if asked, its data (encrypted when a
// password is given), then hands the archive to this phone once and deletes
// it. The bytes go box → phone only; the owner saves or shares the file.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppBackupStartRequest
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.userFacing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class AppBackupViewModel(
    private val serviceId: String,
    private val client: ScreensClient,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    sealed interface Phase {
        data object Idle : Phase
        data object Creating : Phase
        data object Downloading : Phase
        /** The archive, ready to save or share as [fileName]. */
        class Ready(val bytes: ByteArray, val fileName: String, val encrypted: Boolean) : Phase
        data class Failed(val message: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Idle)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    val busy: Boolean get() = _phase.value is Phase.Creating || _phase.value is Phase.Downloading

    suspend fun backUp(includeData: Boolean, password: String) {
        if (busy) return
        _phase.value = Phase.Creating
        try {
            val started = client.appBackupStart(
                AppBackupStartRequest(
                    serviceId = serviceId,
                    password = password.ifEmpty { null },
                    includeUserData = includeData,
                ),
            )
            _phase.value = Phase.Downloading
            val bytes = client.appBackupFetch(started.fetchPath)
            _phase.value = Phase.Ready(bytes, fileName(serviceId, started.encrypted, now()), started.encrypted)
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            _phase.value = Phase.Failed(t.userFacing())
        }
    }

    companion object {
        /** `<slug>-backup-<yyyy-MM-dd-HHmm>.tar.gz`, `.enc` added when encrypted
         *  (the box's own naming). Same as iOS. */
        fun fileName(serviceId: String, encrypted: Boolean, atMs: Long): String {
            val slug = serviceId.substringAfterLast("--")
            val f = SimpleDateFormat("yyyy-MM-dd-HHmm", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
            return "$slug-backup-${f.format(Date(atMs))}.tar.gz${if (encrypted) ".enc" else ""}"
        }
    }
}
