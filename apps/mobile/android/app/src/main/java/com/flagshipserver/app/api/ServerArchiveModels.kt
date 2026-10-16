// "Backup/clone server" (docs/server-backup-and-clone.md): the two files a box
// makes of all its apps, and the restore of them onto a new server made to wait
// for them.
// MIRRORS: apps/mobile/shared/Sources/FlagshipAPI/Models/ServerArchiveModels.swift

package com.flagshipserver.app.api

import kotlinx.serialization.Serializable

@Serializable
data class ServerArchiveApp(val serviceId: String, val name: String)

@Serializable
data class ServerArchiveProgress(val done: Int = 0, val total: Int = 0, val app: String = "")

/** `building` | `ready` | `failed` */
@Serializable
data class ServerArchiveStatus(
    val archiveId: String,
    val state: String,
    val startedAt: Long = 0,
    val progress: ServerArchiveProgress? = null,
    /** The data file's size and SHA-256. */
    val bytes: Long? = null,
    val sha256: String? = null,
    /** The names the two files are saved under. */
    val backupFileName: String? = null,
    val dataFileName: String? = null,
    val apps: List<ServerArchiveApp>? = null,
    /** Apps that couldn't go in (no source to rebuild from), with why. */
    val left: List<ServerArchiveLeftApp>? = null,
    val reason: String? = null,
)

@Serializable
data class ServerArchiveLeftApp(val serviceId: String, val name: String, val reason: String)

@Serializable
data class ServerArchiveStatusResponse(val archive: ServerArchiveStatus? = null)

/** One key slot of a backup file: the content key wrapped under a passcode
 *  (Argon2id) or under the account's archive key (packages/protocol/src/serverBackup.ts). */
@Serializable
data class ServerBackupKdf(
    val algo: String = "argon2id",
    val m: Int,
    val t: Int,
    val p: Int,
    val saltHex: String,
)

@Serializable
data class ServerBackupSlot(
    /** `passcode` | `account` */
    val kind: String,
    val kdf: ServerBackupKdf? = null,
    val nonceHex: String,
    val wrappedHex: String,
)

/** `key` is the random content key this device made for the backup, lowercase
 *  hex; `slots` are the key slots the box writes into the backup file. */
@Serializable
data class ServerArchiveStartRequest(val archiveId: String, val key: String, val slots: List<ServerBackupSlot>)

@Serializable
data class ServerRestoreStartRequest(val archiveId: String, val bytes: Long)

/** How much of the data file the server already holds: the upload goes on from here. */
@Serializable
data class ServerRestoreStartResponse(val received: Long = 0)

@Serializable
data class ServerRestoreCommitRequest(val key: String)

/** `waiting` | `restoring` | `done` | `skipped` | `failed` */
@Serializable
data class ServerRestoreApp(
    val serviceId: String,
    val name: String,
    val state: String,
    val reason: String? = null,
)

/** `uploading` | `ready` | `checking` | `restoring` | `done` | `failed` */
@Serializable
data class ServerRestoreStatus(
    val archiveId: String,
    val state: String,
    val bytes: Long = 0,
    val received: Long = 0,
    val apps: List<ServerRestoreApp> = emptyList(),
    val reason: String? = null,
)

/** The backup a server created to restore one is waiting for. */
@Serializable
data class ServerRestoreWaiting(val archiveId: String, val bytes: Long, val sha256: String)

/** `GET /api/screens/server-restore`. */
@Serializable
data class ServerRestoreStatusResponse(
    val waiting: ServerRestoreWaiting? = null,
    val restore: ServerRestoreStatus? = null,
)

/** One entry of the box's own activity log (`GET /api/screens/activity`). */
@Serializable
data class BoxActivityActor(val kind: String = "owner", val label: String? = null)

@Serializable
data class BoxActivityEntry(
    val seq: Int? = null,
    val ts: Long,
    val actor: BoxActivityActor? = null,
    val action: String,
    val kind: String? = null,
    val detail: String? = null,
    val target: String? = null,
    val ok: Boolean = true,
)

@Serializable
data class BoxActivityResponse(val entries: List<BoxActivityEntry> = emptyList())

/** The owner's approval to download a server backup in a browser
 *  (`flagship/archive-download/v1`). Must pass
 *  packages/protocol/test-vectors/archive-download/vectors.json. */
@Serializable
data class ArchiveDownloadApproval(
    val serverDomain: String,
    val archiveId: String,
    val requestId: String,
    val issuedAt: Long,
) {
    fun canonicalBytes(): ByteArray =
        listOf(TAG, serverDomain, archiveId, requestId, issuedAt.toString()).joinToString("|").toByteArray(Charsets.UTF_8)

    companion object {
        const val TAG = "flagship/archive-download/v1"
        private val ID = Regex("^[0-9a-f]{32}$")
        fun isId(s: String) = ID.matches(s)

        /** The 6-digit code the browser page shows for this request. */
        fun code(requestId: String): String =
            (requestId.take(8).toLong(16) % 1_000_000).toString().padStart(6, '0')
    }
}

@Serializable
data class ServerArchiveApproveRequest(val approval: ArchiveDownloadApproval, val signature: String)
