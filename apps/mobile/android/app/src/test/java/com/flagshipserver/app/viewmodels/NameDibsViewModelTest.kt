package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.DibsClientException
import com.flagshipserver.app.api.DibsWindow
import com.flagshipserver.app.api.MockNameDibsClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.NameDibsInitiate
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirror of iOS NameDibsViewModelTests. */
class NameDibsViewModelTest {
    private val pair = Ed25519Sign.KeyPair.newKeyPair()
    private val pubHex = HexUtil.encode(pair.publicKey)

    private fun vm(client: MockNameDibsClient, now: Long = 1_000) = NameDibsViewModel(
        client = client,
        username = "Fresh-Poppy",
        signer = { Ed25519Sign(pair.privateKey) },
        irkPubHex = { pubHex },
        now = { now },
    )

    @Test fun closedWindow_reportsAFutureStart() = runBlocking {
        val client = MockNameDibsClient().apply { scriptedWindow = DibsWindow(true, false, 5_000, 9_000) }
        val model = vm(client)
        model.load()
        assertEquals(NameDibsPhase.Closed(5_000), model.phase.value)
    }

    @Test fun start_signsTheInitiate_andShowsWhereToPublish() = runBlocking {
        val client = MockNameDibsClient().apply { scriptedWindow = DibsWindow(true, true, 0, 9_000) }
        val model = vm(client)
        model.load()
        assertEquals(NameDibsPhase.EnterName(9_000), model.phase.value)
        model.start(" Acme.com ")

        val body = client.initiates.single()
        assertEquals("fresh-poppy", body.request.username)
        assertEquals("acme", body.request.name)
        assertEquals(pubHex, body.request.irkPubHex)
        val bytes = NameDibsInitiate.canonicalBytes(body.request.username, body.request.name, body.request.irkPubHex, body.request.issuedAt)
        Ed25519Verify(pair.publicKey).verify(HexUtil.decode(body.signature)!!, bytes) // throws on mismatch
        val phase = model.phase.value
        assertTrue(phase is NameDibsPhase.Publish)
        assertEquals("_flagship-claim.acme.com", (phase as NameDibsPhase.Publish).claim.publishAt.dns.name)
    }

    @Test fun check_reportsProven() = runBlocking {
        val client = MockNameDibsClient().apply { scriptedWindow = DibsWindow(true, true, 0, 9_000) }
        val model = vm(client)
        model.load()
        model.start("acme")
        model.check()
        assertEquals(NameDibsPhase.Proven("acme"), model.phase.value)
    }

    @Test fun check_keepsThePublishStep_andShowsTheRefusal() = runBlocking {
        val client = MockNameDibsClient().apply {
            scriptedWindow = DibsWindow(true, true, 0, 9_000)
            verifyError = DibsClientException(409, "no proof found yet")
        }
        val model = vm(client)
        model.load()
        model.start("acme")
        model.check()
        assertTrue(model.phase.value is NameDibsPhase.Publish)
        assertEquals("no proof found yet", model.inlineError.value)
    }

    @Test fun banner_showsOnlyWhileOpen_andUntilDismissed() {
        val open = DibsWindow(true, true, 0, 1)
        assertTrue(NameDibsViewModel.shouldShowBanner(open, dismissed = false))
        assertFalse(NameDibsViewModel.shouldShowBanner(open, dismissed = true))
        assertFalse(NameDibsViewModel.shouldShowBanner(null, dismissed = false))
    }
}
