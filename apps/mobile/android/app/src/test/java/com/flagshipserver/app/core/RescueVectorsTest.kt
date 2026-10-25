// Runs packages/protocol/test-vectors/rescue/ (vectors.json, offline-control.json): the hello and
// session bytes, the phone's hello check, the discovery id and the offline-control orders.

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class RescueVectorsTest {
    private fun load(name: String): JsonObject {
        val rel = "packages/protocol/test-vectors/rescue/$name"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        var hops = 0
        while (dir != null && hops < 14) {
            val f = File(dir, rel)
            if (f.isFile) return Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile
            hops += 1
        }
        error("could not locate $rel")
    }

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun hex(s: String) = HexUtil.decode(s)!!
    private fun exchange(c: JsonObject) = Rescue.Exchange(c.s("serverDomain"), c.s("clientNonce"), c.s("boxNonce"), c.s("certSha256"), c["issuedAt"]!!.jsonPrimitive.long)

    @Test
    fun helloSessionAndDiscovery() {
        val v = load("vectors.json")
        for (el in v["cases"]!!.jsonArray) {
            val c = el.jsonObject
            val x = exchange(c)
            val hello = x.helloCanonical()
            val session = x.sessionCanonical()
            assertEquals(c.s("helloCanonical"), String(hello, Charsets.UTF_8))
            assertEquals(c.s("sessionCanonical"), String(session, Charsets.UTF_8))
            val stk = hex(c.s("stkPub"))
            assertTrue(Rescue.verifyEd25519(stk, hex(c.s("helloSignature")), hello))
            assertTrue(Rescue.verifyEd25519(hex(v.s("irkPub")), hex(c.s("sessionSignature")), session))
            // Distinct tags: a hello's signature never stands for a session order.
            assertFalse(Rescue.verifyEd25519(stk, hex(c.s("helloSignature")), session))
            assertEquals(c.s("discoveryId"), Rescue.discoveryId(stk, x.serverDomain))
            assertEquals(c.s("discoveryId"), Rescue.discoveryId(stk, x.serverDomain.uppercase()))
            val seen = c.s("certSha256")
            val now = x.issuedAt + 1000
            val sig = hex(c.s("helloSignature"))
            assertNull(Rescue.checkHello(x, sig, stk, x.serverDomain, x.clientNonce, seen, now))
            assertEquals("cert-mismatch", Rescue.checkHello(x, sig, stk, x.serverDomain, x.clientNonce, "cd".repeat(32), now))
            assertEquals("bad-signature", Rescue.checkHello(x, sig, hex(v.s("irkPub")), x.serverDomain, x.clientNonce, seen, now))
            assertEquals("wrong-server", Rescue.checkHello(x, sig, stk, "x.other.flagship.services", x.clientNonce, seen, now))
            assertEquals("wrong-nonce", Rescue.checkHello(x, sig, stk, x.serverDomain, "9".repeat(32), seen, now))
            assertEquals("not-yet-valid", Rescue.checkHello(x, sig, stk, x.serverDomain, x.clientNonce, seen, now - 10 * 60_000))
        }
        for (el in v["invalid"]!!.jsonArray) assertThrows(IllegalArgumentException::class.java) { exchange(el.jsonObject).sessionCanonical() }
    }

    @Test
    fun offlineControlOrders() {
        val v = load("offline-control.json")
        fun order(o: JsonObject) = Rescue.ControlOrder(o.s("serverDomain"), o.s("sessionNonce"), o.s("action"), o.s("target"), o.s("nonce"), o["issuedAt"]!!.jsonPrimitive.long)
        for (el in v["cases"]!!.jsonArray) {
            val c = el.jsonObject
            val o = order(c["order"]!!.jsonObject)
            val bytes = o.canonical()
            assertEquals(c.s("name"), c.s("canonical"), String(bytes, Charsets.UTF_8))
            assertTrue(c.s("name"), Rescue.verifyEd25519(hex(v.s("irkPub")), hex(c.s("signature")), bytes))
            assertFalse(Rescue.verifyEd25519(hex(v.s("irkPub")), hex(c.s("signature")), o.copy(issuedAt = o.issuedAt + 1).canonical()))
        }
        for (el in v["refused"]!!.jsonArray) {
            val c = el.jsonObject
            assertThrows(c.s("name"), IllegalArgumentException::class.java) { order(c["order"]!!.jsonObject).canonical() }
        }
    }

    @Test
    fun orderHelpers() {
        assertTrue(Rescue.isServiceId("alice--notes"))
        assertTrue(Rescue.isServiceId("notes"))
        assertFalse(Rescue.isServiceId("a--b--c"))
        assertFalse(Rescue.isServiceId("Notes"))
        assertEquals(32, Rescue.newNonce().length)
        assertTrue(Rescue.Action.SERVER_RESTART.isServerAction)
        assertFalse(Rescue.Action.APP_STOP.isServerAction)
    }
}
