package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.DirectAccessRefusal
import com.flagshipserver.app.api.DirectAccessText
import com.flagshipserver.app.api.DirectNamesClient
import com.flagshipserver.app.api.MockDirectNamesClient
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.DirectAccess
import com.flagshipserver.app.core.DirectName
import com.flagshipserver.app.keystore.BiometricCancelled
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DirectAccessViewModelTest {
    private val server = "home.bright-maple.flagship.services"
    private val seed = ByteArray(32) { 0x5a }
    private val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
    private val t0 = 1_790_000_000_000L
    private val plants = "plants--bright-maple.fshp.app"

    private val calls = mutableListOf<String>()
    private val box = MockScreensClient(simulatedLatencyMs = 0)
    private val com = MockDirectNamesClient()
    private var signs = 0

    private val recordingBox: ScreensClient = object : ScreensClient by box {
        override suspend fun directAccess() = box.directAccess()
        override suspend fun setDirectAccess(signed: DirectAccess.SignedOrder): DirectAccess.Change {
            calls += "box"
            return box.setDirectAccess(signed)
        }
    }
    private val recordingCom: DirectNamesClient = object : DirectNamesClient by com {
        override suspend fun postAccessOrder(username: String, signed: DirectAccess.SignedOrder) {
            calls += "com"
            com.postAccessOrder(username, signed)
        }
    }

    private fun vm(
        canManage: Boolean = true,
        screens: ScreensClient = recordingBox,
        signer: suspend (String) -> Ed25519Sign = { signs++; Ed25519Sign(seed) },
    ) = DirectAccessViewModel(server, "bright-maple", screens, recordingCom, canManage, signer, signer, now = { t0 })

    private suspend fun on(m: DirectAccessViewModel, addresses: String = "81.2.69.142") {
        m.load()
        m.startEditing()
        m.setAddressesText(addresses)
        assertTrue(m.state.value.error, m.saveAccess())
    }

    @Test fun loadsTheBoxViewTheComStateAndOneRowPerApp() = runTest {
        val m = vm()
        m.load()
        val s = m.state.value
        assertTrue(s.loaded)
        assertFalse(m.isOn)
        val rows = m.rows.associateBy { it.serviceId }
        assertEquals(plants, rows["bright-maple--plants"]!!.fqdn)
        assertEquals("wiki--bright-maple.fshp.app", rows["bright-maple--wiki"]!!.fqdn)
        assertNull("another account's app has no direct name here", rows["trent--scratchpad"]!!.fqdn)
    }

    @Test fun aBoxWithoutDirectAccessHidesTheSection() = runTest {
        val old = object : ScreensClient by box {
            override suspend fun directAccess(): DirectAccess.View = throw ScreensError.Http(404, "{}")
        }
        val m = vm(screens = old)
        m.load()
        assertFalse(m.state.value.supported)
    }

    @Test fun turningOnSignsOnceAndSendsToTheBoxThenCom() = runTest {
        val m = vm()
        on(m, "2A02:8010:6400:1::10, 81.2.69.142")
        assertEquals(listOf("box", "com"), calls)
        assertEquals(1, signs)
        val signed = com.accessOrders.single()
        assertEquals(signed, box.directAccessOrders.single())
        assertEquals(listOf("2a02:8010:6400:1::10", "81.2.69.142"), signed.order.addresses)
        assertEquals(443, signed.order.port)
        assertTrue(DirectAccess.verify(signed.order, signed.signatureHex, pub))
        assertTrue(m.isOn)
        assertEquals("Direct access is on.", m.state.value.notice)
        assertFalse(m.state.value.editing)
    }

    @Test fun aPrivateAddressIsRefusedBeforeSigning() = runTest {
        val m = vm()
        m.load()
        m.startEditing()
        m.setAddressesText("192.168.1.20")
        assertFalse(m.saveAccess())
        assertEquals("Only public addresses can be used. Private, local and reserved addresses can't.", m.state.value.error)
        m.setAddressesText("not-an-ip")
        assertFalse(m.saveAccess())
        assertEquals("One of the addresses isn't an IP address.", m.state.value.error)
        m.setAddressesText("81.2.69.142")
        m.setPortText("http")
        assertFalse(m.saveAccess())
        assertEquals("The port must be a number from 1 to 65535.", m.state.value.error)
        assertEquals(0, signs)
        assertTrue(calls.isEmpty())
    }

    @Test fun comRefusalCodesBecomeTheAppsSentence() = runTest {
        com.postError = DirectAccessRefusal(403, "not-admin", "admin root required")
        val m = vm()
        m.load()
        m.startEditing()
        m.setAddressesText("81.2.69.142")
        assertFalse(m.saveAccess())
        assertEquals("Only an admin device of this account can change direct access.", m.state.value.error)
        assertEquals("the box got it first", listOf("box", "com"), calls)
        assertEquals("unknown codes keep the server's words", "admin root required", DirectAccessRefusal(400, null, "admin root required").sentence)
        assertEquals("A newer change is already saved. Reload and try again.", DirectAccessViewModel.message(ScreensError.Http(409, """{"error":"x","code":"replayed"}""")))
    }

    @Test fun cancellingTheBiometricChangesNothing() = runTest {
        val m = vm(signer = { throw BiometricCancelled() })
        m.load()
        m.startEditing()
        m.setAddressesText("81.2.69.142")
        assertFalse(m.saveAccess())
        assertEquals("Direct access wasn't changed.", m.state.value.error)
        assertTrue(calls.isEmpty())
    }

    @Test fun turningOffSendsAnOffOrder() = runTest {
        val m = vm()
        on(m)
        assertTrue(m.turnOff())
        val off = com.accessOrders.last().order
        assertFalse(off.enabled)
        assertTrue(off.addresses.isEmpty())
        assertFalse(m.isOn)
        assertEquals("Direct access is off.", m.state.value.notice)
    }

    @Test fun aNameTurnsOnFollowingTheServerThenSettingsThenOff() = runTest {
        val m = vm()
        on(m)
        val row = m.rows.first { it.serviceId == "bright-maple--plants" }
        assertTrue(m.turnOnName(row))
        val first = com.nameOrders.single()
        assertEquals(DirectName.Order(plants, server, true, emptyList(), DirectName.CAA_PIN, t0), first.order)
        assertTrue(DirectName.verify(first.order, first.signatureHex, pub))
        val published = m.rows.first { it.serviceId == "bright-maple--plants" }
        assertTrue(published.isOn)
        assertTrue(published.state!!.isPublished)

        m.editName(published)
        val d = m.state.value.nameDraft!!
        assertTrue(d.pinCaa)
        m.updateNameDraft(d.copy(pinCaa = false, addressesText = "203.0.114.7"))
        assertTrue(m.saveNameDraft())
        assertNull(m.state.value.nameDraft)
        val owned = com.nameOrders.last().order
        assertEquals(DirectName.CAA_OFF, owned.caa)
        assertEquals(listOf("203.0.114.7"), owned.addresses)

        assertTrue(m.turnOffName(m.rows.first { it.serviceId == "bright-maple--plants" }))
        val off = com.nameOrders.last().order
        assertFalse(off.enabled)
        assertEquals(DirectName.CAA_OFF, off.caa)
        assertEquals("Turned off.", com.nameStateText(plants))
    }

    @Test fun checkFromOutsideSaysWhatItFound() = runTest {
        val m = vm()
        on(m)
        assertTrue(m.turnOnName(m.rows.first { it.serviceId == "bright-maple--plants" }))
        val row = m.rows.first { it.serviceId == "bright-maple--plants" }
        assertTrue(m.probe(row))
        assertEquals(listOf("plants--bright-maple"), com.probes)
        assertEquals("Reachable from outside.", m.state.value.notice)
        val p = m.rows.first { it.serviceId == "bright-maple--plants" }.state!!.probe!!
        assertTrue(DirectAccessViewModel.probeLine(p).endsWith("Reachable from outside."))
    }

    @Test fun aNonAdminDeviceIsReadOnly() = runTest {
        val m = vm(canManage = false)
        m.load()
        m.startEditing()
        m.setAddressesText("81.2.69.142")
        assertFalse(m.saveAccess())
        assertFalse(m.turnOnName(m.rows.first { it.serviceId == "bright-maple--plants" }))
        assertFalse(m.turnOff())
        assertEquals(0, signs)
        assertTrue(calls.isEmpty())
        assertTrue(com.nameOrders.isEmpty())
        assertEquals("Only an admin device can change direct access. This device can see it.", DirectAccessViewModel.ADMIN_ONLY)
    }

    private fun MockDirectNamesClient.nameStateText(fqdn: String): String =
        DirectAccessText.state(scripted.name(fqdn)!!)
}
