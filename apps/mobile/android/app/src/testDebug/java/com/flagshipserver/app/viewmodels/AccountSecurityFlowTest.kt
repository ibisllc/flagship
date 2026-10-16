// v1.2 Phase 4 — drives the AccountSecurityViewModel through the
// enrollment happy path, code-mismatch sad path, the disable flow,
// and the recovery-codes display gate. Kotlin mirror of the iOS
// AccountSecurityFlowTests.

package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.UsernameClaimRequest
import com.flagshipserver.app.keystore.Keystore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class AccountSecurityFlowTest {

    private val dispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        Keystore.attachForTest(ctx.getSharedPreferences("acct-sec-test", Context.MODE_PRIVATE))
        Keystore.wipe()
    }

    @After
    fun tearDown() {
        Keystore.wipe()
        Dispatchers.resetMain()
    }

    private suspend fun primedMock(): MockFlagshipServerClient {
        val s = MockFlagshipServerClient(simulatedLatencyMs = 0)
        s.claimUsername(
            UsernameClaimRequest(
                request = UsernameClaimRequest.Inner(
                    username = "alice",
                    irkPub = "00".repeat(32),
                    issuedAt = 0L,
                ),
                signature = "00".repeat(64),
            ),
        )
        return s
    }

    @Test
    fun load_returnsSingleDeviceByDefault() = runTest(dispatcher) {
        val server = primedMock()
        val vm = AccountSecurityViewModel(server = server, username = { "alice" })
        vm.load()
        advanceUntilIdle()
        assertEquals("single", vm.accountType.value)
        assertFalse(vm.isMultiDevice)
        assertNull(vm.totpEnrolledAt.value)
    }

    @Test
    fun load_returnsMultiDeviceWhenEnrolled() = runTest(dispatcher) {
        val server = primedMock()
        server.accountTypeByUser["alice"] = "multi"
        server.totpEnrolledAtByUser["alice"] = 1_700_000_000_000L
        val vm = AccountSecurityViewModel(server = server, username = { "alice" })
        vm.load()
        advanceUntilIdle()
        assertEquals("multi", vm.accountType.value)
        assertTrue(vm.isMultiDevice)
        assertEquals(1_700_000_000_000L, vm.totpEnrolledAt.value)
    }

    @Test
    fun enrollHappyPath_stagesSecretThenConfirms_returnsRecoveryCodes() = runTest(dispatcher) {
        val server = primedMock()
        server.totpExpectedConfirmCode = "654321"
        val issued = (1..10).map { "RC-$it" }
        server.totpRecoveryCodesToIssue = issued
        val vm = AccountSecurityViewModel(server = server, username = { "alice" })

        vm.beginEnrollment()
        advanceUntilIdle()
        val staged = vm.phase.value
        assertTrue("expected Staged, got $staged", staged is AccountSecurityPhase.Staged)
        staged as AccountSecurityPhase.Staged
        assertTrue(staged.secret.isNotEmpty())
        assertTrue(staged.otpauthUrl.startsWith("otpauth://totp/Flagship:"))
        assertTrue(staged.qrPngBase64.isNotEmpty())
        assertEquals("Flagship", staged.issuer)

        vm.confirmEnrollment("654321")
        advanceUntilIdle()
        val confirmed = vm.phase.value
        assertTrue("expected Confirmed, got $confirmed", confirmed is AccountSecurityPhase.Confirmed)
        confirmed as AccountSecurityPhase.Confirmed
        assertEquals(issued, confirmed.recoveryCodes)
        assertTrue(confirmed.totpEnrolledAt > 0)
        // Local badge + Mock-side state both flipped.
        assertEquals("multi", vm.accountType.value)
        assertEquals("multi", server.accountTypeByUser["alice"])
        assertEquals(issued, server.recoveryCodesByUser["alice"])
    }

    @Test
    fun codeMismatch_bouncesToFailed_andDoesNotEnroll() = runTest(dispatcher) {
        val server = primedMock()
        server.totpExpectedConfirmCode = "111111"
        val vm = AccountSecurityViewModel(server = server, username = { "alice" })

        vm.beginEnrollment(); advanceUntilIdle()
        vm.confirmEnrollment("999999"); advanceUntilIdle()

        val phase = vm.phase.value
        assertTrue("expected Failed, got $phase", phase is AccountSecurityPhase.Failed)
        (phase as AccountSecurityPhase.Failed)
        assertTrue(phase.message.contains("didn't match"))
        assertNull(server.accountTypeByUser["alice"])
        assertNull(server.recoveryCodesByUser["alice"])
    }

    @Test
    fun emptyCode_failsImmediately() = runTest(dispatcher) {
        val server = primedMock()
        val vm = AccountSecurityViewModel(server = server, username = { "alice" })
        vm.beginEnrollment(); advanceUntilIdle()
        vm.confirmEnrollment("   "); advanceUntilIdle()
        val phase = vm.phase.value
        assertTrue(phase is AccountSecurityPhase.Failed)
        assertTrue((phase as AccountSecurityPhase.Failed).message.contains("6-digit"))
    }

    @Test
    fun recoveryCodesDisplayGate_dismissScrubsCodes() = runTest(dispatcher) {
        val server = primedMock()
        val vm = AccountSecurityViewModel(server = server, username = { "alice" })

        vm.beginEnrollment(); advanceUntilIdle()
        vm.confirmEnrollment("123456"); advanceUntilIdle()
        assertTrue(vm.phase.value is AccountSecurityPhase.Confirmed)

        vm.dismissEnrollment()
        assertEquals(AccountSecurityPhase.Idle, vm.phase.value)
        // accountType remains "multi" — the dismiss only scrubs the
        // plaintext codes, not the live enrollment commit.
        assertEquals("multi", vm.accountType.value)
    }

    @Test
    fun disableHappyPath_flipsBackToSingle() = runTest(dispatcher) {
        val server = primedMock()
        server.totpExpectedConfirmCode = "424242"
        server.accountTypeByUser["alice"] = "multi"
        server.totpEnrolledAtByUser["alice"] = 1_700_000_000_000L
        server.totpSecretByUser["alice"] = "STAGED"
        server.recoveryCodesByUser["alice"] = listOf("abc")
        val vm = AccountSecurityViewModel(server = server, username = { "alice" })

        vm.disableEnrollment("424242"); advanceUntilIdle()

        assertEquals(AccountSecurityPhase.Disabled, vm.phase.value)
        assertEquals("single", vm.accountType.value)
        assertNull(vm.totpEnrolledAt.value)
        assertNull(server.totpSecretByUser["alice"])
        assertNull(server.recoveryCodesByUser["alice"])
    }

    @Test
    fun disable_codeMismatch_surfacedAsFailed() = runTest(dispatcher) {
        val server = primedMock()
        server.accountTypeByUser["alice"] = "multi"
        server.totpExpectedConfirmCode = "111111"
        val vm = AccountSecurityViewModel(server = server, username = { "alice" })

        vm.disableEnrollment("999999"); advanceUntilIdle()

        val phase = vm.phase.value
        assertTrue(phase is AccountSecurityPhase.Failed)
        assertTrue((phase as AccountSecurityPhase.Failed).message.contains("didn't match"))
        assertEquals("multi", server.accountTypeByUser["alice"])
    }

    @Test
    fun withoutUsername_beginFailsCleanly() = runTest(dispatcher) {
        val server = primedMock()
        val vm = AccountSecurityViewModel(server = server, username = { null })
        vm.beginEnrollment(); advanceUntilIdle()
        assertTrue(vm.phase.value is AccountSecurityPhase.Failed)
    }

    @Test
    fun canonicalBytes_matchProtocolSpec() {
        // Mismatch with packages/protocol/src/auth.ts breaks the
        // Ed25519 verify on the Worker — pin the exact strings.
        assertArrayEquals(
            "flagship/totp-enroll-begin/v1|alice|100".toByteArray(Charsets.UTF_8),
            AccountSecurityViewModel.canonicalEnrollBegin("alice", 100L),
        )
        assertArrayEquals(
            "flagship/totp-enroll-confirm/v1|alice|200".toByteArray(Charsets.UTF_8),
            AccountSecurityViewModel.canonicalEnrollConfirm("alice", 200L),
        )
        assertArrayEquals(
            "flagship/totp-disable/v1|alice|300".toByteArray(Charsets.UTF_8),
            AccountSecurityViewModel.canonicalDisable("alice", 300L),
        )
    }

    private fun assertArrayEquals(expected: ByteArray, actual: ByteArray) {
        assertEquals(expected.toList(), actual.toList())
    }
}
