// Who leads (docs/server-order.md): the first server in the owner's order
// that is up; the role passes down while it is down and comes back with it.

package com.flagshipserver.app.core

import com.flagshipserver.app.ui.screens.serverRoles
import com.google.crypto.tink.subtle.Ed25519Sign
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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

    @Test fun roles_numberTheLine_andNameWhoTheLeaderStandsInFor() {
        val pods = listOf(pod("a", 1, PodInfo.Status.OFFLINE), pod("b", 2), pod("c", 3))
        val roles = serverRoles(pods, leaderPodId = "b")
        assertEquals(1, roles["a"]?.position)
        assertEquals(2, roles["b"]?.position)
        assertEquals("a", roles["b"]?.standingInFor)
        assertNull(roles["c"]?.standingInFor)
        assertNull(serverRoles(listOf(pod("a", 1)), "a")["a"]?.position)
    }
}
