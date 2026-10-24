// GYM Android: the 0.3 security screens. App chat requests (N08): the dialog raised on a
// content-free push and Activity's App chat requests list, Allow / Always allow / Deny each an
// admin-signed flagship/chat-approval/v1, and Ask me each time. AI-run consent (N12): a git
// adapt the box answers 428 shows the estimate, Continue resends it with a signed consent, Cancel
// sends nothing. The watch boot key (option (a)): a per-server switch under Approve from watch
// deposits an attested copy of the disk key, and off takes it away. NO BACKEND: the mock box and
// `.com` check each signature the way the real ones do on an admin-pinned account.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.flagshipserver.app.api.ChatAppIdentity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GymUxScreensTest : GymBase() {

    /** A content-free push lands while the app is open: the phone asks the box. */
    private fun pushArrives() {
        composeRule.runOnIdle { com.flagshipserver.app.core.AccessRequestBridge.onAccessRequest?.invoke() }
    }

    private fun seedChatAndPush() {
        screensMock.seedChat()
        pushArrives()
        waitUntilExists("chat-alert", 15_000)
    }

    @Test
    fun chatRequestAllowFromTheDialogDenyFromActivity() {
        launch(tab = "activity", adminRoot = true)
        seedChatAndPush()
        assertTrue(textOfTag("chat-alert-title").startsWith("A remote machine claiming to run riverside/garden-club"))
        gymShot("chat-request-dialog")
        tap("chat-alert-allow")
        waitText("Chat request allowed", 15_000)
        tap("chat-alert-close")
        // The outgoing request asks next; it waits under Activity instead.
        waitUntilExists("chat-alert", 15_000)
        assertTrue(textOfTag("chat-alert-title").startsWith("Your app wiki wants to start a chat"))
        tap("chat-alert-not-now")
        waitGone("chat-alert")

        tap("activity-section-chat", 15_000)
        waitUntilExists("chat-request-c0ffee02")
        gymShot("chat-requests-activity")
        tap("chat-request-deny-c0ffee02")
        waitGone("chat-request-c0ffee02", 15_000)

        assertEquals(listOf("allow" to "c0ffee01", "deny" to "c0ffee02"), screensMock.chatAnswers.map { it.decision to it.requestId })
        assertSigned("chat-approval", "admin")
        assertTrue("chat-approval:refused" !in signedChecks())
    }

    @Test
    fun chatAlwaysAllowThenAskMeEachTime() {
        launch(tab = "activity", adminRoot = true)
        seedChatAndPush()
        tap("chat-alert-always")
        waitText("riverside/garden-club can now start a chat with plants without asking", 15_000)
        tap("chat-alert-close")
        waitUntilExists("chat-alert", 15_000)
        tap("chat-alert-not-now")
        waitGone("chat-alert")
        assertEquals("always", screensMock.chatAnswers.single().decision)

        tap("activity-section-chat", 15_000)
        val t = "riverside-garden-club--bright-maple-plants"
        waitUntilExists("chat-always-$t")
        assertEquals("riverside/garden-club → plants", textOfTag("chat-always-title-$t"))
        gymShot("chat-always-allow")
        tap("chat-always-revoke-$t")
        waitGone("chat-always-$t", 15_000)
        assertEquals(
            listOf(com.flagshipserver.app.api.ChatAlwaysRevokeBody("bright-maple", "plants", ChatAppIdentity("riverside", "garden-club"))),
            screensMock.chatRevokes,
        )
        assertSigned("chat-approval", "admin")
    }

    private fun startAdapt() {
        launch(tab = "apps", adminRoot = true)
        buildMock.consentRequired = true
        buildMock.gitFitFixture = false
        buildMock.fqdn = screensMock.let { "${it.podContext}.bright-maple.flagship.services" }
        tap("services-build-cta", 20_000)
        tap("build-src-git")
        composeRule.onAllNodes(hasSetTextAction()).onFirst().typeText("https://github.com/gym/plain")
        tap("build-git-check")
        waitUntilExists("build-git-adapt", 15_000)
        tap("build-git-adapt")
        waitUntilExists("ai-consent", 15_000)
    }

    @Test
    fun aiConsentContinueResendsWithASignedConsent() {
        startAdapt()
        assertTrue(textOfTag("ai-consent-range").endsWith("tokens. The run stops there."))
        assertEquals("Anthropic runs it with your own API key, so Anthropic bills you for it.", textOfTag("ai-consent-payer"))
        gymShot("ai-consent")
        assertEquals("nothing runs before the owner agrees", 1, buildMock.adaptStartCalls.size)
        tap("ai-consent-continue")
        eventually(15_000, "the adapt sent again with the consent") { buildMock.adaptStartCalls.size == 2 }
        assertNull(buildMock.adaptStartCalls[0].second.consent)
        val consent = assertNotNullOf(buildMock.adaptStartCalls[1].second.consent)
        assertEquals(84000L, consent.highTokens)
        assertSigned("ai-repair-consent", "admin")
        waitGone("ai-consent")
    }

    @Test
    fun aiConsentCancelRunsNothing() {
        startAdapt()
        tap("ai-consent-cancel")
        waitGone("ai-consent")
        waitUntilExists("build-git-adapt", 15_000)
        gymShot("ai-consent-cancelled")
        Thread.sleep(500)
        assertEquals(1, buildMock.adaptStartCalls.size)
        assertTrue("ai-repair-consent:admin" !in signedChecks())
    }

    private fun <T> assertNotNullOf(v: T?): T {
        assertNotNull(v)
        return v!!
    }

    @Test
    fun watchBootKeyPerServerOnAndOff() {
        launch(tab = "settings", adminRoot = true)
        // The switch only reads the key this phone pinned at the server's first blessing.
        com.flagshipserver.app.core.ServerKeyPins.shared.forget("home.smoketest.flagship.services")
        com.flagshipserver.app.core.ServerKeyPins.shared.recordFirstSeen("home.smoketest.flagship.services", "51".repeat(32))
        // The disk key `.com` keeps for this phone, sealed to its account key as an install does.
        mailboxMock.sealedLuksKeyFor = {
            val irkPub = com.flagshipserver.app.core.HexUtil.decode(com.flagshipserver.app.keystore.Keystore.irkPubHex())!!
            com.flagshipserver.app.core.HexUtil.encode(com.flagshipserver.app.core.SecretSeal.sealForEd25519Recipient(ByteArray(32) { 7 }, irkPub))
        }
        tap("settings-open-account-security", 15_000)
        waitUntilExists("watch-delegate-toggle", 15_000)
        composeRule.onNodeWithTag("watch-delegate-toggle").performScrollTo().performClick2()
        waitUntilExists("watch-boot-toggle-home", 15_000)
        composeRule.onNodeWithTag("watch-boot-toggle-home").performScrollTo().assertIsOff()
        gymShot("watch-boot-off")

        composeRule.onNodeWithTag("watch-boot-toggle-home").performScrollTo().performClick2()
        waitUntilExists("watch-boot-until-home", 15_000)
        composeRule.onNodeWithTag("watch-boot-toggle-home").assertIsOn()
        gymShot("watch-boot-on")
        val (dep, _) = mailboxMock.watchBootPuts.single()
        assertEquals("home.smoketest.flagship.services", dep.serverDomain)
        assertEquals(com.flagshipserver.app.keystore.Keystore.watchDelegatePubHex(), dep.delegatePubHex)

        composeRule.onNodeWithTag("watch-boot-toggle-home").performScrollTo().performClick2()
        waitGone("watch-boot-until-home", 15_000)
        assertEquals("home.smoketest.flagship.services", mailboxMock.watchBootDeletes.single().first)
        assertTrue(mailboxMock.watchBootKeys.isEmpty())
    }

    // ---- First contact (docs/first-contact.md) --------------------------

    private val fcDomain = "lab.bright-maple.flagship.services"
    private val fcSecret = ByteArray(32) { 0x77 }
    private val fcSerial = "AC-GYM-0001"

    /** The box's signed entitlement request, with its enrollment proof when [proof]. */
    private fun firstRequest(stk: com.google.crypto.tink.subtle.Ed25519Sign.KeyPair, proof: Boolean) {
        val stkHex = com.flagshipserver.app.core.HexUtil.encode(stk.publicKey)
        val issuedAt = System.currentTimeMillis()
        val nonce = "ef".repeat(32)
        val sig = com.flagshipserver.app.core.HexUtil.encode(
            com.google.crypto.tink.subtle.Ed25519Sign(stk.privateKey).sign(
                com.flagshipserver.app.core.SecretRequest.canonicalBytes(fcDomain, stkHex, com.flagshipserver.app.core.SecretPurpose.ENTITLEMENT, nonce, issuedAt),
            ),
        )
        mailboxMock.pending = listOf(
            com.flagshipserver.app.api.PendingSecretRequest(
                serverDomain = fcDomain, requestNonceHex = nonce, stkPub = stkHex, purpose = "entitlement",
                issuedAt = issuedAt, requestSignature = sig, postedAt = issuedAt, expiresAt = issuedAt + 600_000,
                deviceInfo = com.flagshipserver.app.api.DeviceInfoHint(
                    enrollmentProof = if (proof) com.flagshipserver.app.core.Enrollment.proofHex(fcSecret, fcDomain, stkHex, fcSerial) else null,
                ),
            ),
        )
    }

    private fun openApprovals() {
        tapText("Refresh", 15_000)
        tap("activity-section-approvals", 15_000)
        waitUntilExists("secret-request-card", 20_000)
    }

    /** A server this phone created: the box proves its key with the recipe's secret, the code
     *  computed here sits above Approve, Approve pins the key and signs the app-name grant. */
    @Test
    fun firstContactShowsTheCodeThenPinsAndSignsTheGrant() {
        launch(tab = "activity", username = "bright-maple", adminRoot = true)
        waitUntilExists("activity-title", 20_000)
        val pins = com.flagshipserver.app.core.ServerKeyPins.shared
        pins.forget(fcDomain)
        com.flagshipserver.app.core.WildcardGrants.outbox.remove(fcDomain)
        com.flagshipserver.app.core.FirstContact.shared.put(fcDomain, com.flagshipserver.app.core.EnrollmentRecord(com.flagshipserver.app.core.HexUtil.encode(fcSecret), fcSerial))
        val stk = com.google.crypto.tink.subtle.Ed25519Sign.KeyPair.newKeyPair()
        val stkHex = com.flagshipserver.app.core.HexUtil.encode(stk.publicKey)
        firstRequest(stk, proof = true)
        openApprovals()
        val code = com.flagshipserver.app.core.Enrollment.serverCode(stkHex)!!
        assertEquals("If your machine has a monitor, it is showing this code: ${code.take(3)} ${code.drop(3)}", textOfTag("server-code"))
        gymShot("first-contact-code")
        tap("secret-request-approve", 15_000)
        eventually(20_000, "the entitlement was answered") { mailboxMock.postedResponses.isNotEmpty() }
        assertEquals(stkHex, pins.pinnedHex(fcDomain))
        assertNull("the enrollment secret is gone", com.flagshipserver.app.core.FirstContact.shared.get(fcDomain))
        // The grant over the pinned key: sent to the box, or waiting for it.
        val waiting = com.flagshipserver.app.core.WildcardGrants.outbox.get(fcDomain)
        assertTrue(waiting != null || screensMock.wildcardGrantPosts.isNotEmpty())
        waiting?.let { assertEquals(stkHex, it.stkPubHex) }
        if (waiting == null) assertSigned("server-wildcard-grant", "admin")
    }

    /** Without its proof, a server this phone created is refused: no Approve, nothing pinned. */
    @Test
    fun firstContactRefusesAServerNotBuiltFromTheRecipe() {
        launch(tab = "activity", username = "bright-maple", adminRoot = true)
        waitUntilExists("activity-title", 20_000)
        com.flagshipserver.app.core.ServerKeyPins.shared.forget(fcDomain)
        com.flagshipserver.app.core.FirstContact.shared.put(fcDomain, com.flagshipserver.app.core.EnrollmentRecord(com.flagshipserver.app.core.HexUtil.encode(fcSecret), fcSerial))
        firstRequest(com.google.crypto.tink.subtle.Ed25519Sign.KeyPair.newKeyPair(), proof = false)
        openApprovals()
        assertEquals("This server was not built from your recipe. Do not approve it.", textOfTag("first-contact-refusal"))
        gymShot("first-contact-refused")
        assertEquals(0, composeRule.onAllNodesWithTag("secret-request-approve").fetchSemanticsNodes().size)
        assertNull(com.flagshipserver.app.core.ServerKeyPins.shared.pinnedHex(fcDomain))
        com.flagshipserver.app.core.FirstContact.shared.remove(fcDomain)
    }

    /** After the pin, a request naming another key is refused in so many words. */
    @Test
    fun firstContactRefusesAChangedKey() {
        launch(tab = "activity", username = "bright-maple", adminRoot = true)
        waitUntilExists("activity-title", 20_000)
        val pins = com.flagshipserver.app.core.ServerKeyPins.shared
        pins.forget(fcDomain)
        pins.recordFirstSeen(fcDomain, "51".repeat(32))
        firstRequest(com.google.crypto.tink.subtle.Ed25519Sign.KeyPair.newKeyPair(), proof = false)
        openApprovals()
        assertEquals("This server's key changed. If you did not rebuild it, do not approve anything for it.", textOfTag("first-contact-refusal"))
        gymShot("first-contact-key-changed")
        assertEquals("51".repeat(32), pins.pinnedHex(fcDomain))
        pins.forget(fcDomain)
    }

    private fun androidx.compose.ui.test.SemanticsNodeInteraction.performClick2() {
        performClick()
        composeRule.waitForIdle()
    }
}
