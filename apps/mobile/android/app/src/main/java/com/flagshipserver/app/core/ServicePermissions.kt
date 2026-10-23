// "Access & permissions" for one app (SECURITY-HARDENING-PLAN.md 18.5, N05). Kotlin mirror of
// FlagshipAPI/ServicePermissions.swift and the webapp's lib/permissions.js.

package com.flagshipserver.app.core

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
    const val TITLE = "Access & permissions"
    const val NONE = "Nothing can act for this app right now."
    const val REVOKE = "End this access"
    const val REVOKE_ALL = "End all access"
    const val STUCK = "Some work did not stop yet:"

    fun kindLabel(kind: String): String = when (kind) {
        "owner-session" -> "Owner session"
        "companion-session" -> "Browser or companion session"
        "app-api-key" -> "App API key"
        "mcp-key" -> "IDE key"
        "build-token" -> "Build"
        "share" -> "Shared server"
        "member-invite" -> "Invitation"
        "browser-grant" -> "Browser access"
        "secret-handle" -> "Secret"
        "stream-ticket" -> "Stream"
        "job" -> "Background job"
        else -> kind
    }

    fun outcome(r: PermissionRevokeResult): String {
        val base = if (r.revoked == 1) "Access ended." else "${r.revoked} accesses ended."
        return if (r.stuckWork.isEmpty()) base else "$base $STUCK ${r.stuckWork.joinToString(", ")}"
    }
}
