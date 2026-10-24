package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.flagshipserver.app.core.AccountReadTokens
import com.flagshipserver.app.core.BoxKeyPins
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.pq.AssurancePolicy
import com.flagshipserver.app.core.pq.AssurancePolicyWire
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqTrust
import com.flagshipserver.app.core.pq.QuantumSafety
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.QuantumSafetyService
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.URLEncoder

/**
 * Settings → Quantum-safe protection on Android (the port of iOS's QuantumSafetyViewModel,
 * docs/architecture-v2/pq-suites.md §13.6): per server, its policy, its readiness and the owner's
 * choices for turning strict on (the browser question, then each classical connector) or off.
 */
class QuantumSafetyViewModel(
    private val transport: JsonHttpTransport,
    private val username: () -> String?,
    private val deviceId: () -> String?,
    private val servers: () -> List<Pair<String, String>>,
    private val adminKey: suspend (reason: String) -> Ed25519Sign,
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {
    data class Row(val fqdn: String, val name: String, val replayed: QuantumSafety.Replayed?, val readiness: QuantumSafety.Readiness?) {
        val strict: Boolean get() = replayed?.strict == true
    }

    sealed interface Phase {
        data object Idle : Phase
        data object Loading : Phase
        data object Loaded : Phase
        data class Failed(val message: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Idle)
    val phase: StateFlow<Phase> = _phase
    private val _rows = MutableStateFlow<List<Row>>(emptyList())
    val rows: StateFlow<List<Row>> = _rows
    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy
    val connectors: List<QuantumSafety.Connector> = QuantumSafety.connectors(emptyList())
    private val json = Json { ignoreUnknownKeys = true }

    private fun base() = Endpoints.controlBaseUrl.trimEnd('/')
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private suspend fun getJson(user: String, url: String): JsonObject? = runCatching {
        AccountReadTokens.authorize(user) { auth ->
            val r = transport.execute("GET", url, extraHeaders = auth, accept = setOf(200, 404))
            if (r.status != 200) null else json.parseToJsonElement(String(r.body)).jsonObject
        }
    }.getOrNull()

    fun load() {
        viewModelScope.launch { loadNow() }
    }

    suspend fun loadNow() {
        val user = username()?.lowercase() ?: return run { _phase.value = Phase.Failed("Sign in first.") }
        val dev = deviceId()?.lowercase().orEmpty()
        val store = QuantumSafetyService.store ?: return run { _phase.value = Phase.Failed("Quantum-safe protection isn't available on this account.") }
        _phase.value = Phase.Loading
        val grants = getJson(user, "${base()}/api/users/${enc(user)}/device-grants")
        val listed = grants?.get("grants")?.jsonArray?.map { it.jsonObject } ?: emptyList()
        val byDevice = listed.groupBy { it["deviceId"]?.jsonPrimitive?.contentOrNull.orEmpty() }.filterKeys { it.isNotEmpty() }
        val bound = byDevice.count { (_, gs) -> gs.any { it["pqKeyBinding"] is JsonObject } }
        val root = Keystore.adminRootPubHex()?.lowercase()
        val rootWire = grants?.get("pqKeyBindings")?.jsonObject?.get("adminRoot")
        val rootBinding = root?.let { r -> rootWire?.let { runCatching { PqTrust.verifyPqKeyBinding(it, PqTrust.Expectation("admin-root", user, r, now = now())) }.getOrNull() } }
        val thisBound = QuantumSafetyService.pqKeys?.entry("device", dev)?.bindingState == com.flagshipserver.app.keystore.PqKeyStore.BindingState.BOUND
        val out = ArrayList<Row>()
        for ((fqdn, name) in servers()) {
            val host = fqdn.lowercase()
            val wire = runCatching {
                val r = transport.execute("GET", "${base()}/api/server/${enc(host)}/pq-key-binding", accept = setOf(200, 404))
                if (r.status == 200) json.parseToJsonElement(String(r.body)) else null
            }.getOrNull()
            val serverBound = runCatching { BoxKeyPins.shared.acceptStkPqBinding(user, host, wire) }.getOrNull() != null
            val scope = AssurancePolicy.Scope("installation", host)
            var replayed = store.replayed(user, scope)
            val body = getJson(user, "${base()}/api/accounts/${enc(user)}/assurance-policy/installation/${enc(host)}")
            if (body != null) {
                val chain = runCatching { AssurancePolicyWire.chainFromJson(body) }.getOrDefault(emptyList())
                runCatching {
                    QuantumSafety.replay(scope, user, chain, replayed?.state) { c -> if (c.signerKeyId == root) root to rootBinding else null }
                }.getOrNull()?.let { r -> runCatching { store.adopt(user, r) }; replayed = r }
            }
            val recovery = body?.get("evidence")?.jsonObject?.get("recoveryChecked")?.jsonPrimitive?.booleanOrNull == true
            out += Row(host, name, replayed, QuantumSafety.Readiness(bound, byDevice.size, thisBound, Keystore.hasAdminRoot(), recovery, serverBound))
        }
        _rows.value = out
        _phase.value = Phase.Loaded
    }

    private suspend fun post(user: String, change: AssurancePolicy.Change, key: Ed25519Sign) {
        val canonical = AssurancePolicy.canonical(change)
        val keys = QuantumSafetyService.pqKeys ?: throw IllegalStateException("Not available on this account.")
        val entry = keys.entry("admin-root", user) ?: throw IllegalStateException("This device's post-quantum key for the admin root isn't ready. Unlock the app once while online, then try again.")
        val sig = keys.sign(entry, AssurancePolicy.TAG_ASSURANCE_POLICY, canonical) { m -> key.sign(m) }
        val body = buildJsonObject {
            put("change", AssurancePolicyWire.changeToJson(change))
            put("signature", buildJsonObject { put("suite", PqTrust.SUITE_HYBRID); put("signature", PqHex.encode(sig)) })
        }
        val r = transport.execute("POST", "${base()}/api/accounts/${enc(user)}/assurance-policy", body = body.toString().toByteArray(),
            contentType = "application/json", accept = setOf(200, 201, 400, 403, 404, 409))
        if (r.status !in 200..299) {
            val code = runCatching { json.parseToJsonElement(String(r.body)).jsonObject["code"]?.jsonPrimitive?.contentOrNull }.getOrNull() ?: "http ${r.status}"
            throw IllegalStateException(sentence(code))
        }
    }

    fun turnOn(fqdn: String, browsersAllowed: Boolean, blocked: Set<String>) {
        val user = username()?.lowercase() ?: return
        val row = _rows.value.firstOrNull { it.fqdn == fqdn } ?: return
        viewModelScope.launch {
            _busy.value = true
            try {
                val key = adminKey("Turn on quantum-safe protection for ${row.name}")
                val pub = Keystore.adminRootPubHex()?.lowercase() ?: throw IllegalStateException("Only an admin device of this account can turn this on.")
                val scope = AssurancePolicy.Scope("installation", fqdn)
                post(user, QuantumSafety.strictChange(user, scope, row.replayed?.state ?: AssurancePolicy.legacyState(scope), browsersAllowed, listOf(fqdn), "admin-root", pub, now()), key)
                for (c in connectors.filter { it.needsChoice && it.id in blocked }) {
                    val cs = QuantumSafety.connectorScope(fqdn, c.id)
                    val held = QuantumSafetyService.store?.replayed(user, cs)?.state ?: AssurancePolicy.legacyState(cs)
                    if (!AssurancePolicy.strictInForce(held)) post(user, QuantumSafety.strictChange(user, cs, held, false, listOf(fqdn), "admin-root", pub, now()), key)
                }
                _message.value = "Quantum-safe protection is on for ${row.name}. It takes effect when the server next checks in, within 15 minutes."
                loadNow()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Throwable) {
                _message.value = e.message ?: "Quantum-safe protection wasn't changed."
            } finally {
                _busy.value = false
            }
        }
    }

    fun turnOff(fqdn: String) {
        val user = username()?.lowercase() ?: return
        val row = _rows.value.firstOrNull { it.fqdn == fqdn } ?: return
        val state = row.replayed?.state ?: return
        viewModelScope.launch {
            _busy.value = true
            try {
                val key = adminKey("Turn off quantum-safe protection for ${row.name}")
                val pub = Keystore.adminRootPubHex()?.lowercase() ?: throw IllegalStateException("Only an admin device of this account can change this.")
                post(user, QuantumSafety.compatibilityChange(user, state.scope, state, QuantumSafety.LEAVING_STRICT_LOSS, listOf(fqdn), "admin-root", pub, now()), key)
                _message.value = "${row.name} is back to compatibility. Turning strict on again later needs a fresh check of every device and your recovery."
                loadNow()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Throwable) {
                _message.value = e.message ?: "Quantum-safe protection wasn't changed."
            } finally {
                _busy.value = false
            }
        }
    }

    companion object {
        fun sentence(code: String): String = when (code) {
            "not-prepared" -> "The server isn't ready yet: every device, the server and your recovery need their post-quantum keys first."
            "classical-signer-refused", "strict-requires-hybrid", "strict-requires-binding" -> "This device's post-quantum key isn't registered yet. Unlock the app once while online, then try again."
            "stale-generation", "fork" -> "Another device changed this at the same time. Refresh and try again."
            "reentry-incomplete" -> "Turning strict on again needs a fresh check of every device, a rekey and a tested recovery."
            else -> "flagshipserver.com didn't accept the change ($code)."
        }
    }
}
