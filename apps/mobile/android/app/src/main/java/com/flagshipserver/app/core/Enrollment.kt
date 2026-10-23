package com.flagshipserver.app.core

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * First contact between a new server and the device that created it. Wire parity with
 * packages/protocol/src/enrollment.ts; pinned by packages/protocol/test-vectors/enrollment/vectors.json.
 *
 * - The recipe carries a one-time 32-byte `enrollmentKeyHex` this device keeps; the box's first
 *   request carries `deviceInfo.enrollmentProof` = HMAC-SHA256(secret,
 *   `flagship/enrollment-proof/v1|<serverDomain lowercase>|<stkPubHex>|<authCodeSerial>`).
 *   A proof that fails means the key was not built from this device's recipe: refuse to pin it.
 * - The server code: first 4 bytes of SHA-256(`flagship/server-code/v1|<stkPubHex>`), big-endian,
 *   mod 1,000,000, six digits. The box shows it on its own screen.
 */
object Enrollment {
    const val PROOF_TAG = "flagship/enrollment-proof/v1"
    const val CODE_TAG = "flagship/server-code/v1"
    private val HEX64 = Regex("^[0-9a-f]{64}$")

    fun newSecret(): ByteArray = ByteArray(32).also { SecureRandom().nextBytes(it) }

    fun proofHex(secret: ByteArray, serverDomain: String, stkPubHex: String, authCodeSerial: String): String? {
        if (secret.size != 32 || !HEX64.matches(stkPubHex) || '|' in serverDomain || '|' in authCodeSerial) return null
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(secret, "HmacSHA256")) }
        val msg = listOf(PROOF_TAG, serverDomain.lowercase(), stkPubHex, authCodeSerial).joinToString("|").toByteArray(Charsets.UTF_8)
        return mac.doFinal(msg).joinToString("") { "%02x".format(it) }
    }

    /** Constant-time check of the box's proof. */
    fun verify(secret: ByteArray, serverDomain: String, stkPubHex: String, authCodeSerial: String, proofHex: String): Boolean {
        val want = proofHex(secret, serverDomain, stkPubHex, authCodeSerial) ?: return false
        return MessageDigest.isEqual(want.toByteArray(), proofHex.lowercase().toByteArray())
    }

    const val SEEN_TAG = "flagship/server-code-seen/v1"

    /** Studio's report that the VM it hosts showed [stkPubHex]: HMAC-SHA256 under the per-server
     *  `studioConfirmKey` this device sent Studio beside the recipe (never inside it), over
     *  `flagship/server-code-seen/v1|<serverDomain lowercase>|<stkPubHex>`. Read from order status `serverSeen`. */
    fun serverSeenMacHex(studioConfirmKey: ByteArray, serverDomain: String, stkPubHex: String): String? {
        if (studioConfirmKey.size != 32 || !HEX64.matches(stkPubHex) || '|' in serverDomain) return null
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(studioConfirmKey, "HmacSHA256")) }
        return mac.doFinal("$SEEN_TAG|${serverDomain.lowercase()}|$stkPubHex".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    fun verifyServerSeen(studioConfirmKey: ByteArray, serverDomain: String, stkPubHex: String, macHex: String): Boolean {
        val want = serverSeenMacHex(studioConfirmKey, serverDomain, stkPubHex) ?: return false
        return MessageDigest.isEqual(want.toByteArray(), macHex.lowercase().toByteArray())
    }

    fun serverCode(stkPubHex: String): String? {
        if (!HEX64.matches(stkPubHex)) return null
        val d = MessageDigest.getInstance("SHA-256").digest("$CODE_TAG|$stkPubHex".toByteArray(Charsets.UTF_8))
        val n = ((d[0].toLong() and 0xff) shl 24) or ((d[1].toLong() and 0xff) shl 16) or ((d[2].toLong() and 0xff) shl 8) or (d[3].toLong() and 0xff)
        return "%06d".format(n % 1_000_000)
    }
}
