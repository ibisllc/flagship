// Co-manager invites (docs/service-access-gating.md "Co-manager invites") on
// Android: the real ServerShareClient against the smoke share world, whose
// boxes answer with the box's wire and check every signature under the
// share's member key.

package com.flagshipserver.app.core

import com.flagshipserver.app.viewmodels.CoInviteUi
import com.flagshipserver.app.viewmodels.CoInviteViewModel
import com.flagshipserver.app.viewmodels.ServiceAccessViewModel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class CoManagerInviteFlowTest {
    private val home = "home.bright-maple.flagship.services"
    private val world = MockShareWorld("bright-maple", home, "51".repeat(32))
    private val client = world.client(world.phone)

    private suspend fun entry(name: String) = client.inbox().first { it.serverName == name }

    @Test fun personalInviteIsSignedWithTheMemberKeyAndWithdrawn() = runBlocking {
        val garage = entry("Garage")
        val state = client.coInvites(garage, "bright-maple--plants")
        assertTrue(state.canInvite)
        assertEquals(MockServerShares.OWNER_AID, state.ownerAid)
        assertTrue(state.invites.isEmpty())

        val made = client.createCoInvite(garage, "bright-maple--plants", state.ownerAid, "  Alex ")
        val prefix = "https://${MockServerShares.GARAGE_DOMAIN}/invite#"
        assertTrue(made.link, made.link.startsWith(prefix))
        assertTrue(made.link, made.link.endsWith("&a=${MockServerShares.OWNER_AID}&i=${made.inviteId}&s=bright-maple--plants"))
        assertEquals(64, made.inviteId.length)

        val listed = client.coInvites(garage, "bright-maple--plants")
        assertEquals(listOf("Alex"), listed.invites.map { it.name })
        assertEquals("Not opened yet", ShareCoInviteCopy.statusText(listed.invites.single()))

        client.withdrawCoInvite(garage, made.inviteId)
        assertTrue(client.coInvites(garage, "bright-maple--plants").invites.isEmpty())
    }

    @Test fun groupInviteCarriesItsLimits() = runBlocking {
        val garage = entry("Garage")
        val now = 1_792_000_000_000L
        val group = ShareCoInviteGroup.fromForm("10", "30", now)
        assertEquals(ShareCoInviteGroup(10, now + 30 * 86_400_000L), group)
        assertEquals(ShareCoInviteGroup(10), ShareCoInviteGroup.fromForm("x", "", now))
        assertEquals(ShareCoInviteGroup(0), ShareCoInviteGroup.fromForm("0", "0", now))
        client.createCoInvite(garage, "bright-maple--plants", MockServerShares.OWNER_AID, "Chess club", ShareCoInviteGroup(10, null))
        val inv = client.coInvites(garage, "bright-maple--plants").invites.single()
        assertEquals("Chess club", inv.name)
        assertEquals(10, inv.maxRedemptions)
        assertEquals("0 of 10 joined", ShareCoInviteCopy.statusText(inv))
    }

    @Test fun demotedShowsTheBoxSentenceAndRefusesCreate() = runBlocking {
        val garage = entry("Garage")
        val state = client.coInvites(garage, "bright-maple--wiki")
        assertFalse(state.canInvite)
        assertEquals("An admin made you a Member of this app, so you can't invite people to it.", state.whyText)
        assertEquals("Jo", state.invites.single().displayName)
        assertEquals("1 person joined", ShareCoInviteCopy.statusText(state.invites.single()))
        try {
            client.createCoInvite(garage, "bright-maple--wiki", MockServerShares.OWNER_AID, "Sam")
            fail("a demoted co-manager can't invite")
        } catch (e: ShareInviteRefusal) {
            assertEquals("demoted", e.code)
            assertEquals("An admin made you a Member of this app, so you can't invite people to it.", e.message)
        }
    }

    @Test fun viewOnlyCantInvite() = runBlocking {
        val cabin = entry("Cabin")
        val state = client.coInvites(cabin, "bright-maple--plants")
        assertFalse(state.canInvite)
        assertEquals(ShareCoInviteCopy.VIEW_ONLY, state.whyText)
    }

    @Test fun refusalWording() = runBlocking {
        assertEquals("Couldn't create the invite. Try again.",
            ShareInviteRefusal.text("invalid-signature", "invalid-signature", ShareCoInviteCopy.CREATE_FAILED))
        assertEquals("Couldn't create the invite. Try again.",
            ShareInviteRefusal.text("malformed", "bad", ShareCoInviteCopy.CREATE_FAILED))
        assertEquals("You have 200 open invites.",
            ShareInviteRefusal.text("too-many-invites", "You have 200 open invites.", ShareCoInviteCopy.CREATE_FAILED))
        assertEquals("Couldn't withdraw the invite. Try again.",
            ShareInviteRefusal.text(null, "boom", ShareCoInviteCopy.WITHDRAW_FAILED))
        val garage = entry("Garage")
        try {
            client.createCoInvite(garage, "bright-maple--plants", MockServerShares.OWNER_AID, " ")
            fail("needs a name")
        } catch (e: ShareInviteRefusal) { assertEquals("Give them a name.", e.message) }
        try {
            client.createCoInvite(garage, "bright-maple--plants", MockServerShares.OWNER_AID, "", ShareCoInviteGroup(1))
            fail("needs a name")
        } catch (e: ShareInviteRefusal) { assertEquals("Give the group a name.", e.message) }
        try {
            client.withdrawCoInvite(garage, "ee".repeat(32))
            fail("not one of mine")
        } catch (e: ShareInviteRefusal) {
            assertEquals("not-yours", e.code)
            assertEquals("That isn't one of your invites.", e.message)
        }
    }

    @Test fun statusText() {
        val now = 1_000L
        fun inv(j: Int, max: Int? = null, exp: Long? = null) = ShareCoInvite("x", null, joined = j, maxRedemptions = max, expiresAt = exp)
        assertEquals("Not opened yet", ShareCoInviteCopy.statusText(inv(0), now))
        assertEquals("1 person joined", ShareCoInviteCopy.statusText(inv(1), now))
        assertEquals("4 people joined", ShareCoInviteCopy.statusText(inv(4), now))
        assertEquals("3 joined", ShareCoInviteCopy.statusText(inv(3, 0), now))
        assertEquals("3 of 10 joined", ShareCoInviteCopy.statusText(inv(3, 10, now + 1), now))
        assertEquals("Not opened yet · expired", ShareCoInviteCopy.statusText(inv(0, null, now), now))
        assertEquals("The link stops working, and anyone who joined through it loses access to Chess.",
            ShareCoInviteCopy.withdrawMessage("Chess"))
    }

    @Test fun viewModelCreatesListsAndWithdraws() = runBlocking {
        val vm = CoInviteViewModel(client, entry("Garage"), "bright-maple--plants", "Plants")
        vm.toggle()
        assertEquals(true, vm.ui.value.state?.canInvite)
        vm.startAdding(CoInviteUi.Kind.Person)
        assertFalse(vm.create(""))
        assertEquals("Give them a name.", vm.ui.value.error)
        assertTrue(vm.create("Alex"))
        assertNull(vm.ui.value.adding)
        assertTrue(vm.ui.value.lastLink!!.contains("/invite#"))
        assertEquals(listOf("Alex"), vm.ui.value.state!!.invites.map { it.displayName })
        assertTrue(vm.withdraw(vm.ui.value.state!!.invites.single().inviteId))
        assertTrue(vm.ui.value.state!!.invites.isEmpty())
        vm.toggle()
        assertFalse(vm.ui.value.open)
    }

    @Test fun ownerSideNamesCoManagersInvites() {
        assertEquals("Invited by Sam (co-manager)", ServiceAccessViewModel.coManagerInvitedBy("Sam"))
        assertEquals("Invited by a co-manager", ServiceAccessViewModel.coManagerInvitedBy(null))
        assertEquals("Someone they invited", ServiceAccessViewModel.CO_MANAGERS_INVITEE)
        val body = """{"serviceId":"a--b","mode":"members-only","defaultRole":"member","members":[],"invites":[{"inviteId":"i1","role":"member","tier":"co-manager","creatorPub":"${"eb".repeat(32)}","creatorShareId":"${"0f".repeat(16)}","creatorLabel":"Sam"}]}"""
        val members = ServerShareClient.json.decodeFromString(com.flagshipserver.app.api.AppMembersResponse.serializer(), body)
        assertEquals("co-manager", members.inviteTier("i1"))
        assertEquals("Sam", members.invite("i1")?.creatorLabel)
        assertEquals("0f".repeat(16), members.invite("i1")?.creatorShareId)
    }
}
