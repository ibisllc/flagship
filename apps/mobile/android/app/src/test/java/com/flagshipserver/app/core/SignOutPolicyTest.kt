// #52 — the Tier-2 sign-out gate (Android mirror of iOS SignOutPolicyTests).
//
// A Tier-2 sign-out wipes this device's local key material; on an account
// with NO cloud recovery that key is the ONLY copy of the identity, so the
// wipe orphans the account (a later sign-in re-pairs under a brand-new IRK —
// observed live 2026-06-09). SignOutPolicy is the single decision point the
// UI (SettingsScreen dialog) AND the action layer (the confirm handler that
// wipes) both evaluate, so no code path can wipe the only key.

package com.flagshipserver.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.keystore.Keystore
import org.junit.Assert.assertEquals
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
class SignOutPolicyTest {

    @Before
    fun setUp() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        Keystore.attachForTest(ctx.getSharedPreferences("signout-policy-test", Context.MODE_PRIVATE))
        Keystore.setActiveProfile(null)
        Keystore.wipe()
    }

    // ─── The decision matrix ────────────────────────────────────────────

    @Test fun allowed_whenCloudRecoveryEnrolled() {
        assertEquals(
            SignOutPolicy.ALLOWED,
            SignOutPolicy.evaluate(hasCloudRecovery = true, isDemoAccount = false),
        )
    }

    @Test fun blocked_whenNoCloudRecovery() {
        assertEquals(
            "without recovery the local key is the only copy — sign-out must be blocked",
            SignOutPolicy.BLOCKED_NO_RECOVERY,
            SignOutPolicy.evaluate(hasCloudRecovery = false, isDemoAccount = false),
        )
    }

    /** Demo/mock sessions never wrap a real UMK — nothing of value is lost
     *  on wipe, and sign-out is the routine way to leave the sandbox. */
    @Test fun demoAccount_isExempt_evenWithoutRecovery() {
        assertEquals(
            SignOutPolicy.ALLOWED,
            SignOutPolicy.evaluate(hasCloudRecovery = false, isDemoAccount = true),
        )
    }

    @Test fun demoAccount_withRecovery_stillAllowed() {
        assertEquals(
            SignOutPolicy.ALLOWED,
            SignOutPolicy.evaluate(hasCloudRecovery = true, isDemoAccount = true),
        )
    }

    /** Default for the demo flag is fail-closed: omitting it must behave
     *  exactly like a real (non-demo) account. */
    @Test fun defaultIsNotDemo() {
        assertEquals(SignOutPolicy.BLOCKED_NO_RECOVERY, SignOutPolicy.evaluate(hasCloudRecovery = false))
        assertEquals(SignOutPolicy.ALLOWED, SignOutPolicy.evaluate(hasCloudRecovery = true))
    }

    /** No recovery + LAST device ⇒ account DEATH: the UI runs the deletion
     *  ceremony (typed-username + biometric → owner-IRK self-delete bundle),
     *  NOT a silent orphaning wipe. */
    @Test fun deletionCeremony_whenNoRecoveryAndLastDevice() {
        assertEquals(
            SignOutPolicy.DELETION_CEREMONY,
            SignOutPolicy.evaluate(hasCloudRecovery = false, isDemoAccount = false, isLastDevice = true),
        )
    }

    /** No recovery but ANOTHER device exists ⇒ the key survives elsewhere, so
     *  it stays "set up recovery first", not account death. */
    @Test fun blocked_whenNoRecoveryButNotLastDevice() {
        assertEquals(
            SignOutPolicy.BLOCKED_NO_RECOVERY,
            SignOutPolicy.evaluate(hasCloudRecovery = false, isDemoAccount = false, isLastDevice = false),
        )
    }

    /** Recovery present ⇒ allowed even on the last device (the key returns via
     *  the recovery passkey, so it isn't death). */
    @Test fun allowed_withRecovery_evenOnLastDevice() {
        assertEquals(
            SignOutPolicy.ALLOWED,
            SignOutPolicy.evaluate(hasCloudRecovery = true, isDemoAccount = false, isLastDevice = true),
        )
    }

    /** Demo is exempt even as the last device. */
    @Test fun demo_lastDevice_stillAllowed() {
        assertEquals(
            SignOutPolicy.ALLOWED,
            SignOutPolicy.evaluate(hasCloudRecovery = false, isDemoAccount = true, isLastDevice = true),
        )
    }

    // ─── The action-layer guard (the exact pipeline SettingsScreen runs) ─

    /** Mirrors the SettingsScreen confirm handler: evaluate the policy
     *  BEFORE the wipe. Blocked ⇒ the wipe + signOut must be unreachable. */
    @Test fun actionLayerGuard_blocked_neverWipesOrSignsOut() {
        Keystore.loadOrCreateUmkSeed()
        assertTrue(Keystore.hasUmkSeed())
        val app = AppState(isPaired = true, currentUser = "alice", hasCloudRecovery = false)

        if (SignOutPolicy.evaluate(hasCloudRecovery = false, isDemoAccount = false) == SignOutPolicy.ALLOWED) {
            Keystore.wipe()
            app.signOut()
        }

        assertTrue("the guard must make the key wipe unreachable", Keystore.hasUmkSeed())
        assertTrue("the session must survive a blocked sign-out", app.isPaired.value)
        assertEquals("alice", app.currentUser.value)
    }

    @Test fun actionLayerGuard_allowed_proceeds() {
        Keystore.loadOrCreateUmkSeed()
        val app = AppState(isPaired = true, currentUser = "alice", hasCloudRecovery = true)

        if (SignOutPolicy.evaluate(hasCloudRecovery = true, isDemoAccount = false) == SignOutPolicy.ALLOWED) {
            Keystore.wipe()
            app.signOut()
        }

        assertFalse(Keystore.hasUmkSeed())
        assertFalse(app.isPaired.value)
        assertNull(app.currentUser.value)
    }

    @Test fun actionLayerGuard_demoExemption_proceedsWithoutRecovery() {
        Keystore.loadOrCreateUmkSeed()
        val app = AppState(isPaired = true, currentUser = "demo", hasCloudRecovery = false)

        if (SignOutPolicy.evaluate(hasCloudRecovery = false, isDemoAccount = true) == SignOutPolicy.ALLOWED) {
            Keystore.wipe()
            app.signOut()
        }

        assertFalse("demo sessions never wrap a real UMK — sign-out stays routine", Keystore.hasUmkSeed())
        assertFalse(app.isPaired.value)
    }
}
