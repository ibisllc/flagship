// Pins the phone-side STK derivation (UMK → SWK → STK) to the
// cross-platform vector in packages/protocol/tests/daemonStatus.test.ts —
// the trust anchor for verifying STK-signed daemon-status reports without
// trusting `.com`'s identityPubKey echo.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerKeysTest {

    // Pinned cross-platform SWK vector (packages/protocol/tests/keys.test.ts):
    //   umk.seed = 32 × 0x07, serverId = "srv-vector-1"
    //   → SWK = HKDF-SHA256(seed, info="flagship.swk.v1|srv-vector-1", 32)
    private val swkVectorSeed = ByteArray(32) { 0x07 }
    private val swkVectorServerId = "srv-vector-1"
    private val swkVectorHex =
        "55c865a17c9106f0cb6847da659706ed7601e6769253f9b11d851e013b421377"

    @Test fun deriveSwkReproducesThePinnedVector() {
        // The BOX SWK (DOTS info "flagship.swk.v1|<serverId>") — the
        // protocol/daemon derivation, NOT the app-backup slash form.
        val swk = ServerKeys.deriveSwk(swkVectorSeed, swkVectorServerId)
        assertEquals(swkVectorHex, HexUtil.encode(swk))
    }

    @Test fun deriveSwkDiffersPerServerId() {
        val a = ServerKeys.deriveSwk(swkVectorSeed, "srv-A")
        val b = ServerKeys.deriveSwk(swkVectorSeed, "srv-B")
        assertNotEquals(HexUtil.encode(a), HexUtil.encode(b))
    }

    @Test fun createBundleEmbeds64HexSwkSiblingFromBoxDerivation() {
        val swkHex = HexUtil.encode(ServerKeys.deriveSwk(swkVectorSeed, swkVectorServerId))
        assertEquals(64, swkHex.length)
        val bundle = InstallBlobBundle(
            blob = WireBlob(
                serverDomain = "home.harry.flagship.services",
                username = "harry",
                serverName = "home",
                phoneDelegatedPubKey = "11".repeat(32),
                authCode = WireAuthCode(
                    serial = "01ABCD",
                    username = "harry",
                    serverName = "home",
                    serverDomain = "home.harry.flagship.services",
                    delegatedPubKey = "11".repeat(32),
                    userPubKey = "22".repeat(32),
                    issuedAt = 1_000,
                    expiresAt = 2_000,
                ),
                authCodeUserSignature = "44".repeat(64),
                rckPubKey = "55".repeat(32),
            ),
            blobSignature = "ab",
            swkHex = swkHex,
        )
        val json = Json.encodeToString(InstallBlobBundle.serializer(), bundle)
        assertTrue(json.contains("\"swkHex\":\"$swkHex\""))
    }

    @Test fun absentSwkOmitsSiblingFromWire() {
        val bundle = InstallBlobBundle(
            blob = WireBlob(
                serverDomain = "home.harry.flagship.services",
                username = "harry",
                serverName = "home",
                phoneDelegatedPubKey = "11".repeat(32),
                authCode = WireAuthCode(
                    serial = "01ABCD",
                    username = "harry",
                    serverName = "home",
                    serverDomain = "home.harry.flagship.services",
                    delegatedPubKey = "11".repeat(32),
                    userPubKey = "22".repeat(32),
                    issuedAt = 1_000,
                    expiresAt = 2_000,
                ),
                authCodeUserSignature = "44".repeat(64),
                rckPubKey = "55".repeat(32),
            ),
            blobSignature = "ab",
        )
        val json = Json.encodeToString(InstallBlobBundle.serializer(), bundle)
        assertFalse(json.contains("swkHex"))
    }

    @Test fun derivesThePinnedStkPubFromThePinnedUmkAndServerId() {
        val pub = ServerKeys.deriveStkPub(
            DaemonStatusVector.UMK_SEED, DaemonStatusVector.SERVER_ID,
        )
        assertEquals(DaemonStatusVector.STK_PUB_HEX, HexUtil.encode(pub))
    }

    @Test fun derivedStkSeedReproducesThePinnedSignatures() {
        // End-to-end HKDF + Ed25519 determinism: signing the pinned canonical
        // bytes with the derived STK private seed yields the pinned signature.
        val seed = ServerKeys.deriveStkSeed(
            DaemonStatusVector.UMK_SEED, DaemonStatusVector.SERVER_ID,
        )
        val signer = Ed25519Sign(seed)
        assertEquals(
            DaemonStatusVector.SIG_HEX,
            HexUtil.encode(signer.sign(DaemonStatusReport.canonicalBytes(DaemonStatusVector.REPORT))),
        )
        assertEquals(
            DaemonStatusVector.NULL_SIG_HEX,
            HexUtil.encode(signer.sign(DaemonStatusReport.canonicalBytes(DaemonStatusVector.NULL_REPORT))),
        )
    }

    @Test fun differentServerIdYieldsADifferentStk() {
        val a = ServerKeys.deriveStkPub(DaemonStatusVector.UMK_SEED, DaemonStatusVector.SERVER_ID)
        val b = ServerKeys.deriveStkPub(DaemonStatusVector.UMK_SEED, "other.harry1.flagship.services")
        assertNotEquals(HexUtil.encode(a), HexUtil.encode(b))
    }

    @Test fun differentUmkYieldsADifferentStk() {
        val a = ServerKeys.deriveStkPub(DaemonStatusVector.UMK_SEED, DaemonStatusVector.SERVER_ID)
        val b = ServerKeys.deriveStkPub(ByteArray(32) { 0x08 }, DaemonStatusVector.SERVER_ID)
        assertNotEquals(HexUtil.encode(a), HexUtil.encode(b))
    }

    @Test fun rejectsANon32ByteUmkSeed() {
        assertThrows(IllegalArgumentException::class.java) {
            ServerKeys.deriveSwk(ByteArray(31), DaemonStatusVector.SERVER_ID)
        }
        assertThrows(IllegalArgumentException::class.java) {
            ServerKeys.deriveStkPub(ByteArray(33), DaemonStatusVector.SERVER_ID)
        }
    }
}
