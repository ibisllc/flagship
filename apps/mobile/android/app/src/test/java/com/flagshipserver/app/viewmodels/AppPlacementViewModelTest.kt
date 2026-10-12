// "Runs on" (docs/app-placement.md §4–5): ticks come from each server's own
// apps list, an unreachable server is unknown, a tick signs an app-copy order
// and sends it to the target, an untick sends the signed uninstall to that
// server, and the last copy can't be unticked.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppCopyRecord
import com.flagshipserver.app.api.AppCopying
import com.flagshipserver.app.api.AppSummary
import com.flagshipserver.app.api.AppsListResponse
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.AppCopy
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.UninstallServiceOrder
import com.flagshipserver.app.viewmodels.AppPlacementViewModel.Presence
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppPlacementViewModelTest {

    private val serviceId = "harry--notes"

    private fun pod(id: String) = PodInfo(
        podId = id,
        name = id.replaceFirstChar { it.uppercase() },
        fqdn = "$id.harry.flagship.services",
        status = PodInfo.Status.ONLINE,
    )

    private fun app(copying: AppCopying? = null) = AppSummary(
        serviceId = serviceId, creator = "harry", slug = "notes", urlLabel = "notes",
        url = "https://notes.x/", status = "running", installedAt = 1, copying = copying,
    )

    /** One box: its apps list, and the mock that records copies and uninstalls. */
    private class Box(var apps: List<AppSummary>?, val inner: MockScreensClient = MockScreensClient(simulatedLatencyMs = 0)) :
        ScreensClient by inner {
        override suspend fun appsList(): AppsListResponse =
            AppsListResponse(apps ?: throw java.io.IOException("unreachable"))
    }

    private val seed = ByteArray(32) { 7 }
    private val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
    private val irkSeed = ByteArray(32) { 9 }
    private val irkPub = Ed25519Sign.KeyPair.newKeyPairFromSeed(irkSeed).publicKey

    private val home = pod("home")
    private val office = pod("office")
    private val cabin = pod("cabin")

    private fun vm(boxes: Map<String, Box?>, page: String? = "home", reasons: MutableList<String> = mutableListOf()) =
        AppPlacementViewModel(
            serviceId = serviceId,
            appName = "Notes",
            pods = { listOf(home, office, cabin).filter { it.podId in boxes.keys } },
            clientFor = { boxes[it.podId] },
            pagePodId = { page },
            copySigner = { r -> reasons.add(r); Ed25519Sign(seed) },
            uninstallSigner = { r -> reasons.add(r); Ed25519Sign(irkSeed) },
            now = { 1_700_000_000_000 },
        )

    private fun AppPlacementViewModel.presence(id: String) = rows.value.first { it.pod.podId == id }.presence

    @Test fun ticksExactlyTheServersThatHaveTheApp() = runTest {
        val m = vm(mapOf("home" to Box(listOf(app())), "office" to Box(emptyList()), "cabin" to Box(null)))
        m.load()
        assertTrue(m.presence("home") is Presence.Has)
        assertEquals(Presence.Absent, m.presence("office"))
        // Unreachable: unknown, never ticked, can't be changed.
        val cabinRow = m.rows.value.first { it.pod.podId == "cabin" }
        assertTrue(cabinRow.presence is Presence.Unknown)
        assertFalse(cabinRow.ticked)
        assertFalse(m.canChange(cabinRow))
        assertEquals(AppPlacementViewModel.UNREACHABLE, m.blockedReason(cabinRow))
    }

    @Test fun aServerWithoutASessionIsUnknown() = runTest {
        val m = vm(mapOf("home" to Box(listOf(app())), "office" to null))
        m.load()
        assertEquals(Presence.Unknown(AppPlacementViewModel.NO_SESSION), m.presence("office"))
    }

    @Test fun anArrivingCopyShowsAsCopying() = runTest {
        val m = vm(mapOf("home" to Box(listOf(app())), "office" to Box(listOf(app(AppCopying("copying", 0.4))))))
        m.load()
        assertEquals(Presence.Copying(0.4), m.presence("office"))
        assertTrue(m.rows.value.first { it.pod.podId == "office" }.ticked)
        assertEquals(1, m.copyCount)
    }

    @Test fun tickSignsTheCopyAndPostsItToTheTarget() = runTest {
        val homeBox = Box(listOf(app()))
        val officeBox = Box(emptyList())
        val reasons = mutableListOf<String>()
        val m = vm(mapOf("home" to homeBox, "office" to officeBox), reasons = reasons)
        m.load()
        assertTrue(m.copyTo("office"))
        assertEquals(listOf("Copy Notes to Office"), reasons)
        assertTrue(homeBox.inner.copyRequests.isEmpty())
        val req = officeBox.inner.copyRequests.single()
        assertEquals("home.harry.flagship.services", req.grant.sourceServer)
        assertEquals("office.harry.flagship.services", req.grant.targetServer)
        assertEquals(serviceId, req.grant.serviceId)
        assertEquals(1_700_000_000_000, req.grant.issuedAt)
        val canonical = AppCopy.canonicalBytes(
            AppCopy.Grant(req.grant.sourceServer, req.grant.targetServer, req.grant.serviceId, req.grant.issuedAt),
        )
        Ed25519Verify(pub).verify(HexUtil.decode(req.signature)!!, canonical)
        assertEquals(Presence.Copying(0.0), m.presence("office"))
    }

    @Test fun theCopyComesFromThisPagesServerWhenItHasTheApp() = runTest {
        val cabinBox = Box(emptyList())
        val m = vm(
            mapOf("home" to Box(listOf(app())), "office" to Box(listOf(app())), "cabin" to cabinBox),
            page = "office",
        )
        m.load()
        assertTrue(m.copyTo("cabin"))
        assertEquals("office.harry.flagship.services", cabinBox.inner.copyRequests.single().grant.sourceServer)
    }

    @Test fun copyFollowsProgressUntilInstalled() = runTest {
        val officeBox = Box(emptyList())
        val m = vm(mapOf("home" to Box(listOf(app())), "office" to officeBox))
        m.load()
        m.copyTo("office")
        officeBox.apps = listOf(app(AppCopying("installing", 80.0)))
        m.refreshCopying()
        assertEquals(Presence.Copying(80.0), m.presence("office"))
        officeBox.apps = listOf(app())
        m.refreshCopying()
        assertTrue(m.presence("office") is Presence.Has)
        assertEquals(2, m.copyCount)
    }

    @Test fun envValuesThatDidntComeAlongAreNamed() = runTest {
        val officeBox = Box(emptyList())
        val m = vm(mapOf("home" to Box(listOf(app())), "office" to officeBox))
        m.load()
        m.copyTo("office")
        officeBox.inner.copies.clear()
        officeBox.inner.copies.add(
            AppCopyRecord("c1", serviceId, "Notes", "home.harry.flagship.services", "done", startedAt = 5, pendingEnv = listOf("API_KEY")),
        )
        officeBox.apps = listOf(app())
        m.refreshCopying()
        assertTrue(m.presence("office") is Presence.Has)
        assertEquals(
            "Notes is on Office. Its setting API_KEY didn't come along: set it in its environment on Office.",
            m.message.value,
        )
    }

    @Test fun aFailedCopyUnticksWithTheBoxsReason() = runTest {
        val officeBox = Box(emptyList())
        val m = vm(mapOf("home" to Box(listOf(app())), "office" to officeBox))
        m.load()
        m.copyTo("office")
        officeBox.inner.copies.clear()
        officeBox.inner.copies.add(
            AppCopyRecord("c1", serviceId, "Notes", "home.harry.flagship.services", "failed", reason = "not enough disk", startedAt = 5),
        )
        m.refreshCopying()
        assertEquals(Presence.Absent, m.presence("office"))
        assertEquals("Couldn't copy Notes to Office: not enough disk", m.message.value)
    }

    @Test fun anOlderBoxNeedsAnUpdate() = runTest {
        val officeBox = Box(emptyList()).apply { inner.copyError = ScreensError.Http(404, "not found") }
        val m = vm(mapOf("home" to Box(listOf(app())), "office" to officeBox))
        m.load()
        assertFalse(m.copyTo("office"))
        assertEquals("This server needs an update to receive copies.", m.message.value)
        assertEquals(Presence.Absent, m.presence("office"))
    }

    @Test fun refusalsReadPlainly() {
        assertEquals(
            "Notes is already on Office, or a copy is on its way there.",
            AppPlacementViewModel.copyFailure(ScreensError.Http(409, """{"error":"already there"}"""), "Notes", "Office"),
        )
        assertEquals(
            "Office refused the copy. Check this phone's clock and try again.",
            AppPlacementViewModel.copyFailure(ScreensError.Http(403, ""), "Notes", "Office"),
        )
        assertEquals(
            "Office refused the copy: grant is stale.",
            AppPlacementViewModel.copyFailure(ScreensError.Http(403, """{"error":"grant is stale"}"""), "Notes", "Office"),
        )
        assertEquals(
            AppPlacementViewModel.NEEDS_UPDATE,
            AppPlacementViewModel.copyFailure(ScreensError.NotImplemented("copies"), "Notes", "Office"),
        )
    }

    @Test fun untickSendsTheSignedUninstallToThatServer() = runTest {
        val homeBox = Box(listOf(app()))
        val officeBox = Box(listOf(app()))
        val reasons = mutableListOf<String>()
        val m = vm(mapOf("home" to homeBox, "office" to officeBox), reasons = reasons)
        m.load()
        assertTrue(m.canChange(m.rows.value.first { it.pod.podId == "office" }))
        assertTrue(m.removeFrom("office"))
        assertEquals(listOf("Remove Notes from Office"), reasons)
        assertTrue(homeBox.inner.uninstalls.isEmpty())
        val (id, body) = officeBox.inner.uninstalls.single()
        assertEquals(serviceId, id)
        assertEquals("office.harry.flagship.services", body.request.serverId)
        assertEquals("harry", body.request.creator)
        assertEquals("notes", body.request.slug)
        Ed25519Verify(irkPub).verify(
            HexUtil.decode(body.signature)!!,
            UninstallServiceOrder.canonicalBytes(body.request.serverId, "harry", "notes", body.request.issuedAt),
        )
        assertEquals(Presence.Absent, m.presence("office"))
    }

    @Test fun theLastCopyCantBeUnticked() = runTest {
        val homeBox = Box(listOf(app()))
        val reasons = mutableListOf<String>()
        val m = vm(mapOf("home" to homeBox, "office" to Box(emptyList())), reasons = reasons)
        m.load()
        val row = m.rows.value.first { it.pod.podId == "home" }
        assertFalse(m.canChange(row))
        assertEquals(AppPlacementViewModel.LAST_COPY, m.blockedReason(row))
        assertFalse(m.removeFrom("home"))
        assertTrue(reasons.isEmpty())
        assertTrue(homeBox.inner.uninstalls.isEmpty())
        assertTrue(m.presence("home") is Presence.Has)
    }

    @Test fun aFailedUninstallKeepsTheTick() = runTest {
        val officeBox = Box(listOf(app())).apply { inner.uninstallError = ScreensError.Http(400, """{"error":"invalid signature"}""") }
        val m = vm(mapOf("home" to Box(listOf(app())), "office" to officeBox))
        m.load()
        assertFalse(m.removeFrom("office"))
        assertTrue(m.presence("office") is Presence.Has)
        assertEquals("Couldn't remove Notes from Office: invalid signature", m.message.value)
    }

    @Test fun progressText() {
        assertEquals("Copying…", AppPlacementViewModel.progressText(null))
        assertEquals("Copying… 40%", AppPlacementViewModel.progressText(0.4))
        assertEquals("Copying… 75%", AppPlacementViewModel.progressText(75.0))
    }
}
