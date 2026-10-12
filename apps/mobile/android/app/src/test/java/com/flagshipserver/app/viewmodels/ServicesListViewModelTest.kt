// The services list asks every server for its apps over that server's own
// session and lists each app once, with the pill over every server it is on
// (docs/app-placement.md §6).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppActivity
import com.flagshipserver.app.api.AppSummary
import com.flagshipserver.app.api.AppsListResponse
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.core.AppStatus
import com.flagshipserver.app.core.PodInfo
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ServicesListViewModelTest {

    private fun pod(id: String) = PodInfo(
        podId = id,
        name = id.replaceFirstChar { it.uppercase() },
        fqdn = "$id.harry.flagship.services",
        status = PodInfo.Status.ONLINE,
    )

    private fun app(slug: String, status: String = "running", activity: String? = null, server: String = "home") =
        AppSummary(
            serviceId = "harry--$slug", creator = "harry", slug = slug, urlLabel = slug,
            url = "https://$slug.$server.harry.flagship.services/", status = status, installedAt = 1,
            activity = activity?.let { AppActivity(it) },
        )

    /** One box: its apps list, or null while it can't be reached. */
    private class Box(var apps: List<AppSummary>?) : ScreensClient by MockScreensClient(simulatedLatencyMs = 0) {
        override suspend fun appsList(): AppsListResponse =
            AppsListResponse(apps ?: throw java.io.IOException("unreachable"))
    }

    private val home = pod("home")
    private val office = pod("office")

    private fun vm(boxes: Map<String, Box?>, fallback: ScreensClient = Box(emptyList()), preferred: String? = "home") =
        ServicesListViewModel(
            client = fallback,
            server = null,
            username = { "harry" },
            pods = { listOf(home, office).filter { it.podId in boxes.keys } },
            clientFor = { boxes[it.podId] },
            preferredPodId = { preferred },
        )

    private fun ServicesListViewModel.listed() =
        (state.value as LoadingState.Loaded).value

    @Test fun listsEachAppOnceWithEveryServerItIsOn() = runTest {
        val m = vm(
            mapOf(
                "home" to Box(listOf(app("notes"), app("wiki", "stopped"))),
                "office" to Box(listOf(app("notes", server = "office"), app("plants", "unknown", server = "office"))),
            ),
        )
        m.refresh()
        val rows = m.listed()
        assertEquals(listOf("harry--notes", "harry--wiki", "harry--plants"), rows.map { it.app.serviceId })
        val notes = rows[0]
        assertEquals(listOf("home", "office"), notes.podIds)
        assertEquals("On 2 servers", notes.pill.label)
        // The current server's copy describes it.
        assertEquals("https://notes.home.harry.flagship.services/", notes.app.url)
        assertEquals(AppStatus.STOPPED, rows[1].pill)
        // An older box's "unknown" still means it's there.
        assertEquals("On 1 server", rows[2].pill.label)
        assertEquals(listOf("office"), rows[2].podIds)
    }

    @Test fun activityOnAnyServerShows() = runTest {
        val m = vm(
            mapOf(
                "home" to Box(listOf(app("notes"), app("wiki"))),
                "office" to Box(listOf(app("notes", activity = "deploying"), app("wiki", activity = "editing"))),
            ),
        )
        m.refresh()
        assertEquals(listOf(AppStatus.DEPLOYING, AppStatus.EDITING), m.listed().map { it.pill })
    }

    @Test fun aServerThatStopsAnsweringLeavesItsAppsAsCantReach() = runTest {
        val office = Box(listOf(app("plants", server = "office")))
        val m = vm(mapOf("home" to Box(listOf(app("notes"))), "office" to office))
        m.refresh()
        assertEquals("On 1 server", m.listed().first { it.app.slug == "plants" }.pill.label)
        office.apps = null
        m.refresh()
        val plants = m.listed().first { it.app.slug == "plants" }
        assertEquals(AppStatus.CANT_REACH, plants.pill)
        assertEquals("On 1 server", m.listed().first { it.app.slug == "notes" }.pill.label)
    }

    @Test fun anAppOnAnUnreachableAndARunningServerCountsTheRunningOne() = runTest {
        val office = Box(listOf(app("notes", server = "office")))
        val m = vm(mapOf("home" to Box(listOf(app("notes"))), "office" to office))
        m.refresh()
        assertEquals("On 2 servers", m.listed().single().pill.label)
        office.apps = null
        m.refresh()
        assertEquals("On 1 server", m.listed().single().pill.label)
        assertEquals(listOf("home", "office"), m.listed().single().podIds)
    }

    @Test fun noServerAnsweringFails() = runTest {
        val m = vm(mapOf("home" to Box(null), "office" to null))
        m.refresh()
        assertEquals(LoadingState.Failed(ServicesListViewModel.CANT_REACH), m.state.value)
    }

    @Test fun withoutServersAsksTheCurrentClient() = runTest {
        val m = vm(emptyMap(), fallback = Box(listOf(app("notes", "stopped"))))
        m.refresh()
        val row = m.listed().single()
        assertEquals(AppStatus.STOPPED, row.pill)
        assertTrue(row.podIds.isEmpty())
    }
}
