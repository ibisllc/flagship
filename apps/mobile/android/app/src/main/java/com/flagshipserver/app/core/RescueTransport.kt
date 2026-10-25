// How this phone reaches its box over the local network with `.com` and the relay out of reach
// (docs/data-sovereignty.md): by address, the server's name as SNI, and trust by KEY, never by DNS or
// a certificate authority. The TLS layer accepts whatever certificate the box presents and reports
// its SHA-256; the box's signed hello must name that same certificate, so a machine in the middle is
// caught before anything is signed. After the hello checks out, every later connection of the
// session must present that same certificate. MIRRORS the iOS RescueTransport.swift.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.api.PqSignatureWire
import com.flagshipserver.app.api.ServerArchiveStartRequest
import com.flagshipserver.app.api.ServerArchiveStatus
import com.flagshipserver.app.api.ServerArchiveStatusResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.ConnectionPool
import okhttp3.Dns
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.InetAddress
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

data class RescueEndpoint(val host: String, val port: Int = 443) {
    val display: String get() = if (':' in host) "[$host]:$port" else if (port == 443) host else "$host:$port"
    val record: String get() = if (':' in host) "[$host]:$port" else "$host:$port"

    companion object {
        /** `192.168.1.20`, `10.0.0.5:8443`, `[fd00::5]:443`; null for anything else. */
        fun parse(s: String): RescueEndpoint? {
            val t = s.trim()
            if (t.isEmpty() || t.length > 64 || t.any { it.isWhitespace() }) return null
            if (t.startsWith("[")) {
                val close = t.indexOf(']').takeIf { it > 1 } ?: return null
                val rest = t.substring(close + 1)
                val port = if (rest.startsWith(":")) rest.drop(1).toIntOrNull() else if (rest.isEmpty()) 443 else null
                return port?.takeIf { it in 1..65535 }?.let { RescueEndpoint(t.substring(1, close), it) }
            }
            val parts = t.split(':')
            return when (parts.size) {
                1 -> RescueEndpoint(t)
                2 -> parts[1].toIntOrNull()?.takeIf { it in 1..65535 }?.let { RescueEndpoint(parts[0], it) }
                else -> RescueEndpoint(t)
            }
        }
    }
}

/** The hello as it arrived, with what this phone's own TLS stack saw on that connection. */
class RescueHelloReply(
    val hello: Rescue.Exchange,
    val signature: ByteArray,
    val pqSuite: String?,
    val pqSignatureHex: String?,
    val seenCertSha256: String,
    /** Whether that certificate passes ordinary web checks (an expired one doesn't; rescue never needs it). */
    val certificateTrusted: Boolean,
)

@Serializable
data class RescueServerApp(val serviceId: String, val name: String, val state: String = "unknown")

@Serializable
data class RescueServerStatus(
    val version: String? = null,
    val startedAt: Long? = null,
    val certValidUntil: Long? = null,
    val cpuPercent: Double? = null,
    val memUsedBytes: Long? = null,
    val memTotalBytes: Long? = null,
    val diskUsedBytes: Long? = null,
    val diskTotalBytes: Long? = null,
)

/** `GET /api/rescue/server`. */
@Serializable
data class RescueServerSnapshot(
    val serverDomain: String,
    val apps: List<RescueServerApp> = emptyList(),
    val status: RescueServerStatus? = null,
    val controls: List<String>? = null,
    val sessionNonce: String? = null,
    val sessionEndsAt: Long? = null,
)

sealed class RescueTransportException(message: String) : IOException(message) {
    /** The box refused: its own sentence. */
    class Box(val status: Int, val boxMessage: String, val code: String?) : RescueTransportException(sentence(boxMessage))
    class Unreachable : RescueTransportException(FSStrings.get(R.string.offline_unreachable))
    class CertificateChanged : RescueTransportException(FSStrings.get(R.string.offline_certificate_changed))
    class Malformed : RescueTransportException(FSStrings.get(R.string.offline_malformed))

    companion object {
        fun sentence(s: String): String {
            val t = s.trim()
            if (t.isEmpty()) return t
            val c = t.replaceFirstChar { it.uppercase() }
            return if (c.endsWith(".") || c.endsWith("!") || c.endsWith("?")) c else "$c."
        }
    }
}

/** One rescue connection to one box: the hello, then a session, then what the session opens. */
interface RescueConnection {
    suspend fun hello(clientNonce: String): RescueHelloReply
    /** After a good hello: only connections that present this certificate are accepted. */
    fun pin(certSha256: String)
    suspend fun openSession(order: Rescue.Exchange, signatureHex: String, pq: PqSignatureWire?): Long
    suspend fun server(): RescueServerSnapshot
    suspend fun control(order: Rescue.ControlOrder, signatureHex: String, pq: PqSignatureWire?)
    suspend fun archiveStart(req: ServerArchiveStartRequest)
    suspend fun archiveStatus(): ServerArchiveStatus?
    suspend fun bundle(offset: Long): ByteArray
    suspend fun archiveForget()
    fun close()
}

fun interface RescueConnector {
    fun connect(endpoint: RescueEndpoint, serverDomain: String): RescueConnection
}

/** Accepts any certificate and records its hash; once pinned, refuses any other. */
internal class RescueTrustManager(private val serverDomain: String) : X509TrustManager {
    @Volatile var seen: Pair<String, Boolean>? = null
    @Volatile var pinned: String? = null
    @Volatile var sawAnother = false
    private val platform: X509TrustManager? = runCatching {
        TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(null as java.security.KeyStore?) }
            .trustManagers.filterIsInstance<X509TrustManager>().firstOrNull()
    }.getOrNull()

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException("no client certificates")

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("no certificate")
        val sha = MessageDigest.getInstance("SHA-256").digest(leaf.encoded).joinToString("") { "%02x".format(it) }
        val p = pinned
        if (p != null && p != sha) {
            sawAnother = true
            throw CertificateException("another certificate than this session's")
        }
        val trusted = runCatching { platform?.checkServerTrusted(chain, authType ?: "ECDHE_ECDSA"); platform != null }.getOrDefault(false) &&
            runCatching { leaf.checkValidity(); true }.getOrDefault(false)
        seen = sha to trusted
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

class LiveRescueConnection(private val endpoint: RescueEndpoint, serverDomain: String) : RescueConnection {
    private val domain = serverDomain.lowercase()
    private val trust = RescueTrustManager(domain)
    @Volatile private var token: String? = null
    private val json = Json { ignoreUnknownKeys = true }
    private val client: OkHttpClient = run {
        val ctx = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), SecureRandom()) }
        OkHttpClient.Builder()
            .sslSocketFactory(ctx.socketFactory, trust)
            // The name is only the SNI and the box's route: the box is checked by its key (the hello).
            .hostnameVerifier { _, _ -> true }
            // The server's name resolves to the address this phone found, never through DNS.
            .dns(object : Dns {
                override fun lookup(hostname: String): List<InetAddress> =
                    if (hostname.equals(domain, ignoreCase = true)) listOf(InetAddress.getByName(endpoint.host)) else throw java.net.UnknownHostException(hostname)
            })
            .connectionPool(ConnectionPool(1, 1, TimeUnit.MINUTES))
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .build()
    }

    override fun pin(certSha256: String) { trust.pinned = certSha256.lowercase() }

    private suspend fun call(path: String, method: String = "GET", body: JsonObject? = null): ByteArray = withContext(Dispatchers.IO) {
        val url = "https://$domain:${endpoint.port}$path"
        val rb = body?.toString()?.toRequestBody("application/json".toMediaType())
        val req = Request.Builder().url(url).method(method, rb ?: if (method == "POST") ByteArray(0).toRequestBody() else null)
            .apply { token?.let { header("x-flagship-rescue", it) } }
            .build()
        val resp = try {
            client.newCall(req).execute()
        } catch (e: IOException) {
            if (trust.sawAnother) throw RescueTransportException.CertificateChanged()
            throw RescueTransportException.Unreachable()
        }
        resp.use { r ->
            val bytes = r.body?.bytes() ?: ByteArray(0)
            if (!r.isSuccessful) {
                val o = runCatching { json.parseToJsonElement(String(bytes, Charsets.UTF_8)).jsonObject }.getOrNull()
                throw RescueTransportException.Box(r.code, o?.get("error")?.jsonPrimitive?.contentOrNull ?: r.message, o?.get("code")?.jsonPrimitive?.contentOrNull)
            }
            bytes
        }
    }

    private fun pqJson(pq: PqSignatureWire?) = pq?.let { buildJsonObject { put("suite", it.suite); put("signature", it.signature) } }

    override suspend fun hello(clientNonce: String): RescueHelloReply {
        val bytes = call("/api/rescue/hello", "POST", buildJsonObject { put("clientNonce", clientNonce) })
        val o = runCatching { json.parseToJsonElement(String(bytes, Charsets.UTF_8)).jsonObject }.getOrNull() ?: throw RescueTransportException.Malformed()
        val hello = runCatching { json.decodeFromJsonElement(Rescue.Exchange.serializer(), o["hello"]!!) }.getOrNull() ?: throw RescueTransportException.Malformed()
        val sig = HexUtil.decode(o["signatureHex"]?.jsonPrimitive?.contentOrNull ?: "") ?: throw RescueTransportException.Malformed()
        val pq = o["pqSignature"] as? JsonObject
        val seen = trust.seen ?: throw RescueTransportException.Malformed()
        return RescueHelloReply(hello, sig, pq?.get("suite")?.jsonPrimitive?.contentOrNull, pq?.get("signature")?.jsonPrimitive?.contentOrNull, seen.first, seen.second)
    }

    override suspend fun openSession(order: Rescue.Exchange, signatureHex: String, pq: PqSignatureWire?): Long {
        val body = buildJsonObject {
            put("order", json.encodeToJsonElement(Rescue.Exchange.serializer(), order))
            put("signatureHex", signatureHex)
            pqJson(pq)?.let { put("pqSignature", it) }
        }
        val o = runCatching { json.parseToJsonElement(String(call("/api/rescue/session", "POST", body), Charsets.UTF_8)).jsonObject }.getOrNull()
            ?: throw RescueTransportException.Malformed()
        token = o["token"]?.jsonPrimitive?.contentOrNull ?: throw RescueTransportException.Malformed()
        return o["expiresAt"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0
    }

    override suspend fun server(): RescueServerSnapshot =
        runCatching { json.decodeFromString(RescueServerSnapshot.serializer(), String(call("/api/rescue/server"), Charsets.UTF_8)) }
            .getOrElse { if (it is RescueTransportException) throw it else throw RescueTransportException.Malformed() }

    override suspend fun control(order: Rescue.ControlOrder, signatureHex: String, pq: PqSignatureWire?) {
        call("/api/rescue/control", "POST", buildJsonObject {
            put("order", json.encodeToJsonElement(Rescue.ControlOrder.serializer(), order))
            put("signatureHex", signatureHex)
            pqJson(pq)?.let { put("pqSignature", it) }
        })
    }

    override suspend fun archiveStart(req: ServerArchiveStartRequest) {
        call("/api/rescue/archive/start", "POST", json.encodeToJsonElement(ServerArchiveStartRequest.serializer(), req).jsonObject)
    }

    override suspend fun archiveStatus(): ServerArchiveStatus? =
        runCatching { json.decodeFromString(ServerArchiveStatusResponse.serializer(), String(call("/api/rescue/archive"), Charsets.UTF_8)).archive }
            .getOrElse { if (it is RescueTransportException) throw it else null }

    override suspend fun bundle(offset: Long): ByteArray = call("/api/rescue/archive/bundle?offset=$offset")

    override suspend fun archiveForget() { call("/api/rescue/archive", "DELETE") }

    override fun close() {
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }
}

object LiveRescueConnector : RescueConnector {
    override fun connect(endpoint: RescueEndpoint, serverDomain: String): RescueConnection = LiveRescueConnection(endpoint, serverDomain)
}
