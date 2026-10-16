// The watch's Approve is load-bearing crypto: the phone re-fetches and
// re-verifies the box's request, unseals the disk key and posts the sealed
// reply signed with the watch-delegate key (role "delegate"); the watch's
// command carries no consent. Without Quick approve, an unlocked session or
// an account, nothing is posted. Twin of iOS SecretRequestCoordinatorTests'
// watch cases.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.PendingSecretRequest
import com.flagshipserver.app.api.PodDirectoryEntry
import com.flagshipserver.companion.ApproveCommand
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchApprovalTest {
    private val user = "alice"
    private val domain = "kitchen.alice.flagship.services"
    private val issuedAt = 1_750_000_000_000L
    private val irkSeed = ByteArray(32) { 7 }
    private val irkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(irkSeed)
    private val delegateKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 3 })
    private val stkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 5 })
    private val stkPubHex = HexUtil.encode(stkKp.publicKey)
    private val nonceHex = "ab".repeat(32)
    private val luksKey = ByteArray(64) { it.toByte() }

    private fun mailbox(pendingDomain: String = domain) = MockSecretMailboxClient().apply {
        directory = listOf(PodDirectoryEntry(serverDomain = domain, identityPubKey = stkPubHex))
        val sig = HexUtil.encode(
            Ed25519Sign(stkKp.privateKey).sign(
                SecretRequest.canonicalBytes(pendingDomain, stkPubHex, SecretPurpose.UNLOCK_KEY, nonceHex, issuedAt),
            ),
        )
        pending = listOf(
            PendingSecretRequest(
                serverDomain = pendingDomain, requestNonceHex = nonceHex, stkPub = stkPubHex,
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

    private fun coordinator(mock: MockSecretMailboxClient, delegate: Boolean = true) = SecretRequestCoordinator(
        mailbox = mock,
        username = user,
        irk = irkAccess,
        adminSigner = { error("a watch approval mints no owner order") },
        now = { issuedAt },
        nonceGen = { ByteArray(32) { 1 } },
        watchDelegate = {
            if (delegate) WatchDelegateSigner(Ed25519Sign(delegateKp.privateKey), HexUtil.encode(delegateKp.publicKey)) else null
        },
    )

    private fun responder(
        mock: MockSecretMailboxClient,
        enrolled: Boolean = true,
        unlocked: Boolean = true,
        signedIn: Boolean = true,
        made: MutableList<Unit> = mutableListOf(),
    ) = WatchApprovalResponder(
        delegateEnrolled = { enrolled },
        hasSessionKey = { unlocked },
        makeSource = {
            made += Unit
            if (signedIn) coordinator(mock).asWatchApprovalSource() else null
        },
        now = { issuedAt },
    )

    private fun header(auth: String) =
        Json.parseToJsonElement(
            String(java.util.Base64.getUrlDecoder().decode(auth.removePrefix("Flagship-Boot-v1 "))),
        ).jsonObject

    @Test fun approveSignsTheBootResponseWithTheDelegateKey() = runBlocking {
        val mock = mailbox()
        val reply = responder(mock).respond(ApproveCommand(serverFqdn = domain))
        assertTrue(reply.errorMessage, reply.ok)

        val (body, auth) = mock.postedResponses.single()
        assertEquals("unlock-key", body.purpose)
        assertEquals(nonceHex, body.requestNonceHex)
        val h = header(auth)
        assertEquals("delegate", h["role"]!!.jsonPrimitive.content)
        assertEquals("/api/boot/response", h["path"]!!.jsonPrimitive.content)
        assertEquals(HexUtil.encode(delegateKp.publicKey), h["pubKeyHex"]!!.jsonPrimitive.content)
        val canon = BootAuth.canonicalBytes(
            "delegate", domain, "POST", "/api/boot/response",
            h["pubKeyHex"]!!.jsonPrimitive.content, h["nonceHex"]!!.jsonPrimitive.content, h["issuedAt"]!!.jsonPrimitive.long,
        )
        Ed25519Verify(delegateKp.publicKey).verify(HexUtil.decode(h["signatureHex"]!!.jsonPrimitive.content)!!, canon)
        // The delegate can't authorize serving: no owner entitlement rides along.
        assertTrue(mock.entitlementDeposits.isEmpty())
        assertTrue(mock.deposited.isEmpty())
    }

    @Test fun theRequestIdMustBeTheBoxs() = runBlocking {
        val mock = mailbox()
        val reply = responder(mock).respond(ApproveCommand(requestId = "$domain#$nonceHex", serverFqdn = domain))
        assertTrue(reply.ok)
        val other = responder(mailbox()).respond(ApproveCommand(serverFqdn = "attic.alice.flagship.services"))
        assertFalse(other.ok)
        assertEquals(WatchApprovalResponder.GONE, other.errorMessage)
    }

    @Test fun aRequestTheDirectoryDoesntVouchForIsNeverApproved() = runBlocking {
        val mock = mailbox(pendingDomain = "attic.alice.flagship.services")
        val reply = responder(mock).respond(ApproveCommand(serverFqdn = "attic.alice.flagship.services"))
        assertFalse(reply.ok)
        assertTrue(mock.postedResponses.isEmpty())
    }

    @Test fun refusesWithoutQuickApproveAnUnlockedSessionOrAnAccount() = runBlocking {
        val made = mutableListOf<Unit>()
        val m1 = mailbox()
        assertEquals(
            WatchApprovalResponder.NOT_ENROLLED,
            responder(m1, enrolled = false, made = made).respond(ApproveCommand(serverFqdn = domain)).errorMessage,
        )
        assertEquals(
            WatchApprovalResponder.OPEN_AND_UNLOCK,
            responder(m1, unlocked = false, made = made).respond(ApproveCommand(serverFqdn = domain)).errorMessage,
        )
        assertTrue("no relay call before both checks pass", made.isEmpty())
        assertEquals(
            WatchApprovalResponder.SIGNED_OUT,
            responder(m1, signedIn = false).respond(ApproveCommand(serverFqdn = domain)).errorMessage,
        )
        assertEquals(
            WatchApprovalResponder.UNSUPPORTED,
            responder(m1).respond(ApproveCommand(kind = "wipe", serverFqdn = domain)).errorMessage,
        )
        assertTrue(m1.postedResponses.isEmpty())
    }

    /** Before the session's first biometric the watch is told precisely what to
     *  do, and the phone learns the watch is waiting, without relaying, signing
     *  or prompting anything. */
    @Test fun beforeTheFirstBiometricTheWatchIsToldWhatToDo() = runBlocking {
        val m = mailbox()
        val waiting = mutableListOf<String>()
        val made = mutableListOf<Unit>()
        fun responder(enrolled: Boolean = true, inFront: Boolean) = WatchApprovalResponder(
            delegateEnrolled = { enrolled },
            hasSessionKey = { false },
            makeSource = { made += Unit; coordinator(m).asWatchApprovalSource() },
            now = { issuedAt },
            appInForeground = { inFront },
            onNeedsUnlock = { waiting += it.serverFqdn },
        )
        val open = responder(inFront = true).respond(ApproveCommand(serverFqdn = domain))
        assertFalse(open.ok)
        assertEquals(WatchApprovalResponder.UNLOCK_ONCE, open.errorMessage)
        assertEquals(
            WatchApprovalResponder.OPEN_AND_UNLOCK,
            responder(inFront = false).respond(ApproveCommand(serverFqdn = domain)).errorMessage,
        )
        assertEquals(listOf(domain, domain), waiting)
        assertEquals(
            WatchApprovalResponder.NOT_ENROLLED,
            responder(enrolled = false, inFront = true).respond(ApproveCommand(serverFqdn = domain)).errorMessage,
        )
        assertEquals("Quick approve off: nothing for the app to unlock", 2, waiting.size)
        assertTrue("no relay call without the session", made.isEmpty())
        assertTrue(m.postedResponses.isEmpty())
    }

    @Test fun theWaitingPromptAsksOnlyInFrontUnlockedAndWithoutTheSession() {
        var clock = 1_000L
        val prompt = WatchApprovalPrompt(now = { clock })
        assertFalse(prompt.shouldAsk(inFront = true, appUnlocked = true, sessionUnlocked = false))
        prompt.watchIsWaiting(domain)
        assertEquals(domain, prompt.current()?.serverFqdn)
        assertTrue(prompt.shouldAsk(inFront = true, appUnlocked = true, sessionUnlocked = false))
        assertFalse("never from the background", prompt.shouldAsk(inFront = false, appUnlocked = true, sessionUnlocked = false))
        assertFalse("the lock screen says it instead", prompt.shouldAsk(inFront = true, appUnlocked = false, sessionUnlocked = false))
        assertFalse("already unlocked once", prompt.shouldAsk(inFront = true, appUnlocked = true, sessionUnlocked = true))
        clock += WatchApprovalPrompt.LIFETIME_MS
        assertEquals("an old ask expires with the boot request", null, prompt.current())
        prompt.watchIsWaiting(" ")
        assertEquals(null, prompt.current()?.serverFqdn)
        prompt.clear()
        assertEquals(null, prompt.waiting.value)
        assertTrue(WatchApprovalPrompt.message("Kitchen").contains("Kitchen's start-up"))
        assertTrue(WatchApprovalPrompt.message(null).contains("a server's start-up"))
    }

    @Test fun thePhonesOwnApproveStaysOwnerSigned() = runBlocking {
        val mock = mailbox()
        val coord = SecretRequestCoordinator(
            mailbox = mock, username = user, irk = irkAccess,
            now = { issuedAt }, nonceGen = { ByteArray(32) { 1 } },
        )
        coord.approvePendingUnlock(domain)
        assertEquals("owner", header(mock.postedResponses.single().second)["role"]!!.jsonPrimitive.content)
        assertEquals(1, mock.entitlementDeposits.size)
    }
}
