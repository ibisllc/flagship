// Who leads (docs/server-order.md): the first server in the owner's order
// that is up; the role passes down while it is down and comes back with it.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.PodsDirectoryResponse
import com.flagshipserver.app.ui.screens.applyDraft
import com.flagshipserver.app.ui.screens.leaderConfirmed
import com.flagshipserver.app.ui.screens.leaderLabel
import com.flagshipserver.app.ui.screens.successionLine
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import com.google.crypto.tink.subtle.Ed25519Sign
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerOrderTest {
    private fun stk(n: Int) = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { n.toByte() }).publicKey)
    private fun pod(id: String, n: Int, status: PodInfo.Status = PodInfo.Status.ONLINE) = PodInfo(
        podId = id, name = id, fqdn = "$id.u.flagship.services", status = status,
        registeredAt = n.toLong(), identityPubKeyHex = stk(n),
    )
    private fun wire(issuedAt: Long, vararg n: Int) =
        ServerOrderWire(ServerOrder("u", n.map(::stk), issuedAt, "aa".repeat(32)), "00".repeat(64))

    @Test fun withNoOrder_theOldestServerThatIsUpLeads() {
        val app = AppState(isPaired = true, currentUser = "u", pods = listOf(pod("b", 2), pod("a", 1)))
        assertEquals(listOf("a", "b"), app.orderedPods.value.map { it.podId })
        assertEquals("a", app.leaderPodId.value)
    }

    @Test fun theRolePassesDownWhileTheFirstIsDown_andComesBack() {
        val app = AppState(isPaired = true, currentUser = "u", pods = listOf(pod("a", 1), pod("b", 2), pod("c", 3)))
        app.applyDirectoryServerOrder(wire(10, 3, 1, 2))
        assertEquals("c", app.leaderPodId.value)
        app.upsertRegisteredPod(fqdn = "c.u.flagship.services", name = "c", liveness = PodInfo.Liveness.UNREACHABLE, registeredAt = 3)
        assertEquals("a", app.leaderPodId.value)
        assertEquals(listOf("c", "a", "b"), app.orderedPods.value.map { it.podId })
        app.upsertRegisteredPod(fqdn = "c.u.flagship.services", name = "c", liveness = PodInfo.Liveness.LIVE, registeredAt = 3)
        assertEquals("c", app.leaderPodId.value)
    }

    @Test fun aNewServerRanksAfterTheOrderedOnes() {
        val app = AppState(isPaired = true, currentUser = "u", pods = listOf(pod("a", 1), pod("b", 2)))
        app.applyDirectoryServerOrder(wire(10, 2, 1))
        app.addPod(pod("z", 0))
        assertEquals(listOf("b", "a", "z"), app.orderedPods.value.map { it.podId })
        assertEquals("b", app.leaderPodId.value)
    }

    @Test fun anOlderOrderFromPods_neverReplacesANewerOne() {
        val app = AppState(isPaired = true, currentUser = "u", pods = listOf(pod("a", 1), pod("b", 2)))
        app.setServerOrder(listOf(stk(2), stk(1)), 20)
        app.applyDirectoryServerOrder(wire(10, 1, 2))
        assertEquals("b", app.leaderPodId.value)
        app.applyDirectoryServerOrder(null)
        assertEquals("b", app.leaderPodId.value)
        app.applyDirectoryServerOrder(wire(30, 1, 2))
        assertEquals("a", app.leaderPodId.value)
    }

    @Test fun anotherAccountsOrder_isIgnored() {
        val app = AppState(isPaired = true, currentUser = "u", pods = listOf(pod("a", 1), pod("b", 2)))
        app.applyDirectoryServerOrder(wire(10, 2, 1).let { it.copy(order = it.order.copy(user = "mallory")) })
        assertEquals("a", app.leaderPodId.value)
    }

    @Test fun signingOut_forgetsTheOrder() {
        val app = AppState(isPaired = true, currentUser = "u", pods = listOf(pod("a", 1), pod("b", 2)))
        app.applyDirectoryServerOrder(wire(10, 2, 1))
        app.signOut()
        assertNull(app.serverOrder.value)
    }

    @Test fun leaderLabel_isTheFirstOnlineServerInTheShownOrder_namingTheOnesItStandsInFor() {
        val pods = listOf(
            pod("p", 0, PodInfo.Status.PENDING),
            pod("a", 1, PodInfo.Status.OFFLINE),
            pod("r", 2).copy(revokedAt = 5),
            pod("b", 3, PodInfo.Status.UNKNOWN),
            pod("c", 4),
            pod("d", 5),
        )
        assertEquals("c", leaderLabel(pods)?.podId)
        assertEquals("a, b", leaderLabel(pods)?.standingInFor)
        assertNull(leaderLabel(listOf(pod("c", 4), pod("a", 1)))?.standingInFor)
        assertNull(leaderLabel(listOf(pod("a", 1, PodInfo.Status.OFFLINE))))
    }

    @Test fun leaderLabel_followsTheDraft_beforeTheOrderIsSaved() {
        val committed = listOf(pod("a", 1), pod("b", 2), pod("c", 3))
        assertEquals("a", leaderLabel(applyDraft(committed, null))?.podId)
        val shown = applyDraft(committed, listOf("c", "a"))
        assertEquals(listOf("c", "a", "b"), shown.map { it.podId })
        assertEquals("c", leaderLabel(shown)?.podId)
    }

    @Test fun theLeaderBadge_isConfirmedOnlyOnceTheLeaderHoldsTheShownOrder() {
        // The owner never ordered: nothing to wait for.
        assertTrue(leaderConfirmed(false, 0, emptyMap(), "a"))
        // A drag's draft is on screen: never confirmed.
        assertFalse(leaderConfirmed(true, 0, emptyMap(), "a"))
        assertFalse(leaderConfirmed(true, 10, mapOf("a" to 10L), "a"))
        // The leader holds an older order, or none: gray.
        assertFalse(leaderConfirmed(false, 10, mapOf("a" to 9L), "a"))
        assertFalse(leaderConfirmed(false, 10, mapOf("b" to 10L), "a"))
        assertFalse(leaderConfirmed(false, 10, mapOf("a" to 10L), null))
        // It holds this order or a newer one.
        assertTrue(leaderConfirmed(false, 10, mapOf("a" to 10L), "a"))
        assertTrue(leaderConfirmed(false, 10, mapOf("a" to 11L), "a"))
    }

    @Test fun successionLine_namesTheServersAbove_withoutNumbers() {
        assertEquals("First in line to lead", successionLine(emptyList()))
        assertEquals("Takes over while home3 is down", successionLine(listOf("home3")))
        assertEquals("Takes over while a, b and c are down", successionLine(listOf("a", "b", "c")))
    }

    @Test fun acks_onlyMoveForward_andSigningOutForgetsThem() {
        val app = AppState(isPaired = true, currentUser = "u", pods = listOf(pod("a", 1), pod("b", 2)))
        app.recordServerOrderAcks(mapOf("a" to 20L, "b" to 5L))
        app.recordServerOrderAcks(mapOf("a" to 10L, "b" to 7L))
        assertEquals(mapOf("a" to 20L, "b" to 7L), app.serverOrderAcks.value)
        app.setServerOrder(listOf(stk(2), stk(1)), 30)
        assertEquals(30L, app.serverOrderIssuedAt.value)
        app.signOut()
        assertEquals(emptyMap<String, Long>(), app.serverOrderAcks.value)
        assertEquals(0L, app.serverOrderIssuedAt.value)
    }

    @Test fun podsOrderIssuedAt_isParsed_andRecordedPerPod() = runTest {
        val wire = """
            {"username":"u","pods":[
              {"serverDomain":"a.u.flagship.services","identityPubKey":"${stk(1)}","orderIssuedAt":1760000000123},
              {"serverDomain":"b.u.flagship.services","identityPubKey":"${stk(2)}"}
            ]}
        """.trimIndent()
        val directory = Json { ignoreUnknownKeys = true }.decodeFromString(PodsDirectoryResponse.serializer(), wire)
        assertEquals(1_760_000_000_123L, directory.pods[0].orderIssuedAt)
        assertNull(directory.pods[1].orderIssuedAt)

        val app = AppState(isPaired = true, currentUser = "u")
        PendingServerReconciler(app, MockSecretMailboxClient()).reconcile(directory)
        val a = app.pods.value.single { it.fqdn == "a.u.flagship.services" }
        assertEquals(mapOf(a.podId to 1_760_000_000_123L), app.serverOrderAcks.value)
    }
}
