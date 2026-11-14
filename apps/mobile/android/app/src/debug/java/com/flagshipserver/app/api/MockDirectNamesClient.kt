package com.flagshipserver.app.api

import com.flagshipserver.app.core.DirectAccess
import com.flagshipserver.app.core.DirectName

/** Scriptable `.com` for previews, tests and the mock gym. It keeps what it is sent, like `.com` would. */
class MockDirectNamesClient : DirectNamesClient {
    var scripted = DirectAccountState()
    var postError: DirectAccessRefusal? = null
    var probeAnswer: DirectProbe? = null
    val accessOrders = mutableListOf<DirectAccess.SignedOrder>()
    val nameOrders = mutableListOf<DirectName.SignedOrder>()
    val probes = mutableListOf<String>()
    var now: () -> Long = { System.currentTimeMillis() }

    override suspend fun state(username: String): DirectAccountState = scripted

    override suspend fun postAccessOrder(username: String, signed: DirectAccess.SignedOrder) {
        postError?.let { throw it }
        accessOrders += signed
        val o = signed.order
        val servers = scripted.servers.filterNot { it.serverDomain.equals(o.serverDomain, ignoreCase = true) } +
            DirectServerState(o.serverDomain, o.enabled, o.addresses, o.prefixes, o.port, o.issuedAt)
        scripted = scripted.copy(
            servers = servers,
            names = scripted.names.map { n ->
                if (n.serverDomain.equals(o.serverDomain, ignoreCase = true) && n.addresses.isEmpty()) zone(n, o.enabled) else n
            },
        )
    }

    override suspend fun postNameOrder(username: String, signed: DirectName.SignedOrder) {
        postError?.let { throw it }
        nameOrders += signed
        val o = signed.order
        val accessOn = scripted.server(o.serverDomain)?.on ?: false
        val row = DirectNameState(o.name, o.serverDomain, o.enabled, o.caa, o.addresses, o.issuedAt, state = "empty")
        scripted = scripted.copy(names = scripted.names.filterNot { it.name == o.name } + zone(row, accessOn))
    }

    override suspend fun probe(username: String, label: String): DirectProbe {
        probes += label
        val fqdn = "$label.${scripted.apex}"
        val n = scripted.name(fqdn) ?: throw DirectAccessRefusal(404, "unknown-name")
        val p = probeAnswer ?: if (n.isPublished) {
            DirectProbe(now(), reachable = true, https = DirectProbeHttps(ok = true, status = 200))
        } else {
            DirectProbe(now(), reachable = null, why = "not-published")
        }
        scripted = scripted.copy(names = scripted.names.map { if (it.name == fqdn) it.copy(probe = p) else it })
        return p
    }

    private fun zone(n: DirectNameState, accessOn: Boolean): DirectNameState {
        val (state, reason) = when {
            !n.enabled -> "empty" to "off"
            n.addresses.isNotEmpty() || accessOn -> "published" to null
            else -> "empty" to "direct-access-off"
        }
        return n.copy(state = state, reason = reason, publishedAt = if (state == "published") n.issuedAt else null)
    }
}
