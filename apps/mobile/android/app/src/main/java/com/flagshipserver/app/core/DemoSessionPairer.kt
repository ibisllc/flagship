package com.flagshipserver.app.core

import com.flagshipserver.app.api.DemoServerBlock
import com.flagshipserver.app.api.DemoSessionRecord
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.SessionStoring

/** Passwordless demo profiles hold no owner IRK. The Worker therefore mints
 * their narrowly-scoped paired session, while the native protected store keeps
 * the returned token across process death. */
object DemoSessionPairer {
    suspend fun ensurePaired(
        username: String,
        server: DemoServerBlock,
        client: FlagshipServerClient,
        store: SessionStoring,
        replacingExistingToken: Boolean = false,
        makeToken: () -> String = { AddPairedSessionOrder.freshToken() },
    ): String {
        val podId = PodInfo.podId(server.fqdn)
        val existing = store.sessionToken(forPodId = podId)
        if (!replacingExistingToken && !existing.isNullOrEmpty()) {
            store.activatePod(podId, "https://${server.fqdn}")
            store.setDemoSession(DemoSessionRecord(username, server))
            return existing
        }

        val token = makeToken().lowercase()
        val response = client.pairDemoSession(username, token)
        check(response.ok && response.fqdn.equals(server.fqdn, ignoreCase = true)) {
            "demo pairing returned a different server"
        }
        store.setSessionToken(token, forPodId = podId)
        store.activatePod(podId, "https://${server.fqdn}")
        store.setDemoSession(DemoSessionRecord(username, server))
        return token
    }
}
