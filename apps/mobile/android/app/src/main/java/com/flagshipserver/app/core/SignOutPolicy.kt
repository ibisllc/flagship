// #52 — the Tier-2 "Sign out" gate (Kotlin mirror of
// FlagshipCore/SignOutPolicy.swift).
//
// Tier-2 sign-out wipes this device's local key material (Keystore.wipe()).
// On an account with NO cloud recovery that key is the ONLY copy of the
// identity — wiping it orphans the account (and a later sign-in re-pairs
// under a brand-new IRK, observed live 2026-06-09). So when recovery isn't
// enrolled the sign-out must be BLOCKED outright, not merely scare-copied:
// the UI replaces the destructive confirm with a route into recovery
// enrollment, and the action layer (the confirm handler that wipes)
// re-evaluates this policy so no code path can wipe the only key.
//
// Demo/mock sessions are exempt: they never wrap a real UMK (nothing of
// value is lost on wipe), and sign-out is a routine way to leave the sandbox.

package com.flagshipserver.app.core

enum class SignOutPolicy {
    ALLOWED,
    BLOCKED_NO_RECOVERY,

    // Account DEATH: no cloud recovery AND this is the LAST device, so wiping
    // the local key destroys the only copy of the identity. A plain Tier-2/3
    // wipe would silently orphan the account; instead the UI runs the deletion
    // ceremony (docs/account-deletion-and-name-reclaim.md §2): full-page
    // irreversible warning → typed-username + biometric → owner-IRK self-delete
    // bundle → local wipe → Welcome. The founding device never appears in the
    // device roster (docs §0), so callers derive last-device from
    // trustedDevices.count <= 1.
    DELETION_CEREMONY,
    ;

    companion object {
        fun evaluate(
            hasCloudRecovery: Boolean,
            isDemoAccount: Boolean = false,
            isLastDevice: Boolean = false,
        ): SignOutPolicy =
            when {
                isDemoAccount || hasCloudRecovery -> ALLOWED
                isLastDevice -> DELETION_CEREMONY
                else -> BLOCKED_NO_RECOVERY
            }
    }
}
