// The smoke-mode share world answers the real share client the way the real
// `.com`, boot worker and boxes do, so the gym drives the real screens.

package com.flagshipserver.app.core

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MockServerSharesTest {
    private val home = "home.bright-maple.flagship.services"
    private val world = MockShareWorld("bright-maple", home, "51".repeat(32))
    private val client = world.client(world.phone)

    @Test fun ownerSeesSamActiveAndAlexWaitingForTheCode() = runBlocking {
        val shares = client.ownerShares("bright-maple", home, MockServerShares.OWNER_SESSION)
        assertEquals(listOf("Sam"), shares.active.map { it.label })
        val alex = shares.accepted.single()
        assertEquals("Alex", alex.label)
        assertTrue("Alex's acceptance checks out", alex.sas?.matches(Regex("\\d{6}")) == true)

        client.confirm("bright-maple", home, MockServerShares.OWNER_SESSION, alex)
        val after = client.ownerShares("bright-maple", home, MockServerShares.OWNER_SESSION)
        assertEquals(setOf("Sam", "Alex"), after.active.map { it.label }.toSet())
        assertTrue(after.accepted.isEmpty())

        val created = client.createOffer(
            "bright-maple", home, "Home", "51".repeat(32),
            ShareOptions("Robin", ServerShare.LEVEL_MANAGE, unlockAtBoot = false, seeAppData = false),
        )
        assertTrue(created.link.contains("/share#s=${created.shareId}"))
        assertEquals("Robin", client.ownerShares("bright-maple", home, MockServerShares.OWNER_SESSION).pending.single().label)
    }

    @Test fun phoneHasGarageToManageAndPhotosWaiting() = runBlocking {
        val entries = client.inbox().associateBy { it.serverName }
        assertEquals(setOf("Garage", "Photos"), entries.keys)
        val garage = entries.getValue("Garage")
        val signedIn = client.signIn(garage)
        assertTrue(signedIn is ShareSignIn.In)
        assertEquals(ServerShare.LEVEL_MANAGE, (signedIn as ShareSignIn.In).session.level)
        assertTrue(signedIn.session.unlockAtBoot)
        assertEquals(ShareSignIn.Waiting, client.signIn(entries.getValue("Photos")))

        val startup = client.pendingStartups(garage).single()
        client.approveStartup(garage, startup)
        assertTrue("Approved: Garage no longer waits", client.pendingStartups(garage).isEmpty())
        assertNotNull(client.me(garage))

        client.leave(garage)
        assertEquals(listOf("Photos"), client.inbox().map { it.serverName })
    }
}
