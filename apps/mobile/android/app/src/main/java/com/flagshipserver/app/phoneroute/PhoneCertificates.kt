// The phone's own TLS key and certificate for exactly its bare `<account>.<apex>` name (plan H2,
// docs/architecture-v2/phone-route.md section 4):
//
// - The key is ECDSA P-256 in the Android Keystore (StrongBox when the phone has one, else the TEE),
//   never exportable, no user authentication (TLS handshakes happen without a prompt). SSLEngine
//   signs with it through PhoneKeyManager. Keystore keys are deleted with the app.
// - The CSR is PhoneRoute.csrInfo signed by that key; the order is `certificate-order/v1`
//   (class phone) signed by the account device key, sent through PhoneCertIssuer (the H1 issuance
//   API on `.com`: docs/architecture-v2/issuance-service.md).
// - The chain is kept (SharedPreferences, public data) and reused until 30 days before it ends;
//   after a failed order the next try waits at least 6 h. Never one order per handover.

package com.flagshipserver.app.phoneroute

import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import com.flagshipserver.app.core.HexUtil
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayInputStream
import java.net.Socket
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Principal
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedKeyManager

/** The key the certificate is for: its public point (uncompressed) and a DER ECDSA-SHA256 signer. */
class PhoneTlsKey(val privateKey: PrivateKey, val publicUncompressed: ByteArray, val backing: String) {
    fun signDer(msg: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
        initSign(privateKey)
        update(msg)
        sign()
    }

    companion object {
        private const val STORE = "AndroidKeyStore"
        private fun alias(account: String) = "flagship.phone-tls.${account.lowercase()}"

        fun uncompressed(pub: ECPublicKey): ByteArray {
            fun to32(v: java.math.BigInteger): ByteArray {
                val b = v.toByteArray()
                return when {
                    b.size == 32 -> b
                    b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
                    else -> ByteArray(32 - b.size) + b
                }
            }
            return byteArrayOf(0x04) + to32(pub.w.affineX) + to32(pub.w.affineY)
        }

        /** The Keystore key for `account`, made now if there is none. Null where the Keystore can't make one. */
        fun loadOrCreate(account: String): PhoneTlsKey? = runCatching {
            val ks = KeyStore.getInstance(STORE).apply { load(null) }
            val a = alias(account)
            if (ks.getKey(a, null) == null) {
                try {
                    generate(a, strongBox = true)
                } catch (_: StrongBoxUnavailableException) {
                    generate(a, strongBox = false)
                }
            }
            val priv = ks.getKey(a, null) as PrivateKey
            val pub = ks.getCertificate(a).publicKey as ECPublicKey
            val info = runCatching {
                java.security.KeyFactory.getInstance(priv.algorithm, STORE)
                    .getKeySpec(priv, android.security.keystore.KeyInfo::class.java)
            }.getOrNull()
            val backing = when {
                info == null -> "keystore"
                android.os.Build.VERSION.SDK_INT >= 31 && info.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
                else -> "tee"
            }
            PhoneTlsKey(priv, uncompressed(pub), backing)
        }.getOrNull()

        private fun generate(alias: String, strongBox: Boolean) {
            val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                // TLS signs a digest the stack computed (NONE) as well as messages (SHA-256: the CSR).
                .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .setIsStrongBoxBacked(strongBox)
                .build()
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE).apply { initialize(spec) }.generateKeyPair()
        }

        fun delete(account: String) {
            runCatching { KeyStore.getInstance(STORE).apply { load(null) }.deleteEntry(alias(account)) }
        }
    }
}

/** Hands SSLEngine the phone's one key and chain. */
class PhoneKeyManager(private val key: PrivateKey, private val chain: Array<X509Certificate>) : X509ExtendedKeyManager() {
    override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?) = arrayOf(ALIAS)
    override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?) = ALIAS
    override fun chooseEngineServerAlias(keyType: String?, issuers: Array<out Principal>?, engine: SSLEngine?) = ALIAS
    override fun getCertificateChain(alias: String?) = if (alias == ALIAS) chain else null
    override fun getPrivateKey(alias: String?) = if (alias == ALIAS) key else null
    override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?) = null
    override fun chooseClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?) = null

    companion object {
        private const val ALIAS = "phone"

        fun sslContext(key: PrivateKey, chain: Array<X509Certificate>): SSLContext =
            SSLContext.getInstance("TLS").apply { init(arrayOf(PhoneKeyManager(key, chain)), null, SecureRandom()) }

        fun parseChain(pem: String): Array<X509Certificate> {
            val cf = CertificateFactory.getInstance("X.509")
            return cf.generateCertificates(ByteArrayInputStream(pem.toByteArray())).map { it as X509Certificate }.toTypedArray()
        }
    }
}

/** What the phone remembers about its certificate. */
class PhoneCertStore(private val prefs: SharedPreferences) {
    private fun k(account: String, name: String) = "phone-cert.${account.lowercase()}.$name"

    fun chainPem(account: String): String? = prefs.getString(k(account, "chain"), null)
    fun notAfter(account: String): Long? = prefs.getLong(k(account, "notAfter"), -1).takeIf { it > 0 }
    fun lastFailureAt(account: String): Long? = prefs.getLong(k(account, "failedAt"), -1).takeIf { it > 0 }
    fun pendingOrder(account: String): String? = prefs.getString(k(account, "order"), null)

    fun saveIssued(account: String, chainPem: String, notAfter: Long) {
        prefs.edit().putString(k(account, "chain"), chainPem).putLong(k(account, "notAfter"), notAfter)
            .remove(k(account, "failedAt")).remove(k(account, "order")).apply()
    }

    fun savePending(account: String, orderId: String) = prefs.edit().putString(k(account, "order"), orderId).apply()

    fun saveFailure(account: String, at: Long) = prefs.edit().putLong(k(account, "failedAt"), at).remove(k(account, "order")).apply()

    fun clear(account: String) {
        prefs.edit().remove(k(account, "chain")).remove(k(account, "notAfter")).remove(k(account, "failedAt")).remove(k(account, "order")).apply()
    }
}

/** The issuance API, behind one small interface so it can change without touching the rest. */
interface PhoneCertIssuer {
    sealed class Answer {
        data class Pending(val orderId: String, val pollAfterMs: Long) : Answer()
        data class Issued(val chainPem: String, val notAfter: Long) : Answer()
        data class Failed(val code: String) : Answer()
    }

    suspend fun order(account: String, order: PhoneCertificateOrder, signature: String, csr: ByteArray): Answer
    suspend fun poll(orderId: String): Answer
}

/** `.com`'s `POST /api/certificates/orders` and `GET /api/certificates/orders/:id`. */
class ComPhoneCertIssuer(private val okHttp: OkHttpClient, private val controlBaseUrl: String) : PhoneCertIssuer {
    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun order(account: String, order: PhoneCertificateOrder, signature: String, csr: ByteArray): PhoneCertIssuer.Answer {
        val body = buildJsonObject {
            put("account", account)
            put("order", buildJsonObject {
                put("class", "phone")
                put("device", order.device)
                put("regGen", 0)
                put("csrSha256", order.csrSha256)
                put("requestId", order.requestId)
                put("issuedAt", order.issuedAt)
            })
            put("signature", signature)
            put("csr", Base64.getUrlEncoder().withoutPadding().encodeToString(csr))
        }.toString()
        val req = Request.Builder().url("$controlBaseUrl/api/certificates/orders")
            .post(body.toRequestBody("application/json".toMediaType())).build()
        return call(req)
    }

    override suspend fun poll(orderId: String): PhoneCertIssuer.Answer =
        call(Request.Builder().url("$controlBaseUrl/api/certificates/orders/$orderId").get().build())

    private fun call(req: Request): PhoneCertIssuer.Answer = runCatching {
        okHttp.newCall(req).execute().use { res ->
            val o = json.parseToJsonElement(res.body?.string().orEmpty()).jsonObject
            fun s(k: String) = o[k]?.jsonPrimitive?.content
            when {
                s("status") == "issued" && s("chainPem") != null ->
                    PhoneCertIssuer.Answer.Issued(s("chainPem")!!, o["notAfter"]?.jsonPrimitive?.longOrNull ?: 0)
                s("status") == "pending" && s("orderId") != null ->
                    PhoneCertIssuer.Answer.Pending(s("orderId")!!, o["pollAfterMs"]?.jsonPrimitive?.longOrNull ?: 5_000)
                else -> PhoneCertIssuer.Answer.Failed(s("code") ?: "http-${res.code}")
            }
        }
    }.getOrElse { PhoneCertIssuer.Answer.Failed("network") }
}

/** Orders a certificate only when one is due, and reuses the held one otherwise. */
class PhoneCertManager(
    private val store: PhoneCertStore,
    private val issuer: PhoneCertIssuer,
    private val now: () -> Long = System::currentTimeMillis,
    private val random: SecureRandom = SecureRandom(),
) {
    /** The held chain if it is still good to serve with (not past its end). */
    fun current(account: String): Array<X509Certificate>? {
        val pem = store.chainPem(account) ?: return null
        val end = store.notAfter(account) ?: return null
        if (end <= now()) return null
        return runCatching { PhoneKeyManager.parseChain(pem) }.getOrNull()
    }

    /**
     * Order when due (none held, or within 30 days of the end; not within 6 h of a failure). The CSR is signed by
     * `key`; the order by the account device key. Polls until issued or failed. Returns true when a new chain was kept.
     */
    suspend fun ensure(account: String, apex: String, key: PhoneTlsKey, deviceKey: Ed25519Sign, deviceKeyPub: String): Boolean {
        if (!PhoneRoute.needsOrder(store.notAfter(account), store.lastFailureAt(account), now())) return false
        var answer: PhoneCertIssuer.Answer = store.pendingOrder(account)?.let { issuer.poll(it) } ?: run {
            val info = PhoneRoute.csrInfo(key.publicUncompressed, PhoneRoute.hostname(account, apex))
            val csr = PhoneRoute.csr(info, key.signDer(info))
            val order = PhoneCertificateOrder(
                device = deviceKeyPub,
                csrSha256 = PhoneRoute.sha256Hex(csr),
                requestId = HexUtil.encode(ByteArray(16).also(random::nextBytes)),
                issuedAt = now(),
            )
            issuer.order(account, order, PhoneRoute.sign(PhoneRoute.canonical(order), deviceKey), csr)
        }
        val deadline = now() + 15 * 60_000
        while (answer is PhoneCertIssuer.Answer.Pending && now() < deadline) {
            store.savePending(account, answer.orderId)
            delay(answer.pollAfterMs.coerceIn(1_000, 60_000))
            answer = issuer.poll(answer.orderId)
        }
        return when (answer) {
            is PhoneCertIssuer.Answer.Issued -> {
                val chain = runCatching { PhoneKeyManager.parseChain(answer.chainPem) }.getOrNull()
                val leaf = chain?.firstOrNull()
                val ok = leaf != null && uncompressedOf(leaf).contentEquals(key.publicUncompressed)
                if (ok) store.saveIssued(account, answer.chainPem, answer.notAfter.takeIf { it > 0 } ?: leaf!!.notAfter.time)
                else store.saveFailure(account, now())
                ok
            }
            is PhoneCertIssuer.Answer.Failed -> {
                store.saveFailure(account, now())
                false
            }
            is PhoneCertIssuer.Answer.Pending -> false
        }
    }

    private fun uncompressedOf(c: X509Certificate): ByteArray =
        (c.publicKey as? ECPublicKey)?.let(PhoneTlsKey::uncompressed) ?: ByteArray(0)
}
