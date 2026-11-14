// Kotlin port of packages/protocol/src/serverRestoreMerge.ts: the canonical bytes of the
// restore-into-server orders (docs/restore-into-server.md §4) and the plan's digest. Must pass
// packages/protocol/test-vectors/server-restore-merge. All three are sensitive orders: an admin
// device signs them with the account's admin root.
package com.flagshipserver.app.core

import java.security.MessageDigest

object ServerRestoreMerge {
    const val TAG_STAGE = "flagship/server-restore-stage/v1"
    const val TAG_MERGE = "flagship/server-restore-merge/v1"
    const val TAG_UNDO = "flagship/app-restore-undo/v1"
    const val PLAN_MAX_TTL_MS = 24L * 60 * 60_000

    val SOURCES = setOf("upload", "saved", "pull", "peers")
    val ACTIONS = setOf("install", "skip", "keep", "replace", "replace-data", "copy")

    data class StageOrder(val serverDomain: String, val archiveId: String, val bytes: Long, val sha256: String, val source: String, val issuedAt: Long)

    data class PlanLine(
        val archivedServiceId: String,
        val action: String,
        val targetServiceId: String? = null,
        val sameApp: Boolean = false,
        val guardCode: String? = null,
        val guardSchema: String? = null,
        val guardGen: Int? = null,
    )

    data class MergeOrder(
        val serverDomain: String,
        val restoreId: String,
        val archiveId: String,
        val sha256: String,
        val planSha256: String,
        val issuedAt: Long,
        val expiresAt: Long,
    )

    data class UndoOrder(val serverDomain: String, val restoreId: String, val serviceId: String, val action: String, val issuedAt: Long)

    private val HEX32 = Regex("^[0-9a-f]{32}$")
    private val HEX64 = Regex("^[0-9a-f]{64}$")
    private const val LABEL = "[a-z0-9](?:-?[a-z0-9]){0,31}"
    private val SERVICE_ID = Regex("^$LABEL--$LABEL$")
    private val CODE_DIGEST = Regex("^(?:tree|sha256|wasi|manifest):[0-9a-f]{64}$")

    private fun domain(d: String, tag: String) = require(d.isNotEmpty() && !d.contains('|')) { "$tag: bad serverDomain" }

    fun stageBytes(o: StageOrder): ByteArray {
        domain(o.serverDomain, TAG_STAGE)
        require(HEX32.matches(o.archiveId) && o.bytes >= 1 && HEX64.matches(o.sha256) && o.source in SOURCES && o.issuedAt >= 0) { "$TAG_STAGE: bad order" }
        return listOf(TAG_STAGE, o.serverDomain, o.archiveId, o.bytes.toString(), o.sha256, o.source, o.issuedAt.toString()).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun lineString(l: PlanLine): String {
        require(SERVICE_ID.matches(l.archivedServiceId) && l.action in ACTIONS) { "restore plan: bad line" }
        if (l.action == "copy") require(l.targetServiceId != null && SERVICE_ID.matches(l.targetServiceId)) { "restore plan: a copy names its new app" }
        else require(l.targetServiceId == null) { "restore plan: only a copy names a new app" }
        require(!l.sameApp || l.action == "replace") { "restore plan: bad sameApp" }
        if (l.action == "replace" || l.action == "replace-data") {
            require(l.guardCode != null && CODE_DIGEST.matches(l.guardCode) && l.guardSchema != null && HEX64.matches(l.guardSchema) && l.guardGen != null && l.guardGen in 0..999_999) { "restore plan: bad guards" }
        } else {
            require(l.guardCode == null && l.guardSchema == null && l.guardGen == null) { "restore plan: guards on an unguarded line" }
        }
        return listOf(l.archivedServiceId, l.action, l.targetServiceId ?: "-", if (l.sameApp) "1" else "0", l.guardCode ?: "-", l.guardSchema ?: "-", l.guardGen?.toString() ?: "-").joinToString("|")
    }

    /** SHA-256 hex of the lines sorted by archived id and joined with "\n" (ids are ASCII, so String order is byte order). */
    fun planSha256(lines: List<PlanLine>): String {
        require(lines.isNotEmpty() && lines.size <= 500) { "restore plan: bad number of lines" }
        val sorted = lines.sortedBy { it.archivedServiceId }
        for (i in 1 until sorted.size) require(sorted[i].archivedServiceId != sorted[i - 1].archivedServiceId) { "restore plan: an app named twice" }
        val joined = sorted.joinToString("\n") { lineString(it) }
        return MessageDigest.getInstance("SHA-256").digest(joined.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    fun mergeBytes(o: MergeOrder): ByteArray {
        domain(o.serverDomain, TAG_MERGE)
        require(
            HEX32.matches(o.restoreId) && HEX32.matches(o.archiveId) && HEX64.matches(o.sha256) && HEX64.matches(o.planSha256) &&
                o.issuedAt >= 0 && o.expiresAt > o.issuedAt && o.expiresAt - o.issuedAt <= PLAN_MAX_TTL_MS,
        ) { "$TAG_MERGE: bad order" }
        return listOf(TAG_MERGE, o.serverDomain, o.restoreId, o.archiveId, o.sha256, o.planSha256, o.issuedAt.toString(), o.expiresAt.toString()).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun undoBytes(o: UndoOrder): ByteArray {
        domain(o.serverDomain, TAG_UNDO)
        require(HEX32.matches(o.restoreId) && SERVICE_ID.matches(o.serviceId) && (o.action == "undo" || o.action == "discard") && o.issuedAt >= 0) { "$TAG_UNDO: bad order" }
        return listOf(TAG_UNDO, o.serverDomain, o.restoreId, o.serviceId, o.action, o.issuedAt.toString()).joinToString("|").toByteArray(Charsets.UTF_8)
    }
}
