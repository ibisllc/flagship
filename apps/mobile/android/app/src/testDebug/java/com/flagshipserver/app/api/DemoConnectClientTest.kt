// The Worker retired the public demo `/connect` route: operator-provisioned
// demo servers come up on their own, so a 404 must leave the caller polling
// rather than failing the install screen. Mirrors the iOS
// DemoConnectCoordinator 404 handling.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.JsonHttpTransport
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DemoConnectClientTest {

    @Test fun connect_toleratesTheRetiredRoute() = runTest {
        val transport = ThrowingTransport(HttpException(404, "Route not found"))
        LiveDemoConnectClient(transport, MockFlagshipServerClient()).connect("bright-maple")
        assertTrue(transport.calls.single().endsWith("/api/dev/sample-user/bright-maple/connect"))
    }

    @Test fun connect_stillSurfacesOtherFailures() = runTest {
        val client = LiveDemoConnectClient(ThrowingTransport(HttpException(429, "slow down")), MockFlagshipServerClient())
        try {
            client.connect("bright-maple")
            fail("a 429 must reach the caller")
        } catch (e: HttpException) {
            assertEquals(429, e.status)
        }
    }

    private class ThrowingTransport(private val error: Throwable) : JsonHttpTransport {
        val calls = mutableListOf<String>()
        override val json: Json = Json { ignoreUnknownKeys = true }
        override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse {
            calls += url
            throw error
        }
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
    }
}
