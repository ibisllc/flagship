// The phone's bare `<account>.<apex>` name (plan H2/H3, docs/architecture-v2/phone-route.md):
// Kotlin mirror of packages/protocol/src/phoneRoute.ts and the two records the phone signs. The
// vectors in packages/protocol/test-vectors/phone-route/ lock the bytes.
//
//   flagship/route-claim/v1|<account>|<phoneRoutePub>|<hostname>|<generation>|<sessionNonce>|<issuedAt>
//   flagship/certificate-order/v1|phone|<device>|0|<csrSha256>|<requestId>|<issuedAt>

package com.flagshipserver.app.phoneroute

import com.flagshipserver.app.core.HexUtil
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.io.ByteArrayOutputStream
import java.security.MessageDigest

data class RouteClaim(
    val account: String,
    val phoneRoutePub: String,
    val hostname: String,
    val generation: Long,
    val sessionNonce: String,
    val issuedAt: Long,
)

data class PhoneCertificateOrder(
    val device: String,
    val csrSha256: String,
    val requestId: String,
    val issuedAt: Long,
) {
    val certClass: String get() = "phone"
    val regGen: Long get() = 0
}

object PhoneRoute {
    const val TAG_ROUTE_CLAIM = "flagship/route-claim/v1"
    const val TAG_CERTIFICATE_ORDER = "flagship/certificate-order/v1"
    const val TAG_ROUTE_RELEASE = "flagship/route-release/v1"
    const val TAG_PHONE_PRESENCE = "flagship/phone-presence/v1"
    const val CLAIM_SKEW_MS = 60_000L
    const val CERT_RENEW_BEFORE_MS = 30L * 86_400_000
    const val CERT_RETRY_AFTER_MS = 6L * 3_600_000
    const val BEAT_MS = 15_000L
    const val SESSION_COOKIE = "__Host-flagship-phone"
    const val CSRF_HEADER = "x-flagship-csrf"

    private val ACCOUNT = Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
    private val HEX64 = Regex("^[0-9a-f]{64}$")
    private val HEX32 = Regex("^[0-9a-f]{32}$")
    private const val MAX_SAFE = 9_007_199_254_740_991L

    fun hostname(account: String, apex: String): String {
        val a = account.lowercase()
        require(ACCOUNT.matches(a)) { "account must be a lowercase account name" }
        return "$a.${apex.lowercase()}"
    }

    /** The account when `sni` is exactly a bare `<account>.<apex>` name, else null. */
    fun bareAccount(sni: String, apex: String): String? {
        val lower = sni.lowercase()
        val suffix = ".${apex.lowercase()}"
        if (!lower.endsWith(suffix)) return null
        val head = lower.dropLast(suffix.length)
        return if (ACCOUNT.matches(head)) head else null
    }

    fun canonical(c: RouteClaim): ByteArray {
        require(ACCOUNT.matches(c.account)) { "account" }
        require(HEX64.matches(c.phoneRoutePub)) { "phoneRoutePub" }
        require(c.hostname == c.hostname.lowercase() && c.hostname.startsWith("${c.account}.") && c.hostname.split(".").size >= 3 && !c.hostname.contains('|')) { "hostname" }
        require(c.generation in 1..MAX_SAFE) { "generation" }
        require(HEX32.matches(c.sessionNonce)) { "sessionNonce" }
        require(c.issuedAt in 0..MAX_SAFE) { "issuedAt" }
        return listOf(TAG_ROUTE_CLAIM, c.account, c.phoneRoutePub, c.hostname, c.generation, c.sessionNonce, c.issuedAt)
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    /** The holder's release: the fields of the claim it holds, under the release tag. */
    fun canonicalRelease(held: RouteClaim): ByteArray {
        val claim = String(canonical(held), Charsets.UTF_8)
        return (TAG_ROUTE_RELEASE + claim.removePrefix(TAG_ROUTE_CLAIM)).toByteArray(Charsets.UTF_8)
    }

    /** "I'm here": a device's hello to the phone holding the bare name. */
    fun canonicalPresence(account: String, devicePub: String, hostname: String, issuedAt: Long): ByteArray {
        require(ACCOUNT.matches(account)) { "account" }
        require(HEX64.matches(devicePub)) { "devicePub" }
        require(hostname == hostname.lowercase() && hostname.startsWith("$account.") && hostname.split(".").size >= 3 && !hostname.contains('|')) { "hostname" }
        require(issuedAt in 0..MAX_SAFE) { "issuedAt" }
        return listOf(TAG_PHONE_PRESENCE, account, devicePub, hostname, issuedAt).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun verify(bytes: ByteArray, signatureHex: String, publicKeyHex: String): Boolean = runCatching {
        if (signatureHex.length != 128 || !HEX64.matches(publicKeyHex)) return false
        com.google.crypto.tink.subtle.Ed25519Verify(HexUtil.decode(publicKeyHex)!!).verify(HexUtil.decode(signatureHex)!!, bytes)
        true
    }.getOrDefault(false)

    fun canonical(o: PhoneCertificateOrder): ByteArray {
        require(HEX64.matches(o.device)) { "device" }
        require(HEX64.matches(o.csrSha256)) { "csrSha256" }
        require(HEX32.matches(o.requestId)) { "requestId" }
        require(o.issuedAt in 0..MAX_SAFE) { "issuedAt" }
        return listOf(TAG_CERTIFICATE_ORDER, o.certClass, o.device, o.regGen, o.csrSha256, o.requestId, o.issuedAt)
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun sign(bytes: ByteArray, key: Ed25519Sign): String = HexUtil.encode(key.sign(bytes))

    /** Most grants a phone sends in `begin` (a mesh relay reads no more). */
    const val BEGIN_MAX_GRANTS = 8
    private val HEX_SIG = Regex("^[0-9a-fA-F]{128}$")

    /**
     * The phone's own admin grant chain for `begin` (relay-mesh.md section 8.2), picked from `.com`'s
     * `/api/users/:u/device-grants` body: grants naming this device key and account, signed by the admin
     * root, with the `admin` scope and not yet expired; the latest expiry first (then the smaller grant id),
     * at most 8. Matches the TS `phoneBeginGrants` (`phone-route/vectors.json` "begin").
     */
    fun beginGrants(body: JsonElement?, account: String, devicePub: String, now: Long): List<JsonObject> {
        val listed = ((body as? JsonObject)?.get("grants") as? JsonArray) ?: return emptyList()
        val me = devicePub.lowercase()
        val user = account.lowercase()
        fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
        fun JsonObject.int(k: String) = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
        val out = ArrayList<Triple<Long, String, JsonObject>>()
        for (raw in listed) {
            val g = raw as? JsonObject ?: continue
            val grantId = g.str("grantId") ?: continue
            val username = g.str("username") ?: continue
            val deviceId = g.str("deviceId") ?: continue
            val pub = g.str("devicePubHex") ?: continue
            val scopesRaw = g["scopes"] as? JsonArray ?: continue
            val issuedAt = g.int("issuedAt") ?: continue
            val expiresAt = g.int("expiresAt") ?: continue
            val sig = g.str("signatureHex")?.takeIf { HEX_SIG.matches(it) } ?: continue
            val scopes = scopesRaw.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
            if (pub.lowercase() != me || username.lowercase() != user || g.str("signerRoot") != "admin-root") continue
            if ("admin" !in scopes || expiresAt <= now) continue
            out += Triple(expiresAt, grantId, buildJsonObject {
                putJsonObject("grant") {
                    put("grantId", grantId)
                    put("username", username)
                    put("deviceId", deviceId)
                    put("devicePubHex", me)
                    putJsonArray("scopes") { scopes.forEach { add(JsonPrimitive(it)) } }
                    put("issuedAt", issuedAt)
                    put("expiresAt", expiresAt)
                }
                put("signatureHex", sig.lowercase())
                put("signerRoot", "admin-root")
            })
        }
        out.sortWith(compareByDescending<Triple<Long, String, JsonObject>> { it.first }.thenBy { it.second })
        return out.take(BEGIN_MAX_GRANTS).map { it.third }
    }

    /** `{type:"begin", account, grants}`; a relay without the mesh ignores `grants`. */
    fun beginMessage(account: String, grants: List<JsonObject>): JsonObject = buildJsonObject {
        put("type", "begin")
        put("account", account.lowercase())
        put("grants", JsonArray(grants))
    }

    /** Should the phone order a certificate now? Reuse a held one until 30 days before its end; back off after a failure. */
    fun needsOrder(notAfter: Long?, lastFailureAt: Long?, now: Long): Boolean {
        if (lastFailureAt != null && now - lastFailureAt < CERT_RETRY_AFTER_MS) return false
        if (notAfter == null) return true
        return notAfter - now <= CERT_RENEW_BEFORE_MS
    }

    // ---- the CSR (PKCS #10, ECDSA P-256, exactly one name) -----------------

    private fun len(n: Int): ByteArray {
        if (n < 0x80) return byteArrayOf(n.toByte())
        val out = ArrayList<Byte>()
        var v = n
        while (v > 0) {
            out.add(0, (v and 0xff).toByte())
            v = v shr 8
        }
        return byteArrayOf((0x80 or out.size).toByte()) + out.toByteArray()
    }

    private fun tlv(tag: Int, body: ByteArray): ByteArray = byteArrayOf(tag.toByte()) + len(body.size) + body

    private fun cat(vararg parts: ByteArray): ByteArray = ByteArrayOutputStream().apply { parts.forEach { write(it) } }.toByteArray()

    private fun oid(dotted: String): ByteArray {
        val p = dotted.split(".").map { it.toLong() }
        val out = ByteArrayOutputStream()
        out.write((40 * p[0] + p[1]).toInt())
        for (v0 in p.drop(2)) {
            val bytes = ArrayList<Int>()
            var v = v0
            do {
                bytes.add(0, (v and 0x7f).toInt())
                v = v shr 7
            } while (v > 0)
            for (i in 0 until bytes.size - 1) bytes[i] = bytes[i] or 0x80
            bytes.forEach(out::write)
        }
        return tlv(0x06, out.toByteArray())
    }

    /** The CertificationRequestInfo for the phone's key (uncompressed, 65 bytes) and its name. Same bytes as TS and Swift. */
    fun csrInfo(publicKey: ByteArray, hostname: String): ByteArray {
        require(publicKey.size == 65 && publicKey[0] == 0x04.toByte()) { "publicKey must be an uncompressed P-256 point" }
        require(Regex("^[a-z0-9.-]{1,253}$").matches(hostname)) { "hostname must be one lowercase DNS name" }
        val ascii = hostname.toByteArray(Charsets.US_ASCII)
        val name = tlv(0x30, tlv(0x31, tlv(0x30, cat(oid("2.5.4.3"), tlv(0x0c, ascii)))))
        val spki = tlv(0x30, cat(tlv(0x30, cat(oid("1.2.840.10045.2.1"), oid("1.2.840.10045.3.1.7"))), tlv(0x03, cat(byteArrayOf(0), publicKey))))
        val san = tlv(0x30, cat(oid("2.5.29.17"), tlv(0x04, tlv(0x30, tlv(0x82, ascii)))))
        val attr = tlv(0x30, cat(oid("1.2.840.113549.1.9.14"), tlv(0x31, tlv(0x30, san))))
        return tlv(0x30, cat(tlv(0x02, byteArrayOf(0)), name, spki, tlv(0xa0, attr)))
    }

    /** The full CSR from its info and a DER ECDSA-SHA256 signature over the info. */
    fun csr(info: ByteArray, signatureDer: ByteArray): ByteArray =
        tlv(0x30, cat(info, tlv(0x30, oid("1.2.840.10045.4.3.2")), tlv(0x03, cat(byteArrayOf(0), signatureDer))))

    fun sha256Hex(b: ByteArray): String = HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(b))
}

/** One request to the phone endpoint, as the policy sees it. */
data class PhoneEndpointRequest(
    val method: String,
    val host: String,
    val origin: String?,
    val sessionCookie: String?,
    val csrf: String?,
    val upgrade: Boolean,
    val establish: Boolean = false,
)

/** Mirror of `phoneEndpointCheck`: exact Host, exact Origin for anything not a plain read, host-only cookie, CSRF header. */
object PhoneEndpointPolicy {
    fun check(r: PhoneEndpointRequest, hostname: String, sessionToken: String?, csrfToken: String?): String {
        val host = hostname.lowercase()
        if (r.host.lowercase() != host) return "wrong-host"
        val method = r.method.uppercase()
        if ((method == "GET" || method == "HEAD") && !r.upgrade) return "allow"
        if (r.origin != "https://$host") return "cross-origin"
        if (r.establish && method == "POST" && !r.upgrade) return "allow"
        if (sessionToken == null || r.sessionCookie == null || !MessageDigest.isEqual(r.sessionCookie.toByteArray(), sessionToken.toByteArray())) return "no-session"
        if (csrfToken == null || r.csrf == null || !MessageDigest.isEqual(r.csrf.toByteArray(), csrfToken.toByteArray())) return "csrf"
        return "allow"
    }

    fun sessionCookie(token: String): String = "${PhoneRoute.SESSION_COOKIE}=$token; Path=/; Secure; HttpOnly; SameSite=Strict"
}
