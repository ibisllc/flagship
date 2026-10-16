// A server's saved (scheduled) backups and its backup policy
// (docs/server-backup-and-clone.md, "Backup policy" and "Scheduled backups"):
// the box's shapes from serverArchive/service.ts and backupPolicy/http.ts.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.ArchiveKey
import com.flagshipserver.app.core.ArchiveKeysDeposit
import com.flagshipserver.app.core.BackupPolicyOrder
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** `frequency`: `daily` | `weekly` | `off`; the times are UTC (the apps show local time). */
@Serializable
data class BackupSchedule(
    val frequency: String = "daily",
    val minuteOfDayUtc: Int = 180,
    val weekdayUtc: Int = 0,
    val keepDaily: Int = 7,
    val keepWeekly: Int = 4,
)

/** `trigger`: `schedule` | `now`. */
@Serializable
data class BackupLastRun(
    val at: Long,
    val ok: Boolean,
    val trigger: String = "schedule",
    val archiveId: String? = null,
    val reason: String? = null,
)

@Serializable
data class BackupRunning(
    val archiveId: String,
    val trigger: String = "now",
    val startedAt: Long = 0,
    val progress: ServerArchiveProgress = ServerArchiveProgress(),
    val estimatedBytes: Long? = null,
)

@Serializable
data class SavedBackup(
    val archiveId: String,
    val createdAt: Long,
    val trigger: String = "schedule",
    /** The data file's size; [backupBytes] is the small backup file's. */
    val bytes: Long,
    val sha256: String,
    val backupBytes: Long = 0,
    val backupFileName: String,
    val dataFileName: String,
    /** The one `.flagship` file people keep: its name, size and whole-file SHA-256. */
    val bundleFileName: String = com.flagshipserver.app.core.ServerBackupFormat.bundleFileName(dataFileName),
    val bundleBytes: Long = 0,
    val bundleSha256: String = "",
    val apps: List<ServerArchiveApp> = emptyList(),
    val left: List<ServerArchiveLeftApp> = emptyList(),
) {
    /** What the backup takes: the one file (or its two parts on a box from before it). */
    val totalBytes: Long get() = if (bundleBytes > 0) bundleBytes else bytes + backupBytes
}

/** `GET /api/screens/server-archive/backups` (and every write's answer). */
@Serializable
data class SavedBackupsView(
    val schedule: BackupSchedule = BackupSchedule(),
    /** False while the policy is "none": the schedule doesn't run (Back up now still does). */
    val scheduleActive: Boolean = true,
    val nextRunAt: Long? = null,
    val lastRun: BackupLastRun? = null,
    val running: BackupRunning? = null,
    val keysLeft: Int = 0,
    val keysWanted: Int = 0,
    val waitingReason: String? = null,
    val usedBytes: Long = 0,
    /** Newest first. */
    val backups: List<SavedBackup> = emptyList(),
)

@Serializable
data class BackupKeysRequest(val deposit: ArchiveKeysDeposit, val signature: String, val keys: List<ArchiveKey>)

@Serializable
data class BackupRunResponse(val archiveId: String)

/** `POST .../backups/<id>/link`: the browser download page (approved like Back up now's). */
@Serializable
data class SavedBackupLink(
    val path: String,
    val backupFileName: String,
    val dataFileName: String,
    val bytes: Long,
    val sha256: String,
    val bundleFileName: String? = null,
    val bundleBytes: Long? = null,
    val bundleSha256: String? = null,
    val expiresAt: Long? = null,
)

/** `policy`: `unset` | `phone` | `peer` | `none`. */
@Serializable
data class BackupPolicyState(
    val policy: String = "unset",
    val phoneReserveBytes: Long = 0,
    val issuedAt: Long? = null,
)

@Serializable
data class BackupCapApp(val serviceId: String, val bytes: Long)

/** The size limit the policy puts on the server's app data. */
@Serializable
data class BackupCap(
    val limitBytes: Long? = null,
    val usedBytes: Long? = null,
    val measuredAt: Long? = null,
    val overLimit: Boolean = false,
    val diskBytes: Long = 0,
    val reservedForPeersBytes: Long? = null,
    val apps: List<BackupCapApp> = emptyList(),
    val overReason: String? = null,
)

/** The peer engine's status while the policy is "peer" (null otherwise).
 *  Read leniently ([from]): the engine owns this shape. */
data class PeerBackupStatus(
    /** `waiting-for-peers` | `filling` | `placing` | `protected` | `at-risk` | `leaving` | `off` */
    val state: String = "off",
    val lastPlacedAt: Long? = null,
    val healthyBricks: Int = 0,
    val totalBricks: Int = 0,
    val hostingBytes: Long = 0,
    val provenBytes: Long = 0,
    val poolBytes: Long = 0,
    val holders: Int = 0,
    val archiveId: String? = null,
    val reason: String? = null,
) {
    companion object {
        fun from(o: JsonObject?): PeerBackupStatus? {
            o ?: return null
            fun str(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
            fun num(k: String): Long? = (o[k] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toDoubleOrNull()?.toLong()
            val holders = (o["holders"] as? JsonArray)?.size ?: num("holders")?.toInt() ?: 0
            return PeerBackupStatus(
                state = str("state") ?: "off",
                lastPlacedAt = num("lastPlacedAt"),
                healthyBricks = num("healthyBricks")?.toInt() ?: 0,
                totalBricks = num("totalBricks")?.toInt() ?: 0,
                hostingBytes = num("hostingBytes") ?: 0,
                provenBytes = num("provenBytes") ?: 0,
                poolBytes = num("poolBytes") ?: 0,
                holders = holders,
                archiveId = str("archiveId"),
                reason = str("reason"),
            )
        }
    }
}

/** `GET/POST /api/screens/backup-policy`. */
@Serializable
data class BackupPolicyView(
    val policy: BackupPolicyState = BackupPolicyState(),
    val cap: BackupCap = BackupCap(),
    @kotlinx.serialization.SerialName("peer") val peerJson: JsonObject? = null,
) {
    val peer: PeerBackupStatus? get() = PeerBackupStatus.from(peerJson)
}

@Serializable
data class BackupPolicyRequest(val order: BackupPolicyOrder, val signatureHex: String)
