// The certificate check for the TLS connection a call's caller opens to the callee phone's TURN server
// (turns:<account>.<apex>:443). libwebrtc's own check trusts only its built-in roots (rtc_base/ssl_roots.h, Google's
// list), which hold no Let's Encrypt root, and phones' certificates come from Let's Encrypt: the call never connected
// from the app, while browsers (system roots) did. This checks the phone's certificate the way Android checks any TLS
// server: the system's roots and the exact name the call dialled. WebRTC hands over only the server's own
// certificate, so the intermediates come from the address each certificate names (its AIA "CA Issuers" URL, plain
// HTTP: they are signed, and the system check is what decides), kept in memory for later calls. Same rules as iOS
// TurnCertVerifier.swift.

package com.flagshipserver.app.calls

import android.net.http.X509TrustManagerExtensions
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import org.bouncycastle.asn1.ASN1OctetString
import org.bouncycastle.asn1.x509.AccessDescription
import org.bouncycastle.asn1.x509.AuthorityInformationAccess
import org.bouncycastle.asn1.x509.GeneralName

object TurnCertCheck {
    private const val MAX_INTERMEDIATES = 4
    private const val FETCH_TIMEOUT_MS = 4_000
    private const val MAX_CERT_BYTES = 16 * 1024
    private val fetched = ConcurrentHashMap<String, X509Certificate>()

    /** `turns:<host>:443?transport=tcp` → `<host>`; null for anything else. */
    fun host(turnUrl: String): String? {
        if (!turnUrl.startsWith("turns:")) return null
        val hostPort = turnUrl.removePrefix("turns:").substringBefore('?')
        val host = hostPort.substringBefore(':')
        return host.takeIf { it.isNotEmpty() }?.lowercase()
    }

    /** The certificate names exactly [host] (phone certificates carry one DNS name, no wildcard). */
    fun namesHost(cert: X509Certificate, host: String): Boolean =
        runCatching { cert.subjectAlternativeNames.orEmpty() }.getOrDefault(emptyList())
            .any { it.size >= 2 && it[0] == 2 && (it[1] as? String)?.lowercase() == host }

    fun parse(der: ByteArray): X509Certificate? = runCatching {
        CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as X509Certificate
    }.getOrNull()

    /** The certificate's "CA Issuers" URLs (http only, as Let's Encrypt publishes them). */
    fun issuerUrls(cert: X509Certificate): List<String> = runCatching {
        val ext = cert.getExtensionValue("1.3.6.1.5.5.7.1.1") ?: return emptyList()
        val aia = AuthorityInformationAccess.getInstance(ASN1OctetString.getInstance(ext).octets)
        aia.accessDescriptions
            .filter { it.accessMethod == AccessDescription.id_ad_caIssuers && it.accessLocation.tagNo == GeneralName.uniformResourceIdentifier }
            .map { it.accessLocation.name.toString() }
            .filter { it.startsWith("http://") || it.startsWith("https://") }
    }.getOrDefault(emptyList())

    private fun fetch(url: String): X509Certificate? {
        fetched[url]?.let { return it }
        val c = runCatching {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = FETCH_TIMEOUT_MS
            conn.readTimeout = FETCH_TIMEOUT_MS
            conn.instanceFollowRedirects = false
            try {
                if (conn.responseCode != 200) return@runCatching null
                val bytes = conn.inputStream.use { it.readNBytesCompat(MAX_CERT_BYTES + 1) }
                if (bytes.size > MAX_CERT_BYTES) null else parse(bytes)
            } finally {
                conn.disconnect()
            }
        }.getOrNull() ?: return null
        fetched[url] = c
        return c
    }

    private fun java.io.InputStream.readNBytesCompat(max: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(4096)
        while (out.size() < max) {
            val n = read(buf, 0, minOf(buf.size, max - out.size()))
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    /** The leaf plus intermediates up to [MAX_INTERMEDIATES], each the issuer of the one before. */
    fun chain(leaf: X509Certificate, fetcher: (String) -> X509Certificate? = ::fetch): List<X509Certificate> {
        val chain = mutableListOf(leaf)
        var cur = leaf
        repeat(MAX_INTERMEDIATES) {
            if (cur.issuerX500Principal == cur.subjectX500Principal) return chain
            val next = issuerUrls(cur).firstNotNullOfOrNull { u -> fetcher(u)?.takeIf { it.subjectX500Principal == cur.issuerX500Principal } }
                ?: return chain
            chain += next
            cur = next
        }
        return chain
    }

    private val systemTrust: X509TrustManager by lazy {
        val f = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        f.init(null as KeyStore?)
        f.trustManagers.filterIsInstance<X509TrustManager>().first()
    }

    /** The system's verdict on [der] as the TLS server [host]. */
    fun verify(der: ByteArray, host: String): Boolean {
        val leaf = parse(der) ?: return false
        if (!namesHost(leaf, host)) return false
        val chain = chain(leaf)
        val authType = if (leaf.publicKey.algorithm == "EC") "ECDHE_ECDSA" else "ECDHE_RSA"
        return runCatching {
            X509TrustManagerExtensions(systemTrust).checkServerTrusted(chain.toTypedArray(), authType, host)
            true
        }.getOrDefault(false)
    }
}
