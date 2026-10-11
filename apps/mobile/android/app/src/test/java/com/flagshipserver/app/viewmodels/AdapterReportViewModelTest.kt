// "Report a problem with this adaptation": mirrors iOS AdapterReportSheet.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppDetailResponse
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensError
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AdapterReportViewModelTest {
    private val sid = "bright-maple--plants"

    @Test fun sendsTheTrimmedNote() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = AdapterReportViewModel(sid, client, scope = backgroundScope)
        vm.send("  the upload page 500s\n")!!.join()
        assertEquals(listOf(sid to "the upload page 500s"), client.adapterReports)
        assertTrue(vm.sent.value)
        assertFalse(vm.sending.value)
        assertNull(vm.error.value)
    }

    @Test fun anEmptyOrTooLongNoteIsNotSent() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = AdapterReportViewModel(sid, client, scope = backgroundScope)
        assertNull(vm.send(" \n "))
        assertNull(vm.send("x".repeat(2001)))
        assertTrue(client.adapterReports.isEmpty())
        assertFalse(AdapterReport.canSend("", false))
        assertFalse(AdapterReport.canSend("ok", true))
        assertTrue(AdapterReport.canSend("x".repeat(2000), false))
        assertEquals("3 / 2000", AdapterReport.counter("abc"))
    }

    @Test fun theBoxsReasonIsShown() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            adapterReportError = ScreensError.Http(502, """{"error":"Couldn't send the report. Try again later."}""")
        }
        val vm = AdapterReportViewModel(sid, client, scope = backgroundScope)
        vm.send("broken")!!.join()
        assertEquals("Couldn't send the report. Try again later.", vm.error.value)
        assertFalse(vm.sent.value)
        assertFalse(vm.sending.value)
    }

    @Test fun theCopyMatchesIOS() {
        assertEquals("Report a problem with this adaptation", AdapterReport.ROW_TITLE)
        assertEquals("It was set up from a shared adaptation of github.com/me/app", AdapterReport.rowCaption("github.com/me/app"))
        assertEquals("Report a problem", AdapterReport.TITLE)
        assertEquals("What goes wrong? It helps fix the shared adaptation for everyone.", AdapterReport.PROMPT)
        assertEquals(
            "Please don't include anything that identifies you, your server or your data: no names, addresses, emails or passwords.",
            AdapterReport.WARNING,
        )
        assertEquals("Sent. Thank you.", AdapterReport.SENT)
        assertEquals("To fix it on your server now, use Edit this service to change it with AI.", AdapterReport.SENT_NEXT)
    }

    @Test fun appDetailCarriesWhereItWasAdaptedFrom() = runTest {
        val json = Json { ignoreUnknownKeys = true }
        val client = MockScreensClient(simulatedLatencyMs = 0).apply { adaptedFromFixture = mapOf(sid to "github.com/me/plants") }
        val d = client.appDetail(sid)
        assertEquals("github.com/me/plants", d.adaptedFrom?.repo)
        val wire = json.encodeToString(AppDetailResponse.serializer(), d)
        assertEquals("github.com/me/plants", json.decodeFromString(AppDetailResponse.serializer(), wire).adaptedFrom?.repo)
        assertNull(MockScreensClient(simulatedLatencyMs = 0).appDetail(sid).adaptedFrom)
    }
}
