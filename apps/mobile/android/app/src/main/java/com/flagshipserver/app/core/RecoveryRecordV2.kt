// The complete, versioned cloud-recovery record (SECURITY-HARDENING-PLAN.md 18.3, N03).
// Kotlin mirror of FlagshipAPI/RecoveryRecordV2.swift and @flagship/protocol recoveryRecord.ts;
// the shared vectors are packages/protocol/test-vectors/recovery-record/vectors.json.
//
// Every behaviour-changing value is signed: the ciphertext digests, the fetch-token and PRF-salt
// hashes, the versions and policy, the record's generation and the digest of the record it
// replaces. Optional escrows are never omitted: each is keep:<digest>, replace:<digest>, remove or
// none, so inheriting security state is a signed act.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Verify
import java.security.MessageDigest
import java.security.SecureRandom
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable

/** `change` is keep | replace | remove | none; `digestHex` accompanies keep and replace only. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class RecoveryEscrowChange(
    val change: String,
    // Never encoded when absent, whatever the transport's Json config: `.com` rejects an extra key.
    @EncodeDefault(EncodeDefault.Mode.NEVER) val digestHex: String? = null,
) {
    internal fun canonical(name: String): String = when (change) {
        "remove", "none" -> {
            require(digestHex == null) { "bad $name" }
            change
        }
        "keep", "replace" -> {
            require(digestHex != null && HEX64.matches(digestHex)) { "bad $name" }
            "$change:$digestHex"
        }
        else -> throw IllegalArgumentException("bad $name")
    }

    companion object {
        val none = RecoveryEscrowChange("none")
        fun keep(digestHex: String) = RecoveryEscrowChange("keep", digestHex)
        fun replace(digestHex: String) = RecoveryEscrowChange("replace", digestHex)
    }
}

private val HEX64 = Regex("^[0-9a-f]{64}$")

@Serializable
data class RecoveryRecordV2(
    val op: String,
    val username: String,
    val irkPubHex: String,
    val adminRootPubHex: String,
    val credentialIdHex: String,
    val wrappedUmkDigestHex: String,
    val adminRoot: RecoveryEscrowChange,
    val acmeKey: RecoveryEscrowChange,
    val fetchTokenHashHex: String,
    val prfSaltHashHex: String,
    val kdfVersion: Int,
    val algVersion: Int,
    val policy: String,
    val generation: Int,
    val nonceHex: String,
    /** `genesis`, `legacy` (a v1 row) or the previous record's digest. */
    val priorDigestHex: String,
    val issuedAt: Long,
) {
    fun canonicalBytes(): ByteArray {
        require(op == "put" || op == "delete") { "bad op" }
        for ((n, v) in listOf("username" to username, "credentialIdHex" to credentialIdHex)) {
            require(v.isNotEmpty() && v.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }) { "bad $n" }
        }
        require(HEX64.matches(irkPubHex)) { "bad irkPubHex" }
        require(adminRootPubHex == "none" || HEX64.matches(adminRootPubHex)) { "bad adminRootPubHex" }
        require(Regex("^[0-9a-f]{16,512}$").matches(credentialIdHex)) { "bad credentialIdHex" }
        for ((n, v) in listOf("wrappedUmkDigestHex" to wrappedUmkDigestHex, "fetchTokenHashHex" to fetchTokenHashHex, "prfSaltHashHex" to prfSaltHashHex)) {
            require(HEX64.matches(v)) { "bad $n" }
        }
        require(kdfVersion == KDF_VERSION) { "bad kdfVersion" }
        require(algVersion == ALG_VERSION) { "bad algVersion" }
        require(policy == POLICY) { "bad policy" }
        require(generation >= 1) { "bad generation" }
        require(issuedAt >= 0) { "bad issuedAt" }
        require(Regex("^[0-9a-f]{32}$").matches(nonceHex)) { "bad nonceHex" }
        require(priorDigestHex == "genesis" || priorDigestHex == "legacy" || HEX64.matches(priorDigestHex)) { "bad priorDigestHex" }
        require(!(priorDigestHex == "genesis" && generation != 1)) { "a genesis record is generation 1" }
        return listOf(
            TAG, op, username.lowercase(), irkPubHex, adminRootPubHex, credentialIdHex, wrappedUmkDigestHex,
            adminRoot.canonical("adminRoot"), acmeKey.canonical("acmeKey"), fetchTokenHashHex, prfSaltHashHex,
            kdfVersion.toString(), algVersion.toString(), policy, generation.toString(), nonceHex, priorDigestHex,
            issuedAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    /** The chain link the next write must name. */
    fun digestHex(): String = HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(canonicalBytes()))

    fun verify(signatureHex: String, irkPub: ByteArray): Boolean = try {
        HexUtil.encode(irkPub) == irkPubHex &&
            run { Ed25519Verify(irkPub).verify(HexUtil.decode(signatureHex) ?: return false, canonicalBytes()); true }
    } catch (_: Throwable) {
        false
    }

    /** Before anything is unwrapped: is each ciphertext the one this claim names? Returns the first that is not. */
    fun ciphertextMismatch(wrappedUmk: String?, wrappedAdminRoot: String?, wrappedAcmeAccountKey: String?): String? {
        if (wrappedUmk == null || sha256HexOfBase64(wrappedUmk) != wrappedUmkDigestHex) return "wrappedUmk"
        fun check(b64: String?, e: RecoveryEscrowChange, name: String): String? {
            val want = if (e.change == "keep" || e.change == "replace") e.digestHex else null
            if (want == null) return if (b64 == null) null else name
            return if (b64 != null && sha256HexOfBase64(b64) == want) null else name
        }
        return check(wrappedAdminRoot, adminRoot, "wrappedAdminRoot") ?: check(wrappedAcmeAccountKey, acmeKey, "wrappedAcmeAccountKey")
    }

    companion object {
        const val TAG = "flagship/recovery-record/v2"
        const val KDF_VERSION = 1
        const val ALG_VERSION = 1
        const val POLICY = "passkey-and-passphrase"

        fun sha256HexOfBase64(b64: String): String? = try {
            HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(java.util.Base64.getDecoder().decode(b64)))
        } catch (_: Throwable) {
            null
        }
    }
}

/** `GET /api/recovery/by-username/:u` — where the stored record's signed history stands. */
@Serializable
data class RecoveryRecordState(
    val credentialId: String,
    val wrappedUmkHash: String,
    val legacy: Boolean = false,
    val generation: Int? = null,
    val digestHex: String? = null,
    val adminRootDigestHex: String? = null,
    val acmeKeyDigestHex: String? = null,
)

/** The signed claim `.com` serves with the ciphertext on the gated fetch. */
@Serializable
data class SignedRecoveryRecord(
    val claim: RecoveryRecordV2,
    val signatureHex: String,
    val digestHex: String,
    val generation: Int,
)

object RecoveryRecordChain {
    /**
     * The next record for an account. `current` is the stored state (null = none). Escrows not
     * re-sent are keep:<held digest> when something is held, else none.
     */
    fun next(
        username: String,
        irkPubHex: String,
        adminRootPubHex: String?,
        current: RecoveryRecordState?,
        credentialIdHex: String,
        wrappedUmk: String,
        wrappedAdminRoot: String?,
        wrappedAcmeAccountKey: String?,
        fetchTokenHashHex: String,
        prfSaltHashHex: String,
        issuedAt: Long,
        op: String = "put",
        nonce: ByteArray = ByteArray(16).also { SecureRandom().nextBytes(it) },
    ): RecoveryRecordV2 {
        fun change(new: String?, held: String?): RecoveryEscrowChange {
            if (!new.isNullOrEmpty()) return RecoveryEscrowChange.replace(requireNotNull(RecoveryRecordV2.sha256HexOfBase64(new)) { "bad escrow" })
            if (held != null) return RecoveryEscrowChange.keep(held)
            return RecoveryEscrowChange.none
        }
        val legacy = current?.legacy == true
        return RecoveryRecordV2(
            op = op,
            username = username,
            irkPubHex = irkPubHex,
            adminRootPubHex = adminRootPubHex?.lowercase() ?: "none",
            credentialIdHex = credentialIdHex,
            wrappedUmkDigestHex = requireNotNull(RecoveryRecordV2.sha256HexOfBase64(wrappedUmk)) { "bad wrappedUmk" },
            adminRoot = change(wrappedAdminRoot, current?.adminRootDigestHex),
            acmeKey = change(wrappedAcmeAccountKey, current?.acmeKeyDigestHex),
            fetchTokenHashHex = fetchTokenHashHex,
            prfSaltHashHex = prfSaltHashHex,
            kdfVersion = RecoveryRecordV2.KDF_VERSION,
            algVersion = RecoveryRecordV2.ALG_VERSION,
            policy = RecoveryRecordV2.POLICY,
            generation = if (current != null && !legacy) (current.generation ?: 0) + 1 else 1,
            nonceHex = HexUtil.encode(nonce),
            priorDigestHex = if (current == null) "genesis" else if (legacy) "legacy" else (current.digestHex ?: "legacy"),
            issuedAt = issuedAt,
        )
    }
}
