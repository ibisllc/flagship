// The owner's single dead-man setting (docs/architecture-v2/serving-wiring.md section 4,
// issuance-and-lease-records.md section 5). Kotlin mirror of the records an app signs in
// packages/protocol/src/servingAuthority.ts; the vectors in
// packages/protocol/test-vectors/serving-authority/ lock the bytes:
//
//   flagship/serving-policy/v1|<account>|<box>|<regGen>|<policyGen>|<grace>|<onLapse>|<scopeSha256>|<issuedAt>
//   flagship/renewal-key-delegation/v1|<account>|p256|<renewalPub>|<deviceId>|<issuedAt>
//   flagship/serving-lease/v1|<account>|<box>|<regGen>|<policyGen>|<leaseId>|<issuedAt>|<notAfter>
//
// The admin root signs the policy and each device's renewal-key delegation (Ed25519). An admin
// device signs a lease each time the app opens with its hardware renewal key: ECDSA P-256 over
// SHA-256 of the canonical bytes, sent as compact low-S `r‖s`.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import com.google.crypto.tink.subtle.EllipticCurves
import kotlinx.serialization.Serializable
import java.math.BigInteger
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPublicKey

enum class ServingGrace(val wire: String, val ms: Long?) {
    SEVEN_DAYS("7d", 7L * 86_400_000),
    THIRTY_DAYS("30d", 30L * 86_400_000),
    INDEFINITE("indefinite", null);

    companion object {
        fun fromWire(s: String?): ServingGrace? = entries.firstOrNull { it.wire == s }
    }
}

enum class ServingOnLapse(val wire: String) {
    STOP_APPS("stop-apps"),
    LOCK_SERVER("lock-server");

    companion object {
        fun fromWire(s: String?): ServingOnLapse? = entries.firstOrNull { it.wire == s }
    }
}

@Serializable
data class ServingPolicy(
    val account: String,
    /** The box's identity public key. */
    val box: String,
    val regGen: Long,
    val policyGen: Long,
    val grace: String,
    val onLapse: String,
    val scopeSha256: String,
    val issuedAt: Long,
)

@Serializable
data class RenewalKeyDelegation(
    val account: String,
    val alg: String = "p256",
    /** SEC1 compressed P-256 point, 66 lowercase hex. */
    val renewalPub: String,
    /** The device's account device key (64 hex). */
    val deviceId: String,
    val issuedAt: Long,
)

@Serializable
data class ServingLease(
    val account: String,
    val box: String,
    val regGen: Long,
    val policyGen: Long,
    /** 32 lowercase hex, unique per lease. */
    val leaseId: String,
    val issuedAt: Long,
    val notAfter: Long,
)

@Serializable
data class SignedServingPolicy(val record: ServingPolicy, val signature: String)

@Serializable
data class SignedRenewalDelegation(val record: RenewalKeyDelegation, val signature: String)

/** A signed lease and, when the renewal key signed it, that key's delegation. */
data class SignedServingLease(val record: ServingLease, val signature: String, val delegation: SignedRenewalDelegation? = null)

object ServingAuthority {
    const val TAG_POLICY = "flagship/serving-policy/v1"
    const val TAG_DELEGATION = "flagship/renewal-key-delegation/v1"
    const val TAG_LEASE = "flagship/serving-lease/v1"

    private val HEX64 = Regex("^[0-9a-f]{64}$")
    private val HEX32 = Regex("^[0-9a-f]{32}$")
    private val P256_PUB = Regex("^0[23][0-9a-f]{64}$")
    private val ACCOUNT = Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
    private const val MAX_SAFE = 9_007_199_254_740_991L

    /** The P-256 group order n, and floor(n / 2): an S above it is "high". */
    val P256_ORDER = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)
    private val P256_HALF = P256_ORDER.shiftRight(1)

    private fun hex(name: String, v: String, re: Regex) = require(re.matches(v)) { "$name must be lowercase hex of the right length" }
    private fun int(name: String, v: Long, min: Long) = require(v in min..MAX_SAFE) { "$name must be a safe integer ≥ $min" }
    private fun join(vararg parts: Any) = parts.joinToString("|").toByteArray(Charsets.UTF_8)

    fun canonical(p: ServingPolicy): ByteArray {
        require(ACCOUNT.matches(p.account)) { "account must be a lowercase account name" }
        hex("box", p.box, HEX64)
        int("regGen", p.regGen, 1)
        int("policyGen", p.policyGen, 1)
        val g = requireNotNull(ServingGrace.fromWire(p.grace)) { "grace must be 7d, 30d or indefinite" }
        val o = requireNotNull(ServingOnLapse.fromWire(p.onLapse)) { "onLapse must be stop-apps or lock-server" }
        require(!(o == ServingOnLapse.LOCK_SERVER && g == ServingGrace.INDEFINITE)) { "locking needs a time limit" }
        hex("scopeSha256", p.scopeSha256, HEX64)
        int("issuedAt", p.issuedAt, 0)
        return join(TAG_POLICY, p.account, p.box, p.regGen, p.policyGen, p.grace, p.onLapse, p.scopeSha256, p.issuedAt)
    }

    fun canonical(d: RenewalKeyDelegation): ByteArray {
        require(ACCOUNT.matches(d.account)) { "account must be a lowercase account name" }
        require(d.alg == "p256") { "alg must be p256" }
        hex("renewalPub", d.renewalPub, P256_PUB)
        hex("deviceId", d.deviceId, HEX64)
        int("issuedAt", d.issuedAt, 0)
        return join(TAG_DELEGATION, d.account, d.alg, d.renewalPub, d.deviceId, d.issuedAt)
    }

    fun canonical(l: ServingLease): ByteArray {
        require(ACCOUNT.matches(l.account)) { "account must be a lowercase account name" }
        hex("box", l.box, HEX64)
        int("regGen", l.regGen, 1)
        int("policyGen", l.policyGen, 1)
        hex("leaseId", l.leaseId, HEX32)
        int("issuedAt", l.issuedAt, 0)
        int("notAfter", l.notAfter, 0)
        require(l.notAfter > l.issuedAt) { "notAfter must be after issuedAt" }
        return join(TAG_LEASE, l.account, l.box, l.regGen, l.policyGen, l.leaseId, l.issuedAt, l.notAfter)
    }

    /** The lease an admin device signs when the app opens: the full grace ahead of now. Null under an indefinite policy. */
    fun leaseFor(policy: ServingPolicy, now: Long, leaseId: String): ServingLease? {
        val ms = ServingGrace.fromWire(policy.grace)?.ms ?: return null
        return ServingLease(policy.account, policy.box, policy.regGen, policy.policyGen, leaseId, now, now + ms)
    }

    fun randomLeaseId(): String = HexUtil.encode(ByteArray(16).also(SecureRandom()::nextBytes))

    fun signEd25519(canonical: ByteArray, key: Ed25519Sign): String = HexUtil.encode(key.sign(canonical))

    fun verifyEd25519(canonical: ByteArray, signatureHex: String, publicKeyHex: String): Boolean = runCatching {
        if (signatureHex.length != 128 || !HEX64.matches(publicKeyHex)) return false
        Ed25519Verify(HexUtil.decode(publicKeyHex)!!).verify(HexUtil.decode(signatureHex)!!, canonical)
        true
    }.getOrDefault(false)

    // ---- P-256 (the renewal key) ------------------------------------------

    private fun to32(v: BigInteger): ByteArray {
        val b = v.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }

    /** A compact `r‖s` signature with S replaced by n − S when S is high. Null for anything not 64 bytes. */
    fun normalizeLowS(raw: ByteArray): ByteArray? {
        if (raw.size != 64) return null
        val s = BigInteger(1, raw.copyOfRange(32, 64))
        if (s <= P256_HALF) return raw.copyOf()
        return raw.copyOfRange(0, 32) + to32(P256_ORDER - s)
    }

    fun isLowS(raw: ByteArray): Boolean = raw.size == 64 && BigInteger(1, raw.copyOfRange(32, 64)) <= P256_HALF

    /** A DER `SEQUENCE { INTEGER r, INTEGER s }` (what Android Keystore gives) as compact 64-byte `r‖s`. Null when malformed. */
    fun derToRaw(der: ByteArray): ByteArray? {
        var i = 0
        fun len(): Int? {
            if (i >= der.size) return null
            val first = der[i++].toInt() and 0xff
            if (first < 0x80) return first
            val n = first and 0x7f
            if (n !in 1..2 || i + n > der.size) return null
            var v = 0
            repeat(n) { v = (v shl 8) or (der[i++].toInt() and 0xff) }
            return v
        }
        fun integer(): ByteArray? {
            if (i >= der.size || der[i] != 0x02.toByte()) return null
            i++
            val n = len() ?: return null
            if (n < 1 || i + n > der.size) return null
            var v = der.copyOfRange(i, i + n)
            i += n
            while (v.size > 1 && v[0] == 0.toByte()) v = v.copyOfRange(1, v.size)
            if (v.size > 32) return null
            return ByteArray(32 - v.size) + v
        }
        if (der.isEmpty() || der[0] != 0x30.toByte()) return null
        i = 1
        val total = len() ?: return null
        if (i + total != der.size) return null
        val r = integer() ?: return null
        val s = integer() ?: return null
        if (i != der.size) return null
        return r + s
    }

    /** Sign a lease with a signer that returns DER (Android Keystore's `SHA256withECDSA`); low-S compact hex. */
    fun signLeaseP256Der(lease: ServingLease, signDer: (ByteArray) -> ByteArray): String {
        val raw = requireNotNull(derToRaw(signDer(canonical(lease)))) { "a P-256 signature must be DER" }
        return HexUtil.encode(requireNotNull(normalizeLowS(raw)))
    }

    /** SEC1 compressed form of a P-256 public key, 66 lowercase hex. */
    fun compressedHex(key: ECPublicKey): String {
        val x = to32(key.w.affineX)
        val prefix: Byte = if (key.w.affineY.testBit(0)) 0x03 else 0x02
        return HexUtil.encode(byteArrayOf(prefix) + x)
    }

    /** A lease signed by a delegated renewal key; refuses high-S and anything malformed. */
    fun verifyLeaseP256(lease: ServingLease, signatureHex: String, renewalPubHex: String): Boolean = runCatching {
        if (signatureHex.length != 128 || !P256_PUB.matches(renewalPubHex)) return false
        val raw = HexUtil.decode(signatureHex) ?: return false
        if (!isLowS(raw)) return false
        val pub = EllipticCurves.getEcPublicKey(
            EllipticCurves.CurveType.NIST_P256, EllipticCurves.PointFormatType.COMPRESSED, HexUtil.decode(renewalPubHex)!!,
        )
        val v = Signature.getInstance("SHA256withECDSA")
        v.initVerify(pub)
        v.update(canonical(lease))
        v.verify(EllipticCurves.ecdsaIeee2Der(raw))
    }.getOrDefault(false)
}

/** The server page's one line (issuance-and-lease-records.md section 5). */
sealed interface ServingLineKind {
    data class StaysOnline(val until: Long) : ServingLineKind
    data class Locks(val until: Long) : ServingLineKind
    data object NoLimit : ServingLineKind
    data class NoLease(val locks: Boolean) : ServingLineKind

    companion object {
        fun of(grace: ServingGrace, onLapse: ServingOnLapse, until: Long?): ServingLineKind = when {
            grace == ServingGrace.INDEFINITE -> NoLimit
            until == null -> NoLease(onLapse == ServingOnLapse.LOCK_SERVER)
            onLapse == ServingOnLapse.LOCK_SERVER -> Locks(until)
            else -> StaysOnline(until)
        }
    }
}

/** How a `lock-server` serving policy bounds an auto-unlock lease (SEC-DEADMAN-001): a lease never
 *  outlives the deadline that would lock the server. */
object ServingLockLeaseBound {
    /** The lease expiry to use, or null when no lease may be deposited (the policy locks and has no live deadline). */
    fun expiry(requested: Long, locks: Boolean, until: Long?, now: Long): Long? {
        if (!locks) return requested
        if (until == null || until <= now) return null
        return minOf(requested, until)
    }
}
