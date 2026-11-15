// Restore a backup into a running server (docs/restore-into-server.md §6): the box's view and the
// bodies of its orders. `GET /api/screens/server-restore-merge` answers [RestoreMergeView].
// MIRRORS the iOS RestoreMergeModels.

package com.flagshipserver.app.api

import kotlinx.serialization.Serializable

@Serializable
data class RestoreMergeView(
    val stage: RestoreMergeStage? = null,
    val preview: RestoreMergePreview? = null,
    val run: RestoreMergeRun? = null,
    val undo: List<RestoreMergeUndoPoint> = emptyList(),
)

/** `state`: receiving | ready | checking | previewed | failed | running. */
@Serializable
data class RestoreMergeStage(
    val restoreId: String,
    val archiveId: String,
    val source: String,
    val bytes: Long,
    val received: Long = 0,
    val state: String,
    val reason: String? = null,
)

@Serializable
data class RestoreMergePreview(
    val restoreId: String,
    val backup: Backup = Backup(),
    val apps: List<RestoreMergeApp> = emptyList(),
) {
    @Serializable
    data class Backup(val createdAt: Long? = null, val sourceServer: String? = null)
}

@Serializable
data class RestoreMergeApp(
    val archivedServiceId: String,
    val name: String,
    val targetServiceId: String,
    /** new | runs-elsewhere | same | clash | clash-maybe */
    val verdict: String,
    /** same | backup-older | backup-newer | diverged | unknown */
    val code: String = "unknown",
    val codeByVersion: Boolean = false,
    val schema: String? = null,
    val backup: Side,
    val box: Side? = null,
    val alsoOn: List<String> = emptyList(),
    val addressMoves: Boolean = false,
    val allowed: List<String> = emptyList(),
    val disallowed: Map<String, String> = emptyMap(),
    val recommended: String,
    val copyServiceId: String? = null,
    val guards: Guards? = null,
) {
    @Serializable
    data class Side(
        val version: String = "",
        val bytes: Long? = null,
        val installedAt: Long? = null,
        val hasDatabase: Boolean? = null,
        val hasFiles: Boolean? = null,
    )

    @Serializable
    data class Guards(val guardCode: String, val guardSchema: String, val guardGen: Int)
}

/** `state`: running | done. */
@Serializable
data class RestoreMergeRun(
    val restoreId: String,
    val state: String,
    val apps: List<App> = emptyList(),
) {
    /** `step`: waiting … done | failed | kept | skipped | refused-changed. */
    @Serializable
    data class App(
        val archivedServiceId: String,
        val action: String,
        val targetServiceId: String,
        val step: String,
        val reason: String? = null,
    )
}

@Serializable
data class RestoreMergeUndoPoint(
    val serviceId: String,
    val name: String,
    val restoreId: String,
    val keptAt: Long,
    val expiresAt: Long,
) {
    val id: String get() = "$restoreId/$serviceId"
}

/** A plan line as the box reads it (absent fields left out: the client's JSON drops nulls). */
@Serializable
data class RestoreMergeLine(
    val archivedServiceId: String,
    val action: String,
    val targetServiceId: String? = null,
    val sameApp: Boolean = false,
    val guardCode: String? = null,
    val guardSchema: String? = null,
    val guardGen: Int? = null,
)

@Serializable
data class RestoreMergeStageOrder(
    val serverDomain: String,
    val archiveId: String,
    val bytes: Long,
    val sha256: String,
    val source: String,
    val issuedAt: Long,
)

@Serializable
data class RestoreMergePlanOrder(
    val serverDomain: String,
    val restoreId: String,
    val archiveId: String,
    val sha256: String,
    val planSha256: String,
    val issuedAt: Long,
    val expiresAt: Long,
)

@Serializable
data class RestoreMergeUndoOrder(
    val serverDomain: String,
    val restoreId: String,
    val serviceId: String,
    val action: String,
    val issuedAt: Long,
)

/** `pqSignature`: the signer's hybrid half; a quantum-safe (strict) box refuses the order without it. */
@Serializable
data class RestoreMergeStageRequest(val order: RestoreMergeStageOrder, val signatureHex: String, val pqSignature: PqSignatureWire? = null)

@Serializable
data class RestoreMergePlanRequest(val order: RestoreMergePlanOrder, val signatureHex: String, val lines: List<RestoreMergeLine>, val pqSignature: PqSignatureWire? = null)

@Serializable
data class RestoreMergeUndoRequest(val order: RestoreMergeUndoOrder, val signatureHex: String, val pqSignature: PqSignatureWire? = null)

@Serializable
data class RestoreMergeStarted(val restoreId: String, val received: Long = 0)
