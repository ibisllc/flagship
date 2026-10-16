// An app's status pill (docs/app-placement.md §6): one server's state from its
// apps-list row, and the services list's pill over every server the app is on.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.AppActivity
import com.flagshipserver.app.api.AppCopying
import com.flagshipserver.app.api.AppSummary
import com.flagshipserver.app.api.AppsListResponse
import com.flagshipserver.app.core.AppStatus.ServerState.Copying
import com.flagshipserver.app.core.AppStatus.ServerState.Deploying
import com.flagshipserver.app.core.AppStatus.ServerState.Editing
import com.flagshipserver.app.core.AppStatus.ServerState.Running
import com.flagshipserver.app.core.AppStatus.ServerState.Starting
import com.flagshipserver.app.core.AppStatus.ServerState.Stopped
import com.flagshipserver.app.core.AppStatus.ServerState.Unknown
import com.flagshipserver.app.core.AppStatus.Tone
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AppStatusTest {

    private fun app(status: String, activity: String? = null, copying: AppCopying? = null) = AppSummary(
        serviceId = "harry--notes", creator = "harry", slug = "notes", urlLabel = "notes",
        url = "https://notes.x/", status = status, installedAt = 1, copying = copying,
        activity = activity?.let { AppActivity(it) },
    )

    private fun combined(vararg s: AppStatus.ServerState?) = AppStatus.combined(s.toList())

    // ---- one server -------------------------------------------------------

    @Test fun readsTheServersState() {
        assertEquals(Running, AppStatus.of(app("running")))
        assertEquals(Starting, AppStatus.of(app("starting")))
        assertEquals(Stopped, AppStatus.of(app("stopped")))
        assertEquals(Unknown, AppStatus.of(app("unknown")))
        assertEquals(Unknown, AppStatus.of(app("something-new")))
    }

    @Test fun activityWinsOverStatus() {
        assertEquals(Deploying, AppStatus.of(app("running", "deploying")))
        assertEquals(Copying, AppStatus.of(app("stopped", "copying")))
        assertEquals(Editing, AppStatus.of(app("running", "editing")))
        // A copy arriving on an older box (no activity yet) is still a copy.
        assertEquals(Copying, AppStatus.of(app("unknown", copying = AppCopying("copying", 0.4))))
        // An activity this phone doesn't know falls back to the status.
        assertEquals(Running, AppStatus.of(app("running", "tidying")))
    }

    @Test fun appPagePillPerState() {
        assertEquals(AppStatus.Pill("Running", Tone.Online), AppStatus.pill(Running))
        assertEquals(AppStatus.Pill("Starting", Tone.Accent), AppStatus.pill(Starting))
        assertEquals(AppStatus.Pill("Stopped", Tone.Idle), AppStatus.pill(Stopped))
        assertEquals(AppStatus.Pill("Deploying", Tone.Accent), AppStatus.pill(Deploying))
        assertEquals(AppStatus.Pill("Copying", Tone.Accent), AppStatus.pill(Copying))
        assertEquals(AppStatus.Pill("Editing", Tone.Accent), AppStatus.pill(Editing))
        assertNull(AppStatus.pill(Unknown))
    }

    @Test fun decodesActivityOptionally() {
        val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
        val row = """{"serviceId":"harry--notes","creator":"harry","slug":"notes","urlLabel":"notes",""" +
            """"url":"https://notes.x/","installedAt":1"""
        val withActivity = json.decodeFromString<AppsListResponse>(
            """{"apps":[$row,"status":"running","activity":{"kind":"editing"}}]}""",
        ).apps.single()
        assertEquals("editing", withActivity.activity?.kind)
        assertEquals(Editing, AppStatus.of(withActivity))
        val older = json.decodeFromString<AppsListResponse>("""{"apps":[$row,"status":"unknown"}]}""").apps.single()
        assertNull(older.activity)
        assertNull(AppStatus.pill(older))
    }

    // ---- the services list's pill -----------------------------------------

    @Test fun anyDeployingOrCopyingIsDeploying() {
        assertEquals(AppStatus.DEPLOYING, combined(Running, Deploying, Editing))
        assertEquals(AppStatus.DEPLOYING, combined(Stopped, Copying))
        assertEquals(Tone.Accent, AppStatus.DEPLOYING.tone)
    }

    @Test fun elseAnyEditingIsEditing() {
        assertEquals(AppStatus.EDITING, combined(Running, Editing, Stopped))
        assertEquals(Tone.Accent, AppStatus.EDITING.tone)
    }

    @Test fun elseCountsTheServersRunningIt() {
        assertEquals(AppStatus.Pill("On 1 server", Tone.Online, serverCount = 1), combined(Running))
        assertEquals(3, combined(Running, Running, Running).serverCount)
        assertEquals(null, combined(Stopped).serverCount)
        assertEquals("On 1 server", combined(Running, Stopped).label)
        assertEquals("On 2 servers", combined(Running, Starting).label)
        assertEquals("On 3 servers", combined(Running, Running, Running).label)
    }

    @Test fun elseEveryAnsweringServerStoppedIsStopped() {
        assertEquals(AppStatus.STOPPED, combined(Stopped))
        assertEquals(AppStatus.STOPPED, combined(Stopped, Stopped))
        assertEquals(Tone.Idle, AppStatus.STOPPED.tone)
    }

    @Test fun noAnswerIsCantReach() {
        assertEquals(AppStatus.CANT_REACH, combined())
        assertEquals(AppStatus.CANT_REACH, combined(null, null))
        assertEquals(Tone.Warning, AppStatus.CANT_REACH.tone)
    }

    @Test fun anUnansweredServerDoesntCount() {
        assertEquals("On 1 server", combined(Running, null).label)
        assertEquals(AppStatus.STOPPED, combined(Stopped, null))
    }

    @Test fun olderBoxesUnknownCountAsOnButNotRunning() {
        // Every answering server is an older box: the app is on them.
        assertEquals("On 1 server", combined(Unknown).label)
        assertEquals("On 2 servers", combined(Unknown, Unknown, null).label)
        // Mixed with a server that does know: only the running ones count.
        assertEquals("On 1 server", combined(Running, Unknown).label)
        // None running: the unknown ones count, even beside a stopped one.
        assertEquals("On 1 server", combined(Stopped, Unknown).label)
        assertEquals("On 2 servers", combined(Stopped, Unknown, Unknown).label)
        // An older box doesn't mask activity elsewhere.
        assertEquals(AppStatus.DEPLOYING, combined(Unknown, Deploying))
    }
}
