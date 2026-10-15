// InviteAcceptViewModel — the owner approves a friend's tapped/scanned reply:
// {accept, acceptSig} go to the box the reply names, and nothing else.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ServiceAccessClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InviteAcceptViewModelTest {
    private val iid = "ea4ab8be66710610842cf6ef0d7e56bd91a4f03c7a5633fde4a66482cc292890"
    private val aid = "086abb1c191c86e7cb68d4736f73c68f8b0c55c2a3fafa6a2c770fc308ab242a"
    private val sig = "1f".repeat(64)
    private val reply = "https://flagshipserver.com/invite-accept?server=home.alice.flagship.services" +
        "&iid=$iid&ref=alice-notes&aid=$aid&sig=$sig&at=1700006000000"

    private fun vm(t: InviteRedeemViewModelTest.RedeemTransport, raw: String = reply) =
        InviteAcceptViewModel(raw, ServiceAccessClient(boxTransport = t, comTransport = t))

    @Test fun approve_postsOnlyTheAcceptanceToTheNamedBox() = runTest {
        val t = InviteRedeemViewModelTest.RedeemTransport(200, """{"serviceRef":"alice-notes","boundAID":"$aid","bound":true}""")
        val v = vm(t)
        assertEquals("alice-notes", v.serviceRef)
        v.approve()
        assertEquals(InviteAcceptPhase.Done("alice-notes"), v.phase.value)
        assertEquals("https://home.alice.flagship.services/api/service-access/accept", t.lastUrl)
        val body = t.lastBodyJson()!!
        assertEquals(setOf("accept", "acceptSig"), body.keys)
        assertEquals(sig, body["acceptSig"]!!.jsonPrimitive.content)
        val accept = body["accept"]!!.jsonObject
        assertEquals(iid, accept["inviteId"]!!.jsonPrimitive.content)
        assertEquals(aid, accept["contactAID"]!!.jsonPrimitive.content)
        assertEquals(1_700_006_000_000L, accept["acceptedAt"]!!.jsonPrimitive.content.toLong())
    }

    @Test fun approve_oldSchemeReplyStillWorks() = runTest {
        val t = InviteRedeemViewModelTest.RedeemTransport(200, """{"serviceRef":"alice-notes","bound":true}""")
        val v = vm(t, reply.replace("https://flagshipserver.com/", "flagship://"))
        v.approve()
        assertEquals(InviteAcceptPhase.Done("alice-notes"), v.phase.value)
    }

    @Test fun approve_rejectedByBoxSaysSo() = runTest {
        val t = InviteRedeemViewModelTest.RedeemTransport(403)
        val v = vm(t)
        v.approve()
        assertEquals(
            InviteAcceptPhase.Failed("Couldn't verify this approval. Ask them to open the invite again and resend."),
            v.phase.value,
        )
    }

    @Test fun malformedReplyNeverCallsTheBox() = runTest {
        val t = InviteRedeemViewModelTest.RedeemTransport(200)
        val v = vm(t, "https://flagshipserver.com/invite-accept?iid=$iid")
        assertEquals(InviteAcceptPhase.Failed(InviteAcceptViewModel.MALFORMED), v.phase.value)
        v.approve()
        assertNull(t.lastUrl)
    }
}
