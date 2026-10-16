// The two signed orders behind a server's saved backups
// (docs/server-backup-and-clone.md, "Backup policy" and "Scheduled backups"),
// Kotlin ports of packages/protocol/src/backupPolicy.ts and archiveKeys.ts.
// Must pass packages/protocol/test-vectors/backup-policy and
// server-archive-keys vectors. Both are signed with the sensitive-order key
// (admin root, else IRK), like the archive-download approval.

package com.flagshipserver.app.core

import kotlinx.serialization.Serializable
import java.security.MessageDigest

private fun canonicalField(s: String): Boolean = s.isNotEmpty() && s.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }

/** `flagship/backup-policy/v1|<serverDomain>|<phone|peer|none>|<phoneReserveBytes>|<issuedAt>` */
@Serializable
data class BackupPolicyOrder(
    val serverDomain: String,
    /** `phone` | `peer` | `none` */
    val policy: String,
    /** > 0 exactly when the policy is `phone`, else 0. */
    val phoneReserveBytes: Long,
    val issuedAt: Long,
) {
    val isValid: Boolean
        get() = canonicalField(serverDomain) && policy in POLICIES &&
            phoneReserveBytes in 0..MAX_SAFE && (if (policy == "phone") phoneReserveBytes > 0 else phoneReserveBytes == 0L) &&
            issuedAt in 0..MAX_SAFE

    fun canonicalBytes(): ByteArray {
        check(isValid) { "backup-policy: malformed order" }
        return listOf(TAG, serverDomain, policy, phoneReserveBytes.toString(), issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    companion object {
        const val TAG = "flagship/backup-policy/v1"
        val POLICIES = listOf("phone", "peer", "none")
        internal const val MAX_SAFE = 9_007_199_254_740_991L

        /** The order for [policy] on [serverDomain] (lowercased; the reserve only rides a phone policy). */
        fun make(serverDomain: String, policy: String, phoneReserveBytes: Long, issuedAt: Long) = BackupPolicyOrder(
            serverDomain = serverDomain.lowercase(),
            policy = policy,
            phoneReserveBytes = if (policy == "phone") phoneReserveBytes else 0,
            issuedAt = issuedAt,
        )
    }
}

/** One archive id and its account-slot key (`ServerArchive.deriveKey(UMK, archiveId)`). */
@Serializable
data class ArchiveKey(val archiveId: String, val kekHex: String)

/** `flagship/server-archive-keys/v1|<serverDomain>|<count>|<digest>|<issuedAt>` */
@Serializable
data class ArchiveKeysDeposit(
    val serverDomain: String,
    val count: Int,
    val digest: String,
    val issuedAt: Long,
) {
    val isValid: Boolean
        get() = canonicalField(serverDomain) && count in 1..ArchiveKeys.MAX_PER_DEPOSIT &&
            HEX64.matches(digest) && issuedAt in 0..BackupPolicyOrder.MAX_SAFE

    fun canonicalBytes(): ByteArray {
        check(isValid) { "archive-keys: malformed deposit" }
        return listOf(ArchiveKeys.TAG, serverDomain, count.toString(), digest, issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    private companion object {
        val HEX64 = Regex("^[0-9a-f]{64}$")
    }
}

object ArchiveKeys {
    const val TAG = "flagship/server-archive-keys/v1"
    /** The most keys one deposit may carry. */
    const val MAX_PER_DEPOSIT = 400
    private val HEX32 = Regex("^[0-9a-f]{32}$")
    private val HEX64 = Regex("^[0-9a-f]{64}$")

    /** SHA-256 hex of the lines `<archiveId>:<kekHex>` joined with "\n", in order. */
    fun digest(keys: List<ArchiveKey>): String {
        for (k in keys) {
            require(HEX32.matches(k.archiveId)) { "archive-keys: bad archiveId" }
            require(HEX64.matches(k.kekHex)) { "archive-keys: bad kekHex" }
        }
        val text = keys.joinToString("\n") { "${it.archiveId}:${it.kekHex}" }
        return HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)))
    }

    /** [count] fresh archive ids with their account-slot keys. */
    fun mint(umkSeed: ByteArray, count: Int, rng: (Int) -> ByteArray = ServerBackupFormat::randomBytes): List<ArchiveKey> =
        (0 until count).map {
            val id = HexUtil.encode(rng(16))
            val kek = ServerArchive.deriveKey(umkSeed, id) ?: error("archive-keys: bad seed")
            ArchiveKey(id, HexUtil.encode(kek)).also { kek.fill(0) }
        }

    /** The signed deposit for [keys] on [serverDomain] (lowercased). */
    fun deposit(serverDomain: String, keys: List<ArchiveKey>, issuedAt: Long) =
        ArchiveKeysDeposit(serverDomain.lowercase(), keys.size, digest(keys), issuedAt)
}
