package com.flagshipserver.app.core

import com.flagshipserver.app.keystore.BiometricAuthority
import com.flagshipserver.app.keystore.BiometricPrompter
import com.flagshipserver.app.keystore.KeystoreReadTokenSigners
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class AccountReadTokensTest {
    private val user = "plucky-avocet"
    private val deviceId = "0123456789abcdef0123456789abcdef"
    private val umk = ByteArray(32) { 0x2a }
    private var now = 1_900_000_000_000L

    private class MemoryStore : ReadTokenStore {
        val tokens = HashMap<String, AccountReadTokenResponse>()
        override fun get(username: String) = tokens[username]
        override fun put(username: String, token: AccountReadTokenResponse) { tokens[username] = token }
        override fun remove(username: String) { tokens.remove(username) }
        override fun clear() = tokens.clear()
    }

    /** The mint endpoint: answers each mint with a fresh token, or refuses. */
    private inner class MintTransport(var refuse: Boolean = false) : JsonHttpTransport {
        override val json: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
        var deviceMints = 0
        var irkMints = 0
        var lastDeviceHeaders: Map<String, String> = emptyMap()
        var lastIrkBody: String? = null

        private fun issue(): AccountReadTokenResponse {
            if (refuse) throw HttpException(403, """{"error":"not authorized"}""")
            return AccountReadTokenResponse("art1.t${deviceMints + irkMints}", now + 30L * 24 * 60 * 60_000)
        }

        override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse {
            assertTrue(url.endsWith("/api/accounts/$user/read-token"))
            deviceMints += 1
            lastDeviceHeaders = extraHeaders
            val r = issue()
            return HttpResponse(200, json.encodeToString(AccountReadTokenResponse.serializer(), r).toByteArray(), emptyMap())
        }
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R {
            irkMints += 1
            lastIrkBody = json.encodeToString(serializer, body)
            return json.decodeFromString(responseSerializer, json.encodeToString(AccountReadTokenResponse.serializer(), issue()))
        }
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
    }

    private val deviceSigner = ReadTokenSigner.Device(
        deviceId,
        AccountMetadata.deriveAccountDeviceKey(umk, user, deviceId),
        HexUtil.encode(AccountMetadata.deriveAccountDevicePub(umk, user, deviceId)),
    )
    private val irkSigner = ReadTokenSigner.Irk(
        ServerKeys.deriveProtocolIrk(umk),
        HexUtil.encode(ServerKeys.deriveProtocolIrkPub(umk)),
    )

    private fun tokens(
        transport: MintTransport,
        store: ReadTokenStore = MemoryStore(),
        signers: List<ReadTokenSigner> = listOf(deviceSigner),
        demo: Boolean = false,
    ) = AccountReadTokens(
        transport = transport,
        store = store,
        signers = { signers },
        isDemo = { demo },
        baseUrl = "https://flagshipserver.com",
        now = { now },
    )

    @Test fun mintsWithTheDeviceKeyOnceAndSendsItAsBearer() = runBlocking {
        val t = MintTransport()
        val p = tokens(t)
        val seen = ArrayList<Map<String, String>>()
        repeat(2) { p.authorized(user) { seen.add(it) } }
        assertEquals(1, t.deviceMints)
        assertEquals(listOf("Bearer art1.t1", "Bearer art1.t1"), seen.map { it["Authorization"] })
        val h = t.lastDeviceHeaders
        val canonical = AccountMetadata.canonicalDirectoryRequest(
            user, deviceId, deviceSigner.pubHex, "POST", "/api/accounts/$user/read-token",
            h.getValue("x-flagship-request-id"), h.getValue("x-flagship-issued-at").toLong(),
        )
        Ed25519Verify(HexUtil.decode(deviceSigner.pubHex)).verify(HexUtil.decode(h.getValue("x-flagship-signature")), canonical)
    }

    @Test fun aRefusedReadMintsOnceMoreAndRetries() = runBlocking {
        val t = MintTransport()
        val p = tokens(t)
        var calls = 0
        val result = p.authorized(user) { auth ->
            calls += 1
            if (auth["Authorization"] == "Bearer art1.t1") throw HttpException(401, "")
            auth["Authorization"]
        }
        assertEquals("Bearer art1.t2", result)
        assertEquals(2, calls)
        assertFalse(p.statusPaused.value)
    }

    @Test fun withNothingToMintTheReadGoesBareAndStatusPauses() = runBlocking {
        val t = MintTransport()
        val p = tokens(t, signers = emptyList())
        var sent: Map<String, String>? = null
        try {
            p.authorized(user) { auth -> sent = auth; throw HttpException(401, "") }
            fail("the 401 should surface")
        } catch (e: HttpException) {
            assertEquals(401, e.status)
        }
        assertEquals(emptyMap<String, String>(), sent)
        assertTrue(p.statusPaused.value)
        assertEquals(0, t.deviceMints + t.irkMints)
    }

    @Test fun fallsBackToTheIrkWhenTheDeviceIsRefused() = runBlocking {
        val t = MintTransport()
        val p = AccountReadTokens(
            transport = object : JsonHttpTransport by t {
                override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse {
                    throw HttpException(403, "")
                }
            },
            store = MemoryStore(),
            signers = { listOf(deviceSigner, irkSigner) },
            isDemo = { false },
            now = { now },
        )
        var auth: String? = null
        p.authorized(user) { auth = it["Authorization"] }
        assertEquals(1, t.irkMints)
        assertEquals("Bearer art1.t1", auth)
        val body = Json.parseToJsonElement(t.lastIrkBody!!).jsonObject
        val a = body.getValue("auth").jsonObject
        assertEquals("account-read-token", a.getValue("endpointLabel").jsonPrimitive.content)
        val canonical = DeviceEndpointClaim.canonicalBytes(
            user, "account-read-token", irkSigner.pubHex,
            a.getValue("issuedAt").jsonPrimitive.long, a.getValue("expiresAt").jsonPrimitive.long,
            a.getValue("nonce").jsonPrimitive.content,
        )
        Ed25519Verify(HexUtil.decode(irkSigner.pubHex))
            .verify(HexUtil.decode(body.getValue("authSignature").jsonPrimitive.content), canonical)
    }

    @Test fun refreshesNearExpiryAndBacksOffAfterARefusedMint() = runBlocking {
        val t = MintTransport()
        val p = tokens(t)
        p.authorized(user) { }
        now += 30L * 24 * 60 * 60_000 - 30 * 60_000 // inside the refresh margin
        t.refuse = true
        var auth: String? = null
        p.authorized(user) { auth = it["Authorization"] }
        assertEquals("Bearer art1.t1", auth) // still valid, kept while the refresh failed
        p.authorized(user) { }
        assertEquals(2, t.deviceMints) // backing off: no second refresh within a minute
    }

    @Test fun unlockingForShowMyServers_mintsAtOnceDespiteTheBackoff() = runBlocking {
        val t = MintTransport()
        var available = emptyList<ReadTokenSigner>()
        val p = AccountReadTokens(
            transport = t,
            store = MemoryStore(),
            signers = { available },
            isDemo = { false },
            baseUrl = "https://flagshipserver.com",
            now = { now },
        )
        val read: suspend (Map<String, String>) -> Unit = { h ->
            if (h["Authorization"] == null) throw HttpException(401, "")
        }
        runCatching { p.authorized(user, read) }
        assertTrue(p.statusPaused.value)
        available = listOf(irkSigner)
        assertTrue(runCatching { p.authorized(user, read) }.isFailure) // still backing off
        p.keysUnlocked()
        p.authorized(user, read)
        assertEquals(1, t.irkMints)
        assertFalse(p.statusPaused.value)
    }

    @Test fun clearDropsTheProfilesTokens() = runBlocking {
        val store = MemoryStore()
        val p = tokens(MintTransport(), store)
        p.authorized(user) { }
        assertEquals(1, store.tokens.size)
        p.clear()
        assertNull(store.get(user))
    }

    @Test fun demoAccountsSendNoTokenAndMintNothing() = runBlocking {
        val t = MintTransport()
        var sent: Map<String, String>? = null
        tokens(t, demo = true).authorized(user) { sent = it }
        assertEquals(emptyMap<String, String>(), sent)
        assertEquals(0, t.deviceMints + t.irkMints)
    }

    // ---- signer policy: never prompts -----------------------------------

    private fun neverPrompt() = BiometricAuthority.forTest(BiometricPrompter { _, _ -> fail("a read must never prompt") })

    @Test fun signersSkipTheIrkWhileTheBiometricSessionIsStale() = runBlocking {
        var irkAsked = false
        val signers = KeystoreReadTokenSigners.resolve(
            username = user,
            currentUser = user,
            profile = Profile(cloudName = user, deviceId = deviceId),
            hasUmk = { true },
            authority = { neverPrompt() },
            device = { _, id -> deviceSigner.copy(deviceId = id) },
            umk = { umk },
            irk = { irkAsked = true; error("must not derive the IRK") },
        )
        assertFalse(irkAsked)
        assertEquals(listOf(deviceSigner), signers)
    }

    @Test fun signersUseTheIrkInAFreshSessionAndNothingForAnotherAccount() = runBlocking {
        val fresh = BiometricAuthority.forTest(BiometricPrompter { _, _ -> })
        fresh.ensureFresh("t", "s")
        val material = IrkMaterial(irkSigner.signer, ByteArray(32), irkSigner.pubHex)
        val mine = KeystoreReadTokenSigners.resolve(
            username = user, currentUser = user, profile = Profile(cloudName = user),
            hasUmk = { true }, authority = { fresh }, umk = { umk }, irk = { material },
        )
        assertEquals(listOf<ReadTokenSigner>(irkSigner), mine)
        val other = KeystoreReadTokenSigners.resolve(
            username = "someone-else", currentUser = user, profile = Profile(cloudName = user),
            hasUmk = { true }, authority = { fresh }, umk = { umk }, irk = { material },
        )
        assertTrue(other.isEmpty())
    }
}
