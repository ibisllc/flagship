package com.flagshipserver.app.api

import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.HttpClientFactory
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.OkHttpJsonTransport
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.net.URLEncoder

/**
 * Mock-mode box + `.com` for Access control (iOS MockServiceAccessClient's
 * twin): each app starts open to all with no invites; a signed mode change,
 * create or revoke takes effect in memory (a create is member-tier unless the
 * gym seeds an admin device). Never touches the network, so a demo or gym session
 * doesn't call a real box with a made-up name.
 */
class MockServiceAccessClient : ServiceAccessClient() {
    private val modes = mutableMapOf<String, String>()
    private val invites = mutableListOf<ServiceInviteRow>()

    override suspend fun getAccessState(serverDomain: String, serviceRef: String): ServiceAccessState =
        ServiceAccessState(modes[serviceRef] ?: "open", 0)

    override suspend fun setAccessMode(serverDomain: String, request: JsonObject, signatureHex: String): String {
        val ref = request["serviceRef"]?.jsonPrimitive?.contentOrNull
            ?: request["serviceId"]?.jsonPrimitive?.contentOrNull ?: ""
        val mode = request["mode"]?.jsonPrimitive?.contentOrNull ?: "open"
        modes[ref] = mode
        return mode
    }

    override suspend fun removeServiceAllow(serverDomain: String, request: JsonObject, signatureHex: String): Boolean = true

    override suspend fun withdrawInvite(serverDomain: String, revoke: JsonObject, signatureHex: String): Int = 0

    override suspend fun listInvites(
        username: String,
        authorAidHex: String,
        issuedAt: Long,
        sigHex: String,
    ): List<ServiceInviteRow> = invites.toList()

    override suspend fun createInvite(username: String, request: JsonObject, signatureHex: String) {
        fun str(k: String) = request[k]?.jsonPrimitive?.contentOrNull
        invites += ServiceInviteRow(
            inviteId = str("inviteId") ?: return,
            serviceRef = str("serviceRef") ?: return,
            encryptedBundleHex = str("encryptedBundle") ?: return,
            boundAidHex = null,
            boundAt = null,
            createdAt = str("issuedAt")?.toLongOrNull(),
            revokedAt = null,
            maxRedemptions = str("maxRedemptions")?.toIntOrNull(),
            expiresAt = str("expiresAt")?.toLongOrNull(),
            approvalMode = str("approvalMode"),
            creatorTier = if (com.flagshipserver.app.core.GymSeams.forceAdminRoot) "admin" else "member",
            creatorDeviceId = str("deviceId"),
        )
    }

    override suspend fun revokeInvite(username: String, request: JsonObject, signatureHex: String) {
        val id = request["inviteId"]?.jsonPrimitive?.contentOrNull ?: return
        val at = request["issuedAt"]?.jsonPrimitive?.longOrNull ?: System.currentTimeMillis()
        invites.replaceAll { if (it.inviteId == id) it.copy(revokedAt = at) else it }
    }

    companion object {
        /** One per process, so a mode change survives leaving the screen. */
        val shared = MockServiceAccessClient()
    }
}
