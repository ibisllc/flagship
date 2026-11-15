package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.OrgClient
import com.flagshipserver.app.core.pq.OrgAuthority
import com.flagshipserver.app.core.pq.OrgAuthorityWire
import com.flagshipserver.app.core.pq.OrgRotation
import com.flagshipserver.app.core.pq.OrgSeatRole
import com.flagshipserver.app.core.pq.OrgServers
import com.flagshipserver.app.core.pq.PqHybrid
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The org directory on Android (docs/org-directory.md §2) and the create, invite and freeze screens'
// view model (matching iOS): pseudonyms replace "Seat <id>", `.com` never stores a name unsealed, a
// joining seat's KEM key rides with its accept.
class OrgDirectoryViewModelTest {
    private val umk = ByteArray(32) { 7 }
    private val memberRoles = buildJsonArray { add(buildJsonObject { put("role", "member") }) }
    private fun admin(w: OrgTestWorld) = OrgViewModel(OrgClient(w.http), w.founderSeats, { umk.copyOf() }, { w.now })

    @Test fun adminsSeeThePseudonymTheInviterChoseAndComSeesNoName() = runTest {
        val w = OrgTestWorld()
        val a = admin(w)
        a.load(w.founder)
        a.invite(w.founder, "Ana Pérez", OrgViewModel.InviteRole.MEMBER, "")
        val link = a.inviteLink.value!!
        val parts = link.substringAfter('#').split('&').associate { it.substringBefore('=') to it.substringAfter('=') }
        val seat = parts["s"]!!
        OrgJoinViewModel(w.orgId, seat, parts["k"]!!, OrgClient(w.http), FakeOrgSeats(), { umk.copyOf() }, { w.now }).apply { load(); accept() }
        val b = admin(w)
        b.load(w.founder)
        assertEquals(seat, b.pendingJoins.value.single().seatId)
        assertEquals("Ana Pérez", b.name(w.founder, seat))
        assertEquals(1, w.directory.size)
        assertFalse(w.directory.values.toString().contains("Ana"))
    }

    @Test fun theAcceptCarriesTheSeatsKemKeySignedByItsMemberKey() = runTest {
        val w = OrgTestWorld()
        val seat = OrgTestWorld.hex(16)
        val key = w.invite(seat, listOf(OrgSeatRole.Member), memberRoles)
        OrgJoinViewModel(w.orgId, seat, key, OrgClient(w.http), FakeOrgSeats(), { umk.copyOf() }, { w.now }).apply { load(); accept() }
        val a = admin(w)
        a.load(w.founder)
        a.admit(w.founder, a.pendingJoins.value.single())
        val k = w.accepts.single()["seatKem"] as JsonObject
        val snap = OrgClient(w.http).snapshot(w.orgId, w.genesisHash, w.now)
        val v = OrgRotation.verifySeatKem(snap.state, snap.book, k["statement"] as JsonObject, (k["kemPubHex"] as JsonPrimitive).content,
            (k["signature"] as JsonPrimitive).content, w.now)
        assertEquals(OrgServers.kemKeyIdHex(PqHybrid.hybridSealKeygen(OrgServers.seatKemSeed(umk, w.orgId)).publicKey), v.kemKeyId)
    }

    @Test fun createMakesAGenesisThatVerifiesFromItsOwnHash() = runTest {
        val w = OrgTestWorld()
        val seats = FakeOrgSeats()
        val vm = OrgViewModel(OrgClient(w.http), seats, { umk.copyOf() }, { w.now })
        assertTrue(vm.create(" Beta "))
        val body = w.created.single()
        assertEquals("beta", (body["name"] as JsonPrimitive).content)
        val entry = OrgAuthorityWire.entry(body["entry"])
        val mine = seats.seats().single()
        val st = OrgAuthority.verifyChain(listOf(entry), mine.genesisHash, w.now, emptyList(), emptyList(), emptyList())
        assertEquals(mine.seatId, st.current.founderSeatId)
    }

    @Test fun freezeSignsAFreezeOfTheTargetFor72Hours() = runTest {
        val w = OrgTestWorld()
        val a = admin(w)
        a.load(w.founder)
        val target = OrgTestWorld.hex(16)
        a.freeze(w.founder, target)
        val f = OrgAuthorityWire.freeze(w.freezes.single())
        assertEquals(target, f.body.seatId)
        assertEquals(72 * 3_600_000L, f.body.untilMs - f.body.issuedAt)
        assertEquals(OrgAuthority.sha256Hex(OrgAuthority.canonical(f.body)), f.approvals.single().orderSha256)
    }
}
