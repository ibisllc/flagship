// Calling from the app with the browser's WebRTC (docs/voici-calls.md "Calling from the app"): the Kotlin twin of the
// handoff section of packages/protocol/src/voiciCalls.ts (vectors: test-vectors/voici-calls/vectors.json `handoff`).
// When this build's media engine is missing, the app signs a short-lived voi.ci session for the callee's page (its
// own pseudonym there, a delegation to a P-256 key made for this one call) and hands it to
// `https://voi.ci/<callee>#call=<sid>.<k>` over /qr-pipe: k is an X25519 secret the app made for the browser, the app
// says `hello` with its own key and delivers the handoff sealed under the pipe key (the sign-in construction). The
// relay consumes the session on delivery, so the ticket is one-use.

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.core.Base64URL
import com.flagshipserver.app.core.QrRelay
import com.google.crypto.tink.subtle.X25519
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

data class VoiciCallHandoffSealed(val phonePk: String, val nonce: String, val ciphertext: String)

object VoiciCallHandoff {
    const val TAG = "flagship/voici-call-handoff/v1"
    /** A handoff lives 5 minutes; the session inside at most 10 (one call, then it lapses). */
    const val TTL_MS = 5 * 60_000L
    const val SESSION_MS = 10 * 60_000L
    private val USERNAME = Regex("^[a-z0-9](?:-?[a-z0-9]){0,31}$")
    private val SID = Regex("^[A-Za-z0-9_-]{1,64}$")

    /** The delegate's public key (uncompressed SEC1 hex) for a 32-byte P-256 scalar. */
    fun delegatePub(delegatePriv: ByteArray): String = VoiciJs.hex(VoiciJs.p256PublicKey(delegatePriv))

    /** The handoff record (exact keys); [signIn] is a flagship/voici-sign-in/v1 answer naming [delegatePriv]'s key. */
    fun build(username: String, pageId: String, media: String, issuedAt: Long, expiresAt: Long, delegatePriv: ByteArray, signIn: JsonObject): JsonObject {
        require(USERNAME.matches(username) && Regex("^[0-9a-f]{32}$").matches(pageId) && media in VoiciCalls.MEDIA_VALUES) { TAG }
        require(expiresAt > issuedAt && expiresAt - issuedAt <= TTL_MS && delegatePriv.size == 32) { TAG }
        return JsonObject(
            linkedMapOf(
                "kind" to JsonPrimitive(TAG),
                "username" to JsonPrimitive(username),
                "pageId" to JsonPrimitive(pageId),
                "media" to JsonPrimitive(media),
                "issuedAt" to JsonPrimitive(issuedAt),
                "expiresAt" to JsonPrimitive(expiresAt),
                "delegatePriv" to JsonPrimitive(VoiciJs.hex(delegatePriv)),
                "signIn" to signIn,
            ),
        )
    }

    /** `https://<host>/<username>#call=<sid>.<browser X25519 secret>` (both base64url). */
    fun link(host: String, username: String, sid: String, browserSecret: ByteArray): String {
        require(USERNAME.matches(username) && SID.matches(sid) && browserSecret.size == 32) { TAG }
        return "https://$host/$username#call=$sid.${Base64URL.encode(browserSecret)}"
    }

    /** The pipe key (HKDF(X25519, "flagship/qr/v1", "flagship/qr/enc/v1")), as the sign-in pipe derives it. */
    fun pipeKey(mySecret: ByteArray, peerPub: ByteArray): ByteArray =
        QrRelay.hkdfSha256(X25519.computeSharedSecret(mySecret, peerPub), "flagship/qr/v1".toByteArray(), "flagship/qr/enc/v1".toByteArray(), 32)

    /** The app's delivery: the handoff's canonical JSON sealed under the pipe key with [nonce] (12 bytes). */
    fun seal(handoff: JsonObject, appSecret: ByteArray, browserSecret: ByteArray, nonce: ByteArray): VoiciCallHandoffSealed {
        require(nonce.size == 12)
        val key = pipeKey(appSecret, X25519.publicFromPrivate(browserSecret))
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        val ct = c.doFinal(WebEnvelopes.canonicalJsonBytes(handoff))
        key.fill(0)
        return VoiciCallHandoffSealed(Base64URL.encode(X25519.publicFromPrivate(appSecret)), Base64URL.encode(nonce), Base64URL.encode(ct))
    }

    /** voi.ci's host for a link, from the configured origin ("https://voi.ci" → "voi.ci"). */
    fun host(origin: String): String = origin.removePrefix("https://").trimEnd('/')
}
