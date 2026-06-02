// #28 SEAL-TO-BOX — GrantCertAutonomyViewModel orchestration tests.
//
// These pin the VIEW-MODEL's contract, NOT the producer's signature KAT
// (that lives in core/AcmeAccountKeyGrantTest). Two things matter here:
//   1. the built { grant, signature } body carries the RIGHT fields —
//      recipientPubKey == the box STK from the directory, accountKeyId present
//      and == AcmeAccountKey.accountKeyId(scalar), signature verifies under the
//      IRK pub over the canonical grant;
//   2. when delivered through the live client extension over a recording
//      transport, the POST targets the DOMAIN-scoped URL.
// Plus the fail-closed guards (no account / no key / box not in directory).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AcmeAccountKeyGrantDeliverResponse
import com.flagshipserver.app.api.AcmeAccountKeyGrantMintRequest
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.grantAcmeAccountKeyAutonomy
import com.flagshipserver.app.core.AcmeAccountKey
import com.flagshipserver.app.core.AcmeAccountKeyGrant
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.JsonHttpTransport
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GrantCertAutonomyViewModelTest {

    // A deterministic 32-byte account-key scalar + a box STK keypair so the
    // assertions are stable across runs.
    private val scalar = ByteArray(32) { ((it * 13 + 5) and 0xff).toByte() }
    private val boxStkPub =
        Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 0x07 }).publicKey
    private val boxStkHex = HexUtil.encode(boxStkPub)
    private val irkPair = Ed25519Sign.KeyPair.newKeyPair()
    private val irk = Ed25519Sign(irkPair.privateKey)

    @Test fun buildsCorrectGrantBody_recipientIsBoxStk_accountKeyIdPresent_andSignatureVerifies() = runTest {
        var captured: Pair<String, AcmeAccountKeyGrantMintRequest>? = null
        val vm = GrantCertAutonomyViewModel(
            serverDomain = "home.harry.flagship.services",
            username = { "harry" },
            boxStkResolver = { _, _ -> boxStkHex },
            scalarProvider = { scalar },
            signer = { irk },
            deliver = { domain, request -> captured = domain to request },
            grantIdGen = { "00000000-0000-4000-8000-0000000000ab" },
            now = { 1_700_000_000_000L },
        )

        vm.run()
        assertTrue("expected Completed, got ${vm.phase.value}", vm.phase.value is GrantCertAutonomyPhase.Completed)

        val (domain, req) = captured!!
        assertEquals("home.harry.flagship.services", domain)
        val grant = req.grant
        // recipientPubKey is the box STK (lowercase hex) the directory vouched.
        assertEquals(boxStkHex, grant.recipientPubKey)
        // accountKeyId is the cross-platform id of the account key — present + correct.
        assertTrue(grant.accountKeyId.isNotEmpty())
        assertEquals(AcmeAccountKey.accountKeyId(scalar), grant.accountKeyId)
        assertEquals("harry", grant.username)
        assertEquals("00000000-0000-4000-8000-0000000000ab", grant.grantId)
        assertEquals(1_700_000_000_000L, grant.issuedAt)

        // The IRK signature verifies over the canonical grant the body carries.
        assertTrue(
            AcmeAccountKeyGrant.verify(
                HexUtil.decode(req.signature)!!,
                irkPair.publicKey,
                grant.grantId,
                grant.username,
                grant.accountKeyId,
                HexUtil.decode(grant.recipientPubKey)!!,
                HexUtil.decode(grant.sealedAccountKey)!!,
                grant.issuedAt,
                grant.expiresAt,
            ),
        )
    }

    @Test fun deliversToDomainScopedUrl_throughLiveExtension() = runTest {
        // Bind the REAL delivery extension over a recording transport so the
        // URL the VM hits is asserted, not just the lambda.
        val transport = RecordingTransport(
            cannedResponse = Json.encodeToString(
                AcmeAccountKeyGrantDeliverResponse.serializer(),
                AcmeAccountKeyGrantDeliverResponse(ok = true, accountKeyId = "ignored"),
            ),
        )
        val vm = GrantCertAutonomyViewModel(
            serverDomain = "vault.dani.flagship.services",
            username = { "dani" },
            boxStkResolver = { _, _ -> boxStkHex },
            scalarProvider = { scalar },
            signer = { irk },
            deliver = GrantCertAutonomyViewModel.liveDeliver(
                MockFlagshipServerClient(simulatedLatencyMs = 0),
                transport,
            ),
            grantIdGen = { "00000000-0000-4000-8000-0000000000ac" },
            now = { 1_700_000_000_000L },
        )

        vm.run()
        assertTrue("expected Completed, got ${vm.phase.value}", vm.phase.value is GrantCertAutonomyPhase.Completed)

        val url = transport.lastUrl
        assertNotNull(url)
        assertEquals(
            "https://flagshipserver.com/api/server/vault.dani.flagship.services/acme-account-key",
            url,
        )
        // The body that went over the wire round-trips to the same grant.
        val sent = Json { ignoreUnknownKeys = true }
            .decodeFromString(AcmeAccountKeyGrantMintRequest.serializer(), transport.lastBody!!)
        assertEquals(boxStkHex, sent.grant.recipientPubKey)
        assertEquals(AcmeAccountKey.accountKeyId(scalar), sent.grant.accountKeyId)
    }

    @Test fun noUsername_failsImmediately_andDoesNotDeliver() = runTest {
        var delivered = false
        val vm = GrantCertAutonomyViewModel(
            serverDomain = "home.harry.flagship.services",
            username = { null },
            boxStkResolver = { _, _ -> boxStkHex },
            scalarProvider = { scalar },
            signer = { irk },
            deliver = { _, _ -> delivered = true },
        )
        vm.run()
        assertTrue(vm.phase.value is GrantCertAutonomyPhase.Failed)
        assertTrue(!delivered)
    }

    @Test fun noAccountKeyOnDevice_failsBeforeResolving_andDoesNotDeliver() = runTest {
        var delivered = false
        val vm = GrantCertAutonomyViewModel(
            serverDomain = "home.harry.flagship.services",
            username = { "harry" },
            boxStkResolver = { _, _ -> boxStkHex },
            scalarProvider = { null },
            signer = { irk },
            deliver = { _, _ -> delivered = true },
        )
        vm.run()
        assertTrue(vm.phase.value is GrantCertAutonomyPhase.Failed)
        assertTrue(!delivered)
    }

    @Test fun boxNotInDirectory_fails_andDoesNotDeliver() = runTest {
        var delivered = false
        val vm = GrantCertAutonomyViewModel(
            serverDomain = "ghost.harry.flagship.services",
            username = { "harry" },
            boxStkResolver = { _, _ -> null },   // directory can't vouch
            scalarProvider = { scalar },
            signer = { irk },
            deliver = { _, _ -> delivered = true },
        )
        vm.run()
        assertTrue(vm.phase.value is GrantCertAutonomyPhase.Failed)
        assertTrue(!delivered)
    }

    // A minimal recording JsonHttpTransport — captures the POST url + body and
    // returns a canned JSON response. Only postJsonForResponse is exercised.
    private class RecordingTransport(private val cannedResponse: String) : JsonHttpTransport {
        override val json: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }
        var lastUrl: String? = null
        var lastBody: String? = null

        override suspend fun execute(
            method: String,
            url: String,
            body: ByteArray?,
            contentType: String?,
            extraHeaders: Map<String, String>,
            accept: Set<Int>,
        ): HttpResponse {
            lastUrl = url
            lastBody = body?.let { String(it, Charsets.UTF_8) }
            return HttpResponse(200, cannedResponse.toByteArray(Charsets.UTF_8), emptyMap())
        }

        override suspend fun <T> postJson(
            url: String,
            body: T,
            serializer: KSerializer<T>,
            accept: Set<Int>,
            extraHeaders: Map<String, String>,
        ) {
            lastUrl = url
            lastBody = json.encodeToString(serializer, body)
        }

        override suspend fun <T, R> postJsonForResponse(
            url: String,
            body: T,
            serializer: KSerializer<T>,
            responseSerializer: KSerializer<R>,
            extraHeaders: Map<String, String>,
        ): R {
            lastUrl = url
            lastBody = json.encodeToString(serializer, body)
            return json.decodeFromString(responseSerializer, cannedResponse)
        }

        override suspend fun <R> getJson(
            url: String,
            responseSerializer: KSerializer<R>,
            extraHeaders: Map<String, String>,
        ): R = error("not used")

        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) =
            error("not used")
    }
}
