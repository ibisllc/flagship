// "Access & permissions" for one app (SECURITY-HARDENING-PLAN.md 18.5, N05). Kotlin mirror of
// FlagshipAPI/ServicePermissions.swift and the webapp's lib/permissions.js.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import kotlinx.serialization.Serializable

@Serializable
data class ServicePermissionGrant(
    val id: String,
    val kind: String,
    val capability: String,
    val issuedAt: Long = 0,
    val expiresAt: Long? = null,
    val secretAccess: Boolean = false,
    val openWork: List<String> = emptyList(),
)

@Serializable
data class ServicePermissionOperation(val id: String, val kind: String, val state: String)

@Serializable
data class ServicePermissions(
    val grants: List<ServicePermissionGrant> = emptyList(),
    val pendingOperations: List<ServicePermissionOperation> = emptyList(),
)

@Serializable
data class PermissionRevokeResult(
    val revoked: Int = 0,
    val stoppedWork: List<String> = emptyList(),
    val stuckWork: List<String> = emptyList(),
)

@Serializable
data class PermissionRevokeBody(val grantId: String? = null)

object PermissionWords {
    val TITLE get() = FSStrings.get(R.string.access_permissions)
    val NONE get() = FSStrings.get(R.string.nothing_can_act_for_this_app)
    val REVOKE get() = FSStrings.get(R.string.end_this_access)
    val REVOKE_ALL get() = FSStrings.get(R.string.end_all_access)
    val STUCK get() = FSStrings.get(R.string.some_work_did_not_stop_yet)

    fun kindLabel(kind: String): String = when (kind) {
        "owner-session" -> FSStrings.get(R.string.owner_session)
        "companion-session" -> FSStrings.get(R.string.browser_or_companion_session)
        "app-api-key" -> FSStrings.get(R.string.app_api_key)
        "mcp-key" -> FSStrings.get(R.string.ide_key)
        "build-token" -> "Build"
        "share" -> FSStrings.get(R.string.shared_server)
        "member-invite" -> "Invitation"
        "browser-grant" -> FSStrings.get(R.string.browser_access)
        "secret-handle" -> "Secret"
        "stream-ticket" -> "Stream"
        "job" -> FSStrings.get(R.string.background_job)
        else -> kind
    }

    fun outcome(r: PermissionRevokeResult): String {
        val base = if (r.revoked == 1) FSStrings.get(R.string.access_ended) else FSStrings.get(R.string.accesses_ended, r.revoked)
        return if (r.stuckWork.isEmpty()) base else "$base $STUCK ${r.stuckWork.joinToString(", ")}"
    }
}
