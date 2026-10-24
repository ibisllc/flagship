package com.flagshipserver.app.core.pq

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Boot unlock v2, the phone side (packages/protocol/src/bootUnlockV2.ts,
 * docs/architecture-v2/pq-suites.md §19): verify a box's v2 boot material under the STK's
 * verified hybrid binding, verify a v2 request under the boot key's hybrid key, and seal the disk
 * key to the request's per-boot reply key (or a v3 lease to the box's lease key) with
 * `flagship/hybrid-seal/v1`, signed with the owner's hybrid key. Codes match the TS port and
 * test-vectors/boot-unlock-v2/vectors.json.
 */
object BootUnlockV2 {
    const val TAG_BOOT_KEY_BINDING_V3 = "flagship/boot-key-binding/v3"
    const val TAG_SECRET_REQUEST_V2 = "flagship/secret-request/v2"
    const val TAG_BOOT_REPLY_V2 = "flagship/boot-reply/v2"
    const val TAG_AUTO_UNLOCK_LEASE_V3 = "flagship/auto-unlock-lease/v3"
    private const val SIG_LEN = 3373

    class Failure(val code: String) : Exception(code)

    private fun fail(code: String): Nothing = throw Failure(code)

    data class Material(
        val serverDomain: String,
        val bootPubHex: String,
        val bootHybridPublicKey: ByteArray,
        val leaseKemPublicKey: ByteArray,
        val custody: String,
        val issuedAt: Long,
    )

    private val HEX = Regex("^[0-9a-f]*$")
    private val DOMAIN = Regex("^[a-z0-9][a-z0-9.-]{0,252}$")
    private fun isHex(s: String?, bytes: Int) = s != null && s.length == bytes * 2 && HEX.matches(s)
    private fun str(o: JsonObject, k: String): String? = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun unhex(s: String): ByteArray = PqHex.decode(s) ?: fail("v2-malformed")
    private fun utf8(s: String) = s.toByteArray(Charsets.UTF_8)

    fun hybridKeyIdHex(pk: ByteArray): String = PqHex.encode(PqHybrid.pqKeyId(PqHybrid.SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, pk))
    fun kemKeyIdHex(pk: ByteArray): String = PqHex.encode(PqHybrid.pqKeyId(PqHybrid.SUITE_HYBRID_SEAL_V1, pk))

    fun canonicalBootKeyBindingV3(domain: String, bootPubHex: String, bootMldsaPubHex: String, leaseKemPubHex: String, custody: String, issuedAt: Long): ByteArray =
        utf8(listOf(TAG_BOOT_KEY_BINDING_V3, domain, bootPubHex, hybridKeyIdHex(unhex(bootPubHex + bootMldsaPubHex)), kemKeyIdHex(unhex(leaseKemPubHex)), custody, issuedAt.toString()).joinToString("|"))

    /** Verifies the `pq` object `.com` serves beside the boot-key binding. */
    fun verifyMaterial(
        wire: JsonElement?,
        serverDomain: String,
        bootPubHex: String,
        stkBinding: PqTrust.VerifiedBinding,
        now: Long,
        pinnedBootMldsaPubHex: String? = null,
    ): Material {
        val o = wire as? JsonObject ?: fail("v2-malformed")
        if (o.keys != setOf("bootBinding", "bootMldsaPubHex", "bootPubHex", "custody", "issuedAt", "leaseKemPubHex", "serverDomain", "stkSignature", "v")) fail("v2-malformed")
        if ((o["v"] as? JsonPrimitive)?.intOrNull != 1) fail("v2-malformed")
        val domain = str(o, "serverDomain")?.takeIf { DOMAIN.matches(it) } ?: fail("v2-malformed")
        val boot = str(o, "bootPubHex")?.takeIf { isHex(it, 32) } ?: fail("v2-malformed")
        val mldsa = str(o, "bootMldsaPubHex")?.takeIf { isHex(it, 1952) } ?: fail("v2-malformed")
        val kemHex = str(o, "leaseKemPubHex")?.takeIf { isHex(it, 1216) } ?: fail("v2-malformed")
        val custody = str(o, "custody")?.takeIf { it == "software" || it == "tpm" } ?: fail("v2-malformed")
        val at = (o["issuedAt"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it >= 0 } ?: fail("v2-malformed")
        val sig = str(o, "stkSignature")?.takeIf { isHex(it, SIG_LEN) } ?: fail("v2-malformed")
        if (domain != serverDomain.lowercase() || boot != bootPubHex.lowercase()) fail("material-boot-key")
        if (stkBinding.role != "box-stk" || stkBinding.subjectId != domain) fail("material-signature")
        val bootBinding = try {
            PqTrust.verifyPqKeyBinding(o["bootBinding"], PqTrust.Expectation("boot-key", domain, boot, pinnedBootMldsaPubHex ?: mldsa, now))
        } catch (_: Exception) {
            fail("material-binding")
        }
        if (bootBinding.mldsaPubHex != mldsa) fail("material-binding")
        val kem = unhex(kemHex)
        try { PqHybrid.parseHybridSealPublicKey(kem) } catch (_: Exception) { fail("v2-malformed") }
        try {
            PqHybrid.hybridVerify(stkBinding.hybridPublicKey, TAG_BOOT_KEY_BINDING_V3, canonicalBootKeyBindingV3(domain, boot, mldsa, kemHex, custody, at), unhex(sig))
        } catch (_: Exception) {
            fail("material-signature")
        }
        return Material(domain, boot, bootBinding.hybridPublicKey, kem, custody, at)
    }

    /** Verifies a v2 request's `pq` extension; returns the per-boot reply key. */
    fun verifyRequest(serverDomain: String, bootPubHex: String, purpose: String, nonceHex: String, issuedAt: Long, pq: JsonElement?, material: Material): ByteArray {
        val p = pq as? JsonObject ?: fail("v2-malformed")
        if (p.keys != setOf("replyKemPubHex", "signature", "v") || (p["v"] as? JsonPrimitive)?.intOrNull != 2) fail("v2-malformed")
        val kemHex = str(p, "replyKemPubHex")?.lowercase()?.takeIf { isHex(it, 1216) } ?: fail("v2-malformed")
        val sig = str(p, "signature")?.lowercase()?.takeIf { isHex(it, SIG_LEN) } ?: fail("v2-malformed")
        if (serverDomain.lowercase() != material.serverDomain || bootPubHex.lowercase() != material.bootPubHex) fail("other-server")
        val nonce = nonceHex.lowercase()
        if (purpose != "unlock-key" || !isHex(nonce, 32)) fail("v2-malformed")
        val kem = unhex(kemHex)
        try { PqHybrid.parseHybridSealPublicKey(kem) } catch (_: Exception) { fail("v2-malformed") }
        val statement = utf8(listOf(TAG_SECRET_REQUEST_V2, material.serverDomain, material.bootPubHex, "unlock-key", nonce, kemKeyIdHex(kem), issuedAt.toString()).joinToString("|"))
        try { PqHybrid.hybridVerify(material.bootHybridPublicKey, TAG_SECRET_REQUEST_V2, statement, unhex(sig)) } catch (_: Exception) { fail("request-signature") }
        return kem
    }

    /** A hybrid signer for the owner key: purpose and payload in, 3373 bytes out. */
    fun interface OwnerSigner {
        fun sign(purpose: String, payload: ByteArray): ByteArray
    }

    private fun pack(key: ByteArray, sig: ByteArray): ByteArray {
        if (key.isEmpty() || key.size > 1024) fail("v2-malformed")
        if (sig.size != SIG_LEN) fail("owner-signature")
        return byteArrayOf(((key.size ushr 8) and 0xff).toByte(), (key.size and 0xff).toByte()) + key + sig
    }

    private fun sha512Hex(b: ByteArray) = PqHex.encode(PqHybrid.sha512(b))

    fun buildReply(
        serverDomain: String,
        bootPubHex: String,
        nonceHex: String,
        replyKemPub: ByteArray,
        diskKey: ByteArray,
        ownerHybridPublicKey: ByteArray,
        issuedAt: Long,
        sign: OwnerSigner,
        randomness: ByteArray? = null,
    ): ByteArray {
        val d = serverDomain.lowercase(); val b = bootPubHex.lowercase(); val n = nonceHex.lowercase()
        if (!DOMAIN.matches(d) || !isHex(b, 32) || !isHex(n, 32) || replyKemPub.size != 1216) fail("v2-malformed")
        val statement = utf8(listOf(TAG_BOOT_REPLY_V2, d, b, "unlock-key", n, kemKeyIdHex(replyKemPub), sha512Hex(diskKey), issuedAt.toString()).joinToString("|"))
        val plaintext = pack(diskKey, sign.sign(TAG_BOOT_REPLY_V2, statement))
        try {
            val opts = PqHybrid.HybridSealOptions(
                purpose = TAG_BOOT_REPLY_V2,
                senderKeyId = PqHybrid.pqKeyId(PqHybrid.SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, ownerHybridPublicKey),
                issuedAt = issuedAt,
                sessionNonce = unhex(n),
            )
            val context = listOf(utf8(d), unhex(b), utf8("unlock-key"), unhex(n))
            return if (randomness != null) PqHybrid.hybridSealWithRandomness(replyKemPub, opts, context, plaintext, randomness)
            else PqHybrid.hybridSeal(replyKemPub, opts, context, plaintext)
        } finally {
            plaintext.fill(0)
        }
    }

    fun sealLease(
        serverDomain: String,
        bootPubHex: String,
        leaseId: String,
        issuedAt: Long,
        expiresAt: Long,
        maxUses: Int? = null,
        leaseKemPublicKey: ByteArray,
        diskKey: ByteArray,
        ownerHybridPublicKey: ByteArray,
        sign: OwnerSigner,
        randomness: ByteArray? = null,
    ): ByteArray {
        val d = serverDomain.lowercase(); val b = bootPubHex.lowercase(); val l = leaseId.lowercase()
        if (!DOMAIN.matches(d) || !isHex(b, 32) || !Regex("^[0-9a-f]{16,128}$").matches(l) || expiresAt <= issuedAt || issuedAt < 0) fail("v2-malformed")
        val statement = utf8(
            listOf(TAG_AUTO_UNLOCK_LEASE_V3, d, b, kemKeyIdHex(leaseKemPublicKey), l, sha512Hex(diskKey), issuedAt.toString(), expiresAt.toString(), (maxUses ?: -1).toString())
                .joinToString("|"),
        )
        val plaintext = pack(diskKey, sign.sign(TAG_AUTO_UNLOCK_LEASE_V3, statement))
        try {
            val opts = PqHybrid.HybridSealOptions(
                purpose = TAG_AUTO_UNLOCK_LEASE_V3,
                senderKeyId = PqHybrid.pqKeyId(PqHybrid.SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, ownerHybridPublicKey),
                issuedAt = issuedAt,
                expiresAt = expiresAt,
            )
            val context = listOf(utf8(d), unhex(b), utf8(l))
            return if (randomness != null) PqHybrid.hybridSealWithRandomness(leaseKemPublicKey, opts, context, plaintext, randomness)
            else PqHybrid.hybridSeal(leaseKemPublicKey, opts, context, plaintext)
        } finally {
            plaintext.fill(0)
        }
    }

    fun chooseReplyVersion(strict: Boolean, material: Boolean, requestHasPq: Boolean, canSignHybrid: Boolean): Int {
        if (material && requestHasPq && canSignHybrid) return 2
        if (!strict) return 1
        if (!material || !requestHasPq) fail("box-has-no-v2")
        fail("phone-cannot-sign-hybrid")
    }

    fun chooseLeaseVersion(strict: Boolean, material: Boolean, canSignHybrid: Boolean): Int {
        if (material && canSignHybrid) return 3
        if (!strict) return 2
        fail(if (material) "phone-cannot-sign-hybrid" else "box-has-no-v2")
    }
}
