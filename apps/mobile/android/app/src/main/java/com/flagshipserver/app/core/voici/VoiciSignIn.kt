// "Sign in with Flagship" on the visitor's app (docs/voici-and-messages.md §6, §11.4; the "C:" note in §6.5). A
// voi.ci tab shows `https://<control apex>/voici-sign-in#s=<sid>&k=<browser X25519>&p=<pageId>&u=<username>&d=<B>
// &n=<nonce>`: the browser key B and the nonce ride in the link (the /qr-pipe relay is one-way). This phone forms the
// sign-in request from those fields, joins the pipe as `phone`, both screens show the same 6-digit code, the person
// approves with the biometric, and the phone answers in one sealed frame with the pseudonym P, `.com`'s attestation
// of P, a web delegation P → B and the thread key. Reference reader: parseSignInLink in packages/flagship-web.

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.core.Base64URL
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.PairingSocket
import com.flagshipserver.app.core.QrSession
import com.flagshipserver.app.core.asTerminalError
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import java.net.URLEncoder

/** The parsed sign-in link: the pipe, the page, and the browser's key B and nonce. */
data class VoiciSignInLink(
    val sid: String,
    val browserPk: ByteArray,
    val pageId: String,
    val username: String,
    val delegatePub: String,
    val nonce: String,
) {
    /** The request the browser would have sent, with this app's configured voi.ci origin. */
    fun request(origin: String) = VoiciSignInRequest(origin, pageId, username, delegatePub, nonce)

    companion object {
        private val PAGE = Regex("^[0-9a-f]{32}$")
        private val USER = Regex("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
        private val SID = Regex("^[A-Za-z0-9_-]{1,64}$")
        private val B = Regex("^04[0-9a-f]{128}$")
        private val NONCE = Regex("^[0-9a-f]{32}$")

        /** `…/voici-sign-in#s=&k=&p=&u=&d=&n=` (the query form too); null when anything is off, as parseSignInLink. */
        fun parse(raw: String): VoiciSignInLink? {
            val uri = runCatching { java.net.URI(raw.trim()) }.getOrNull() ?: return null
            if (uri.path?.trimEnd('/') != "/voici-sign-in") return null
            val params = HashMap<String, String>()
            for (part in listOfNotNull(uri.rawFragment, uri.rawQuery)) {
                for (kv in part.split('&')) {
                    val i = kv.indexOf('=')
                    if (i <= 0) continue
                    params.putIfAbsent(kv.substring(0, i), java.net.URLDecoder.decode(kv.substring(i + 1), "UTF-8"))
                }
            }
            val sid = params["s"]?.takeIf { SID.matches(it) } ?: return null
            val pk = params["k"]?.let(Base64URL::decode)?.takeIf { it.size == 32 } ?: return null
            val page = params["p"]?.takeIf { PAGE.matches(it) } ?: return null
            val user = params["u"]?.takeIf { USER.matches(it) } ?: return null
            val d = params["d"]?.takeIf { B.matches(it) } ?: return null
            val n = params["n"]?.takeIf { NONCE.matches(it) } ?: return null
            return VoiciSignInLink(sid, pk, page, user, d, n)
        }
    }

    override fun equals(other: Any?) = other is VoiciSignInLink && sid == other.sid && browserPk.contentEquals(other.browserPk) &&
        pageId == other.pageId && username == other.username && delegatePub == other.delegatePub && nonce == other.nonce
    override fun hashCode() = sid.hashCode()
}

/** The phone's side of the one-leg pipe. The live one speaks /qr-pipe; the gym gives a scripted one. */
interface VoiciSignInPipe {
    /** Join the session (hello with this phone's X25519 key); returns the 6-digit code both screens show. */
    suspend fun connect(link: VoiciSignInLink): String
    /** Seal the answer under the pipe key and deliver it; returns once the browser has it. */
    suspend fun deliver(answer: ByteArray)
    fun close()
}

class LiveVoiciSignInPipe(
    private val http: OkHttpClient,
    private val host: () -> String = { Endpoints.controlHost },
    private val secure: () -> Boolean = { Endpoints.controlBaseUrl.startsWith("https") },
) : VoiciSignInPipe {
    private var session: QrSession? = null
    private var leg: PairingSocket? = null

    private fun url(sid: String) = "${if (secure()) "wss" else "ws"}://${host()}/qr-pipe/${URLEncoder.encode(sid, "UTF-8")}?role=phone"

    override suspend fun connect(link: VoiciSignInLink): String {
        val s = QrSession.fresh()
        session = s
        val code = s.pair(link.browserPk)
        val sock = PairingSocket(http, url(link.sid)).also { leg = it }
        sock.open()
        sock.send {
            put("kind", "hello")
            put("phonePk", Base64URL.encode(s.phonePubKey))
        }
        while (true) {
            val f = sock.next()
            if (f.kind == "ack") return code
            f.asTerminalError()?.let { throw it }
        }
    }

    override suspend fun deliver(answer: ByteArray) {
        val sock = leg ?: error("not connected")
        val sealed = (session ?: error("not connected")).seal(answer)
        sock.send {
            put("kind", "deliver")
            put("ciphertext", sealed.ciphertextB64u)
            put("nonce", sealed.nonceB64u)
        }
        while (true) {
            val f = sock.next()
            if (f.kind == "delivered") return
            f.asTerminalError()?.let { throw it }
        }
    }

    override fun close() {
        leg?.close()
        leg = null
    }
}

/** The approval's steps; the screen draws one of these. */
sealed interface VoiciSignInPhase {
    data object Connecting : VoiciSignInPhase
    data class Waiting(val code: String) : VoiciSignInPhase
    data class Review(val code: String, val displayName: String, val avatar: ByteArray?, val pseudonymPub: String) : VoiciSignInPhase
    data object Working : VoiciSignInPhase
    data object Done : VoiciSignInPhase
    /** [code] is a refusal code (VoiciCopy.signInRefusal makes the sentence); [retryAfterSec] when rate limited. */
    data class Failed(val code: String, val retryAfterSec: Long? = null) : VoiciSignInPhase
}

class VoiciSignInFlow(
    private val center: VoiciCenter,
    private val keyring: VoiciKeyring,
    private val pipe: VoiciSignInPipe,
    private val integrity: VoiciIntegrity,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _phase = kotlinx.coroutines.flow.MutableStateFlow<VoiciSignInPhase>(VoiciSignInPhase.Connecting)
    val phase: kotlinx.coroutines.flow.StateFlow<VoiciSignInPhase> = _phase
    private var request: VoiciSignInRequest? = null

    /** Join the pipe, read and check the request and the page it is for. */
    suspend fun start(link: VoiciSignInLink) {
        try {
            val keys = center.accountKeys(link.username) ?: return fail("not-found")
            val idxJson = center.client.page(link.username) ?: return fail("not-found")
            val idx = VoiciPage.checkVoiciPageIndex(idxJson, link.username, keys.sensitiveKind, keys.sensitivePub, pageId = link.pageId).valueOrNull()
                ?: return fail("page-unchecked")
            val profileRef = idx.body.pieces.first { it.role == "profile" }
            val profile = center.client.piece(link.username, idx.body.pageId, profileRef.sha256)
                ?.takeIf { WebEnvelopes.sha256Hex(it) == profileRef.sha256 }
                ?.let(VoiciPage::parseVoiciProfilePiece) ?: return fail("page-unchecked")
            val avatar = idx.body.pieces.firstOrNull { it.role == "avatar" }?.let { ref ->
                center.client.piece(link.username, idx.body.pageId, ref.sha256)?.takeIf { WebEnvelopes.sha256Hex(it) == ref.sha256 && VoiciPage.isVoiciJpeg(it) }
            }
            if (idx.body.acceptsMessages != 1) return fail("not-accepting")
            val req = link.request(Endpoints.voiciOrigin)
            val code = withTimeout(60_000) { pipe.connect(link) }
            request = req
            val umk = keyring.umk() ?: return fail("not-found")
            _phase.value = VoiciSignInPhase.Review(code, profile.displayName, avatar, VoiciVisitorKeys.derive(umk, req.pageId).pseudonymPub)
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            fail("expired")
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            fail("network")
        }
    }

    /** The person approved: biometric, attestation, delegation, answer. */
    suspend fun approve(reason: String) {
        val req = request ?: return
        val review = _phase.value as? VoiciSignInPhase.Review ?: return
        try {
            keyring.confirm(reason)
        } catch (e: Exception) {
            _phase.value = review
            return
        }
        _phase.value = VoiciSignInPhase.Working
        try {
            val u = keyring.username() ?: return fail("not-found")
            val umk = keyring.umk() ?: return fail("not-found")
            val device = keyring.device() ?: return fail("not-found")
            val visitor = VoiciVisitorKeys.derive(umk, req.pageId)
            val ca = center.caKeys()
            val previous = center.previousAttestation(req.pageId)?.let { MessagesAttestations.parseMessagesKeyAttestation(it) }
            val t = now()
            val attestation = previous?.takeIf { it.pseudonymPub == visitor.pseudonymPub && it.expiresAt - t > 7 * 86_400_000L }
                ?.takeIf { ca.isEmpty() || MessagesAttestations.checkMessagesKeyAttestation(it.toJson(), ca, t, visitor.pseudonymPub).ok }
                ?.toJson()
                ?: run {
                    val renewOf = previous?.takeIf { it.pseudonymPub == visitor.pseudonymPub && t - it.expiresAt <= MessagesAttestations.MESSAGES_ATTESTATION_RENEW_GRACE_MS }
                        ?.let(MessagesAttestations::messagesAttestationHash).orEmpty()
                    val probe = VoiciOwner.attestationRequest(u, visitor, renewOf, "android", t) { device.signer.sign(it) }
                    val token = integrity.token(VoiciOwner.requestHash(probe.first))
                    val (reqJson, sig) = if (token != null) probe else VoiciOwner.attestationRequest(u, visitor, renewOf, "none", t) { device.signer.sign(it) }
                    // B2: `integrity` only with a token (absent for `none`); `previous` names the attestation a renewal renews.
                    val body = linkedMapOf<String, kotlinx.serialization.json.JsonElement>("request" to reqJson, "signature" to kotlinx.serialization.json.JsonPrimitive(sig))
                    token?.let { body["integrity"] = JsonObject(mapOf("platform" to kotlinx.serialization.json.JsonPrimitive("android"), "token" to kotlinx.serialization.json.JsonPrimitive(it))) }
                    if (renewOf.isNotEmpty()) previous?.let { body["previous"] = it.toJson() }
                    center.client.attest(u, device, JsonObject(body))
                }
            // `.com`'s clock may run a little ahead of this phone's: judge a just-issued attestation at its own issuedAt.
            val issued = MessagesAttestations.parseMessagesKeyAttestation(attestation)?.issuedAt ?: t
            val checkAt = if (issued > t && issued - t <= VoiciMessages.VOICI_SEND_SKEW_MS) issued else t
            val att = if (ca.isNotEmpty()) MessagesAttestations.checkMessagesKeyAttestation(attestation, ca, checkAt, visitor.pseudonymPub).valueOrNull()
            else MessagesAttestations.parseMessagesKeyAttestation(attestation)
            if (att == null || att.pseudonymPub != visitor.pseudonymPub) return fail("bad-attestation")
            val answer = VoiciOwner.signInAnswer(req, visitor, att.toJson(), att.expiresAt, t)
            pipe.deliver(WebEnvelopes.canonicalJsonBytes(answer))
            center.recordSignIn(req.pageId, req.username, req.delegatePub, att.toJson())
            _phase.value = VoiciSignInPhase.Done
        } catch (e: com.flagshipserver.app.api.VoiciHttpError) {
            fail(e.code ?: "network", e.retryAfterSec)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            fail("network")
        } finally {
            pipe.close()
        }
    }

    fun cancel() {
        pipe.close()
    }

    private fun fail(code: String, retry: Long? = null) {
        _phase.value = VoiciSignInPhase.Failed(code, retry)
        pipe.close()
    }
}
