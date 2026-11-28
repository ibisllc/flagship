package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.OrgClient
import com.flagshipserver.app.core.pq.OrgAuthorityWire
import com.flagshipserver.app.core.pq.OrgSeatRole
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OrgJoinViewModelTest {
    private val memberRoles = buildJsonArray { add(buildJsonObject { put("role", "member") }) }
    private val umk = ByteArray(32) { 7 }

    private fun joiner(w: OrgTestWorld, seat: String, key: String, keys: FakeOrgSeats = FakeOrgSeats()) =
        OrgJoinViewModel(w.orgId, seat, key, OrgClient(w.http), keys, { umk.copyOf() }, { w.now })

    @Test fun joinShowsTheSameCodeTheAdminSeesAndTheAdmitVerifies() = runTest {
        val w = OrgTestWorld()
        val seat = OrgTestWorld.hex(16)
        val key = w.invite(seat, listOf(OrgSeatRole.Member), memberRoles, "Pat")
        val mine = FakeOrgSeats()
        val vm = joiner(w, seat, key, mine)
        vm.load()
        val ready = vm.phase.value as OrgJoinViewModel.Phase.Ready
        assertEquals("acme", ready.orgName)
        assertEquals("Pat", ready.pseudonym)
        assertEquals(false, ready.isAdminRole)

        vm.accept()
        val code = (vm.phase.value as OrgJoinViewModel.Phase.Accepted).code
        assertEquals(1, w.accepts.size)
        assertTrue(mine.seats().single().memberOnly)

        val admin = OrgViewModel(OrgClient(w.http), w.founderSeats, { umk.copyOf() }, { w.now })
        admin.load(w.founder)
        val waiting = admin.pendingJoins.value.single()
        assertEquals(code.replace(" ", ""), waiting.sas)

        admin.admit(w.founder, waiting)
        assertEquals(1, w.grants.size)
        val snap = OrgClient(w.http).snapshot(w.orgId, w.genesisHash, w.now)
        assertTrue(snap.book.seats.containsKey(seat))
        assertTrue(admin.pendingJoins.value.isEmpty())
    }

    @Test fun anAdminRoleMakesAnAdminKeyAndNeedsTheThresholdOfOneAdminHere() = runTest {
        val w = OrgTestWorld()
        val seat = OrgTestWorld.hex(16)
        val roles = buildJsonArray { add(buildJsonObject { put("role", "server-admin"); put("servers", buildJsonArray { add(JsonPrimitive("home.acme.flagship.services")) }) }) }
        val key = w.invite(seat, OrgAuthorityWire.roles(roles), roles)
        val mine = FakeOrgSeats()
        val vm = joiner(w, seat, key, mine)
        vm.load()
        assertEquals(true, (vm.phase.value as OrgJoinViewModel.Phase.Ready).isAdminRole)
        vm.accept()
        assertTrue(vm.phase.value is OrgJoinViewModel.Phase.Accepted)
        assertEquals(false, mine.seats().single().memberOnly)
        // One org admin: the grant threshold for an admin role is min(2, admins) = 1.
        val admin = OrgViewModel(OrgClient(w.http), w.founderSeats, { umk.copyOf() }, { w.now })
        admin.load(w.founder)
        admin.admit(w.founder, admin.pendingJoins.value.single())
        val snap = OrgClient(w.http).snapshot(w.orgId, w.genesisHash, w.now)
        assertTrue(snap.book.seats[seat]?.admin != null)
    }

    @Test fun anExpiredInvitationSaysSo() = runTest {
        val w = OrgTestWorld()
        val seat = OrgTestWorld.hex(16)
        val key = w.invite(seat, listOf(OrgSeatRole.Member), memberRoles)
        w.inviteExpired = true
        val vm = joiner(w, seat, key)
        vm.load()
        assertTrue(vm.phase.value is OrgJoinViewModel.Phase.Failed)
    }

    @Test fun aWrongLinkKeyOpensNothing() = runTest {
        val w = OrgTestWorld()
        val seat = OrgTestWorld.hex(16)
        w.invite(seat, listOf(OrgSeatRole.Member), memberRoles)
        val vm = joiner(w, seat, OrgTestWorld.hex(32))
        vm.load()
        assertTrue(vm.phase.value is OrgJoinViewModel.Phase.Failed)
        assertTrue(w.accepts.isEmpty())
    }

    @Test fun anAcceptServedWithoutTheInviteKeysSignatureIsNotOfferedToAdmit() = runTest {
        val w = OrgTestWorld()
        val seat = OrgTestWorld.hex(16)
        val key = w.invite(seat, listOf(OrgSeatRole.Member), memberRoles)
        joiner(w, seat, key).apply { load(); accept() }
        // `.com` (or a squatter it let through) serves the accept with its invite-key signature dropped or another accept's.
        val a = w.accepts.single()
        w.accepts[0] = kotlinx.serialization.json.JsonObject(a - "inviteSignature")
        val admin = OrgViewModel(OrgClient(w.http), w.founderSeats, { umk.copyOf() }, { w.now })
        admin.load(w.founder)
        assertTrue(admin.pendingJoins.value.isEmpty())
        w.accepts[0] = a
        admin.load(w.founder)
        assertEquals(1, admin.pendingJoins.value.size)
    }

    @Test fun anAdminWithdrawsAnInvitationWhoseCodesDidNotMatch() = runTest {
        val w = OrgTestWorld()
        val seat = OrgTestWorld.hex(16)
        val pending = OrgTestWorld.hex(16)
        val key = w.invite(seat, listOf(OrgSeatRole.Member), memberRoles)
        w.invite(pending, listOf(OrgSeatRole.Member), memberRoles, "Sam")
        joiner(w, seat, key).apply { load(); accept() }
        val admin = OrgViewModel(OrgClient(w.http), w.founderSeats, { umk.copyOf() }, { w.now })
        admin.load(w.founder)
        assertEquals(listOf(pending), admin.pendingInvites.value)
        admin.withdrawInvite(w.founder, seat)
        val order = w.withdrawn.single()
        val body = order["withdraw"] as kotlinx.serialization.json.JsonObject
        assertEquals(seat, (body["seatId"] as JsonPrimitive).content)
        val approval = OrgAuthorityWire.approval((order["approvals"] as kotlinx.serialization.json.JsonArray).single())
        val canonical = com.flagshipserver.app.core.pq.OrgAuthority.canonicalInviteWithdraw(w.orgId, seat, 0, w.now)
        assertEquals(com.flagshipserver.app.core.pq.OrgAuthority.sha256Hex(canonical), approval.orderSha256)
        assertTrue(admin.pendingJoins.value.isEmpty())
        // The withdrawn link reads as no invitation.
        val again = joiner(w, seat, key)
        again.load()
        assertTrue(again.phase.value is OrgJoinViewModel.Phase.Failed)
    }

    @Test fun aChainThatDoesNotMatchTheOfferedGenesisIsRefused() = runTest {
        val w = OrgTestWorld()
        val seat = OrgTestWorld.hex(16)
        val key = w.invite(seat, listOf(OrgSeatRole.Member), memberRoles)
        // `.com` serves another org's chain under this id.
        val other = OrgTestWorld()
        w.entries.clear(); w.entries.addAll(other.entries)
        val vm = joiner(w, seat, key)
        vm.load()
        assertTrue(vm.phase.value is OrgJoinViewModel.Phase.Failed)
    }

    @Test fun aLockedSessionCannotAdmit() = runTest {
        val w = OrgTestWorld()
        val seat = OrgTestWorld.hex(16)
        val key = w.invite(seat, listOf(OrgSeatRole.Member), memberRoles)
        joiner(w, seat, key).apply { load(); accept() }
        w.founderSeats.locked = true
        val admin = OrgViewModel(OrgClient(w.http), w.founderSeats, { umk.copyOf() }, { w.now })
        admin.load(w.founder)
        admin.admit(w.founder, admin.pendingJoins.value.single())
        assertTrue(w.grants.isEmpty())
        assertTrue(admin.message.value != null)
    }
}
