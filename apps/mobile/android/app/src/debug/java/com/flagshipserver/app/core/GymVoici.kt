// The UI gym's voi.ci world (docs/voici-and-messages.md): one in-memory `.com` per launch that knows the gym
// account (its admin root is GymSeams' fixed one), a second account "ana-page" with a published page to sign in
// to, a grant for this device so a non-admin run can hand drafts over, and a scripted voi.ci tab for "Sign in with
// Flagship". NO BACKEND.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.MockVoiciClient
import com.flagshipserver.app.api.VoiciAccountKeys
import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.VoiciOwner
import com.flagshipserver.app.core.voici.VoiciOwnerKeys
import com.flagshipserver.app.core.voici.VoiciPage
import com.flagshipserver.app.core.voici.VoiciPageIndexBody
import com.flagshipserver.app.core.voici.VoiciPieceRef
import com.flagshipserver.app.core.voici.VoiciSignInLink
import com.flagshipserver.app.core.voici.VoiciSignInPipe
import com.flagshipserver.app.core.voici.VoiciSignInRequest
import com.flagshipserver.app.keystore.Keystore
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

object GymVoici {
    const val OTHER = "ana-page"
    val OTHER_ROOT: ByteArray = ByteArray(32) { 0x3A }
    val OTHER_UMK: ByteArray = ByteArray(32) { 0x3B }
    /** A visitor account that writes to the gym account's page. */
    val VISITOR_UMK: ByteArray = ByteArray(32) { 0x4C }
    val BROWSER_PRIV: ByteArray = ByteArray(32) { 0x22 }

    @Volatile var client = MockVoiciClient()
        private set
    /** Ana's pageId (fixed, so a scenario can build the sign-in link before it launches). */
    val otherPageId: String = "a1".repeat(16)
    /** The answer the scripted voi.ci tab received, and what it sent. */
    @Volatile var delivered: ByteArray? = null
    @Volatile var lastRequest: VoiciSignInRequest? = null

    fun reset(username: String, deviceId: String?) {
        val c = MockVoiciClient()
        client = c
        delivered = null
        lastRequest = null
        val umk = Keystore.loadOrCreateUmkSeed()
        val irk = VoiciJs.hex(VoiciJs.edPub(VoiciJs.hkdf32(umk, "gym-irk")))
        c.accounts[username] = VoiciAccountKeys(irk, VoiciJs.hex(GymSeams.gymAdminRootPub))
        val dev = deviceId?.takeIf { Regex("^[0-9a-f]{32}$").matches(it) } ?: "d0".repeat(16)
        val pub = VoiciJs.hex(Keystore.accountDevicePublicKey(umk, username, dev))
        val now = System.currentTimeMillis()
        val scopes = listOf("member")
        val grantId = "gym-voici-grant"
        val bytes = DeviceCapabilityGrant.canonicalBytes(grantId, username, dev, pub, scopes, now - 60_000, now + 86_400_000)
        c.grants[username] = listOf(
            JsonObject(
                linkedMapOf(
                    "grantId" to JsonPrimitive(grantId), "username" to JsonPrimitive(username), "deviceId" to JsonPrimitive(dev),
                    "devicePubHex" to JsonPrimitive(pub), "scopes" to JsonArray(scopes.map { JsonPrimitive(it) }),
                    "issuedAt" to JsonPrimitive(now - 60_000), "expiresAt" to JsonPrimitive(now + 86_400_000),
                    "signatureHex" to JsonPrimitive(VoiciJs.hex(VoiciJs.edSign(GymSeams.GYM_ADMIN_ROOT_SEED, bytes))),
                    "signerRoot" to JsonPrimitive("admin-root"),
                ),
            ),
        )
        seedOtherPage(c)
    }

    /** "Ana" published a page that accepts messages. */
    private fun seedOtherPage(c: MockVoiciClient) {
        val root = VoiciJs.hex(VoiciJs.edPub(OTHER_ROOT))
        c.accounts[OTHER] = VoiciAccountKeys(root, root)
        val pageId = otherPageId
        val profile = VoiciOwner.defaultProfile("Ana").copy(bio = "Gardener and photographer.")
        val bytes = VoiciOwner.profileBytes(profile)
        val sha = com.flagshipserver.app.core.voici.WebEnvelopes.sha256Hex(bytes)
        c.pieces["$pageId/$sha"] = bytes
        val keys = VoiciOwnerKeys.derive(OTHER_UMK, pageId, 1)
        val body = VoiciPageIndexBody(OTHER, pageId, 1, System.currentTimeMillis(), 1, 1, keys.inboxPub, keys.signPub, listOf(VoiciPieceRef("profile", sha, bytes.size.toLong())), "admin-root")
        runBlocking { c.publish(OTHER, VoiciPage.signVoiciPageIndex(body, OTHER_ROOT).toJson()) }
    }

    /** The link a voi.ci tab on Ana's page would show (C's fragment form: the browser key and nonce ride in it). */
    fun signInLink(): String {
        val pk = ByteArray(32) { 0x55 }
        val b = VoiciJs.hex(VoiciJs.p256PublicKey(BROWSER_PRIV))
        return Endpoints.controlBaseUrl + "/voici-sign-in#s=gymvoicisid01&k=${Base64URL.encode(pk)}&p=$otherPageId&u=$OTHER&d=$b&n=${"cd".repeat(16)}"
    }

    /** Ana answers the gym account's conversation on her page (the reply the visitor's app should notice). */
    fun anaReplies(text: String = "Thanks for writing!") {
        val umk = Keystore.loadOrCreateUmkSeed()
        val v = com.flagshipserver.app.core.voici.VoiciVisitorKeys.derive(umk, otherPageId)
        val conv = com.flagshipserver.app.core.voici.StoredVoiciConversation(
            com.flagshipserver.app.core.voici.VoiciMessages.voiciConv(otherPageId, v.pseudonymPub), otherPageId, v.pseudonymPub, v.threadPub,
        )
        val env = VoiciOwner.reply(VoiciOwnerKeys.derive(OTHER_UMK, otherPageId, 1), conv, text, null, 1, System.currentTimeMillis())
        runBlocking { client.send(env.toJson()) }
    }

    /** The voi.ci tab, played in process: it shows 482 913 and keeps what the app answers. */
    fun pipe(): VoiciSignInPipe = object : VoiciSignInPipe {
        override suspend fun connect(link: VoiciSignInLink): String {
            lastRequest = link.request(Endpoints.voiciOrigin)
            return "482913"
        }

        override suspend fun deliver(answer: ByteArray) {
            delivered = answer
        }

        override fun close() {}
    }
}
