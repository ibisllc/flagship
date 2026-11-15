package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.OrgClient
import com.flagshipserver.app.core.OrgJson
import com.flagshipserver.app.core.memberKey
import com.flagshipserver.app.core.pq.OrgAuthority
import com.flagshipserver.app.core.pq.OrgAuthorityWire
import com.flagshipserver.app.core.pq.OrgKeyKind
import com.flagshipserver.app.core.pq.OrgRotation
import com.flagshipserver.app.core.pq.OrgSeatRevokeBundle
import com.flagshipserver.app.core.pq.OrgServers
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import com.google.crypto.tink.subtle.Ed25519Sign
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

/**
 * "Rotate keys" after a server admin leaves: the departed seat shows as pending on the admin's
 * phone (computed here, not taken from `.com`), Rotate seals a fresh version to the box and this
 * phone only, names the departed seat as retired, and the pending entry is gone afterwards.
 */
class OrgRotateViewModelTest {
    private val domain = "home.acme.flagship.services"
    private val umkX = ByteArray(32) { 9 }
    private val umkFounder = ByteArray(32) { 5 }

    private suspend fun world(): Pair<OrgTestWorld, String> {
        val w = OrgTestWorld()
        // The org's one server and its KEM key, signed by its STK.
        val stkSeed = ByteArray(32) { 4 }
        val stkPub = Ed25519Sign.KeyPair.newKeyPairFromSeed(stkSeed).publicKey
        w.servers += buildJsonObject { put("serverDomain", domain); put("identityPubKeyHex", PqHex.encode(stkPub)) }
        val boxKem = PqHybrid.hybridSealKeygen(ByteArray(32) { 8 })
        val boxKemId = OrgServers.kemKeyIdHex(boxKem.publicKey)
        val bt = w.now - 50_000
        w.boxKems += buildJsonObject {
            put("statement", buildJsonObject { put("orgId", w.orgId); put("serverDomain", domain); put("kemKeyId", boxKemId); put("issuedAt", bt) })
            put("kemPubHex", PqHex.encode(boxKem.publicKey))
            put("signature", PqHex.encode(Ed25519Sign(stkSeed).sign(OrgServers.canonicalBoxKem(w.orgId, domain, boxKemId, bt))))
        }
        // Seat X: a server admin of the box, admitted through the join flow.
        val x = OrgTestWorld.hex(16)
        val roles = buildJsonArray { add(buildJsonObject { put("role", "server-admin"); put("servers", buildJsonArray { add(JsonPrimitive(domain)) }) }) }
        val key = w.invite(x, OrgAuthorityWire.roles(roles), roles)
        OrgJoinViewModel(w.orgId, x, key, OrgClient(w.http), FakeOrgSeats(), { umkX.copyOf() }, { w.now }).apply { load(); accept() }
        val admin = OrgViewModel(OrgClient(w.http), w.founderSeats, { umkFounder.copyOf() }, { w.now })
        admin.load(w.founder)
        admin.admit(w.founder, admin.pendingJoins.value.single())
        // X announces its KEM key (signed by its member key), and gets version 1 of the box's backup keys.
        val kt = w.now - 40_000
        val xKem = PqHybrid.hybridSealKeygen(OrgServers.seatKemSeed(umkX, w.orgId))
        val xKemId = OrgServers.kemKeyIdHex(xKem.publicKey)
        val (_, xSecret) = OrgAuthority.memberKey(umkX, w.orgId, x, kt)
        w.seatKems += buildJsonObject {
            put("statement", buildJsonObject { put("orgId", w.orgId); put("seatId", x); put("kemKeyId", xKemId); put("issuedAt", kt) })
            put("kemPubHex", PqHex.encode(xKem.publicKey))
            put("signature", PqHex.encode(PqHybrid.hybridSign(xSecret, OrgServers.TAG_SEAT_KEM, OrgServers.canonicalSeatKem(w.orgId, x, xKemId, kt))))
        }
        val snap = OrgClient(w.http).snapshot(w.orgId, w.genesisHash, w.now - 30_000)
        val plan = OrgClient(w.http).rotationPlan(snap, w.now - 30_000)
        val v1 = OrgRotation.rotate(plan, OrgKeyKind.ARCHIVE_KEYS, domain, w.now - 30_000, ByteArray(32) { 1 }) { order, oar ->
            OrgAuthority.signApproval(w.orgId, oar, order, w.founderSeat, w.founder.keyId, w.now - 30_000, w.now + 86_400_000) { p, m -> w.founderSeats.sign(w.founder, p, m)!! }
        }
        assertTrue(v1.recipients.any { it.recipient == "seat:$x" })
        assertTrue(v1.recipients.any { it.recipient == "box:$domain" })
        w.rings += OrgRotation.bundleJson(v1)
        // X is removed.
        val rt = w.now - 20_000
        val unsigned = OrgSeatRevokeBundle(w.orgId, x, "removed", 0, rt, emptyList(), null)
        val a = OrgAuthority.signApproval(w.orgId, 0, OrgAuthority.canonical(unsigned), w.founderSeat, w.founder.keyId, rt, rt + 86_400_000) { p, m -> w.founderSeats.sign(w.founder, p, m)!! }
        w.revokes += buildJsonObject {
            put("revoke", buildJsonObject { put("orgId", w.orgId); put("seatId", x); put("reason", "removed"); put("oarVersion", 0); put("issuedAt", rt) })
            put("approvals", buildJsonArray { add(OrgJson.approval(a)) })
        }
        return w to x
    }

    @Test fun rotateAnswersTheDepartedSeat() = runTest {
        val (w, x) = world()
        val vm = OrgViewModel(OrgClient(w.http), w.founderSeats, { umkFounder.copyOf() }, { w.now })
        vm.load(w.founder)
        val pending = vm.rotations.value.single()
        assertEquals(x, pending.seatId)
        assertEquals(listOf(OrgKeyKind.ARCHIVE_KEYS to domain), pending.keys)

        vm.rotate(w.founder, pending)
        assertEquals(1, w.seatKems.count { (it["statement"] as JsonObject)["seatId"] == JsonPrimitive(w.founderSeat) })
        assertEquals(2, w.rings.size)
        val v2 = OrgRotation.bundle(w.rings.last())
        assertEquals(2L, v2.ring.version)
        assertEquals(listOf(x), v2.ring.retired)
        assertFalse(v2.recipients.any { it.recipient == "seat:$x" })
        assertTrue(v2.recipients.any { it.recipient == "seat:${w.founderSeat}" })
        assertTrue(v2.recipients.any { it.recipient == "box:$domain" })
        assertTrue(vm.rotations.value.isEmpty())
        // The box opens the new version and it matches the commitment.
        val box = PqHybrid.hybridSealKeygen(ByteArray(32) { 8 })
        assertEquals(32, OrgServers.openKeyRing(v2.ring, v2.recipients, "box:$domain", box.secretKey).size)
    }

    @Test fun aServedKemKeyThatNoSeatSignedIsNeverARecipient() = runTest {
        val (w, _) = world()
        val stranger = OrgTestWorld.hex(16)
        val k = PqHybrid.hybridSealKeygen(ByteArray(32) { 3 })
        val id = OrgServers.kemKeyIdHex(k.publicKey)
        w.seatKems += buildJsonObject {
            put("statement", buildJsonObject { put("orgId", w.orgId); put("seatId", stranger); put("kemKeyId", id); put("issuedAt", w.now - 1000) })
            put("kemPubHex", PqHex.encode(k.publicKey)); put("signature", "00".repeat(PqHybrid.HYBRID_SIG_LEN))
        }
        val vm = OrgViewModel(OrgClient(w.http), w.founderSeats, { umkFounder.copyOf() }, { w.now })
        vm.load(w.founder)
        vm.rotate(w.founder, vm.rotations.value.single())
        assertFalse(OrgRotation.bundle(w.rings.last()).recipients.any { it.recipient == "seat:$stranger" })
    }

    @Test fun aLockedSessionRotatesNothing() = runTest {
        val (w, _) = world()
        w.founderSeats.locked = true
        val vm = OrgViewModel(OrgClient(w.http), w.founderSeats, { umkFounder.copyOf() }, { w.now })
        vm.load(w.founder)
        vm.rotate(w.founder, vm.rotations.value.single())
        assertEquals(1, w.rings.size)
        assertTrue(vm.message.value != null)
    }
}
