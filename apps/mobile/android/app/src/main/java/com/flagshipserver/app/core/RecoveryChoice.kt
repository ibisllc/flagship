// Kotlin mirror of FlagshipCore/RecoveryChoice.swift.
//
// The user's choice after a successful WebAuthn-PRF recovery on a new
// (or re-joining) device. The three options have distinct
// cryptographic consequences — see docs/multi-device.md (lands in
// Phase F1) for the threat-model breakdown.

package com.flagshipserver.app.core

sealed interface RecoveryChoice {
    /**
     * **No rotation.** Both this device and any other trusted devices
     * keep working as peers. Default for the "I got a new phone and
     * want to use Flagship there too" case.
     */
    data object KeepBothDevices : RecoveryChoice

    /**
     * **IRK rotation.** Derives a new IRK from the (still shared) UMK
     * with a bumped HKDF salt; J.3 walks every server; the previous
     * IRK stops verifying. Pick this when the prior device is gone,
     * lost, or sold, but you trust your iCloud/Credential Manager
     * passkey to remain yours.
     */
    data object ReplaceLostDevice : RecoveryChoice

    /**
     * **UMK + recovery-passkey rotation (v1.1).** Generates a brand-
     * new UMK and a brand-new WebAuthn credential, retires the old
     * envelope on .com, then runs the IRK rotation. Even an attacker
     * holding the old device AND the old passkey is locked out. Pick
     * this when biometric coercion or a credential-manager breach is
     * on the table.
     */
    data object WipeAndRestart : RecoveryChoice
}
