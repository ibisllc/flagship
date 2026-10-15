// "Backup/clone server" (docs/server-backup-and-clone.md): the sealed archive a
// box makes of all its apps, and the import of one onto a box.
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
    val bytes: Long? = null,
    val sha256: String? = null,
    val apps: List<ServerArchiveApp>? = null,
    val reason: String? = null,
)

@Serializable
data class ServerArchiveStatusResponse(val archive: ServerArchiveStatus? = null)

/** `key` is the 32-byte key this device derived for the archive, lowercase hex. */
@Serializable
data class ServerArchiveStartRequest(val archiveId: String, val key: String)

@Serializable
data class ServerRestoreStartRequest(val archiveId: String, val bytes: Long)

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

/** `uploading` | `ready` | `opening` | `restoring` | `done` | `failed` */
@Serializable
data class ServerRestoreStatus(
    val archiveId: String,
    val state: String,
    val bytes: Long = 0,
    val received: Long = 0,
    val apps: List<ServerRestoreApp> = emptyList(),
    val reason: String? = null,
)

@Serializable
data class ServerRestoreStatusResponse(val restore: ServerRestoreStatus? = null)

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
