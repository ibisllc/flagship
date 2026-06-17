// JournalViewModel — the selected unit (from the server-detail unit picker)
// must flow through load() into the IRK-signed JournalRequest body + the
// /api/journal POST, and the line count must clamp to MAX_LINES. Pins that a
// non-default unit is honored (the picker's payoff) and that the signature is
// over the canonical bytes for the SELECTED unit.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.JournalRequestBody
import com.flagshipserver.app.api.LockPowerClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.JournalRequest
import com.flagshipserver.app.core.JournalUnits
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class JournalViewModelTest {

    private val server = "home.alice.flagship.services"

    private fun vm(
        transport: PowerOffViewModelTest.RecordingTransport,
        kp: Ed25519Sign.KeyPair,
        now: Long = 1700L,
    ) = JournalViewModel(
        serverDomain = server,
        signer = { Ed25519Sign(kp.privateKey) },
        client = LockPowerClient(transport = transport, podBaseUrl = { "https://$it" }),
        now = { now },
    )

    @Test fun load_selectedUnit_flowsToBody_andSignsCanonicalBytes() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val transport = PowerOffViewModelTest.RecordingTransport(
            """{"ok":true,"unit":"flagship-data-services","lines":["x"]}""",
        )
        val m = vm(transport, kp)
        // The non-default unit a user picks in the segmented row.
        m.load("flagship-data-services", JournalUnits.DEFAULT_LINES)

        assertEquals("https://$server/api/journal", transport.lastUrl)
        val body = transport.decode(JournalRequestBody.serializer())
        assertEquals(server, body.request.serverId)
        assertEquals("flagship-data-services", body.request.unit)
        assertEquals(JournalUnits.DEFAULT_LINES, body.request.lines)
        assertEquals(1700L, body.request.issuedAt)

        val sig = HexUtil.decode(body.signature)!!
        Ed25519Verify(kp.publicKey).verify(
            sig,
            JournalRequest.canonicalBytes(server, "flagship-data-services", JournalUnits.DEFAULT_LINES, 1700L),
        )
    }

    @Test fun load_clampsLinesToMax() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val transport = PowerOffViewModelTest.RecordingTransport("""{"ok":true,"unit":"flagship-daemon","lines":[]}""")
        vm(transport, kp).load(JournalUnits.DEFAULT_UNIT, JournalUnits.MAX_LINES + 9999)
        val body = transport.decode(JournalRequestBody.serializer())
        assertEquals(JournalUnits.MAX_LINES, body.request.lines)
    }

    @Test fun load_loadedPhase_carriesUnit() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val transport = PowerOffViewModelTest.RecordingTransport(
            """{"ok":true,"unit":"flagship-data-services","lines":["a","b"]}""",
        )
        val m = vm(transport, kp)
        m.load("flagship-data-services", 50)
        val phase = m.phase.value
        assertTrue(phase is JournalPhase.Loaded)
        assertEquals("flagship-data-services", (phase as JournalPhase.Loaded).unit)
        assertEquals(listOf("a", "b"), phase.lines)
    }
}
