package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.DebugAccess
import com.flagshipserver.app.core.InstallBlobBundle
import com.flagshipserver.app.core.WireAuthCode
import com.flagshipserver.app.core.WireBlob
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Advanced "Debug-friendly server" toggle bakes an admin-signed
 * `flagship/debug-access/v2` grant for the pasted SSH key into the recipe as
 * the UNSIGNED `debugGrant` sibling (7 days from mint); the recipe carries no
 * `debugGrant` when it's off.
 */
class DebugGrantEnvelopeTest {
    private val key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3"
    private val adminSeed = ByteArray(32) { 0x5a }
    private val adminPub = Ed25519Sign.KeyPair.newKeyPairFromSeed(adminSeed).publicKey

    @Test fun debugToggleOn_embedsAV2GrantForThePastedKey() {
        val serverDomain = "home.harry.flagship.services"
        val envelope = debugGrantEnvelope(serverDomain, "  $key harry@laptop\n", Ed25519Sign(adminSeed), now = 1700L)

        val obj = Json.parseToJsonElement(envelope).jsonObject
        val g = obj["grant"]!!.jsonObject
        val grant = DebugAccess.Grant(
            serverDomain = g["serverDomain"]!!.jsonPrimitive.content,
            sshPublicKey = g["sshPublicKey"]!!.jsonPrimitive.content,
            issuedAt = g["issuedAt"]!!.jsonPrimitive.long,
            expiresAt = g["expiresAt"]!!.jsonPrimitive.long,
        )
        assertEquals(key, grant.sshPublicKey)
        assertEquals(1700L + DebugAccess.MAX_MS, grant.expiresAt)
        assertEquals(
            "flagship/debug-access/v2|home.harry.flagship.services|$key|1700|${1700L + DebugAccess.MAX_MS}",
            String(DebugAccess.canonicalBytes(grant)),
        )
        assertTrue(DebugAccess.verify(grant, obj["signatureHex"]!!.jsonPrimitive.content, adminPub))
    }

    @Test fun aMissingOrBadKeyIsRefusedWithASentence() {
        assertEquals("Debug access needs an SSH public key.", debugSshKeyProblem("  "))
        assertEquals("That isn't an SSH public key this server can use.", debugSshKeyProblem("hello"))
        assertNull(debugSshKeyProblem("$key me"))
        assertThrows(IllegalArgumentException::class.java) {
            debugGrantEnvelope("home.harry.flagship.services", "", Ed25519Sign(adminSeed), now = 1700L)
        }
    }

    @Test fun toggleOff_recipeHasNoDebugGrant() {
        val json = Json.encodeToString(InstallBlobBundle.serializer(), sampleBundle(debugGrant = null))
        assertFalse("a non-debug recipe must omit debugGrant", json.contains("debugGrant"))
    }

    @Test fun toggleOn_recipeCarriesDebugGrant() {
        val envelope = debugGrantEnvelope("home.harry.flagship.services", key, Ed25519Sign(adminSeed), now = 1700L)
        val json = Json.encodeToString(InstallBlobBundle.serializer(), sampleBundle(debugGrant = envelope))
        assertTrue("a debug recipe must carry debugGrant", json.contains("debugGrant"))
    }

    private fun sampleBundle(debugGrant: String?) = InstallBlobBundle(
        blob = WireBlob(
            serverDomain = "home.harry.flagship.services",
            username = "harry",
            serverName = "home",
            phoneDelegatedPubKey = "00",
            authCode = WireAuthCode(
                serial = "S",
                username = "harry",
                serverName = "home",
                serverDomain = "home.harry.flagship.services",
                delegatedPubKey = "00",
                userPubKey = "00",
                issuedAt = 1L,
                expiresAt = 2L,
            ),
            authCodeUserSignature = "00",
            rckPubKey = "00",
        ),
        blobSignature = "00",
        debugGrant = debugGrant,
    )
}
