// Renewal on use and the dead-man editor (serving-wiring.md section 4), against the mock `.com` and
// box: what is signed, with which key, and where it goes. Mirror of iOS ServingRenewalTests.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.AccountServingEntry
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.ServingView
import com.flagshipserver.app.keystore.RenewalSigner
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

class ServingRenewalTest {
    private val user = "alice"
    private val boxA = "6e".repeat(32)
    private val boxB = "7f".repeat(32)
    private val scope = "1b".repeat(32)
    private val device = "8a".repeat(32)
    private val now = 1_800_000_000_000L
    private val adminSeed = ByteArray(32) { 7 }
    private val admin = Ed25519Sign(adminSeed)
    private val adminPub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(adminSeed).publicKey)
    private val ec = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    private val signer = RenewalSigner(ServingAuthority.compressedHex(ec.public as ECPublicKey)) { msg ->
        Signature.getInstance("SHA256withECDSA").run { initSign(ec.private); update(msg); sign() }
    }
    private var delegations = mutableMapOf<String, SignedRenewalDelegation>()
    private val recorded = mutableMapOf<String, Pair<Boolean, Long?>>()

    private fun policy(box: String, grace: ServingGrace, lapse: ServingOnLapse = ServingOnLapse.STOP_APPS, gen: Long = 1): SignedServingPolicy {
        val p = ServingPolicy(user, box, 1, gen, grace.wire, lapse.wire, scope, now - 1000)
        return SignedServingPolicy(p, ServingAuthority.signEd25519(ServingAuthority.canonical(p), admin))
    }

    private fun renewer(mailbox: MockSecretMailboxClient, box: MockScreensClient?, silentRoot: Boolean) = ServingRenewer(
        username = user,
        mailbox = mailbox,
        box = box?.let { b -> { _ -> b } },
        renewalKey = { signer },
        silentAdminRoot = { if (silentRoot) admin else null },
        deviceKeyPub = { device },
        delegation = { u, pub -> delegations[u]?.takeIf { it.record.renewalPub == pub } },
        recordDelegation = { delegations[it.record.account] = it },
        record = { d, o, g, u -> recorded[d] = (o == ServingOnLapse.LOCK_SERVER && g != ServingGrace.INDEFINITE) to u },
        now = { now },
    )

    @Test fun openingSignsOneLeasePerFiniteServerWithTheDelegatedKey() = runTest {
        val mailbox = MockSecretMailboxClient()
        mailbox.serving += AccountServingEntry("home.alice.flagship.services", boxA, 1, policy(boxA, ServingGrace.SEVEN_DAYS))
        mailbox.serving += AccountServingEntry("cabin.alice.flagship.services", boxB, 1, policy(boxB, ServingGrace.INDEFINITE))
        val box = MockScreensClient(simulatedLatencyMs = 0)
        assertEquals(1, renewer(mailbox, box, silentRoot = true).renew())
        val d = mailbox.renewalDelegations.single().second
        assertEquals(signer.publicKeyHex, d.delegation.renewalPub)
        assertEquals(device, d.delegation.deviceId)
        assertTrue(ServingAuthority.verifyEd25519(ServingAuthority.canonical(d.delegation), d.signature, adminPub))
        val item = mailbox.servingLeasePosts.single().second.leases.single()
        assertEquals(boxA, item.lease.box)
        assertEquals(now + 7L * 86_400_000, item.lease.notAfter)
        assertEquals(signer.publicKeyHex, item.delegationPub)
        assertTrue(ServingAuthority.verifyLeaseP256(item.lease, item.signature, signer.publicKeyHex))
        val boxPost = box.servingPosts.single()
        assertEquals(signer.publicKeyHex, boxPost.leases!!.single().delegationPub)
        assertEquals(signer.publicKeyHex, boxPost.delegations!!.single().record.renewalPub)

        // Next open: no admin root needed and no second delegation.
        assertEquals(1, renewer(mailbox, null, silentRoot = false).renew())
        assertEquals(1, mailbox.renewalDelegations.size)
        assertEquals(2, mailbox.servingLeasePosts.size)
    }

    @Test fun withoutADelegationOrASilentAdminRootNothingIsSigned() = runTest {
        val mailbox = MockSecretMailboxClient()
        mailbox.serving += AccountServingEntry("home.alice.flagship.services", boxA, 1, policy(boxA, ServingGrace.THIRTY_DAYS))
        assertEquals(0, renewer(mailbox, null, silentRoot = false).renew())
        assertTrue(mailbox.servingLeasePosts.isEmpty())
        assertTrue(mailbox.renewalDelegations.isEmpty())
    }

    @Test fun aLockingDeadlineIsRemembered() = runTest {
        val mailbox = MockSecretMailboxClient()
        mailbox.serving += AccountServingEntry("home.alice.flagship.services", boxA, 1, policy(boxA, ServingGrace.SEVEN_DAYS, ServingOnLapse.LOCK_SERVER))
        renewer(mailbox, null, silentRoot = true).renew()
        assertEquals(true to (now + 7L * 86_400_000), recorded["home.alice.flagship.services"])
    }

    private fun editor(mailbox: MockSecretMailboxClient, box: MockScreensClient, current: ServingView) = ServingPolicyEditor(
        current = current, username = user, serverDomain = "home.alice.flagship.services", boxPub = boxA,
        adminRoot = admin, mailbox = mailbox, box = box, renewer = renewer(mailbox, box, silentRoot = false), now = { now },
    )

    @Test fun theEditorSignsTheNextGenerationAndAFirstLease() = runTest {
        val mailbox = MockSecretMailboxClient()
        val box = MockScreensClient(simulatedLatencyMs = 0)
        val ed = editor(mailbox, box, ServingView("indefinite", "stop-apps", null, policyGen = 3, regGen = 2, scopeSha256 = scope))
        assertFalse(ed.canLock)
        ed.setGrace(ServingGrace.THIRTY_DAYS)
        ed.onLapse = ServingOnLapse.LOCK_SERVER
        assertTrue(ed.changed)
        assertEquals(ServingPolicyEditor.Result.Saved, ed.save())
        val post = mailbox.servingPolicies.single().second
        assertEquals(4L, post.policy.policyGen)
        assertEquals(2L, post.policy.regGen)
        assertEquals("30d", post.policy.grace)
        assertEquals("lock-server", post.policy.onLapse)
        assertEquals(scope, post.policy.scopeSha256)
        assertTrue(ServingAuthority.verifyEd25519(ServingAuthority.canonical(post.policy), post.signature, adminPub))
        assertEquals(post.policy, box.servingPosts.first().policy?.record)
        assertEquals(1, mailbox.renewalDelegations.size)
        val lease = mailbox.servingLeasePosts.single().second.leases.single().lease
        assertEquals(4L, lease.policyGen)
        assertEquals(now + 30L * 86_400_000, lease.notAfter)
    }

    @Test fun neverGreysOutLockingAndSignsNoLease() = runTest {
        val mailbox = MockSecretMailboxClient()
        val box = MockScreensClient(simulatedLatencyMs = 0)
        val ed = editor(mailbox, box, ServingView("7d", "lock-server", now + 1, policyGen = 1, regGen = 1, scopeSha256 = scope))
        assertTrue(ed.canLock)
        ed.setGrace(ServingGrace.INDEFINITE)
        assertFalse(ed.canLock)
        assertEquals(ServingOnLapse.STOP_APPS, ed.onLapse)
        assertEquals(ServingPolicyEditor.Result.Saved, ed.save())
        assertEquals("indefinite", mailbox.servingPolicies.single().second.policy.grace)
        assertEquals("stop-apps", mailbox.servingPolicies.single().second.policy.onLapse)
        assertTrue(mailbox.servingLeasePosts.isEmpty())
    }
}
