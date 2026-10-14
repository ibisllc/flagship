// The owner's server order on the phone (docs/server-order.md): Home's drag
// and a server page's "Make leader" share one saver and AppState's order.

package com.flagshipserver.app.core

import com.flagshipserver.app.keystore.BiometricCancelled
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerOrderSaverTest {
    private val key = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 5 })
    private fun stk(n: Int) = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { n.toByte() }).publicKey)

    private fun pod(id: String, n: Int, status: PodInfo.Status = PodInfo.Status.ONLINE) = PodInfo(
        podId = id, name = id, fqdn = "$id.u.flagship.services", status = status,
        registeredAt = n.toLong(), identityPubKeyHex = stk(n),
    )

    private fun app(vararg pods: PodInfo) = AppState(isPaired = true, currentUser = "u", pods = pods.toList()).also {
        it.setCurrentPod(it.leaderPodId.value!!)
    }

    private class Fake {
        val posted = mutableListOf<ServerOrderWire>()
        var postError: Throwable? = null
        var signError: Throwable? = null
        var signed = 0
        var latest: ServerOrderWire? = null
        var signGate: CompletableDeferred<Unit>? = null
    }

    private fun saver(app: AppState, f: Fake, demo: Boolean = false, now: Long = 1_000) = ServerOrderSaver(
        app = app,
        post = { _, wire -> f.postError?.let { throw it }; f.posted.add(wire) },
        fetchOrder = { f.latest },
        signer = { f.signGate?.await(); f.signError?.let { throw it }; f.signed++; Ed25519Sign(key.privateKey) },
        isDemo = { demo },
        now = { now },
        randomBytes = { n -> ByteArray(n) { 1 } },
    )

    private fun AppState.homeOrder() = orderedPods.value.map { it.podId }

    @Test fun makeLeaderOnTheServerPage_putsItFirstOnHome() = runTest {
        val app = app(pod("a", 1), pod("b", 2), pod("c", 3))
        val f = Fake()
        assertEquals(listOf("a", "b", "c"), app.homeOrder())

        assertEquals(ServerOrderSaver.Outcome.Saved, saver(app, f).makeLeader("c"))

        // Home reads the same AppState order: the server is first and leads.
        assertEquals(listOf("c", "a", "b"), app.homeOrder())
        assertEquals("c", app.leaderPodId.value)
        assertEquals("c", app.currentPodId.value)
        val wire = f.posted.single()
        assertEquals(listOf(stk(3), stk(1), stk(2)), wire.order.stks)
        assertTrue(ServerOrderProtocol.verify(wire.order, wire.signature, key.publicKey))
    }

    @Test fun theNewOrderShowsWhileTheOwnerIsStillConfirming() = runTest {
        val app = app(pod("a", 1), pod("b", 2))
        val f = Fake().apply { signGate = CompletableDeferred() }
        val job = launch(start = CoroutineStart.UNDISPATCHED) { saver(app, f).makeLeader("b") }
        assertEquals(listOf("b", "a"), app.homeOrder())
        f.signGate!!.complete(Unit)
        job.join()
        assertEquals(listOf("b", "a"), app.homeOrder())
    }

    @Test fun aFailedSave_putsHomeBackToo() = runTest {
        val app = app(pod("a", 1), pod("b", 2), pod("c", 3))
        val f = Fake().apply { postError = HttpException(500, "boom") }
        val outcome = saver(app, f).makeLeader("c")
        assertTrue(outcome is ServerOrderSaver.Outcome.Failed)
        assertEquals(listOf("a", "b", "c"), app.homeOrder())
        assertEquals("a", app.leaderPodId.value)
        assertEquals("a", app.currentPodId.value)
    }

    @Test fun aCancelledConfirmation_putsTheOrderBack() = runTest {
        val app = app(pod("a", 1), pod("b", 2))
        val f = Fake().apply { signError = BiometricCancelled() }
        val outcome = saver(app, f).reorder(listOf("b", "a"))
        assertEquals("Order not changed: you didn't confirm it.", (outcome as ServerOrderSaver.Outcome.Failed).message)
        assertEquals(listOf("a", "b"), app.homeOrder())
        assertTrue(f.posted.isEmpty())
    }

    @Test fun aNewerOrderFromAnotherDevice_winsOn409() = runTest {
        val app = app(pod("a", 1), pod("b", 2), pod("c", 3))
        val f = Fake().apply {
            postError = HttpException(409, "stale")
            latest = ServerOrderWire(ServerOrder("u", listOf(stk(2), stk(3), stk(1)), 5_000, "aa".repeat(32)), "00".repeat(64))
        }
        assertEquals(ServerOrderSaver.Outcome.Superseded, saver(app, f).makeLeader("c"))
        assertEquals(listOf("b", "c", "a"), app.homeOrder())
    }

    @Test fun demoAccounts_reorderOnThisDeviceOnly() = runTest {
        val app = app(pod("a", 1), pod("b", 2))
        val f = Fake()
        assertEquals(ServerOrderSaver.Outcome.Local, saver(app, f, demo = true).reorder(listOf("b", "a")))
        assertEquals(listOf("b", "a"), app.homeOrder())
        assertEquals(0, f.signed)
        assertTrue(f.posted.isEmpty())
    }

    @Test fun droppingAServerWhereItWas_changesNothing() = runTest {
        val app = app(pod("a", 1), pod("b", 2))
        val f = Fake()
        assertEquals(ServerOrderSaver.Outcome.Unchanged, saver(app, f).reorder(listOf("a", "b")))
        assertEquals(0, f.signed)
    }

    @Test fun pendingAndRevokedServers_neverEnterTheOrder() = runTest {
        val pending = PodInfo(podId = "p", name = "p", fqdn = "p.u.flagship.services", status = PodInfo.Status.PENDING)
        val revoked = pod("r", 4).copy(revokedAt = 9, status = PodInfo.Status.OFFLINE)
        val app = app(pod("a", 1), pod("b", 2), revoked, pending)
        val f = Fake()
        saver(app, f).reorder(listOf("p", "r", "b", "a"))
        assertEquals(listOf(stk(2), stk(1)), f.posted.single().order.stks)
        assertEquals(listOf("b", "a", "r", "p"), app.homeOrder())
    }
}
