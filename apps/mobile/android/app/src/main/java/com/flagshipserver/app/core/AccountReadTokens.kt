// Account read tokens (docs/account-read-token.md). `.com` serves an
// account's server inventory (/pods, /stream), device history (/audit) and app
// names (/apps/aliases, /apps/<id>/links) only to a bearer of a read token for
// that account. This mints one with whatever key is already at hand — the
// account device key (never biometric-gated on Android) or the IRK when the
// biometric session is already fresh — keeps it in the profile's encrypted
// prefs, and sends it as `Authorization: Bearer`. A poll never raises a prompt:
// when nothing can mint, the read goes out bare, `.com` answers 401, and
// [statusPaused] tells Home to say so until the next unlock.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import java.security.SecureRandom

object AccountReadTokenProtocol {
    const val ENDPOINT_LABEL = "account-read-token"
    fun path(username: String): String = "/api/accounts/${username.lowercase()}/read-token"
}

@Serializable
data class AccountReadTokenResponse(val token: String, val expiresAt: Long)

@Serializable
private data class IrkMintBody(val auth: IrkMintAuth, val authSignature: String)

@Serializable
private data class IrkMintAuth(
    val username: String,
    val endpointLabel: String,
    val phoneIrkPub: String,
    val issuedAt: Long,
    val expiresAt: Long,
    val nonce: String,
)

/** A key that can sign a mint right now without a prompt. */
sealed interface ReadTokenSigner {
    data class Device(val deviceId: String, val signer: Ed25519Sign, val pubHex: String) : ReadTokenSigner
    data class Irk(val signer: Ed25519Sign, val pubHex: String) : ReadTokenSigner
}

/** Where a profile's token lives: device-local, outside biometrics. */
interface ReadTokenStore {
    fun get(username: String): AccountReadTokenResponse?
    fun put(username: String, token: AccountReadTokenResponse)
    fun remove(username: String)
    fun clear()
}

class AccountReadTokens(
    private val transport: JsonHttpTransport,
    private val store: ReadTokenStore,
    /** The keys that can sign for [username] without a prompt, best first. */
    private val signers: suspend (username: String) -> List<ReadTokenSigner>,
    /** Demo accounts are keyless; `.com` serves them without a token. */
    private val isDemo: (username: String) -> Boolean,
    baseUrl: String = Endpoints.controlBaseUrl,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val randomBytes: (Int) -> ByteArray = { n -> ByteArray(n).also(SecureRandom()::nextBytes) },
) {
    companion object {
        /** Refresh a token this close to its expiry (it still works meanwhile). */
        const val REFRESH_MARGIN_MS = 60 * 60_000L
        /** After a mint every signer refused, wait this long before asking again. */
        const val MINT_BACKOFF_MS = 60_000L

        /** The app-wide provider, set by MainActivity; null ⇒ reads go out bare. */
        @Volatile var shared: AccountReadTokens? = null

        /** Run [call] through the shared provider, or bare when there is none. */
        suspend fun <T> authorize(username: String, call: suspend (Map<String, String>) -> T): T =
            shared?.authorized(username, call) ?: call(emptyMap())
    }

    private val base = baseUrl.trimEnd('/')
    private val mutex = Mutex()
    private var lastFailedMintAt: Long? = null
    private val _statusPaused = MutableStateFlow(false)

    /** True after `.com` refused a read and no token could be minted without a
     *  prompt: Home shows the last state and says status is paused. */
    val statusPaused: StateFlow<Boolean> = _statusPaused.asStateFlow()

    /** Run a gated read with the account's token; on a 401 mint once more and
     *  retry. Never prompts. */
    suspend fun <T> authorized(username: String, call: suspend (Map<String, String>) -> T): T {
        if (isDemo(username)) return call(emptyMap())
        val first = token(username, forceMint = false)
        val refused = try {
            return call(headers(first)).also { _statusPaused.value = false }
        } catch (e: HttpException) {
            if (e.status != 401) throw e
            e
        }
        val fresh = token(username, forceMint = true)
        if (fresh == null || fresh == first) {
            _statusPaused.value = true
            throw refused
        }
        return try {
            call(headers(fresh)).also { _statusPaused.value = false }
        } catch (e: HttpException) {
            if (e.status == 401) _statusPaused.value = true
            throw e
        }
    }

    /** Drop every token of this profile (sign-out, wipe, profile switch). */
    fun clear() {
        store.clear()
        lastFailedMintAt = null
        _statusPaused.value = false
    }

    /** The active profile changed: its tokens live under its own keys, so
     *  only the paused banner and the mint backoff start over. */
    fun profileChanged() {
        lastFailedMintAt = null
        _statusPaused.value = false
    }

    private fun headers(token: String?): Map<String, String> =
        if (token == null) emptyMap() else mapOf("Authorization" to "Bearer $token")

    private suspend fun token(username: String, forceMint: Boolean): String? = mutex.withLock {
        val u = username.lowercase()
        val cached = store.get(u)?.takeIf { it.expiresAt > now() }
        if (!forceMint && cached != null && cached.expiresAt - now() > REFRESH_MARGIN_MS) return@withLock cached.token
        val backoff = lastFailedMintAt?.let { now() - it < MINT_BACKOFF_MS } == true
        if (backoff) return@withLock if (forceMint) null else cached?.token
        if (forceMint) store.remove(u)
        val minted = mint(u)
        if (minted == null) {
            lastFailedMintAt = now()
            return@withLock if (forceMint) null else cached?.token
        }
        lastFailedMintAt = null
        store.put(u, minted)
        minted.token
    }

    private suspend fun mint(username: String): AccountReadTokenResponse? {
        val candidates = runCatching { signers(username) }.getOrDefault(emptyList())
        for (signer in candidates) {
            val minted = runCatching {
                when (signer) {
                    is ReadTokenSigner.Device -> mintWithDevice(username, signer)
                    is ReadTokenSigner.Irk -> mintWithIrk(username, signer)
                }
            }.getOrNull()
            if (minted != null) return minted
        }
        return null
    }

    private suspend fun mintWithDevice(username: String, d: ReadTokenSigner.Device): AccountReadTokenResponse {
        val path = AccountReadTokenProtocol.path(username)
        val requestId = HexUtil.encode(randomBytes(16))
        val issuedAt = now()
        val signature = d.signer.sign(
            AccountMetadata.canonicalDirectoryRequest(username, d.deviceId, d.pubHex, "POST", path, requestId, issuedAt),
        )
        val resp = transport.execute(
            method = "POST",
            url = base + path,
            body = "{}".toByteArray(),
            contentType = "application/json",
            extraHeaders = mapOf(
                "x-flagship-device-id" to d.deviceId,
                "x-flagship-device-pub" to d.pubHex,
                "x-flagship-request-id" to requestId,
                "x-flagship-issued-at" to issuedAt.toString(),
                "x-flagship-signature" to HexUtil.encode(signature),
            ),
            accept = setOf(200),
        )
        return transport.json.decodeFromString(AccountReadTokenResponse.serializer(), resp.body.decodeToString())
    }

    private suspend fun mintWithIrk(username: String, k: ReadTokenSigner.Irk): AccountReadTokenResponse {
        val issuedAt = now()
        val expiresAt = issuedAt + 120_000
        val nonceHex = HexUtil.encode(randomBytes(32))
        val signature = DeviceEndpointClaim.sign(
            irk = k.signer,
            username = username,
            endpointLabel = AccountReadTokenProtocol.ENDPOINT_LABEL,
            phoneIrkPubHex = k.pubHex,
            issuedAt = issuedAt,
            expiresAt = expiresAt,
            nonceHex = nonceHex,
        )
        val body = IrkMintBody(
            auth = IrkMintAuth(username, AccountReadTokenProtocol.ENDPOINT_LABEL, k.pubHex, issuedAt, expiresAt, nonceHex),
            authSignature = HexUtil.encode(signature),
        )
        return transport.postJsonForResponse(
            url = base + AccountReadTokenProtocol.path(username),
            body = body,
            serializer = IrkMintBody.serializer(),
            responseSerializer = AccountReadTokenResponse.serializer(),
        )
    }
}
