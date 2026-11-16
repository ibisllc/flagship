// Pins the "Secure your account" backup-nudge tick logic:
//   - cloud and file start UNTICKED; Continue waits for a choice
//   - the two tick independently (either, both, neither)
//   - cloud unavailable → cloud can't be ticked; file + skip still work
//   - skip              → raises the warning-confirm flag
//
// Pure-JVM — the VM holds no Android types, so no Robolectric needed.

package com.flagshipserver.app.viewmodels

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SecureAccountViewModelTest {

    // ── cloud available ─────────────────────────────────────────────

    @Test fun bothStartUnticked_andContinueWaits() = runTest {
        val vm = SecureAccountViewModel(passkeyAvailable = true)
        assertFalse("cloud starts unticked", vm.cloudSelected.first())
        assertFalse("file starts unticked", vm.fileSelected.first())
        assertFalse("Continue waits for a choice; Skip is the way out", vm.canContinue)
    }

    @Test fun optionsAreIndependent() = runTest {
        val vm = SecureAccountViewModel(passkeyAvailable = true)
        vm.toggle(SecureAccountOption.Cloud)
        assertTrue(vm.cloudSelected.first())
        assertFalse("ticking cloud leaves the file alone", vm.fileSelected.first())
        assertTrue(vm.canContinue)
        vm.toggle(SecureAccountOption.File)
        assertTrue("ticking the file keeps cloud ticked", vm.cloudSelected.first())
        assertTrue(vm.fileSelected.first())
        vm.toggle(SecureAccountOption.Cloud)
        assertFalse(vm.cloudSelected.first())
        assertTrue("unticking cloud keeps the file", vm.fileSelected.first())
        assertTrue(vm.canContinue)
        vm.toggle(SecureAccountOption.File)
        assertFalse("with neither ticked Continue is inert again", vm.canContinue)
    }

    // ── cloud unavailable ───────────────────────────────────────────

    @Test fun cloudUnavailable_cannotTickCloud_butFileWorks() = runTest {
        val vm = SecureAccountViewModel(passkeyAvailable = false)

        // Ticking cloud is a no-op (the row is disabled).
        vm.toggle(SecureAccountOption.Cloud)
        assertFalse(vm.cloudSelected.first())
        assertFalse(vm.canContinue)

        // File remains a valid path → the step still works.
        vm.toggle(SecureAccountOption.File)
        assertTrue(vm.fileSelected.first())
        assertTrue(vm.canContinue)
    }

    // ── skip (works in both states) ─────────────────────────────────

    @Test fun skip_raisesAndClearsConfirmFlag_whenUnavailable() = runTest {
        val vm = SecureAccountViewModel(passkeyAvailable = false)
        assertFalse(vm.showSkipConfirm.first())
        vm.requestSkip()
        assertTrue("skip must surface the warning", vm.showSkipConfirm.first())
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
                "this device. We cannot recover it for you.",
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
