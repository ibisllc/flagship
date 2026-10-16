// The gym's mock box and `.com` check each signed order the way the real ones
// do on an admin-pinned account: an admin order verifies under the account's
// admin root (an IRK signature is refused), a co-manager's under its share
// key. So a client that slips back to signing with the IRK fails the gym
// instead of passing against a mock that accepts anything. On only in smoke
// mode (GymSeams.verifySignatures); previews and unit tests send fakes.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.GymSeams
import com.flagshipserver.app.core.HexUtil
import com.google.crypto.tink.subtle.Ed25519Verify

object MockSignatures {
    /** The box's sentence for an admin order not signed by the admin root. */
    const val ADMIN_REFUSAL = "This change needs an admin device of the account."

    private val log = mutableListOf<String>()

    /** Every check, in order: "<what>:admin", "<what>:share", "<what>:refused". */
    fun checks(): List<String> = synchronized(log) { log.toList() }

    fun clear() = synchronized(log) { log.clear() }

    private fun record(entry: String) = synchronized(log) { log += entry }

    fun verifies(pub: ByteArray, bytes: ByteArray, sigHex: String?): Boolean {
        val sig = sigHex?.let(HexUtil::decode) ?: return false
        return try {
            Ed25519Verify(pub).verify(sig, bytes)
            true
        } catch (_: Exception) {
            false
        }
    }

    /** An admin order: it must verify under the account's admin root, as the
     *  box and `.com` require on an admin-pinned account (never the IRK). */
    fun requireAdmin(what: String, bytes: ByteArray, sigHex: String?) {
        if (!GymSeams.verifySignatures) return
        if (verifies(GymSeams.gymAdminRootPub, bytes, sigHex)) {
            record("$what:admin")
            return
        }
        record("$what:refused")
        throw ScreensError.Http(403, """{"error":"$ADMIN_REFUSAL","code":"admin-key-required"}""")
    }

    /** A co-manager's order on a shared server: it must verify under its
     *  share key. Returns false (and records the refusal) when it doesn't. */
    fun checkShareKey(what: String, memberPub: ByteArray, bytes: ByteArray, sigHex: String?): Boolean {
        if (!GymSeams.verifySignatures) return true
        val ok = verifies(memberPub, bytes, sigHex)
        record(if (ok) "$what:share" else "$what:refused")
        return ok
    }

    /** An admin order checked by the share world's own keys (an in-memory
     *  owner whose admin key isn't the phone's Keystore). */
    fun checkAdminKey(what: String, adminPub: ByteArray, bytes: ByteArray, sigHex: String?): Boolean {
        if (!GymSeams.verifySignatures) return true
        val ok = verifies(adminPub, bytes, sigHex)
        record(if (ok) "$what:admin" else "$what:refused")
        return ok
    }
}
