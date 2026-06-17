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

    // ---- dead-man heartbeat-lock state ---------------------------------
    //
    // The phone's view of a server's dead-man policy (the daemon enforces; this
    // drives the UI + reminder scheduling). Non-secret — no key material — so
    // SharedPreferences is fine. Mirror of iOS DeadManStore (keyed by FQDN):
    //   - enabled     the opt-in toggle (default OFF)
    //   - windowMs    affirmation window (default 24h)
    //   - graceMs     fixed grace past the window (default 6h; part of the
    //                 signed policy, not user-exposed)
    //   - lockoutMode "off" (default) or "restart"
    //   - leaseExpiry last lease deadline the box reported (drives the
    //                 "time remaining" countdown + reminder scheduling)

    fun deadManEnabled(serverDomain: String): Boolean =
        prefs.getBoolean(deadManEnabledKey(serverDomain), false)

    fun deadManWindowMs(serverDomain: String): Long =
        prefs.getLong(deadManWindowKey(serverDomain), DEFAULT_DEADMAN_WINDOW_MS)

    fun deadManGraceMs(serverDomain: String): Long =
        prefs.getLong(deadManGraceKey(serverDomain), DEFAULT_DEADMAN_GRACE_MS)

    /** "off" (default) or "restart". */
    fun deadManLockoutMode(serverDomain: String): String =
        prefs.getString(deadManLockoutKey(serverDomain), "off") ?: "off"

    /** Last lease deadline (ms) the box reported, or null if never affirmed. */
    fun deadManLeaseExpiry(serverDomain: String): Long? {
        val k = deadManExpiryKey(serverDomain)
        return if (prefs.contains(k)) prefs.getLong(k, 0L) else null
    }

    /** Persist the policy fields (NOT the lease expiry — that rides
     *  [setDeadManLeaseExpiry] after a successful affirm). */
    fun saveDeadManPolicy(
        serverDomain: String,
        enabled: Boolean,
        windowMs: Long,
        graceMs: Long,
        lockoutMode: String,
    ) {
        prefs.edit().apply {
            putBoolean(deadManEnabledKey(serverDomain), enabled)
            putLong(deadManWindowKey(serverDomain), windowMs)
            putLong(deadManGraceKey(serverDomain), graceMs)
            putString(deadManLockoutKey(serverDomain), lockoutMode)
        }.apply()
    }

    /** Record (or clear, with null) the lease deadline the box reported. */
    fun setDeadManLeaseExpiry(serverDomain: String, expiry: Long?) {
        prefs.edit().apply {
            if (expiry != null) putLong(deadManExpiryKey(serverDomain), expiry)
            else remove(deadManExpiryKey(serverDomain))
        }.apply()
    }

    private fun modeKey(d: String) = "$MODE_PREFIX${d.lowercase()}"
    private fun leaseKey(d: String) = "$LEASE_PREFIX${d.lowercase()}"
    private fun deadManEnabledKey(d: String) = "$DEADMAN_ENABLED_PREFIX${d.lowercase()}"
    private fun deadManWindowKey(d: String) = "$DEADMAN_WINDOW_PREFIX${d.lowercase()}"
    private fun deadManGraceKey(d: String) = "$DEADMAN_GRACE_PREFIX${d.lowercase()}"
    private fun deadManLockoutKey(d: String) = "$DEADMAN_LOCKOUT_PREFIX${d.lowercase()}"
    private fun deadManExpiryKey(d: String) = "$DEADMAN_EXPIRY_PREFIX${d.lowercase()}"

    companion object {
        private const val PREFS = "flagship.bootUnlock"
        private const val MODE_PREFIX = "mode."
        private const val LEASE_PREFIX = "leaseId."
        private const val DEADMAN_ENABLED_PREFIX = "deadman.enabled."
        private const val DEADMAN_WINDOW_PREFIX = "deadman.windowMs."
        private const val DEADMAN_GRACE_PREFIX = "deadman.graceMs."
        private const val DEADMAN_LOCKOUT_PREFIX = "deadman.lockout."
        private const val DEADMAN_EXPIRY_PREFIX = "deadman.leaseExpiry."

        const val DEFAULT_DEADMAN_WINDOW_MS = 24L * 3600_000
        const val DEFAULT_DEADMAN_GRACE_MS = 6L * 3600_000

        fun from(context: Context): ServerSettingsStore =
            ServerSettingsStore(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE))
    }
}
