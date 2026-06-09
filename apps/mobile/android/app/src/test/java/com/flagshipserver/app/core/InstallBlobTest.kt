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

    @Test fun installBlobCanonicalBytes_bootUnlockModeAppendedOnlyWhenPresent() {
        val auth = AuthCode(
            serial = "01ABCD",
            username = "harry",
            serverName = "home",
            serverDomain = "home.harry.flagship.services",
            delegatedPubKey = ByteArray(32) { 0x11 },
            userPubKey = ByteArray(32) { 0x22 },
            issuedAt = 1L, expiresAt = 2L,
        )
        fun blob(mode: String?) = InstallBlob(
            serverDomain = "home.harry.flagship.services",
            username = "harry",
            serverName = "home",
            phoneDelegatedPubKey = ByteArray(32) { 0x33 },
            authCode = auth,
            authCodeUserSignature = ByteArray(64) { 0x44 },
            rckPubKey = ByteArray(32) { 0x55 },
            bootUnlockMode = mode,
        )
        // Absent ⇒ exact legacy bytes (canonical ends at rckPubKey).
        assertTrue(String(blob(null).canonicalBytes()).endsWith("|" + "55".repeat(32)))
        // Present ⇒ appended as the final field.
        assertTrue(String(blob("approve").canonicalBytes()).endsWith("|" + "55".repeat(32) + "|approve"))
        assertTrue(String(blob("auto").canonicalBytes()).endsWith("|auto"))
    }

    // Mirrors the Swift test_installBlobCanonicalBytes_certAutonomyMatchesTSBytes
    // + the TS canonicalInstallBlob `ca=${mode}:${days}` append. certAutonomy
    // composes AFTER bootUnlockMode; absent ⇒ exact legacy bytes.
    @Test fun installBlobCanonicalBytes_certAutonomyMatchesTSBytes() {
        val auth = AuthCode(
            serial = "01ABCD",
            username = "harry",
            serverName = "home",
            serverDomain = "home.harry.flagship.services",
            delegatedPubKey = ByteArray(32) { 0x11 },
            userPubKey = ByteArray(32) { 0x22 },
            issuedAt = 1L, expiresAt = 2L,
        )
        fun blob(ca: InstallBlob.CertAutonomy?, boot: String? = null) = InstallBlob(
            serverDomain = "home.harry.flagship.services",
            username = "harry",
            serverName = "home",
            phoneDelegatedPubKey = ByteArray(32) { 0x33 },
            authCode = auth,
            authCodeUserSignature = ByteArray(64) { 0x44 },
            rckPubKey = ByteArray(32) { 0x55 },
            bootUnlockMode = boot,
            certAutonomy = ca,
        )
        fun canon(b: InstallBlob) = String(b.canonicalBytes())
        val rck = "55".repeat(32)
        // Absent ⇒ exact legacy bytes (no ca= token).
        assertTrue(canon(blob(null)).endsWith("|$rck"))
        // managed with a window ⇒ `ca=managed:<days>` — MUST match TS `ca=${mode}:${days}`.
        assertTrue(canon(blob(InstallBlob.CertAutonomy("managed", 7))).endsWith("|ca=managed:7"))
        // autonomous ⇒ days default to 0 on the wire.
        assertTrue(canon(blob(InstallBlob.CertAutonomy("autonomous"))).endsWith("|ca=autonomous:0"))
        // Composes AFTER bootUnlockMode (both committed independently).
        assertTrue(
            canon(blob(InstallBlob.CertAutonomy("managed", 15), boot = "approve"))
                .endsWith("|approve|ca=managed:15")
        )
    }

    // The on-wire blob the box reads. Mirrors the webapp's onWireBlob: with
    // the DEFAULT Json (encodeDefaults=false, as used at CreateServerScreen's
    // deliver step), bootUnlockMode is OMITTED for the "auto" default and
    // emitted only for "approve".
    @Test fun wireBlob_bootUnlockMode_onlyEmittedWhenApprove() {
        fun bundle(mode: String?) = InstallBlobBundle(
            blob = WireBlob(
                serverDomain = "home.harry.flagship.services",
                username = "harry",
                serverName = "home",
                phoneDelegatedPubKey = "33".repeat(32),
                authCode = WireAuthCode(
                    serial = "01ABCD",
                    username = "harry",
                    serverName = "home",
                    serverDomain = "home.harry.flagship.services",
                    delegatedPubKey = "33".repeat(32),
                    userPubKey = "22".repeat(32),
                    issuedAt = 1L,
                    expiresAt = 2L,
                ),
                authCodeUserSignature = "44".repeat(64),
                rckPubKey = "55".repeat(32),
                bootUnlockMode = mode,
            ),
            blobSignature = "ab",
        )
        val auto = kotlinx.serialization.json.Json.encodeToString(InstallBlobBundle.serializer(), bundle(null))
        assertFalse(auto.contains("bootUnlockMode"))
        val approve = kotlinx.serialization.json.Json.encodeToString(InstallBlobBundle.serializer(), bundle("approve"))
        assertTrue(approve.contains("\"bootUnlockMode\":\"approve\""))
    }

    // The on-wire certAutonomy: managed emits mode + offlineWindowDays;
    // autonomous omits offlineWindowDays (null + encodeDefaults=false), matching
    // the webapp onWireBlob + iOS OnWireCertAutonomy so trailer.ts round-trips.
    @Test fun wireBlob_certAutonomy_emittedWithModeAndDays() {
        fun bundle(ca: WireCertAutonomy?) = InstallBlobBundle(
            blob = WireBlob(
                serverDomain = "home.harry.flagship.services",
                username = "harry",
                serverName = "home",
                phoneDelegatedPubKey = "33".repeat(32),
                authCode = WireAuthCode(
                    serial = "01ABCD",
                    username = "harry",
                    serverName = "home",
                    serverDomain = "home.harry.flagship.services",
                    delegatedPubKey = "33".repeat(32),
                    userPubKey = "22".repeat(32),
                    issuedAt = 1L,
                    expiresAt = 2L,
                ),
                authCodeUserSignature = "44".repeat(64),
                rckPubKey = "55".repeat(32),
                certAutonomy = ca,
            ),
            blobSignature = "ab",
        )
        val managed = kotlinx.serialization.json.Json.encodeToString(
            InstallBlobBundle.serializer(), bundle(WireCertAutonomy("managed", 30)))
        assertTrue(managed.contains("\"certAutonomy\""))
        assertTrue(managed.contains("\"mode\":\"managed\""))
        assertTrue(managed.contains("\"offlineWindowDays\":30"))
        val autonomous = kotlinx.serialization.json.Json.encodeToString(
            InstallBlobBundle.serializer(), bundle(WireCertAutonomy("autonomous")))
        assertTrue(autonomous.contains("\"mode\":\"autonomous\""))
        assertFalse(autonomous.contains("offlineWindowDays"))
    }

    // diskEncryption composes AFTER certAutonomy with a `de=` prefix. Absent ⇒
    // exact legacy bytes (a "luks" box omits it); present ⇒ `de=<mode>`. MUST
    // match the TS canonicalInstallBlob `de=${diskEncryption}` append.
    @Test fun installBlobCanonicalBytes_diskEncryptionMatchesTSBytes() {
        val auth = AuthCode(
            serial = "01ABCD",
            username = "harry",
            serverName = "home",
            serverDomain = "home.harry.flagship.services",
            delegatedPubKey = ByteArray(32) { 0x11 },
            userPubKey = ByteArray(32) { 0x22 },
            issuedAt = 1L, expiresAt = 2L,
        )
        fun blob(de: String?, ca: InstallBlob.CertAutonomy? = null, boot: String? = null) = InstallBlob(
            serverDomain = "home.harry.flagship.services",
            username = "harry",
            serverName = "home",
            phoneDelegatedPubKey = ByteArray(32) { 0x33 },
            authCode = auth,
            authCodeUserSignature = ByteArray(64) { 0x44 },
            rckPubKey = ByteArray(32) { 0x55 },
            bootUnlockMode = boot,
            certAutonomy = ca,
            diskEncryption = de,
        )
        fun canon(b: InstallBlob) = String(b.canonicalBytes())
        val rck = "55".repeat(32)
        // Absent ⇒ exact legacy bytes (no de= token).
        assertTrue(canon(blob(null)).endsWith("|$rck"))
        // "none" ⇒ `de=none` as the FINAL field.
        assertTrue(canon(blob("none")).endsWith("|de=none"))
        assertTrue(canon(blob("luks")).endsWith("|de=luks"))
        // Composes AFTER certAutonomy + bootUnlockMode (each committed).
        assertTrue(
            canon(blob("none", ca = InstallBlob.CertAutonomy("managed", 30), boot = "approve"))
                .endsWith("|approve|ca=managed:30|de=none")
        )
    }

    // Byte-identity with the TS @flagship/protocol signInstallBlob (Ed25519
    // deterministic). The fixed golden vector below is produced by signing a
    // diskEncryption:"none" blob with the IRK whose pub key is the userPubKey;
    // the canonical bytes the Android `canonicalBytes()` emits MUST verify
    // under that signature, proving Android ⇔ TS wire-byte parity for `de=`.
    @Test fun installBlobCanonicalBytes_deNone_matchesTSGoldenSignature() {
        val userPubHex = "8146640f02493af4fbc54fe33388e75dc2c937ae0b7727cc2b2afb1b75199a3e"
        val delegatedPubHex = "c86d01ad8b2fb694b22ff60e3c9d9e7ed90db5604772b74450d40913b9a9cbaf"
        val rckPubHex = "ba42458e83ba7926ba8b8f3e9ab9caaf0f1c4918dda8c551084f7aeb1065b74b"
        val goldenSigHex =
            "31da15400225ae17acde21eb50bbe51f0b939754283c231e99c9edf307731d48" +
                "899f5bf314278a5c58d81b093d550b53fd05c8917cb0b28481cf78f18759d002"

        val auth = AuthCode(
            version = 1,
            serial = "01DENONE0001",
            username = "denone",
            serverName = "home",
            serverDomain = "home.denone.flagship.services",
            delegatedPubKey = HexUtil.decode(delegatedPubHex)!!,
            userPubKey = HexUtil.decode(userPubHex)!!,
            issuedAt = 1000L,
            expiresAt = 99999999999999L,
        )
        val blob = InstallBlob(
            version = 2,
            serverDomain = "home.denone.flagship.services",
            username = "denone",
            serverName = "home",
            phoneDelegatedPubKey = HexUtil.decode(delegatedPubHex)!!,
            registrationUrl = "https://flagshipserver.com/api/server/register",
            authCode = auth,
            // authCodeUserSignature = 64 bytes of 0x55 (fixed in the vector).
            authCodeUserSignature = ByteArray(64) { 0x55 },
            installerGitRef = "main",
            rckPubKey = HexUtil.decode(rckPubHex)!!,
            diskEncryption = "none",
        )

        // The TS golden recipe's canonical bytes, reconstructed explicitly so a
        // regression in field order/separator fails loudly (not just at verify).
        val expected =
            "flagship/install-blob/v1|2|home.denone.flagship.services|denone|home|" +
                delegatedPubHex + "|https://flagshipserver.com/api/server/register|" +
                "01DENONE0001|" + userPubHex + "|" + "55".repeat(64) + "|main|" +
                rckPubHex + "|de=none"
        assertEquals(expected, String(blob.canonicalBytes()))

        // The fixed TS signature MUST verify over the Android canonical bytes.
        com.google.crypto.tink.subtle.Ed25519Verify(HexUtil.decode(userPubHex)!!)
            .verify(HexUtil.decode(goldenSigHex)!!, blob.canonicalBytes())
    }

    // The on-wire diskEncryption: "none" is emitted; the "luks" default is
    // omitted (null + encodeDefaults=false), mirroring bootUnlockMode's "auto".
    @Test fun wireBlob_diskEncryption_onlyEmittedWhenNone() {
        fun bundle(de: String?) = InstallBlobBundle(
            blob = WireBlob(
                serverDomain = "home.harry.flagship.services",
                username = "harry",
                serverName = "home",
                phoneDelegatedPubKey = "33".repeat(32),
                authCode = WireAuthCode(
                    serial = "01ABCD",
                    username = "harry",
                    serverName = "home",
                    serverDomain = "home.harry.flagship.services",
                    delegatedPubKey = "33".repeat(32),
                    userPubKey = "22".repeat(32),
                    issuedAt = 1L,
                    expiresAt = 2L,
                ),
                authCodeUserSignature = "44".repeat(64),
                rckPubKey = "55".repeat(32),
                diskEncryption = de,
            ),
            blobSignature = "ab",
        )
        val luks = kotlinx.serialization.json.Json.encodeToString(InstallBlobBundle.serializer(), bundle(null))
        assertFalse(luks.contains("diskEncryption"))
        val none = kotlinx.serialization.json.Json.encodeToString(InstallBlobBundle.serializer(), bundle("none"))
        assertTrue(none.contains("\"diskEncryption\":\"none\""))
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
