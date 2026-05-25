// Pins the "Secure your account" backup-nudge selection logic:
//   - cloud available   → cloud is PRE-SELECTED
//   - cloud unavailable → nothing pre-selected; file + skip still work
//                         and the cloud option can't be selected
//   - skip              → raises the warning-confirm flag
//
// Pure-JVM — the VM holds no Android types, so no Robolectric needed.

package com.flagshipserver.app.viewmodels

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SecureAccountViewModelTest {

    // ── cloud available ─────────────────────────────────────────────

    @Test fun cloudAvailable_preSelectsCloud_andCanContinue() = runTest {
        val vm = SecureAccountViewModel(passkeyAvailable = true)
        assertEquals(SecureAccountOption.Cloud, vm.selected.first())
        assertTrue("a pre-selection means Continue is actionable", vm.canContinue)
    }

    @Test fun cloudAvailable_canSwitchToFileAndBack() = runTest {
        val vm = SecureAccountViewModel(passkeyAvailable = true)
        vm.select(SecureAccountOption.File)
        assertEquals(SecureAccountOption.File, vm.selected.first())
        vm.select(SecureAccountOption.Cloud)
        assertEquals(SecureAccountOption.Cloud, vm.selected.first())
    }

    // ── cloud unavailable ───────────────────────────────────────────

    @Test fun cloudUnavailable_preSelectsNothing() = runTest {
        val vm = SecureAccountViewModel(passkeyAvailable = false)
        assertNull("nothing is pre-selected when passkeys are unavailable", vm.selected.first())
        assertFalse("no selection ⇒ Continue is inert", vm.canContinue)
    }

    @Test fun cloudUnavailable_cannotSelectCloud_butFileWorks() = runTest {
        val vm = SecureAccountViewModel(passkeyAvailable = false)

        // Attempting to choose cloud is a no-op (the row is disabled).
        vm.select(SecureAccountOption.Cloud)
        assertNull(vm.selected.first())
        assertFalse(vm.canContinue)

        // File remains a valid path → the step still works.
        vm.select(SecureAccountOption.File)
        assertEquals(SecureAccountOption.File, vm.selected.first())
        assertTrue(vm.canContinue)
    }

    // ── skip (works in both states) ─────────────────────────────────

    @Test fun skip_raisesAndClearsConfirmFlag_whenUnavailable() = runTest {
        val vm = SecureAccountViewModel(passkeyAvailable = false)
        assertFalse(vm.showSkipConfirm.first())
        vm.requestSkip()
        assertTrue("skip must surface the warning dialog", vm.showSkipConfirm.first())
        vm.cancelSkip()
        assertFalse("Back dismisses the warning", vm.showSkipConfirm.first())
    }

    @Test fun skip_raisesConfirmFlag_whenAvailable() = runTest {
        val vm = SecureAccountViewModel(passkeyAvailable = true)
        vm.requestSkip()
        assertTrue(vm.showSkipConfirm.first())
    }

    // ── copy is the approved, cross-surface-verbatim text ───────────

    @Test fun copy_isVerbatim() {
        assertEquals("Secure your account", SecureAccountViewModel.TITLE)
        assertEquals(
            "Back up your account now so you can get back in if you lose " +
                "this device. No one — not even us — can recover it for you.",
            SecureAccountViewModel.BODY,
        )
        assertEquals(
            "Without a backup, losing this device means losing your " +
                "account for good. You can set this up anytime in Settings.",
            SecureAccountViewModel.SKIP_WARNING,
        )
        assertEquals("Skip anyway", SecureAccountViewModel.SKIP_CONFIRM)
        assertEquals("Back", SecureAccountViewModel.SKIP_BACK)
        assertEquals(
            "Passkeys aren't available on this device — use a backup file.",
            SecureAccountViewModel.CLOUD_UNAVAILABLE_HINT,
        )
    }
}
