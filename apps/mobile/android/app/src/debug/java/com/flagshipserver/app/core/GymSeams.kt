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

    /** This device's rank in the mock box's apps when it isn't an admin
     *  ("member" | "manager" | "master" | "refused"; null = the default,
     *  Manager), so the gym reaches each Access control state. */
    @Volatile
    var deviceRank: String? = null

    /** Pass the biometric / device-credential prompts (twin of iOS
     *  `GymSeams.bypassBiometricGates`). An emulator has no screen lock, so
     *  every signed order in the no-backend gym would stop at a prompt that
     *  can't succeed. Only SmokeMode sets it (debug builds, smoke intent);
     *  the orders it lets through go to the mock clients. */
    @Volatile
    var bypassBiometricGates: Boolean = false

    /** Stand in a passkey app that saves passkeys but returns the PRF key
     *  only on an assertion (Samsung Pass's behaviour), for the cloud
     *  recovery set-up scenario. */
    @Volatile
    var fakePasskeysNoPrfOnCreate: Boolean = false

    /** Back to production behaviour (a launch without the gym's extras). */
    fun reset() {
        forceAdminRoot = false
        deviceRank = null
        bypassBiometricGates = false
        fakePasskeysNoPrfOnCreate = false
    }
}
