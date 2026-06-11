// Kotlin mirror of the lock-&-power-off + dead-man canonical bytes in
// packages/protocol/src/auth.ts (canonicalPhoneOrder "power-off",
// canonicalSetDeadManPolicy, canonicalDeadManAffirmation). See
// docs/lock-and-poweroff.md for the product spec.
//
// Three envelopes, all "|"-separated UTF-8 canonical bytes:
//
//   power-off PhoneOrder (box PSK / phoneDelegated key):
//     flagship/order/power-off/v1|<serverId>|<mode>|<issuedAt>
//
//   SetDeadManPolicy (owner IRK):
//     flagship/set-deadman-policy/v1|<serverId>|<enabled 0|1>|<windowMs>|
//       <graceMs>|<lockoutMode>|<issuedAt>
//
//   DeadManAffirmation (owner IRK):
//     flagship/deadman-affirm/v1|<serverId>|<nonceHex>|<issuedAt>
//
// MUST stay byte-identical to the TS implementation — pinned by the
// vectors in packages/protocol/tests/lockAndPowerOff.test.ts and mirrored
// in LockAndPowerOffTest here.

package com.flagshipserver.app.core

/** Power action mode — poweroff ("off") or reboot ("restart"). Enum-style
 *  guard: the canonical bytes only ever commit to a known literal, matching
 *  the TS `powerOffModeToken` / `deadManLockoutToken`. */
enum class PowerMode(val wire: String) {
    OFF("off"),
    RESTART("restart");

    companion object {
        fun fromWire(s: String): PowerMode? = entries.firstOrNull { it.wire == s }
    }
}

/** `power-off` PhoneOrder — signed by the per-server PSK (the phone-delegated
 *  key baked into the install trailer), NOT the IRK. The daemon verifies
 *  against the trailer-pinned `pskPub`. */
object PowerOffOrder {
    const val CANONICAL_TAG = "flagship/order/power-off/v1"

    fun canonicalBytes(serverId: String, mode: PowerMode, issuedAt: Long): ByteArray = listOf(
        CANONICAL_TAG,
        serverId,
        mode.wire,
        issuedAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)
}

/** `SetDeadManPolicy` — owner-IRK-signed dead-man heartbeat-lock config. */
object SetDeadManPolicy {
    const val CANONICAL_TAG = "flagship/set-deadman-policy/v1"

    fun canonicalBytes(
        serverId: String,
        enabled: Boolean,
        windowMs: Long,
        graceMs: Long,
        lockoutMode: PowerMode,
        issuedAt: Long,
    ): ByteArray = listOf(
        CANONICAL_TAG,
        serverId,
        if (enabled) "1" else "0",
        windowMs.toString(),
        graceMs.toString(),
        lockoutMode.wire,
        issuedAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)
}

/** `DeadManAffirmation` — owner-IRK-signed keep-unlocked renewal. The nonce
 *  is fresh (16+ bytes) per affirmation; the daemon rejects a replayed value. */
object DeadManAffirmation {
    const val CANONICAL_TAG = "flagship/deadman-affirm/v1"

    fun canonicalBytes(serverId: String, nonce: ByteArray, issuedAt: Long): ByteArray = listOf(
        CANONICAL_TAG,
        serverId,
        HexUtil.encode(nonce),
        issuedAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)
}
