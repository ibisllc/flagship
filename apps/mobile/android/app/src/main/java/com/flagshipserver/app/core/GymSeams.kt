// GYM-ONLY static overrides — Kotlin twin of iOS FlagshipCore/GymSeams.swift
// (same pattern as SignOutPolicy.gymForceBlockNoRecovery): seed states the UI
// gym needs that a smoke-mode demo session can't otherwise reach offline.
// Production never flips these — the only writer is SmokeMode.apply, which is
// debug-gated in MainActivity.

package com.flagshipserver.app.core

object GymSeams {
    /** Treat THIS device as holding the admin master root (Slice D). A demo
     *  session never mints one (`Keystore.hasAdminRoot()` is false without a
     *  real account-open ceremony), so the admin-gated surfaces — the
     *  Account-security "Rotate admin key" card and the add-device
     *  promote-to-admin toggle — would be unreachable in the no-backend gym.
     *  The gym asserts their RENDER + confirm stage only; it never fires a
     *  rotation/admit (which would fail on the absent real key — by design). */
    @Volatile
    var forceAdminRoot: Boolean = false
}
