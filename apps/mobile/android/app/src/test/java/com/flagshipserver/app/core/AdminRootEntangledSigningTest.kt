// Slice D Phase 2 (final) — the DUAL-SIGNER split for the "entangled" deposit
// ops + the transfer claim. Each of these carriers pairs a SENSITIVE ORDER with
// an IRK-bound transport envelope (mailbox-auth or the QR identity field). The
// order must sign with the ADMIN MASTER ROOT (`orderKey`) when the device holds
// one, while the transport envelope STAYS the membership IRK. These pin that the
// builders route the two keys correctly and that the canonical bytes are
// byte-identical (only the signing key changes).

package com.flagshipserver.app.core

import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.PendingSecretRequest
import com.flagshipserver.app.api.PodDirectoryEntry
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.security.GeneralSecurityException

class AdminRootEntangledSigningTest {
    private val user = "alice"
    private val serverDomain = "kitchen.alice.flagship.services"
    private val stkHex = "fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618"
    private val issuedAt = 1_750_000_000_000L

    private val irkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 7 })
    private val adminKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 9 })
    private val irk get() = Ed25519Sign(irkKp.privateKey)
    private val admin get() = Ed25519Sign(adminKp.privateKey)
    private val irkPubHex get() = HexUtil.encode(irkKp.publicKey)
    private val adminPubHex get() = HexUtil.encode(adminKp.publicKey)

    // ── set-leader vote ───────────────────────────────────────────────────────

    @Test
    fun setLeader_orderSignsWithAdminRoot_authStaysIrk() {
        val body = SetLeaderDeposit.buildDeposit(
            username = user, serverDomain = serverDomain, preferredStkPubHex = stkHex,
            irk = irk, irkPubHex = irkPubHex, now = issuedAt, orderKey = admin,
        )
        val canonical = CloudGossip.setLeaderCanonicalBytes(
            body.vote.user, body.vote.preferredStkPubHex, body.vote.issuedAt, body.vote.nonce,
        )
        // The VOTE verifies under the admin root...
        Ed25519Verify(adminKp.publicKey).verify(HexUtil.decode(body.signature)!!, canonical)
        // ...and NOT under the membership IRK.
        assertThrows(GeneralSecurityException::class.java) {
            Ed25519Verify(irkKp.publicKey).verify(HexUtil.decode(body.signature)!!, canonical)
        }
        // The mailbox AUTH envelope stays the membership IRK (deposit credential).
        assertEquals(irkPubHex, body.auth.phoneIrkPub)
    }

    @Test
    fun setLeader_noOrderKey_isByteIdenticalIrkSigned() {
        val withNull = SetLeaderDeposit.buildDeposit(
            username = user, serverDomain = serverDomain, preferredStkPubHex = stkHex,
            irk = irk, irkPubHex = irkPubHex, now = issuedAt,
            mailboxNonceHex = "aa".repeat(32), depositNonceHex = "bb".repeat(32), voteNonceHex = "cc".repeat(32),
        )
        val explicitIrk = SetLeaderDeposit.buildDeposit(
            username = user, serverDomain = serverDomain, preferredStkPubHex = stkHex,
            irk = irk, irkPubHex = irkPubHex, now = issuedAt, orderKey = irk,
            mailboxNonceHex = "aa".repeat(32), depositNonceHex = "bb".repeat(32), voteNonceHex = "cc".repeat(32),
        )
        // Passing the IRK as the orderKey is identical to the legacy (null) path.
        assertEquals(withNull.signature, explicitIrk.signature)
        Ed25519Verify(irkKp.publicKey).verify(
            HexUtil.decode(withNull.signature)!!,
            CloudGossip.setLeaderCanonicalBytes(user, stkHex, issuedAt, "cc".repeat(32)),
        )
    }

    // ── decommission / replace ────────────────────────────────────────────────

    @Test
    fun decommission_orderSignsWithAdminRoot_authStaysIrk() {
        val body = ReplaceServerFlow.buildDeposit(
            serverFqdn = serverDomain, username = user, irk = irk, irkPubHex = irkPubHex,
            orderKey = admin, retiredStkPubHex = stkHex, finalBackup = true,
            disposition = ReplaceServerFlow.Disposition.WipeAfterHandoff, issuedAt = issuedAt,
        )
        val canonical = ServerDecommissionOrder.canonicalBytes(
            podCanonical = body.order.podCanonical,
            retiredStkPubHex = body.order.retiredStkPubHex,
            finalBackup = body.order.finalBackup,
            diskDisposition = body.order.diskDisposition,
            backupEpoch = body.order.backupEpoch,
            nonce = body.order.nonce,
            issuedAt = body.order.issuedAt,
        )
        Ed25519Verify(adminKp.publicKey).verify(HexUtil.decode(body.signature)!!, canonical)
        assertThrows(GeneralSecurityException::class.java) {
            Ed25519Verify(irkKp.publicKey).verify(HexUtil.decode(body.signature)!!, canonical)
        }
        assertEquals(irkPubHex, body.auth.phoneIrkPub)
    }

    // ── transfer OFFER (giver) ────────────────────────────────────────────────

    @Test
    fun transferOffer_orderSignsWithAdminRoot_qrGiverPubTracksIt_authStaysIrk() {
        val built = ServerTransferFlow.buildOffer(
            serverDomain = serverDomain, username = user, irk = irk, irkPubHex = irkPubHex,
            issuedAt = issuedAt, orderKey = admin, orderKeyPubHex = adminPubHex,
        )
        val canonical = ServerTransferOfferOrder.canonicalBytes(
            serverDomain, built.body.offer.transferNonce, issuedAt, built.body.offer.expiresAt,
        )
        // The offer signature verifies under the admin root, NOT the IRK.
        Ed25519Verify(adminKp.publicKey).verify(HexUtil.decode(built.body.offerSignature)!!, canonical)
        assertThrows(GeneralSecurityException::class.java) {
            Ed25519Verify(irkKp.publicKey).verify(HexUtil.decode(built.body.offerSignature)!!, canonical)
        }
        // The QR `giverIrkPub` TRACKS the signing key so the acquirer's local
        // verifyOfferSignature passes (it checks the sig under this field).
        assertEquals(adminPubHex.lowercase(), built.qr.giverIrkPub)
        assert(ServerTransferFlow.verifyOfferSignature(built.qr))
        // The mailbox AUTH stays the membership IRK.
        assertEquals(irkPubHex, built.body.auth.phoneIrkPub)
    }

    // ── transfer CLAIM (acquirer) ─────────────────────────────────────────────

    @Test
    fun transferClaim_orderSignsWithAdminRoot_identityFieldStaysIrk() {
        // A valid offer to claim (signed by the giver, irrelevant which key).
        val giver = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 3 })
        val offer = ServerTransferFlow.buildOffer(
            serverDomain = serverDomain, username = "giver", irk = Ed25519Sign(giver.privateKey),
            irkPubHex = HexUtil.encode(giver.publicKey), issuedAt = issuedAt, ttlMs = 9_000_000L,
        ).qr

        val body = ServerTransferFlow.buildClaim(
            offer, user, irk, irkPubHex, issuedAt + 1, admin,
            acquirerAdminRootPubHex = adminPubHex,
        )
        val canonical = ServerTransferClaimOrder.canonicalBytes(
            offer.serverDomain, offer.transferNonce, user.lowercase(), irkPubHex, adminPubHex, issuedAt + 1,
        )
        // The claim ORDER verifies under the acquirer's admin root, NOT the IRK.
        Ed25519Verify(adminKp.publicKey).verify(HexUtil.decode(body.claimSignature)!!, canonical)
        assertThrows(GeneralSecurityException::class.java) {
            Ed25519Verify(irkKp.publicKey).verify(HexUtil.decode(body.claimSignature)!!, canonical)
        }
        // ...but the `acquirerIrkPub` IDENTITY field stays the registered IRK
        // (`.com` matches it against the acquirer's account, independent of the sig).
        assertEquals(irkPubHex.lowercase(), body.claim.acquirerIrkPub)
        // The §9.8 admin-root pub rides the wire AND the signed canonical above.
        assertEquals(adminPubHex.lowercase(), body.claim.acquirerAdminRootPub)
    }

    // ── RootEntitlement (bring-a-box-online — owner decision: ADMIN-ROOT) ──────

    @Test
    fun entitlementCeremony_mintsAdminRootSignedRootEntitlement() {
        // A reburned admin-pinned box REJECTS an IRK-signed RootEntitlement at
        // HELLO, so the boot-approval ceremony must sign the mint with the admin
        // root when this device holds one. This drives the coordinator end-to-end
        // through a mock mailbox and inspects the posted entitlement carrier.
        val stkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 5 })
        val stkPubHex = HexUtil.encode(stkKp.publicKey)
        val nonceHex = "ab".repeat(32)

        val reqSig = HexUtil.encode(
            Ed25519Sign(stkKp.privateKey).sign(
                SecretRequest.canonicalBytes(serverDomain, stkPubHex, SecretPurpose.ENTITLEMENT, nonceHex, issuedAt),
            ),
        )
        val mock = MockSecretMailboxClient().apply {
            directory = listOf(PodDirectoryEntry(serverDomain = serverDomain, identityPubKey = stkPubHex))
            pending = listOf(
                PendingSecretRequest(
                    serverDomain = serverDomain, requestNonceHex = nonceHex, stkPub = stkPubHex,
                    purpose = "entitlement", issuedAt = issuedAt, requestSignature = reqSig,
                    postedAt = issuedAt, expiresAt = issuedAt + 600_000,
                ),
            )
        }
        val irkSeed = ByteArray(32) { 7 }   // == irkKp seed above
        val irkAccess = object : IrkAccess {
            override suspend fun resolve(reason: String) =
                IrkMaterial(signer = irk, seed = irkSeed, pubHex = irkPubHex)
        }
        val coord = SecretRequestCoordinator(
            mailbox = mock,
            username = user,
            irk = irkAccess,
            adminSigner = { admin },              // this device holds an admin root
            now = { issuedAt },
            nonceGen = { ByteArray(32) { 1 } },
        )

        runBlocking { coord.approvePendingEntitlement(serverDomain) }

        // The posted entitlement carrier holds a RootEntitlement signed by the
        // ADMIN ROOT (not the IRK) over the canonical entitlement bytes.
        val carrierHex = mock.postedResponses.single().first.sealed
        val json = String(HexUtil.decode(carrierHex)!!, Charsets.UTF_8)
        val sigHex = Regex("\"rootEntitlementSig\":\"([0-9a-fA-F]+)\"").find(json)!!.groupValues[1]
        val canonical = RootEntitlement.canonicalBytes(user, stkPubHex, serverDomain, issuedAt)

        Ed25519Verify(adminKp.publicKey).verify(HexUtil.decode(sigHex)!!, canonical)
        assertThrows(GeneralSecurityException::class.java) {
            Ed25519Verify(irkKp.publicKey).verify(HexUtil.decode(sigHex)!!, canonical)
        }
        // The mailbox-auth on the folded entitlement deposit stays the IRK; the
        // entitlement deposit likewise rode the same carrier.
        assertEquals(irkPubHex, mock.lastPostedAuth!!.auth.phoneIrkPub)
    }
}
