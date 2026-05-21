// Mirror of FlagshipMobileTests/InstallBlobTests.swift on the JVM.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InstallBlobTest {

    @Test fun authCodeCanonicalBytes_followsV1Format() {
        val auth = AuthCode(
            serial = "01XYZ",
            username = "harry",
            serverName = "home",
            serverDomain = "home.harry.flagship.services",
            delegatedPubKey = ByteArray(32) { 0x11 },
            userPubKey = ByteArray(32) { 0x22 },
            issuedAt = 1234L,
            expiresAt = 5678L,
        )
        val s = String(auth.canonicalBytes())
        assertEquals(
            "flagship/auth-code/v1|1|01XYZ|harry|home|home.harry.flagship.services|" +
                "11".repeat(32) + "|" + "22".repeat(32) + "|1234|5678",
            s
        )
    }

    @Test fun installBlobCanonicalBytes_startsWithV1TagAndCanonicalSeparator() {
        val auth = AuthCode(
            serial = "01ABCD",
            username = "harry",
            serverName = "home",
            serverDomain = "home.harry.flagship.services",
            delegatedPubKey = ByteArray(32) { 0x11 },
            userPubKey = ByteArray(32) { 0x22 },
            issuedAt = 1L, expiresAt = 2L,
        )
        val blob = InstallBlob(
            serverDomain = "home.harry.flagship.services",
            username = "harry",
            serverName = "home",
            phoneDelegatedPubKey = ByteArray(32) { 0x33 },
            authCode = auth,
            authCodeUserSignature = ByteArray(64) { 0x44 },
            rckPubKey = ByteArray(32) { 0x55 },
        )
        val s = String(blob.canonicalBytes())
        // v2: blob.issuedAt+expiresAt removed; tag stays v1.
        assertTrue(s.startsWith("flagship/install-blob/v1|2|home.harry.flagship.services|harry|home|"))
        assertTrue(s.contains("33".repeat(32)))
        assertTrue(s.contains("|01ABCD|"))
        assertTrue(s.endsWith("|" + "55".repeat(32)))
    }

    @Test fun usernameClaim_canonicalBytes() {
        val s = String(UsernameClaim.canonicalBytes("harry", "abcd", 42))
        assertEquals("flagship/claim-username/v1|harry|abcd|42", s)
    }

    @Test fun pushTokenRegister_canonicalBytes() {
        val s = String(PushTokenRegister.canonicalBytes(
            username = "harry",
            platform = "fcm",
            providerToken = "deadbeef",
            pushX25519PubHex = "ab".repeat(32),
            label = "Pixel 8",
            issuedAt = 1700000000L,
        ))
        // Field order: tag | username | platform | providerToken |
        // pushX25519Pub | label | issuedAt. Mirrors the Worker side
        // in packages/protocol/src/auth.ts.
        assertEquals(
            "flagship/push-token-register/v1|harry|fcm|deadbeef|" +
                "ab".repeat(32) + "|Pixel 8|1700000000",
            s
        )
    }

    @Test fun authCodeRevoke_canonicalBytes() {
        val s = String(AuthCodeRevoke.canonicalBytes("01ABCD", "harry", 7))
        assertEquals("flagship/auth-code-revoke/v1|01ABCD|harry|7", s)
    }

    @Test fun rckRegister_canonicalBytes() {
        val s = String(RckRegister.canonicalBytes(
            "harry", "home.harry.flagship.services", "deadbeef", 99
        ))
        assertEquals(
            "flagship/rck-register/v1|harry|home.harry.flagship.services|deadbeef|99",
            s
        )
    }

    @Test fun hexRoundTrip() {
        val raw = ByteArray(256) { it.toByte() }
        val hex = HexUtil.encode(raw)
        assertEquals(512, hex.length)
        assertTrue(raw.contentEquals(HexUtil.decode(hex)!!))
    }

    @Test fun hexDecode_rejectsOddLengthAndNonHex() {
        assertNull(HexUtil.decode("abc"))
        assertNull(HexUtil.decode("zz"))
    }

    @Test fun serialGen_returnsExactly22HexCharsPrefixed01() {
        repeat(10) {
            val s = SerialGen.random()
            assertEquals(22, s.length)
            assertTrue(s.startsWith("01"))
            assertFalse(s.uppercase() != s)
        }
    }
}
