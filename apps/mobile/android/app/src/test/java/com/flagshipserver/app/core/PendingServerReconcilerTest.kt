// #56 — Android parity for the iOS PendingServerReconcilerTests. Pins that the
// server list is driven from ONE unauthenticated `/pods` fetch carrying BOTH
// registered servers (online) AND active orders (pending), with identity
// unified on the fqdn so a registered fqdn supersedes a pending one.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.PendingPodEntry
import com.flagshipserver.app.api.PodDirectoryEntry
import com.flagshipserver.app.api.PodsDirectoryResponse
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PendingServerReconcilerTest {

    // Mirror the production transport's lenient decoder (ignoreUnknownKeys).
    private val json = Json { ignoreUnknownKeys = true }

    private fun signedInApp(user: String = "harry"): AppState =
        AppState().also { it.completeOnboarding(user, emptyList()) }

    private fun registered(fqdn: String) =
        PodDirectoryEntry(serverDomain = fqdn, identityPubKey = "00".repeat(32))

    private fun order(serial: String, name: String, fqdn: String, phase: String? = null) =
        PendingPodEntry(serial = serial, serverName = name, fqdn = fqdn, phase = phase, createdAt = 1L)

    // (1) registered + pending BOTH surface from one /pods fetch.
    @Test fun registeredAndPending_bothSurfaceFromOneFetch() = runTest {
        val app = signedInApp()
        val mailbox = MockSecretMailboxClient().apply {
            directory = listOf(registered("home.harry.flagship.services"))
            pendingOrders = listOf(
                order("S-1", "Work", "work.harry.flagship.services", phase = "installing"),
            )
        }
        PendingServerReconciler(app, mailbox).reconcile()

        val pods = app.pods.value
        assertEquals(2, pods.size)

        val online = pods.first { it.fqdn == "home.harry.flagship.services" }
        assertEquals(PodInfo.Status.ONLINE, online.status)

        val pending = pods.first { it.fqdn == "work.harry.flagship.services" }
        assertEquals(PodInfo.Status.PENDING, pending.status)
        assertEquals("Work", pending.name)
        assertEquals("S-1", pending.pendingAuthCodeSerial)
    }

    // (2) a pending order with NO local record appears as a pending pod.
    @Test fun pendingOrderWithoutLocalRecord_appears() = runTest {
        val app = signedInApp()
        assertTrue(app.pods.value.isEmpty())
        val mailbox = MockSecretMailboxClient().apply {
            pendingOrders = listOf(order("S-9", "Music", "music.harry.flagship.services"))
        }
        PendingServerReconciler(app, mailbox).reconcile()

        assertEquals(1, app.pods.value.size)
        val pod = app.pods.value.single()
        assertEquals(PodInfo.Status.PENDING, pod.status)
        assertEquals("S-9", pod.pendingAuthCodeSerial)
        assertEquals(PodInfo.podId("music.harry.flagship.services"), pod.podId)
    }

    // (3) a registered server SUPERSEDES a pending one for the same fqdn:
    //     the pending pod flips online in place — no stuck duplicate.
    @Test fun registeredSupersedesPending_byFqdn() = runTest {
        val app = signedInApp()
        // Pre-seed a local pending pod for the box (as if just ordered).
        app.addPod(
            PodInfo(
                podId = PodInfo.podId("home.harry.flagship.services"),
                name = "Home",
                fqdn = "home.harry.flagship.services",
                status = PodInfo.Status.PENDING,
                pendingAuthCodeSerial = "S-5",
            ),
        )
        // The box has now registered AND the order is still listed outstanding
        // — registered must win and collapse to ONE online pod.
        val mailbox = MockSecretMailboxClient().apply {
            directory = listOf(registered("home.harry.flagship.services"))
            pendingOrders = listOf(order("S-5", "Home", "home.harry.flagship.services"))
        }
        PendingServerReconciler(app, mailbox).reconcile()

        assertEquals(1, app.pods.value.size)
        val pod = app.pods.value.single()
        assertEquals(PodInfo.Status.ONLINE, pod.status)
        assertEquals("Home", pod.name)            // richer local name preserved
        assertNull(pod.pendingAuthCodeSerial)     // cleared on going online
    }

    // A dead local pending pod (serial in neither array) is aged out.
    @Test fun deadPendingGhost_isDropped() = runTest {
        val app = signedInApp()
        app.addPod(
            PodInfo(
                podId = PodInfo.podId("ghost.harry.flagship.services"),
                name = "Ghost",
                fqdn = "ghost.harry.flagship.services",
                status = PodInfo.Status.PENDING,
                pendingAuthCodeSerial = "S-DEAD",
            ),
        )
        val mailbox = MockSecretMailboxClient() // empty directory + no orders
        PendingServerReconciler(app, mailbox).reconcile()

        assertTrue(app.pods.value.isEmpty())
    }

    // Backward-compatible: a pre-#56 response with no `pending` key still
    // surfaces registered servers (the default keeps `pending` empty).
    @Test fun backwardCompatible_responseWithoutPending() = runTest {
        val app = signedInApp()
        val resp = json.decodeFromString(
            PodsDirectoryResponse.serializer(),
            """{"username":"harry","pods":[{"serverDomain":"home.harry.flagship.services","identityPubKey":"${"00".repeat(32)}"}]}""",
        )
        assertTrue(resp.pending.isEmpty())
        val mailbox = MockSecretMailboxClient().apply { directory = resp.pods }
        PendingServerReconciler(app, mailbox).reconcile()

        assertEquals(1, app.pods.value.size)
        assertEquals(PodInfo.Status.ONLINE, app.pods.value.single().status)
    }

    // No signed-in user → no-op (and certainly no crash / no fetch effect).
    @Test fun noUser_isNoOp() = runTest {
        val app = AppState()
        val mailbox = MockSecretMailboxClient().apply {
            pendingOrders = listOf(order("S-1", "X", "x.harry.flagship.services"))
        }
        PendingServerReconciler(app, mailbox).reconcile()
        assertTrue(app.pods.value.isEmpty())
    }

    // The new `pending` array decodes from the live Worker JSON shape.
    @Test fun pendingArray_decodesFromWorkerJson() {
        val resp = json.decodeFromString(
            PodsDirectoryResponse.serializer(),
            """{"username":"harry","pods":[],"pending":[
                {"serial":"S-1","serverName":"Work","fqdn":"work.harry.flagship.services","phase":"installing","createdAt":1717000000000,"state":"pending"}
            ],"fetchedAt":1717000000000}""",
        )
        assertEquals(1, resp.pending.size)
        val p = resp.pending.single()
        assertEquals("S-1", p.serial)
        assertEquals("installing", p.phase)
        assertEquals("pending", p.state)
        assertNotNull(p.fqdn)
        assertFalse(p.fqdn.isEmpty())
    }
}
