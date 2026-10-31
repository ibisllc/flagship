// Kotlin mirror of the lock-&-power-off canonical bytes in
// packages/protocol/src/auth.ts (canonicalPhoneOrder "power-off"). See
// docs/lock-and-poweroff.md for the product spec.
//
//   power-off PhoneOrder:
//     flagship/order/power-off/v1|<serverId>|<mode>|<issuedAt>
//
// The old dead-man switch (set-deadman-policy/v1, deadman-affirm/v1) is retired:
// it is the serving policy's `lock-server` now (ServingAuthority.kt).
//
// MUST stay byte-identical to the TS implementation — pinned by the
// vectors in packages/protocol/tests/lockAndPowerOff.test.ts and mirrored
// in LockAndPowerOffTest here.

package com.flagshipserver.app.core

/** Power action mode — poweroff ("off") or reboot ("restart"). Enum-style
 *  guard: the canonical bytes only ever commit to a known literal, matching
 *  the TS `powerOffModeToken`. */
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
