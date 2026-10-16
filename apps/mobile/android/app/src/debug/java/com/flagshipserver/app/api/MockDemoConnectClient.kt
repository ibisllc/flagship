package com.flagshipserver.app.api

import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JsonHttpTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.net.URLEncoder

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
}
