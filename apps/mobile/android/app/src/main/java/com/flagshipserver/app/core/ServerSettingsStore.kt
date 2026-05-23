// Per-server boot-unlock state the phone remembers locally, keyed by the
// server's canonical FQDN (serverDomain). Kotlin mirror of
// FlagshipCore/BootUnlockStore.swift.
//
//   - mode    the user's create-time choice ("auto" = box self-unlocks via a
//             box-sealed lease after the first approved boot, the default;
//             "approve" = phone-gated every boot). The recipe carries this to
//             the box; the phone keeps it so the approval screen knows whether
//             to deposit a self-unlock lease and server-detail knows whether
//             to offer the kill switch.
//   - leaseId set once an "auto" server's first boot is approved and a
//             box-sealed lease is deposited. The kill switch revokes by id.
//
// Non-secret (the lease ciphertext lives on .com — I1; the id is just a
// handle), so plain SharedPreferences is appropriate.
//
// Cross-device caveat: a server created on THIS phone always has its mode
// persisted here. When another paired device approves a box it didn't create,
// mode() is null and effectiveMode() falls back to the product default
// ("auto"). Depositing a lease for an approve-mode box is harmless — that box
// never reads the lease (boot-stage: approve ⇒ relay-only).

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences

class ServerSettingsStore(private val prefs: SharedPreferences) {
    enum class Mode(val wire: String) {
        AUTO("auto"),
        APPROVE("approve");

        companion object {
            fun fromWire(s: String?): Mode? = entries.firstOrNull { it.wire == s }
        }
    }

    /** The explicitly stored mode, or null if this device never recorded one. */
    fun mode(serverDomain: String): Mode? =
        Mode.fromWire(prefs.getString(modeKey(serverDomain), null))

    /** The mode to act on — absent ⇒ the product default ("auto"). */
    fun effectiveMode(serverDomain: String): Mode =
        mode(serverDomain) ?: Mode.AUTO

    fun setMode(serverDomain: String, mode: Mode) {
        prefs.edit().putString(modeKey(serverDomain), mode.wire).apply()
    }

    fun leaseId(serverDomain: String): String? =
        prefs.getString(leaseKey(serverDomain), null)

    /** Record (or clear, with null) the deposited lease id for a server. */
    fun setLeaseId(serverDomain: String, leaseId: String?) {
        prefs.edit().apply {
            if (leaseId != null) putString(leaseKey(serverDomain), leaseId)
            else remove(leaseKey(serverDomain))
        }.apply()
    }

    private fun modeKey(d: String) = "$MODE_PREFIX${d.lowercase()}"
    private fun leaseKey(d: String) = "$LEASE_PREFIX${d.lowercase()}"

    companion object {
        private const val PREFS = "flagship.bootUnlock"
        private const val MODE_PREFIX = "mode."
        private const val LEASE_PREFIX = "leaseId."

        fun from(context: Context): ServerSettingsStore =
            ServerSettingsStore(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE))
    }
}
