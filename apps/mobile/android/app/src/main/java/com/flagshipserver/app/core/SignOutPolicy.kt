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
    ;

    companion object {
        fun evaluate(hasCloudRecovery: Boolean, isDemoAccount: Boolean = false): SignOutPolicy =
            if (isDemoAccount || hasCloudRecovery) ALLOWED else BLOCKED_NO_RECOVERY
    }
}
