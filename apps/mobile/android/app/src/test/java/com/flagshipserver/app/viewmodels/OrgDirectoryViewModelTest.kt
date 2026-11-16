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
import com.flagshipserver.app.core.pq.OrgConnector
import com.flagshipserver.app.core.pq.OrgConnectorConsole
import com.flagshipserver.app.core.pq.OrgConnectors
import com.flagshipserver.app.core.pq.OrgDirectory
import com.flagshipserver.app.core.pq.OrgDirectoryEntry
import com.flagshipserver.app.core.pq.OrgProposal
import com.flagshipserver.app.core.pq.PqHex
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.Json

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

    private val domain = "home.acme.flagship.services"

    @Test fun aProposalOpensAndApprovingItMakesTheInvitation() = runTest {
        val w = OrgTestWorld()
        val a = admin(w)
        a.load(w.founder)
        val conn = PqHybrid.hybridSigKeygen(ByteArray(32) { 0x61 }, ByteArray(32) { 0x62 })
        val c = OrgConnector(w.orgId, OrgTestWorld.hex(16), "scim", domain, OrgConnectors.connectorKeyId(conn.publicKey), OrgConnectors.SCOPES, "ab".repeat(32), "active", w.now - 1000)
        w.connectors += buildJsonObject { put("connector", OrgConnectorConsole.json(c)); put("connectorPubHex", PqHex.encode(conn.publicKey)); put("approvals", JsonArray(emptyList())) }
        val kem = PqHybrid.hybridSealKeygen(OrgServers.seatKemSeed(umk, w.orgId))
        val pending = OrgTestWorld.hex(16)
        val proposalId = OrgTestWorld.hex(16)
        val t = w.now - 500
        val body = OrgDirectory.canonicalBody(OrgDirectoryEntry(seatId = "", pendingId = pending, pseudonym = "Ben Okafor", email = "ben@acme.example", source = "scim", updatedAt = t))
        val recipient = "seat:${w.founderSeat}"
        val sealed = PqHybrid.hybridSeal(kem.publicKey, PqHybrid.HybridSealOptions(purpose = OrgConnectors.TAG_PROPOSAL, senderKeyId = ByteArray(32), issuedAt = t),
            listOf(w.orgId, proposalId, recipient).map { it.toByteArray() }, body)
        val recipients = listOf(Triple(recipient, OrgServers.kemKeyIdHex(kem.publicKey), PqHex.encode(sealed)))
        val roles = listOf(OrgSeatRole.Member)
        val prop = OrgProposal(w.orgId, proposalId, c.connectorId, "invite", pending, OrgAuthority.rolesHash(roles), OrgConnectors.recipientsHash(recipients), t)
        val sig = PqHybrid.hybridSign(conn.secretKey, OrgConnectors.TAG_PROPOSAL, OrgConnectors.canonical(prop))
        fun bundle(subject: String) = buildJsonObject {
            put("proposal", buildJsonObject {
                put("orgId", prop.orgId); put("proposalId", prop.proposalId); put("connectorId", prop.connectorId); put("kind", prop.kind)
                put("subject", subject); put("rolesHash", prop.rolesHash); put("sealedSha256", prop.sealedSha256); put("issuedAt", t)
            })
            put("roles", buildJsonArray { add(buildJsonObject { put("role", "member") }) })
            put("recipients", JsonArray(recipients.map { (r, k, h) -> buildJsonObject { put("recipient", r); put("kemKeyId", k); put("sealedHex", h) } }))
            put("signature", PqHex.encode(sig))
        }
        w.proposals += buildJsonObject { put("bundle", bundle(pending)); put("decision", JsonNull) }
        a.load(w.founder)
        val p = a.proposals.value.single()
        assertEquals("Ben Okafor", p.entry.pseudonym)
        a.approveProposal(w.founder, p)
        assertTrue(a.inviteLink.value != null)
        val d = w.decisions.single()["decision"] as JsonObject
        assertEquals("done", (d["decision"] as JsonPrimitive).content)
        val inv = w.invites.values.single()["invite"] as JsonObject
        val seat = (inv["seatId"] as JsonPrimitive).content
        assertEquals("Ben Okafor", a.name(w.founder, seat))
        assertTrue(a.proposals.value.isEmpty())
        // Changed after the connector signed it: not shown.
        w.proposals.clear(); w.proposals += buildJsonObject { put("bundle", bundle(OrgTestWorld.hex(16))); put("decision", JsonNull) }
        a.load(w.founder)
        assertTrue(a.proposals.value.isEmpty())
    }

    @Test fun addingAScimConnectorSealsItsSetupToTheServerAndShowsTheTokenOnce() = runTest {
        val w = OrgTestWorld()
        val stkSeed = ByteArray(32) { 4 }
        val stkPub = Ed25519Sign.KeyPair.newKeyPairFromSeed(stkSeed).publicKey
        w.servers += buildJsonObject { put("serverDomain", domain); put("identityPubKeyHex", PqHex.encode(stkPub)) }
        val box = PqHybrid.hybridSealKeygen(ByteArray(32) { 8 })
        val boxId = OrgServers.kemKeyIdHex(box.publicKey)
        val bt = w.now - 50_000
        w.boxKems += buildJsonObject {
            put("statement", buildJsonObject { put("orgId", w.orgId); put("serverDomain", domain); put("kemKeyId", boxId); put("issuedAt", bt) })
            put("kemPubHex", PqHex.encode(box.publicKey))
            put("signature", PqHex.encode(Ed25519Sign(stkSeed).sign(OrgServers.canonicalBoxKem(w.orgId, domain, boxId, bt))))
        }
        val a = admin(w)
        a.load(w.founder)
        assertEquals(listOf(domain), a.servers())
        a.addScimConnector(w.founder, domain)
        val (url, token) = a.newConnector.value!!
        assertEquals("https://$domain/scim/v2", url)
        val posted = w.connectors.single()
        val c = OrgConnectors.connector(posted["connector"] as JsonObject)
        val setup = posted["setup"] as JsonObject
        val plain = PqHybrid.hybridOpen(box.secretKey, OrgConnectors.TAG_CONNECTOR, listOf(w.orgId, c.connectorId, domain).map { it.toByteArray() },
            PqHex.decode((setup["sealedHex"] as JsonPrimitive).content)!!).plaintext
        val o = Json.parseToJsonElement(String(plain)) as JsonObject
        assertEquals(OrgAuthority.sha256Hex(token.toByteArray()), (o["scimTokenSha256"] as JsonPrimitive).content)
        assertEquals(c.mappingSha256, OrgConnectorConsole.mappingSha256(o["mapping"] as JsonObject))
        assertFalse(posted.toString().contains(token))
    }

    private suspend fun memberJoined(w: OrgTestWorld, a: OrgViewModel, umkM: ByteArray): Pair<String, FakeOrgSeats> {
        val seat = OrgTestWorld.hex(16)
        val key = w.invite(seat, listOf(OrgSeatRole.Member), memberRoles, "Mia")
        val mine = FakeOrgSeats()
        OrgJoinViewModel(w.orgId, seat, key, OrgClient(w.http), mine, { umkM.copyOf() }, { w.now }).apply { load(); accept() }
        a.load(w.founder)
        a.admit(w.founder, a.pendingJoins.value.single())
        return seat to mine
    }

    private fun withServer(w: OrgTestWorld) {
        val stkSeed = ByteArray(32) { 4 }
        val stkPub = Ed25519Sign.KeyPair.newKeyPairFromSeed(stkSeed).publicKey
        w.servers += buildJsonObject { put("serverDomain", domain); put("identityPubKeyHex", PqHex.encode(stkPub)) }
        val box = PqHybrid.hybridSealKeygen(ByteArray(32) { 8 })
        val boxId = OrgServers.kemKeyIdHex(box.publicKey)
        val bt = w.now - 50_000
        w.boxKems += buildJsonObject {
            put("statement", buildJsonObject { put("orgId", w.orgId); put("serverDomain", domain); put("kemKeyId", boxId); put("issuedAt", bt) })
            put("kemPubHex", PqHex.encode(box.publicKey))
            put("signature", PqHex.encode(Ed25519Sign(stkSeed).sign(OrgServers.canonicalBoxKem(w.orgId, domain, boxId, bt))))
        }
    }

    private fun openSetup(w: OrgTestWorld, posted: JsonObject): JsonObject {
        val c = OrgConnectors.connector(posted["connector"] as JsonObject)
        val box = PqHybrid.hybridSealKeygen(ByteArray(32) { 8 })
        val plain = PqHybrid.hybridOpen(box.secretKey, OrgConnectors.TAG_CONNECTOR, listOf(w.orgId, c.connectorId, domain).map { it.toByteArray() },
            PqHex.decode(((posted["setup"] as JsonObject)["sealedHex"] as JsonPrimitive).content)!!).plaintext
        return Json.parseToJsonElement(String(plain)) as JsonObject
    }

    @Test fun aMemberSeesOnlyThePeopleItSharesWith() = runTest {
        val w = OrgTestWorld()
        val a = admin(w)
        a.load(w.founder)
        a.recordEntry(w.founder, OrgDirectoryEntry(seatId = w.founderSeat, pseudonym = "Fay", email = "fay@acme.example", updatedAt = w.now))
        val umkM = ByteArray(32) { 3 }
        val (seat, mine) = memberJoined(w, a, umkM)
        a.load(w.founder)
        val stored = w.slices[seat]!!
        assertFalse(stored.toString().contains("Fay"))
        val m = OrgViewModel(OrgClient(w.http), mine, { umkM.copyOf() }, { w.now })
        val ms = mine.seats().single()
        m.load(ms)
        assertFalse(m.isOrgAdmin(ms))
        assertEquals(listOf("Fay"), m.sharedWith.value!!.entries.map { it.pseudonym })
        assertEquals("", m.sharedWith.value!!.entries.single().email)
        // Without an org admin's approval it is not shown.
        w.slices[seat] = JsonObject(stored + ("approvals" to JsonArray(emptyList())))
        m.load(ms)
        assertTrue(m.sharedWith.value == null)
    }

    @Test fun pauseRotateMappingAndLdap() = runTest {
        val w = OrgTestWorld()
        withServer(w)
        val a = admin(w)
        a.load(w.founder)
        a.addScimConnector(w.founder, domain)
        val id = OrgConnectors.connector(w.connectors.last()["connector"] as JsonObject).connectorId
        assertTrue(w.connectors.last()["mappingSealed"] != null)
        a.clearNewConnector()
        a.load(w.founder)
        a.rotateScimToken(w.founder, id)
        val token = a.newConnector.value!!.second
        val rotated = openSetup(w, w.connectors.last())
        assertTrue(rotated["connectorSeedsHex"] == null)
        assertEquals(OrgAuthority.sha256Hex(token.toByteArray()), (rotated["scimTokenSha256"] as JsonPrimitive).content)
        a.load(w.founder)
        a.setConnectorStatus(w.founder, id, "paused")
        assertEquals("paused", OrgConnectors.connector(w.connectors.last()["connector"] as JsonObject).status)
        a.load(w.founder)
        a.saveMapping(w.founder, id, listOf(OrgViewModel.MappingRow("Finance", OrgViewModel.InviteRole.SERVER_ADMIN, domain)), false)
        val saved = w.connectors.last()
        val mapping = openSetup(w, saved)["mapping"] as JsonObject
        assertEquals(OrgConnectors.connector(saved["connector"] as JsonObject).mappingSha256, OrgConnectorConsole.mappingSha256(mapping))
        a.load(w.founder)
        assertEquals(listOf("Finance"), a.mappingRows(id).first.map { it.group })
        a.saveLdapConnector(w.founder, domain, OrgViewModel.LdapForm("ldaps://dc1.acme.example", "CN=svc,DC=acme,DC=example", "s3cret", "DC=acme,DC=example"))
        val ldap = w.connectors.last()
        assertEquals("ldap", OrgConnectors.connector(ldap["connector"] as JsonObject).kind)
        assertEquals("s3cret", ((openSetup(w, ldap)["ldap"] as JsonObject)["bindPassword"] as JsonPrimitive).content)
        assertFalse(ldap.toString().contains("s3cret"))
    }

    @Test fun aRoleChangeProposalIsCarriedOutWithANewGrant() = runTest {
        val w = OrgTestWorld()
        val a = admin(w)
        a.load(w.founder)
        val (seat, _) = memberJoined(w, a, ByteArray(32) { 3 })
        val conn = PqHybrid.hybridSigKeygen(ByteArray(32) { 0x61 }, ByteArray(32) { 0x62 })
        val c = OrgConnector(w.orgId, OrgTestWorld.hex(16), "scim", domain, OrgConnectors.connectorKeyId(conn.publicKey), OrgConnectors.SCOPES, "ab".repeat(32), "active", w.now - 1000)
        w.connectors += buildJsonObject { put("connector", OrgConnectorConsole.json(c)); put("connectorPubHex", PqHex.encode(conn.publicKey)); put("approvals", JsonArray(emptyList())) }
        val kem = PqHybrid.hybridSealKeygen(OrgServers.seatKemSeed(umk, w.orgId))
        val pid = OrgTestWorld.hex(16)
        val t = w.now - 500
        val body = OrgDirectory.canonicalBody(OrgDirectoryEntry(seatId = seat, pseudonym = "Mia", source = "scim", updatedAt = t))
        val recipient = "seat:${w.founderSeat}"
        val sealed = PqHybrid.hybridSeal(kem.publicKey, PqHybrid.HybridSealOptions(purpose = OrgConnectors.TAG_PROPOSAL, senderKeyId = ByteArray(32), issuedAt = t),
            listOf(w.orgId, pid, recipient).map { it.toByteArray() }, body)
        val recipients = listOf(Triple(recipient, OrgServers.kemKeyIdHex(kem.publicKey), PqHex.encode(sealed)))
        val roles = listOf(OrgSeatRole.Member, OrgSeatRole.Unlock(listOf(domain)))
        val prop = OrgProposal(w.orgId, pid, c.connectorId, "role-change", seat, OrgAuthority.rolesHash(roles), OrgConnectors.recipientsHash(recipients), t)
        val sig = PqHybrid.hybridSign(conn.secretKey, OrgConnectors.TAG_PROPOSAL, OrgConnectors.canonical(prop))
        w.proposals += buildJsonObject {
            put("bundle", buildJsonObject {
                put("proposal", buildJsonObject {
                    put("orgId", w.orgId); put("proposalId", pid); put("connectorId", c.connectorId); put("kind", "role-change"); put("subject", seat)
                    put("rolesHash", prop.rolesHash); put("sealedSha256", prop.sealedSha256); put("issuedAt", t)
                })
                put("roles", com.flagshipserver.app.core.OrgJson.roles(roles))
                put("recipients", JsonArray(recipients.map { (r, k, h) -> buildJsonObject { put("recipient", r); put("kemKeyId", k); put("sealedHex", h) } }))
                put("signature", PqHex.encode(sig))
            })
            put("decision", JsonNull)
        }
        a.load(w.founder)
        val p = a.proposals.value.single()
        val before = w.grants.size
        a.approveProposal(w.founder, p)
        assertEquals(before + 1, w.grants.size)
        val snap = OrgClient(w.http).snapshot(w.orgId, w.genesisHash, w.now)
        assertEquals(roles, snap.book.seats[seat]!!.roles)
        assertEquals("done", ((w.decisions.last()["decision"] as JsonObject)["decision"] as JsonPrimitive).content)
    }
}
