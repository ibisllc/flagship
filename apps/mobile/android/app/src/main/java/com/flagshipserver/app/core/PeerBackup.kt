// Peer backup between accounts (docs/peer-backup.md), the phone's side. Kotlin
// twin of the webapp's lib/peerBackup.js; must pass
// packages/protocol/test-vectors/peer-backup/vectors.json.
//
//   status   GET  /api/screens/peer-backup/status        the v2 screen: holders as Server 1..n
//   root     POST /api/screens/peer-backup/root          a lost server's record, opened by a running box
//   restore  POST /api/screens/server-restore/from-peers the waiting new server fetches the pieces
//
// A device of the account makes the keys for any of its servers, a dead one
// too: SWK = deriveSWK(UMK, serverId), PBK = HKDF(SWK, "flagship/peer-backup-key/v1").

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.api.PeerBackupStatusResponse
import com.flagshipserver.app.api.PeerRootArchive
import com.flagshipserver.app.api.PeerRootSummary
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object PeerBackup {
    const val INFO_PBK = "flagship/peer-backup-key/v1"
    const val INFO_ROOT = "flagship/pb-root/v1"
    private const val DAY_MS = 24L * 60 * 60 * 1000
    private val SERVER_ID = Regex("^[a-z0-9.-]{1,253}$")

    class PeerBackupException(message: String) : Exception(message)

    /** The server address as the box and `.com` key it (trimmed, lowercase), or a sentence. */
    fun normalizeServerId(raw: String?): String {
        val id = raw.orEmpty().trim().lowercase()
        if (!SERVER_ID.matches(id)) throw PeerBackupException(FSStrings.get(R.string.that_isnt_a_server_address))
        return id
    }

    /** PBK (lowercase hex) of [serverId]'s peer backups, from the account key. */
    fun derivePbkHex(umkSeed: ByteArray, serverId: String): String {
        val id = normalizeServerId(serverId)
        val swk = ServerKeys.deriveSwk(umkSeed, id)
        return try {
            HexUtil.encode(ServerKeys.hkdf32(swk, INFO_PBK))
        } finally {
            swk.fill(0)
        }
    }

    /** The record `.com` keeps for a server, sealed under a key only the account has. */
    data class SealedRoot(val nonceHex: String, val ciphertextHex: String)

    /** Open a sealed root with the PBK; the same checks as the box. Returns the root JSON. */
    fun openSealedRoot(sealed: SealedRoot, pbkHex: String, serverId: String): JsonObject {
        val rootKey = ServerKeys.hkdf32(HexUtil.decode(pbkHex) ?: throw PeerBackupException(FSStrings.get(R.string.that_isnt_a_peer_backup_key)), INFO_ROOT)
        val plain = try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(rootKey, "AES"),
                GCMParameterSpec(128, HexUtil.decode(sealed.nonceHex) ?: ByteArray(0)),
            )
            c.updateAAD("$INFO_ROOT|$serverId".toByteArray(Charsets.UTF_8))
            c.doFinal(HexUtil.decode(sealed.ciphertextHex) ?: ByteArray(0))
        } catch (_: Exception) {
            throw PeerBackupException(FSStrings.get(R.string.the_peer_backup_record_doesnt_open))
        }
        val root = Json.parseToJsonElement(String(plain, Charsets.UTF_8)).jsonObject
        if (root["v"]?.jsonPrimitive?.content != "1" || root["serverId"]?.jsonPrimitive?.content != serverId) {
            throw PeerBackupException(FSStrings.get(R.string.that_peer_backup_record_is_for))
        }
        return root
    }

    /** What the box's /root answers, made from an opened record. */
    fun summaryOfRoot(root: JsonObject): PeerRootSummary {
        val members = (root["stripes"] as? JsonArray).orEmpty().flatMap { it.jsonArray }
        val a = root["archive"]!!.jsonObject
        return PeerRootSummary(
            serverId = root["serverId"]!!.jsonPrimitive.content,
            generation = root["generation"]?.jsonPrimitive?.long,
            revision = root["revision"]?.jsonPrimitive?.long,
            createdAt = root["createdAt"]?.jsonPrimitive?.long,
            archive = PeerRootArchive(
                archiveId = a["archiveId"]!!.jsonPrimitive.content,
                createdAt = a["createdAt"]?.jsonPrimitive?.long ?: 0,
                bytes = a["bytes"]!!.jsonPrimitive.long,
                sha256 = a["sha256"]!!.jsonPrimitive.content,
                backupFile = a["backupFile"]!!.jsonPrimitive.content,
            ),
            holders = members.size,
            needed = root["network"]?.jsonObject?.get("k")?.jsonPrimitive?.content?.toIntOrNull() ?: 1,
            keepUntil = members.minOfOrNull { it.jsonObject["expiresAt"]!!.jsonPrimitive.long } ?: 0,
        )
    }

    // ── Words ──────────────────────────────────────────────────────

    fun stateTitle(state: String?): String = when (state) {
        "waiting-for-peers" -> FSStrings.get(R.string.looking_for_servers_to_keep_pieces)
        "filling" -> FSStrings.get(R.string.getting_ready)
        "placing" -> FSStrings.get(R.string.sending_pieces_to_other_servers)
        "protected" -> "Protected"
        "at-risk" -> FSStrings.get(R.string.at_risk)
        "leaving" -> FSStrings.get(R.string.leaving_peer_backups)
        "off" -> "Off"
        else -> state.orEmpty()
    }

    fun stateNote(state: String?): String = when (state) {
        "waiting-for-peers" -> FSStrings.get(R.string.peer_backup_starts_once_enough_other)
        "filling" -> FSStrings.get(R.string.this_server_is_setting_aside_space)
        "placing" -> FSStrings.get(R.string.your_newest_backup_is_being_spread)
        "protected" -> FSStrings.get(R.string.enough_of_the_servers_holding_your)
        "at-risk" -> FSStrings.get(R.string.too_few_pieces_are_safe_your)
        "leaving" -> FSStrings.get(R.string.this_server_stops_taking_new_pieces)
        "off" -> FSStrings.get(R.string.choose_peer_distributed_backups_in_this)
        else -> ""
    }

    private fun holderState(state: String?): String = when (state) {
        "ok" -> "Answering"
        "checking" -> "Checking"
        "failing" -> FSStrings.get(R.string.not_answering)
        "offline" -> "Offline"
        else -> state.orEmpty()
    }

    fun formatSize(n: Long): String {
        if (n < 0) return ""
        val gb = 1024.0 * 1024 * 1024
        return when {
            n >= gb -> if (n < 10 * gb) "%.1f GB".format(java.util.Locale.US, n / gb) else FSStrings.get(R.string.gb, Math.round(n / gb))
            n >= 1024L * 1024 -> FSStrings.get(R.string.mb, Math.round(n / (1024.0 * 1024)))
            else -> FSStrings.get(R.string.kb, maxOf(0L, Math.round(n / 1024.0)))
        }
    }

    data class HolderRow(val label: String, val state: String, val line: String)

    /** The list for the status page: "Server 1: Answering, last proof 2 hours ago, 12 pieces". */
    fun holderRows(status: PeerBackupStatusResponse, formatTime: (Long) -> String = ::defaultTime): List<HolderRow> =
        status.holderList.orEmpty().map { h ->
            HolderRow(
                label = h.label,
                state = h.state,
                line = listOf(
                    holderState(h.state),
                    h.lastProofAt?.takeIf { it > 0 }?.let { "last proof ${formatTime(it)}" } ?: "no proof yet",
                    FSStrings.plural(R.plurals.pieces_count, h.bricks, h.bricks),
                ).joinToString(" · "),
            )
        }

    private fun defaultTime(t: Long): String =
        java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT).format(java.util.Date(t))

    private fun defaultDate(t: Long): String =
        java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM).format(java.util.Date(t))

    /** The date by which a lost server's backup must be restored, or "". */
    fun restoreByLine(keepUntil: Long?, now: Long = System.currentTimeMillis(), formatDate: (Long) -> String = ::defaultDate): String {
        if (keepUntil == null || keepUntil <= 0) return ""
        if (keepUntil <= now) return FSStrings.get(R.string.the_pieces_of_this_backup_are)
        val days = Math.ceil((keepUntil - now).toDouble() / DAY_MS).toLong()
        return FSStrings.plural(R.plurals.restore_by_days_left, days.toInt(), formatDate(keepUntil), days)
    }

    /** What this server keeps for others. */
    fun hostingLines(status: PeerBackupStatusResponse): List<String> {
        val h = status.hosting ?: return emptyList()
        if (h.poolBytes <= 0) return emptyList()
        return buildList {
            add("Pool: ${formatSize(h.poolBytes)}, of which ${formatSize(h.realBytes)} holds other servers' pieces and ${formatSize(h.fillerBytes)} is proof filler.")
            add(FSStrings.get(R.string.proven_so_far, formatSize(h.provenBytes)))
            if (h.leaving) add(FSStrings.get(R.string.this_server_is_leaving_peer_backups))
        }
    }

    /** The card a restore shows once a lost server's record is found. */
    fun rootLines(summary: PeerRootSummary, now: Long = System.currentTimeMillis()): List<String> = buildList {
        val a = summary.archive
        add(FSStrings.get(R.string.backup_of_saved, summary.serverId, defaultTime(a.createdAt), formatSize(a.bytes)))
        add(FSStrings.plural(R.plurals.servers_hold_its_pieces, summary.holders, summary.holders, summary.needed))
        restoreByLine(summary.keepUntil, now).takeIf { it.isNotEmpty() }?.let { add(it) }
    }

    val OLDER_ENGINE get() = FSStrings.get(R.string.this_server_runs_an_older_peer)

    val RESTORE_INTRO get() =
        FSStrings.get(R.string.your_lost_servers_latest_backup_is)
}
