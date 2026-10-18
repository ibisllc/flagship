// The auto-unlock lease is signed by the owner IRK, even on a device that holds
// the admin root. The boot worker verifies the lease body against the IRK in
// the Authorization header (boot-core handleDepositLease) and answers 403
// "invalid lease signature" for anything else; with the admin root signing, no
// lease was ever stored and every restart asked the phone again. The mock
// mailbox applies the worker's rule, and the shared vector fixes both
// signatures over the real canonical bytes (packages/protocol/test-vectors/
// auto-unlock-lease, also read by the TypeScript side).

package com.flagshipserver.app.core

import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.PendingSecretRequest
import com.flagshipserver.app.api.PodDirectoryEntry
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.io.IOException

class AutoUnlockLeaseSignerTest {
    private val user = "alice"
    private val domain = "kitchen.alice.flagship.services"
    private val issuedAt = 1_750_000_000_000L
    private val irkSeed = ByteArray(32) { 7 }
    private val irkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(irkSeed)
    private val adminKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 9 })
    private val stkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 5 })
    private val stkPubHex = HexUtil.encode(stkKp.publicKey)
    private val nonceHex = "ab".repeat(32)
    private val luksKey = ByteArray(64) { it.toByte() }

    private fun mailbox() = MockSecretMailboxClient().apply {
        directory = listOf(PodDirectoryEntry(serverDomain = domain, identityPubKey = stkPubHex))
        val sig = HexUtil.encode(
            Ed25519Sign(stkKp.privateKey).sign(
                SecretRequest.canonicalBytes(domain, stkPubHex, SecretPurpose.UNLOCK_KEY, nonceHex, issuedAt),
            ),
        )
        pending = listOf(
            PendingSecretRequest(
                serverDomain = domain, requestNonceHex = nonceHex, stkPub = stkPubHex,
                purpose = "unlock-key", issuedAt = issuedAt, requestSignature = sig,
                postedAt = issuedAt, expiresAt = issuedAt + 600_000,
            ),
        )
        sealedLuksKeyHex = HexUtil.encode(SecretSeal.sealForEd25519Recipient(luksKey, irkKp.publicKey))
    }

    private val irkAccess = object : IrkAccess {
        override suspend fun resolve(reason: String) =
            IrkMaterial(Ed25519Sign(irkKp.privateKey), irkSeed, HexUtil.encode(irkKp.publicKey))
    }

    private class MemoryLeases : PendingLeases {
        val map = mutableMapOf<String, PendingLease>()
        override fun put(serverDomain: String, pending: PendingLease) { map[serverDomain] = pending }
        override fun clear(serverDomain: String) { map.remove(serverDomain) }
        override fun all() = map.toMap()
    }

    /** A device that holds the admin root: the order key the coordinator is handed is the root. */
    private fun coordinator(mock: MockSecretMailboxClient, leases: PendingLeases? = null) = SecretRequestCoordinator(
        mailbox = mock,
        username = user,
        irk = irkAccess,
        adminSigner = { Ed25519Sign(adminKp.privateKey) },
        now = { issuedAt },
        nonceGen = { ByteArray(32) { 1 } },
        pendingLeases = leases,
        leaseRetryDelaysMs = listOf(0L, 0L),
    )

    private fun approve(c: SecretRequestCoordinator): String? = runBlocking {
        val req = c.fetchVerifiedRequests().single()
        c.confirmAndRespond(req, depositAutoLease = true)
    }

    private fun verifies(pub: ByteArray, sig: ByteArray, msg: ByteArray) =
        runCatching { Ed25519Verify(pub).verify(sig, msg) }.isSuccess

    @Test fun anAdminRootDeviceSignsTheLeaseWithTheIrk() {
        val mock = mailbox()
        val leaseId = approve(coordinator(mock))
        assertNotNull("the worker took the lease", leaseId)
        // The worker stored it, so a restart unlocks without the phone.
        assertTrue(mock.secondBoot(domain))
        val (wire, sigHex, auth) = mock.deposited.single()
        val lease = AutoUnlockLeaseV2(
            wire.serverDomain, HexUtil.decode(wire.stkPub)!!, wire.leaseId,
            HexUtil.decode(wire.sealedKey)!!, wire.issuedAt, wire.expiresAt, wire.maxUses,
        )
        val sig = HexUtil.decode(sigHex)!!
        assertTrue("verifies under the IRK on the real canonical bytes", verifies(irkKp.publicKey, sig, lease.canonicalBytes()))
        assertFalse("not under the admin root", verifies(adminKp.publicKey, sig, lease.canonicalBytes()))
        // ...and the Authorization header names that same IRK.
        val h = Json.parseToJsonElement(String(java.util.Base64.getUrlDecoder().decode(auth.removePrefix("Flagship-Boot-v1 ")))).jsonObject
        assertEquals(HexUtil.encode(irkKp.publicKey), h["pubKeyHex"]!!.jsonPrimitive.content)
        assertEquals("PUT", h["method"]!!.jsonPrimitive.content)
    }

    @Test fun theMockWorkerRefusesARootSignedLeaseLikeTheRealOne() {
        val mock = mailbox()
        val lease = AutoUnlockLeaseV2.build(domain, stkKp.publicKey, "a".repeat(32), luksKey, issuedAt, issuedAt + 60_000)
        val wire = com.flagshipserver.app.api.BoxSealedLeaseWire(
            lease.serverDomain, HexUtil.encode(lease.stkPub), lease.leaseId, HexUtil.encode(lease.sealedKey),
            lease.issuedAt, lease.expiresAt, lease.maxUses,
        )
        val auth = BootAuth.ownerHeader(
            domain, "PUT", "/api/boot/lease", Ed25519Sign(irkKp.privateKey), HexUtil.encode(irkKp.publicKey),
            issuedAt, ByteArray(16) { 2 },
        )
        val e = runCatching {
            runBlocking { mock.depositBoxSealedLease(wire, HexUtil.encode(lease.sign(Ed25519Sign(adminKp.privateKey))), auth) }
        }.exceptionOrNull() as HttpException
        assertEquals(403, e.status)
        assertTrue(e.body.contains("invalid lease signature"))
        assertFalse(mock.secondBoot(domain))
        runBlocking { mock.depositBoxSealedLease(wire, HexUtil.encode(lease.sign(Ed25519Sign(irkKp.privateKey))), auth) }
        assertTrue(mock.secondBoot(domain))
    }

    @Test fun aRefusedLeaseNeverFailsTheApprovalAndIsNotKept() {
        val mock = mailbox().apply { leaseDepositError = HttpException(403, """{"error":"invalid lease signature"}""") }
        val kept = MemoryLeases()
        assertNull(approve(coordinator(mock, kept)))
        assertEquals("the unlock reply was answered", 1, mock.postedResponses.size)
        assertTrue("a refusal would be refused again", kept.map.isEmpty())
    }

    @Test fun aLeaseThatFailedInPassingIsSentAgainLater() {
        val mock = mailbox()
        val kept = MemoryLeases()
        // The worker is unreachable for all three tries of the approval, then back.
        val flaky = object {
            var left = 3
        }
        val req = runBlocking { coordinator(mock).fetchVerifiedRequests().single() }
        val failing = object : com.flagshipserver.app.api.SecretMailboxClient by mock {
            override suspend fun depositBoxSealedLease(lease: com.flagshipserver.app.api.BoxSealedLeaseWire, signatureHex: String, bootAuth: String) {
                if (flaky.left-- > 0) throw IOException("no connection")
                mock.depositBoxSealedLease(lease, signatureHex, bootAuth)
            }
        }
        val c2 = SecretRequestCoordinator(
            mailbox = failing, username = user, irk = irkAccess,
            adminSigner = { Ed25519Sign(adminKp.privateKey) }, now = { issuedAt },
            nonceGen = { ByteArray(32) { 1 } }, pendingLeases = kept, leaseRetryDelaysMs = listOf(0L, 0L),
        )
        assertNull(runBlocking { c2.confirmAndRespond(req, depositAutoLease = true) })
        assertEquals("kept to send again", 1, kept.map.size)
        assertFalse(mock.secondBoot(domain))
        // The next foreground: the worker answers, the lease goes in and is forgotten.
        val done = runBlocking { c2.retryPendingLeases() }
        assertEquals(1, done.size)
        assertEquals(domain, done.single().first)
        assertTrue(mock.secondBoot(domain))
        assertTrue(kept.map.isEmpty())
    }

    // ── the shared vector ────────────────────────────────────────────────────

    private fun vectors(): kotlinx.serialization.json.JsonObject {
        val rel = "packages/protocol/test-vectors/auto-unlock-lease/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        var hops = 0
        while (dir != null && hops < 14) {
            val f = File(dir, rel)
            if (f.isFile) return Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile; hops++
        }
        fail("could not locate $rel"); error("unreachable")
    }

    @Test fun theSharedVectorPinsTheCanonicalBytesAndBothSignatures() {
        val v = vectors()
        fun s(k: String) = v[k]!!.jsonPrimitive.content
        val l = v["lease"]!!.jsonObject
        fun ls(k: String) = l[k]!!.jsonPrimitive.content
        val lease = AutoUnlockLeaseV2(
            ls("serverDomain"), HexUtil.decode(ls("stkPubHex"))!!, ls("leaseId"), HexUtil.decode(ls("sealedKeyHex"))!!,
            l["issuedAt"]!!.jsonPrimitive.long, l["expiresAt"]!!.jsonPrimitive.long,
        )
        assertEquals(s("canonical"), String(lease.canonicalBytes()))
        val irk = Ed25519Sign.KeyPair.newKeyPairFromSeed(HexUtil.decode(s("irkSeedHex"))!!)
        val admin = Ed25519Sign.KeyPair.newKeyPairFromSeed(HexUtil.decode(s("adminSeedHex"))!!)
        assertEquals(s("irkPubHex"), HexUtil.encode(irk.publicKey))
        assertEquals(s("irkSignatureHex"), HexUtil.encode(lease.sign(Ed25519Sign(irk.privateKey))))
        assertEquals(s("adminSignatureHex"), HexUtil.encode(lease.sign(Ed25519Sign(admin.privateKey))))
        // The worker's check: the admin-root signature does not verify under the IRK.
        assertFalse(verifies(irk.publicKey, HexUtil.decode(s("adminSignatureHex"))!!, lease.canonicalBytes()))
        assertTrue(verifies(irk.publicKey, HexUtil.decode(s("irkSignatureHex"))!!, lease.canonicalBytes()))
        assertArrayEquals(lease.canonicalBytes(), s("canonical").toByteArray())
    }
}
