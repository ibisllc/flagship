// The Keystore-backed first-contact stores (docs/first-contact.md): the one pin store, the
// enrollment secrets of servers this device created, and app-name grants waiting for their box.
// All live in the Keystore-encrypted preferences, which are device-local and never backed up.

package com.flagshipserver.app.keystore

import com.flagshipserver.app.core.EnrollmentRecord
import com.flagshipserver.app.core.EnrollmentSecretStore
import com.flagshipserver.app.core.PendingWildcardGrant
import com.flagshipserver.app.core.ServerKeyPinStore
import com.flagshipserver.app.core.WildcardGrantOutbox

object KeystoreServerKeyPinStore : ServerKeyPinStore {
    /** No profile open yet means no pin, never a crash. */
    override fun get(serverDomain: String) = runCatching { Keystore.serverKeyPin(serverDomain) }.getOrNull()
    override fun put(serverDomain: String, stkPubHex: String) = Keystore.setServerKeyPin(serverDomain, stkPubHex)
    override fun remove(serverDomain: String) = Keystore.setServerKeyPin(serverDomain, null)
}

object KeystoreEnrollmentSecretStore : EnrollmentSecretStore {
    private const val NAME = "first.contact.enrollment"

    override fun get(serverDomain: String): EnrollmentRecord? {
        val parts = runCatching { Keystore.deviceLocalValue(NAME, serverDomain) }.getOrNull()?.split('|') ?: return null
        if (parts.size !in 2..3) return null
        return EnrollmentRecord(parts[0], parts[1], parts.getOrNull(2)?.takeIf { it.isNotEmpty() })
    }

    override fun put(serverDomain: String, record: EnrollmentRecord) =
        Keystore.setDeviceLocalValue(NAME, serverDomain, listOf(record.secretHex, record.serial, record.studioConfirmKeyHex ?: "").joinToString("|"))

    override fun remove(serverDomain: String) = Keystore.setDeviceLocalValue(NAME, serverDomain, null)
}

object KeystoreWildcardGrantOutbox : WildcardGrantOutbox {
    private const val NAME = "first.contact.wildcard.grants"

    override fun get(serverDomain: String): PendingWildcardGrant? {
        val p = runCatching { Keystore.deviceLocalValue(NAME, serverDomain) }.getOrNull()?.split('|') ?: return null
        if (p.size != 3) return null
        return PendingWildcardGrant(p[0], p[1].toLongOrNull() ?: return null, p[2])
    }

    override fun put(serverDomain: String, grant: PendingWildcardGrant) =
        Keystore.setDeviceLocalValue(NAME, serverDomain, "${grant.stkPubHex}|${grant.issuedAt}|${grant.signatureHex}")

    override fun remove(serverDomain: String) = Keystore.setDeviceLocalValue(NAME, serverDomain, null)
}
