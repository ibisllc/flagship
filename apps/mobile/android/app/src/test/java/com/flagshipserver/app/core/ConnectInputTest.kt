// "Connect to an existing account": what each field does with what's typed or
// pasted. Mirrors iOS ConnectInputTests and apps/web/tests/webappConnectAccount.test.ts.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectInputTest {
    private val pk = "A".repeat(43)
    private val httpsLink = "https://${JoinLink.HOST}/join?sid=abc123&pk=$pk"
    private val legacyLink = "flagship://join?sid=abc123&pk=$pk"
    private val bareCode = "sid=abc123&pk=$pk"

    @Test fun readsEveryPairingFormTheJoinParserReads() {
        for (link in listOf(httpsLink, legacyLink, bareCode)) {
            val c = ConnectInput.classify("  $link\n")
            assertTrue(link, c is ConnectInput.Pairing && c.link.sid == "abc123")
            val r = ConnectInput.readPairingField(link)
            assertTrue(link, r is ConnectInput.PairingField.Join && r.link.sid == "abc123")
        }
    }

    @Test fun pairingLinkInTheNameFieldGoesToJoinWithANote() {
        val r = ConnectInput.readNameField(httpsLink)
        assertTrue(r is ConnectInput.NameField.Join)
        assertEquals(ConnectInput.ROUTED_TO_JOIN, (r as ConnectInput.NameField.Join).note)
        assertTrue(ConnectInput.readNameField(legacyLink) is ConnectInput.NameField.Join)
    }

    @Test fun anAccountNameSignsInLowercased() {
        assertEquals(ConnectInput.NameField.SignIn("bright-maple"), ConnectInput.readNameField("  Bright-Maple "))
        assertEquals(ConnectInput.NameField.SignIn("demo"), ConnectInput.readNameField("@demo"))
        assertEquals(ConnectInput.NameField.None, ConnectInput.readNameField("  "))
    }

    @Test fun otherLinksAreRefusedInASentence() {
        val other = "https://${JoinLink.HOST}/share#s=1"
        assertEquals(ConnectInput.NameField.Error(ConnectInput.BAD_LINK), ConnectInput.readNameField(other))
        assertEquals(ConnectInput.PairingField.Error(ConnectInput.BAD_LINK), ConnectInput.readPairingField(other))
        assertEquals(
            ConnectInput.PairingField.Error(ConnectInput.BAD_LINK),
            ConnectInput.readPairingField("https://${JoinLink.HOST}/join?sid=abc"),
        )
    }

    @Test fun aNameInTheCodeFieldPointsAtSignIn() {
        assertEquals(ConnectInput.PairingField.Error(ConnectInput.NAME_IN_CODE), ConnectInput.readPairingField("bright-maple"))
        assertEquals(ConnectInput.PairingField.Error(ConnectInput.NOT_A_CODE), ConnectInput.readPairingField("not a code!"))
        assertEquals(ConnectInput.PairingField.None, ConnectInput.readPairingField(""))
        for (msg in listOf(ConnectInput.ROUTED_TO_JOIN, ConnectInput.NOT_A_CODE, ConnectInput.NAME_IN_CODE, ConnectInput.BAD_LINK, ConnectInput.EMPTY_CODE)) {
            assertTrue(msg, msg.first().isUpperCase() && msg.endsWith("."))
        }
    }

    @Test fun deviceNameDefaultsToTheSettingsNameThenTheModel() {
        assertEquals("Harry's Galaxy S26", DeviceDisplayName.pick(" Harry's Galaxy S26 ", "SM-S948U1"))
        assertEquals("SM-S948U1", DeviceDisplayName.pick("  ", "SM-S948U1"))
        assertEquals("SM-S948U1", DeviceDisplayName.pick(null, "SM-S948U1"))
        assertNull(DeviceDisplayName.pick(null, " "))
    }
}
