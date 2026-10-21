// Where "Restore from other servers" reads the lost server's peer backup record
// (docs/peer-backup.md §9): a running server of the account opens it (it holds
// the PBK we send), and with none running this phone reads the sealed record
// from `.com` itself and opens it (it is public and sealed under a key only the
// account has). Twin of describePeerRoot / helperServer in the webapp.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.api.PeerRootRequest
import com.flagshipserver.app.api.PeerRootSummary
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.PeerBackup
import com.flagshipserver.app.core.PodInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request

class LivePeerRestoreSource(
    private val pods: () -> List<PodInfo>,
    /** A screens client for a server of the account, or null while this device has no session there. */
    private val clientFor: suspend (fqdn: String) -> ScreensClient?,
    private val umkSeed: suspend () -> ByteArray,
    /** The sealed record `.com` keeps for [serverId]; the fixed sentences for 404 / 503 / other. */
    private val fetchSealed: suspend (serverId: String) -> PeerBackup.SealedRoot = ::fetchSealedFromCom,
) : PeerRestoreSource {

    override val lostChoices: List<String>
        get() = pods()
            .sortedWith(compareByDescending<PodInfo> { it.isRevoked || it.status != PodInfo.Status.ONLINE }.thenBy { it.fqdn })
            .map { it.fqdn.lowercase() }
            .distinct()

    override suspend fun pbkHex(lost: String): String {
        val seed = umkSeed()
        try {
            return PeerBackup.derivePbkHex(seed, lost)
        } finally {
            seed.fill(0)
        }
    }

    override suspend fun describe(lost: String): PeerRootSummary {
        val id = PeerBackup.normalizeServerId(lost)
        val pbk = pbkHex(id)
        val helpers = pods().filter { !it.isRevoked && it.status == PodInfo.Status.ONLINE && !it.fqdn.equals(id, ignoreCase = true) }
        for (h in helpers) {
            val client = clientFor(h.fqdn) ?: continue
            try {
                return client.peerBackupRoot(PeerRootRequest(id, pbk))
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                // Try the next running server, then `.com`.
            }
        }
        val sealed = fetchSealed(id)
        return PeerBackup.summaryOfRoot(PeerBackup.openSealedRoot(sealed, pbk, id))
    }

    companion object {
        suspend fun fetchSealedFromCom(serverId: String): PeerBackup.SealedRoot = withContext(Dispatchers.IO) {
            val url = "${Endpoints.controlBaseUrl}/api/peer-backup/root/${java.net.URLEncoder.encode(serverId, "UTF-8")}"
            val (status, body) = try {
                OkHttpClient().newCall(Request.Builder().url(url).get().build()).execute().use { it.code to (it.body?.string() ?: "") }
            } catch (e: java.io.IOException) {
                throw PeerBackup.PeerBackupException(FSStrings.get(R.string.couldnt_reach_the_peer_backup_record))
            }
            when {
                status == 404 -> throw PeerBackup.PeerBackupException(FSStrings.get(R.string.no_peer_backup_of_that_server))
                status == 503 -> throw PeerBackup.PeerBackupException(FSStrings.get(R.string.peer_backup_between_accounts_isnt_set))
                status !in 200..299 -> throw PeerBackup.PeerBackupException(FSStrings.get(R.string.couldnt_reach_the_peer_backup_record))
            }
            val o = Json.parseToJsonElement(body).jsonObject
            PeerBackup.SealedRoot(o["nonceHex"]!!.jsonPrimitive.content, o["ciphertextHex"]!!.jsonPrimitive.content)
        }
    }
}
