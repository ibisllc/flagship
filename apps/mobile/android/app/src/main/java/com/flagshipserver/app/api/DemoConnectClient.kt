// Plan A — client for the `/api/dev/sample-user/{username}/connect`
// endpoint pair. Kotlin mirror of iOS DemoConnectClient.swift.
//
// When the typed username matches a `demo_users` row (i.e.
// `/api/users/check` returns a `demoServer` block), tapping "Connect"
// on the rendered single device POSTs `/connect` (no auth, no body)
// and then polls `/api/users/check` until the lifecycle flips to
// `up`. See docs/sample-users.md §10.5 + Phase D in
// docs/archive/sample-user-vps-plan.md.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JsonHttpTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.net.URLEncoder

interface DemoConnectClient {
    /** POST `/api/dev/sample-user/{username}/connect` with an empty
     *  body. 200 = the Worker observed (or already had) a
     *  `provisioning` / `up` row; non-2xx throws [HttpException] so
     *  the caller can show a precise error. The endpoint is rate-
     *  limited on the Worker (10/min/IP, 30/min/u) — a 429 surfaces
     *  as `HttpException(429, ...)`. */
    suspend fun connect(username: String)

    /** Poll `/api/users/check` every [pollIntervalMs] ms until the
     *  embedded `demoServer.status` flips to `"up"`. Returns the
     *  final [DemoServerBlock]. Throws [DemoConnectException.TimedOut]
     *  on timeout and [DemoConnectException.DemoServerWentAway] if
     *  the row is deleted under us. */
    suspend fun pollUntilUp(
        username: String,
        pollIntervalMs: Long = 3000L,
        timeoutMs: Long = 300_000L,
    ): DemoServerBlock

    /** POST `/api/dev/sample-user/{username}/cancel` with an empty body.
     *  "Cancel this device" — tears down the demo's VPS and resets it to
     *  the empty state. Public (demo = capability-by-name) + edge
     *  rate-limited; scoped to demo_users on the Worker. Non-2xx throws
     *  [HttpException] so the caller can show a precise message. */
    suspend fun cancel(username: String)
}

/** Errors specific to the demo-connect flow. Surfaced to the host so
 *  it can render a precise message without parsing strings. */
sealed class DemoConnectException(message: String) : RuntimeException(message) {
    /** [pollUntilUp] exhausted its budget before
     *  `demoServer.status` flipped to `"up"`. Carries the last
     *  status the Worker reported. */
    class TimedOut(val lastStatus: String) :
        DemoConnectException("still booting (last status: $lastStatus)")
    /** The Worker stopped returning a `demoServer` block mid-poll —
     *  likely the operator ran `delete-sample-user` while a client
     *  was waiting. */
    class DemoServerWentAway :
        DemoConnectException("demo was removed mid-connect")
}

// ── Live ──────────────────────────────────────────────────────────

class LiveDemoConnectClient(
    private val transport: JsonHttpTransport,
    private val server: FlagshipServerClient,
    baseUrl: String = LiveFlagshipServerClient.DEFAULT_BASE_URL,
) : DemoConnectClient {
    private val base = baseUrl.trimEnd('/')

    override suspend fun connect(username: String) {
        val encoded = URLEncoder.encode(username, "UTF-8")
        // The endpoint accepts an empty body. We send `{}` so the
        // Content-Type header always carries valid JSON.
        transport.execute(
            method = "POST",
            url = "$base/api/dev/sample-user/$encoded/connect",
            body = "{}".toByteArray(Charsets.UTF_8),
            contentType = "application/json; charset=utf-8",
            accept = setOf(200, 201),
        )
    }

    override suspend fun pollUntilUp(
        username: String,
        pollIntervalMs: Long,
        timeoutMs: Long,
    ): DemoServerBlock {
        val deadline = System.currentTimeMillis() + timeoutMs
        var lastStatus = "provisioning"
        while (System.currentTimeMillis() < deadline) {
            val resp = server.usernameAvailable(username)
            val block = resp.demoServer ?: throw DemoConnectException.DemoServerWentAway()
            lastStatus = block.status
            if (block.lifecycle == DemoServerBlock.Lifecycle.Up) {
                return block
            }
            delay(pollIntervalMs)
        }
        throw DemoConnectException.TimedOut(lastStatus)
    }

    override suspend fun cancel(username: String) {
        val encoded = URLEncoder.encode(username, "UTF-8")
        transport.execute(
            method = "POST",
            url = "$base/api/dev/sample-user/$encoded/cancel",
            body = "{}".toByteArray(Charsets.UTF_8),
            contentType = "application/json; charset=utf-8",
            accept = setOf(200, 201),
        )
    }
}

// ── Mock ──────────────────────────────────────────────────────────

class MockDemoConnectClient(
    private val server: MockFlagshipServerClient,
    /** When > 0, schedule a coroutine that flips the mock's
     *  `demoServers` row to `"up"` after this many ms. The default
     *  (0) flips synchronously so tight unit tests don't hang. */
    var simulatedProvisioningMs: Long = 0,
) : DemoConnectClient {
    /** Tracks the usernames that received a `connect()` call so tests
     *  can assert wire round-trips happened. */
    val connectCalls: MutableList<String> = mutableListOf()
    /** Tracks the usernames that received a `cancel()` call. */
    val cancelCalls: MutableList<String> = mutableListOf()

    override suspend fun connect(username: String) {
        connectCalls += username
        val lower = username.lowercase()
        val block = server.demoServers[lower]
            ?: throw HttpException(404, "no such demo user")
        // Mirror the Worker's state-machine: `none → provisioning` on
        // the first connect.
        if (block.lifecycle == DemoServerBlock.Lifecycle.None) {
            server.demoServers[lower] = block.copy(status = "provisioning")
        }
        // Schedule a flip to `up` after the configured delay.
        if (simulatedProvisioningMs > 0) {
            val target = lower
            val delayMs = simulatedProvisioningMs
            // Detached fire-and-forget so the poll loop can observe
            // the eventual flip without the connect() caller awaiting
            // it. Mirrors the iOS MockDemoConnectClient.
            CoroutineScope(Dispatchers.Default).launch {
                delay(delayMs)
                server.demoServers[target]?.let {
                    server.demoServers[target] = it.copy(status = "up")
                }
            }
        } else {
            server.demoServers[lower]?.let {
                server.demoServers[lower] = it.copy(status = "up")
            }
        }
    }

    override suspend fun pollUntilUp(
        username: String,
        pollIntervalMs: Long,
        timeoutMs: Long,
    ): DemoServerBlock {
        val deadline = System.currentTimeMillis() + timeoutMs
        var lastStatus = "provisioning"
        while (System.currentTimeMillis() < deadline) {
            val resp = server.usernameAvailable(username)
            val block = resp.demoServer ?: throw DemoConnectException.DemoServerWentAway()
            lastStatus = block.status
            if (block.lifecycle == DemoServerBlock.Lifecycle.Up) return block
            delay(pollIntervalMs)
        }
        throw DemoConnectException.TimedOut(lastStatus)
    }

    override suspend fun cancel(username: String) {
        cancelCalls += username
        val lower = username.lowercase()
        val cur = server.demoServers[lower] ?: throw HttpException(404, "no such demo user")
        // Mirror the Worker: reset to the empty state. Keep the FQDN so a
        // later connect re-provisions under the same name.
        server.demoServers[lower] = DemoServerBlock(fqdn = cur.fqdn, status = "none")
    }
}

