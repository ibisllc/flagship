// Where a new app runs (docs/app-placement.md §2): the picker defaults to the
// leader, a server-page start is pinned, and the request goes to the chosen
// box's own client.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.BuildClient
import com.flagshipserver.app.api.MockBuildClient
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.VibeCodeStartRequest
import com.flagshipserver.app.api.VibeCodeStartResponse
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class CreationPlacementTest {

    private fun pod(id: String, status: PodInfo.Status = PodInfo.Status.ONLINE) =
        PodInfo(podId = id, name = id.replaceFirstChar { it.uppercase() }, fqdn = "$id.harry.flagship.services", status = status)

    private val home = pod("home")
    private val office = pod("office")
    private val pods = listOf(home, office)
    private val all: (PodInfo) -> Boolean = { true }

    @Test fun defaultsToTheLeader() {
        assertEquals("office", CreationPlacement.resolve(pods, "office", null, all)?.podId)
        val scope = CreationPlacement.scope(listOf(null, null), creation = true, pods, "office", all)
        assertEquals("office", scope?.first?.podId)
        assertEquals(false, scope?.second)
    }

    @Test fun aChoiceWins() {
        val marks = listOf(null, CreationPlacement.Mark("home"), null)
        assertEquals("home", CreationPlacement.scope(marks, creation = true, pods, "office", all)?.first?.podId)
    }

    @Test fun aChoiceThisPhoneCantUseFallsBackToTheLeader() {
        val noHome: (PodInfo) -> Boolean = { it.podId != "home" }
        val marks = listOf(CreationPlacement.Mark("home"))
        assertEquals("office", CreationPlacement.scope(marks, creation = true, pods, "office", noHome)?.first?.podId)
    }

    @Test fun aLeaderWithoutASessionFallsBackToAServerThisPhoneCanUse() {
        val noOffice: (PodInfo) -> Boolean = { it.podId != "office" }
        assertEquals("home", CreationPlacement.resolve(pods, "office", null, noOffice)?.podId)
    }

    @Test fun startedFromAServerPageIsPinnedAndNotAsked() {
        val marks = listOf(CreationPlacement.Mark("home", pinned = true))
        val (pinnedPod, pinned) = CreationPlacement.scope(marks, creation = true, pods, "office", all)!!
        assertEquals("home", pinnedPod.podId)
        assertTrue(pinned)
        val scope = PodScope(pinnedPod, pinned = true, creation = true, choose = null)
        assertFalse(CreationPlacement.showsPicker(scope, CreationPlacement.options(pods, all)))
    }

    @Test fun thePickerShowsWithMoreThanOneServer() {
        val scope = PodScope(home, creation = true, choose = {})
        assertTrue(CreationPlacement.showsPicker(scope, CreationPlacement.options(pods, all)))
        assertFalse(CreationPlacement.showsPicker(scope, CreationPlacement.options(listOf(home), all)))
    }

    @Test fun pendingAndRevokedServersAreNotOffered() {
        val pending = pod("new", PodInfo.Status.PENDING)
        val revoked = pod("lost").copy(revokedAt = 1L)
        val ids = CreationPlacement.options(pods + pending + revoked, all).map { it.pod.podId }
        assertEquals(listOf("home", "office"), ids)
    }

    @Test fun outsideACreationFlowOnlyAMarkCounts() {
        assertNull(CreationPlacement.scope(listOf(null), creation = false, pods, "office", all))
        assertEquals(
            "home",
            CreationPlacement.scope(listOf(CreationPlacement.Mark("home")), creation = false, pods, "office", all)?.first?.podId,
        )
    }

    /** Records which box a build started on. */
    private class Box(val name: String, val started: MutableList<String>) :
        ScreensClient by MockScreensClient(simulatedLatencyMs = 0) {
        override suspend fun vibeCodeStart(req: VibeCodeStartRequest): VibeCodeStartResponse {
            started.add(name)
            return VibeCodeStartResponse(sessionId = "s-$name")
        }
    }

    @Test fun theRequestGoesToTheChosenBox() = runTest {
        val started = mutableListOf<String>()
        val boxes = mapOf("home" to Box("home", started), "office" to Box("office", started))
        val clients = object : PodClients {
            override fun screens(pod: PodInfo): ScreensClient? = boxes[pod.podId]
            override fun build(pod: PodInfo): BuildClient? = MockBuildClient()
        }
        val available: (PodInfo) -> Boolean = { clients.screens(it) != null }
        val (chosen, _) = CreationPlacement.scope(
            listOf(CreationPlacement.Mark("home")), creation = true, pods, "office", available,
        )!!
        val client = clients.screens(chosen)!!
        assertSame(boxes["home"], client)
        client.vibeCodeStart(VibeCodeStartRequest(prompt = "notes"))
        assertEquals(listOf("home"), started)
    }
}
