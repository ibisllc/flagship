package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.TotpEnrollBeginResponse
import com.flagshipserver.app.api.UsernameLookupResponse
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.UserErrorText
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Proxy

/** Security report F2: code protection is an admin order, and `.com`'s
 *  refusals are worded from their `code`, never from the exception text. */
class AccountSecurityViewModelTest {

    /** A server whose every call answers from [answers] by method name (a value, or a Throwable to throw). */
    private class FakeServer(val answers: Map<String, Any>) {
        val calls = mutableListOf<String>()
        val client: FlagshipServerClient = Proxy.newProxyInstance(
            FlagshipServerClient::class.java.classLoader,
            arrayOf(FlagshipServerClient::class.java),
        ) { _, method, _ ->
            calls += method.name
            when (val a = answers[method.name]) {
                is Throwable -> throw a
                null -> throw UnsupportedOperationException(method.name)
                else -> a
            }
        } as FlagshipServerClient
    }

    private fun refusal(status: Int, code: String) =
        HttpException(status, """{"error":"refused","code":"$code"}""", "HTTP $status")

    private val staged = TotpEnrollBeginResponse(
        secret = "JBSWY3DPEHPK3PXP",
        otpauthUrl = "otpauth://totp/Flagship:alice?secret=JBSWY3DPEHPK3PXP",
        qrPngBase64 = "",
        issuer = "Flagship",
    )

    private fun vm(server: FakeServer, admin: Boolean = true, signed: MutableList<String> = mutableListOf()) =
        AccountSecurityViewModel(
            server = server.client,
            username = { "alice" },
            canChange = { admin },
            sign = { _, bytes -> signed += String(bytes); ByteArray(64) },
        )

    private fun failed(vm: AccountSecurityViewModel): String =
        (vm.phase.value as AccountSecurityPhase.Failed).message

    @Test fun anAdminDeviceSignsTheBeginAndGetsTheQr() = runTest {
        val signed = mutableListOf<String>()
        val server = FakeServer(mapOf("totpEnrollBegin" to staged))
        val v = vm(server, signed = signed)
        v.beginEnrollment()
        assertTrue(v.phase.value is AccountSecurityPhase.Staged)
        assertTrue(signed.single().startsWith("flagship/totp-enroll-begin/v1|alice|"))
    }

    @Test fun aNonAdminDeviceIsToldWhyAndSendsNothing() = runTest {
        val server = FakeServer(mapOf("totpEnrollBegin" to staged))
        val v = vm(server, admin = false)
        v.beginEnrollment()
        assertEquals(CodeProtectionText.adminOnly, failed(v))
        assertEquals("Only an admin device of this account can change code protection.", failed(v))
        v.disableEnrollment("123456")
        assertEquals(CodeProtectionText.adminOnly, failed(v))
        assertTrue(server.calls.isEmpty())
    }

    @Test fun alreadyOnIsItsOwnSentence() = runTest {
        val server = FakeServer(
            mapOf(
                "totpEnrollBegin" to refusal(409, "totp-already-enrolled"),
                "getUsernameRecord" to UsernameLookupResponse("alice", "00", 0, "multi", 1L),
            ),
        )
        val v = vm(server)
        v.beginEnrollment()
        assertEquals(CodeProtectionText.alreadyOn, failed(v))
        assertTrue(v.isMultiDevice)
    }

    @Test fun theServersAdminRefusalIsTheAdminSentence() = runTest {
        val v = vm(FakeServer(mapOf("totpEnrollBegin" to refusal(403, "totp-admin-only"))))
        v.beginEnrollment()
        assertEquals(CodeProtectionText.adminOnly, failed(v))
    }

    @Test fun anInternalErrorIsAServerProblemNotTheRawText() = runTest {
        val v = vm(FakeServer(mapOf("totpEnrollBegin" to refusal(500, "internal-error"))))
        v.beginEnrollment()
        assertEquals(UserErrorText.SERVER_PROBLEM, failed(v))
        assertFalse(failed(v).contains("HTTP"))
    }

    @Test fun aWrongCodeAndAnExpiredSetupAreToldApart() = runTest {
        val wrong = vm(FakeServer(mapOf("totpEnrollConfirm" to refusal(401, "invalid-totp-code"))))
        wrong.confirmEnrollment("123456")
        assertTrue(failed(wrong).contains("didn't match"))
        val expired = vm(FakeServer(mapOf("totpEnrollConfirm" to refusal(409, "totp-pending-expired"))))
        expired.confirmEnrollment("123456")
        assertEquals(CodeProtectionText.expired, failed(expired))
    }

    @Test fun disableRefusalsByCode() = runTest {
        val others = vm(FakeServer(mapOf("totpDisable" to refusal(409, "totp-other-devices"))))
        others.disableEnrollment("123456")
        assertEquals(CodeProtectionText.otherDevices, failed(others))
        val off = vm(FakeServer(mapOf("totpDisable" to refusal(409, "totp-not-enrolled"))))
        off.disableEnrollment("123456")
        assertEquals(CodeProtectionText.alreadyOff, failed(off))
        assertFalse(off.isMultiDevice)
    }

    @Test fun aTransportFailureIsWordedWithoutTheExceptionText() = runTest {
        val v = vm(FakeServer(mapOf("totpEnrollBegin" to java.net.UnknownHostException("flagshipserver.com"))))
        v.beginEnrollment()
        assertFalse(failed(v).contains("UnknownHost"))
        assertTrue(failed(v).contains(UserErrorText.OFFLINE))
    }
}
