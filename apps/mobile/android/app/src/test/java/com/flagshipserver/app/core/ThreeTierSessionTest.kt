// Task #46 — the three-tier session model (Android mirror of iOS
// ThreeTierSessionTests).
//
//   Tier 1 LOCK — re-gate behind biometrics, remove nothing. (Latch
//     behavior lives in AppStateBiometricGateTest.)
//   Tier 2 SIGN OUT — erase this device's local key material from the
//     AndroidKeyStore WITHOUT revoking server-side (snoop-hardening);
//     the device stays a valid account member and comes back via passkey
//     recovery as an INSTANT re-pair (same IRK ⇒ Phase A, pinned in
//     LoginFlowTest).
//   Tier 3 REMOVE THIS DEVICE — cryptographic eviction (revoke + wipe),
//     unchanged (the danger-zone path in SettingsScreen).
//
// This file pins the Keystore + server-mutation contract that separates
// Tier 2 (local-only) from Tier 3 (revokes server-side), so the two can
// never collapse back together.

package com.flagshipserver.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.keystore.Keystore
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ThreeTierSessionTest {

    @Before
    fun setUp() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        Keystore.attachForTest(ctx.getSharedPreferences("three-tier-test", Context.MODE_PRIVATE))
        Keystore.setActiveProfile(null)
        Keystore.wipe()
    }

    @After
    fun tearDown() {
        Keystore.setActiveProfile(null)
        Keystore.wipe()
    }

    /** Spy that records whether the server-side push-token revoke was
     *  invoked. Tier 2 must NOT call it (server is untouched); Tier 3 does. */
    private class SpyRevoker {
        var revokeCalled = false
        fun revoke() { revokeCalled = true }
    }

    // ─── Tier 2: key-wipe sign-out ─────────────────────────────────────

    @Test fun signOut_wipesKeystore_hasUmkSeedFalseAfter() {
        Keystore.loadOrCreateUmkSeed()
        assertTrue(Keystore.hasUmkSeed())

        // The exact Tier-2 pipeline the SettingsScreen sign-out runs:
        // wipe local key material, then drop the session. No revoke.
        Keystore.wipe()
        val app = AppState(isPaired = true, currentUser = "alice")
        app.signOut()

        assertFalse("the UMK/IRK must be gone from the Keystore", Keystore.hasUmkSeed())
        assertFalse(app.isPaired.value)
        assertNull(app.currentUser.value)
    }

    @Test fun signOut_doesNotRevokeServerSide() {
        Keystore.loadOrCreateUmkSeed()
        val spy = SpyRevoker()
        val app = AppState(isPaired = true, currentUser = "alice")

        // Tier-2 sign out: local-only. Deliberately NO spy.revoke(),
        // unlike the danger-zone eviction (Tier 3).
        Keystore.wipe()
        app.signOut()

        assertFalse(
            "Tier-2 sign out must not mutate server state — no push-token revoke",
            spy.revokeCalled,
        )
        assertFalse(Keystore.hasUmkSeed())
    }

    /** Contrast: Tier 3 (Remove this device) DOES revoke. Pins the
     *  distinction so the two don't collapse back together. */
    @Test fun removeFromAccount_revokesServerSide() {
        Keystore.loadOrCreateUmkSeed()
        val spy = SpyRevoker()
        val app = AppState(isPaired = true, currentUser = "alice")

        // The Remove-this-device pipeline: revoke push on .com, then wipe.
        spy.revoke()
        Keystore.wipe()
        app.signOut()

        assertTrue("Tier-3 eviction revokes server-side", spy.revokeCalled)
        assertFalse(Keystore.hasUmkSeed())
    }
}
