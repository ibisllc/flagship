package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
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
import com.flagshipserver.app.core.pq.StrictReentry
import com.flagshipserver.app.core.DeviceCapabilityGrant
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.longOrNull
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
    /** This server's apps as (service id, name); empty when it can't be reached. */
    private val appsFor: suspend (fqdn: String) -> List<Pair<String, String>> = { emptyList() },
    /** This phone's account device key, while the session is unlocked (the admin-device signer). */
    private val deviceKey: suspend (reason: String) -> Ed25519Sign? = { null },
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {
    data class Row(
        val fqdn: String,
        val name: String,
        val replayed: QuantumSafety.Replayed?,
        val readiness: QuantumSafety.Readiness?,
        val apps: List<AppChoice> = emptyList(),
    ) {
        val strict: Boolean get() = replayed?.strict == true
    }

    /** One app's own scope on a strict server: strict there means only the Flagship app reaches it. */
    data class AppChoice(val serviceId: String, val name: String, val replayed: QuantumSafety.Replayed?) {
        val appOnly: Boolean get() = replayed?.strict == true
    }

    /** An admin-granted device of the account: its grant verified under the pinned admin root, its PQ key bound. */
    private data class AdminDevice(val deviceId: String, val binding: PqTrust.VerifiedBinding)

    private var adminDevices: Map<String, AdminDevice> = emptyMap()
    private var verifiedDevices: List<StrictReentry.Binding> = emptyList()
    private var deviceCount = 0
    private var rootBindingSeen: PqTrust.VerifiedBinding? = null
    private var recoveryByServer: Map<String, Boolean> = emptyMap()

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
        val user = username()?.lowercase() ?: return run { _phase.value = Phase.Failed(FSStrings.get(R.string.sign_in_first)) }
        val dev = deviceId()?.lowercase().orEmpty()
        val store = QuantumSafetyService.store ?: return run { _phase.value = Phase.Failed(FSStrings.get(R.string.quantum_safe_protection_isnt_available_on)) }
        _phase.value = Phase.Loading
        val grants = getJson(user, "${base()}/api/users/${enc(user)}/device-grants")
        val listed = grants?.get("grants")?.jsonArray?.map { it.jsonObject } ?: emptyList()
        val byDevice = listed.groupBy { it["deviceId"]?.jsonPrimitive?.contentOrNull.orEmpty() }.filterKeys { it.isNotEmpty() }
        val bound = byDevice.count { (_, gs) -> gs.any { it["pqKeyBinding"] is JsonObject } }
        val root = Keystore.adminRootPubHex()?.lowercase()
        val rootWire = grants?.get("pqKeyBindings")?.jsonObject?.get("adminRoot")
        val rootBinding = root?.let { r -> rootWire?.let { runCatching { PqTrust.verifyPqKeyBinding(it, PqTrust.Expectation("admin-root", user, r, now = now())) }.getOrNull() } }
        val thisBound = QuantumSafetyService.pqKeys?.entry("device", dev)?.bindingState == com.flagshipserver.app.keystore.PqKeyStore.BindingState.BOUND
        adminDevices = adminDevicesFrom(user, root, listed)
        verifiedDevices = byDevice.mapNotNull { (id, gs) ->
            gs.firstNotNullOfOrNull { g ->
                val pub = g["devicePubHex"]?.jsonPrimitive?.contentOrNull?.lowercase() ?: return@firstNotNullOfOrNull null
                val w = g["pqKeyBinding"] as? JsonObject ?: return@firstNotNullOfOrNull null
                runCatching { PqTrust.verifyPqKeyBinding(w, PqTrust.Expectation("device", id, pub, now = now())) }.getOrNull()?.let { StrictReentry.Binding(it) }
            }
        }
        deviceCount = byDevice.size
        rootBindingSeen = rootBinding
        val myPub = myDevicePubHex(user, dev)
        val thisIsAdmin = Keystore.hasAdminRoot() || (myPub != null && myPub in adminDevices)
        val recovery = HashMap<String, Boolean>()
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
                    QuantumSafety.replay(scope, user, chain, replayed?.state) { c -> trustedSigner(c, root, rootBinding) }
                }.getOrNull()?.let { r -> runCatching { store.adopt(user, r) }; replayed = r }
            }
            val checked = body?.get("evidence")?.jsonObject?.get("recoveryChecked")?.jsonPrimitive?.booleanOrNull == true
            recovery[host] = checked
            val apps = if (replayed?.strict == true) loadApps(user, host, root, rootBinding) else emptyList()
            out += Row(host, name, replayed, QuantumSafety.Readiness(bound, byDevice.size, thisBound, thisIsAdmin, checked, serverBound), apps)
        }
        recoveryByServer = recovery
        _rows.value = out
        _phase.value = Phase.Loaded
    }

    private fun trustedSigner(c: AssurancePolicy.Change, root: String?, rootBinding: PqTrust.VerifiedBinding?): Pair<String, PqTrust.VerifiedBinding?>? = when {
        c.signerKind == "admin-root" && c.signerKeyId == root -> root to rootBinding
        c.signerKind == "admin-device" -> adminDevices[c.signerKeyId]?.let { c.signerKeyId to it.binding }
        else -> null
    }

    /** Devices whose grant the pinned admin root signed with the admin scope, and their bound PQ keys. */
    private fun adminDevicesFrom(user: String, root: String?, grants: List<JsonObject>): Map<String, AdminDevice> {
        val rootKey = root?.let { PqHex.decode(it) } ?: return emptyMap()
        val out = HashMap<String, AdminDevice>()
        for (g in grants) {
            if (g["signerRoot"]?.jsonPrimitive?.contentOrNull != "admin-root") continue
            val scopes = g["scopes"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: continue
            if ("admin" !in scopes) continue
            val id = g["deviceId"]?.jsonPrimitive?.contentOrNull ?: continue
            val pub = g["devicePubHex"]?.jsonPrimitive?.contentOrNull?.lowercase() ?: continue
            val sig = g["signatureHex"]?.jsonPrimitive?.contentOrNull?.let { PqHex.decode(it) } ?: continue
            val bytes = DeviceCapabilityGrant.canonicalBytes(
                g["grantId"]?.jsonPrimitive?.contentOrNull ?: continue, user, id, pub, scopes,
                g["issuedAt"]?.jsonPrimitive?.longOrNull ?: continue, g["expiresAt"]?.jsonPrimitive?.longOrNull ?: continue,
            )
            if (runCatching { Ed25519Verify(rootKey).verify(sig, bytes) }.isFailure) continue
            val w = g["pqKeyBinding"] as? JsonObject ?: continue
            val b = runCatching { PqTrust.verifyPqKeyBinding(w, PqTrust.Expectation("device", id, pub, now = now())) }.getOrNull() ?: continue
            out[pub] = AdminDevice(id, b)
        }
        return out
    }

    private fun myDevicePubHex(user: String, dev: String): String? =
        if (dev.isEmpty() || !Keystore.hasUmkSeed()) null else runCatching { PqHex.encode(Keystore.accountDevicePublicKey(Keystore.currentUmkSeed(), user, dev)) }.getOrNull()

    private suspend fun loadApps(user: String, host: String, root: String?, rootBinding: PqTrust.VerifiedBinding?): List<AppChoice> {
        val store = QuantumSafetyService.store ?: return emptyList()
        return runCatching { appsFor(host) }.getOrDefault(emptyList()).map { (id, name) ->
            val scope = QuantumSafety.serviceScope(host, id)
            var r = store.replayed(user, scope)
            getJson(user, "${base()}/api/accounts/${enc(user)}/assurance-policy/service/${enc(scope.id)}")?.let { body ->
                val chain = runCatching { AssurancePolicyWire.chainFromJson(body) }.getOrDefault(emptyList())
                runCatching { QuantumSafety.replay(scope, user, chain, r?.state) { c -> trustedSigner(c, root, rootBinding) } }.getOrNull()?.let { n ->
                    runCatching { store.adopt(user, n) }; r = n
                }
            }
            AppChoice(id, name, r)
        }
    }

    /** Who signs: the admin root with its PQ half on this phone, else this admin-granted device's own key. */
    private class Signer(val kind: String, val keyId: String, val role: String, val subject: String, val key: Ed25519Sign)

    private suspend fun signer(user: String, reason: String): Signer {
        val keys = QuantumSafetyService.pqKeys ?: throw IllegalStateException(FSStrings.get(R.string.not_available_on_this_account))
        val root = Keystore.adminRootPubHex()?.lowercase()
        if (Keystore.hasAdminRoot() && root != null && keys.entry("admin-root", user) != null) {
            return Signer("admin-root", root, "admin-root", user, adminKey(reason))
        }
        val dev = deviceId()?.lowercase().orEmpty()
        val pub = myDevicePubHex(user, dev)
        if (pub == null || pub !in adminDevices) throw IllegalStateException(FSStrings.get(R.string.only_an_admin_device_of_this_4))
        val key = deviceKey(reason) ?: throw IllegalStateException(FSStrings.get(R.string.unlock_the_app_and_try_again))
        return Signer("admin-device", pub, "device", dev, key)
    }

    private suspend fun post(user: String, change: AssurancePolicy.Change, s: Signer) {
        val canonical = AssurancePolicy.canonical(change)
        val keys = QuantumSafetyService.pqKeys ?: throw IllegalStateException(FSStrings.get(R.string.not_available_on_this_account))
        val entry = keys.entry(s.role, s.subject) ?: throw IllegalStateException(FSStrings.get(R.string.this_devices_post_quantum_key_isnt_2))
        val sig = keys.sign(entry, AssurancePolicy.TAG_ASSURANCE_POLICY, canonical) { m -> s.key.sign(m) }
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

    /** The re-entry evidence for a scope that was strict before (strictReentry.ts): what load() verified, the pinned server key, a fresh nonce. */
    private suspend fun reentry(user: String, scope: AssurancePolicy.Scope, fqdn: String): AssurancePolicy.StrictReentryEvidence {
        val body = getJson(user, "${base()}/api/accounts/${enc(user)}/assurance-policy/${scope.kind}/${enc(scope.id)}")
            ?: throw IllegalStateException(FSStrings.get(R.string.couldnt_read_this_servers_protection_history))
        val head = runCatching { AssurancePolicyWire.chainFromJson(body) }.getOrDefault(emptyList()).lastOrNull()?.change
            ?: throw IllegalStateException(FSStrings.get(R.string.couldnt_read_this_servers_protection_history_2))
        val box = BoxKeyPins.shared.verifiedBoxPqBinding(user, fqdn)
            ?: throw IllegalStateException(FSStrings.get(R.string.this_phone_hasnt_checked_the_servers))
        val t = now()
        return try {
            StrictReentry.evidence(StrictReentry.Inputs(user, scope, head.issuedAt, verifiedDevices, deviceCount, rootBindingSeen?.let { StrictReentry.Binding(it) },
                StrictReentry.Binding(box), recoveryByServer[fqdn] == true, t, StrictReentry.freshNonce(), t))
        } catch (r: StrictReentry.Refusal) {
            throw IllegalStateException(r.message)
        }
    }

    /** One app's browser answer on a strict server (pq-suites.md §13.6, the box's app gate). */
    fun setAppBrowsers(fqdn: String, serviceId: String, allowed: Boolean) {
        val user = username()?.lowercase() ?: return
        val row = _rows.value.firstOrNull { it.fqdn == fqdn } ?: return
        val app = row.apps.firstOrNull { it.serviceId == serviceId } ?: return
        if (app.appOnly != allowed) return
        viewModelScope.launch {
            _busy.value = true
            try {
                val s = signer(user, if (allowed) FSStrings.get(R.string.let_browsers_reach, app.name) else FSStrings.get(R.string.keep_browsers_away_from, app.name))
                val scope = QuantumSafety.serviceScope(fqdn, serviceId)
                val state = app.replayed?.state ?: AssurancePolicy.legacyState(scope)
                val change = if (allowed) {
                    QuantumSafety.compatibilityChange(user, scope, state, listOf(QuantumSafety.BROWSER_LOSS), listOf(fqdn), s.kind, s.keyId, now())
                } else {
                    QuantumSafety.strictChange(user, scope, state, false, listOf(fqdn), s.kind, s.keyId, now(), if (state.enforcedEver) reentry(user, scope, fqdn) else null)
                }
                post(user, change, s)
                _message.value = if (allowed) FSStrings.get(R.string.browsers_can_reach_again_within_15, app.name) else FSStrings.get(R.string.only_the_flagship_app_reaches_now, app.name)
                loadNow()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Throwable) {
                _message.value = e.message ?: FSStrings.get(R.string.wasnt_changed, app.name)
            } finally {
                _busy.value = false
            }
        }
    }

    fun turnOn(fqdn: String, browsersAllowed: Boolean, blocked: Set<String>) {
        val user = username()?.lowercase() ?: return
        val row = _rows.value.firstOrNull { it.fqdn == fqdn } ?: return
        viewModelScope.launch {
            _busy.value = true
            try {
                val sg = signer(user, FSStrings.get(R.string.turn_on_quantum_safe_protection_for, row.name))
                val scope = AssurancePolicy.Scope("installation", fqdn)
                val state = row.replayed?.state ?: AssurancePolicy.legacyState(scope)
                // Back to strict after a compatibility period: sign what this phone re-checked.
                val back = if (state.enforcedEver) reentry(user, scope, fqdn) else null
                post(user, QuantumSafety.strictChange(user, scope, state, browsersAllowed, listOf(fqdn), sg.kind, sg.keyId, now(), back), sg)
                for (c in connectors.filter { it.needsChoice && it.id in blocked }) {
                    val cs = QuantumSafety.connectorScope(fqdn, c.id)
                    val held = QuantumSafetyService.store?.replayed(user, cs)?.state ?: AssurancePolicy.legacyState(cs)
                    if (!AssurancePolicy.strictInForce(held)) {
                        post(user, QuantumSafety.strictChange(user, cs, held, false, listOf(fqdn), sg.kind, sg.keyId, now(), if (held.enforcedEver) reentry(user, cs, fqdn) else null), sg)
                    }
                }
                _message.value = FSStrings.get(R.string.quantum_safe_protection_is_on_for, row.name)
                loadNow()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Throwable) {
                _message.value = e.message ?: FSStrings.get(R.string.quantum_safe_protection_wasnt_changed)
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
                val sg = signer(user, FSStrings.get(R.string.turn_off_quantum_safe_protection_for, row.name))
                post(user, QuantumSafety.compatibilityChange(user, state.scope, state, QuantumSafety.LEAVING_STRICT_LOSS, listOf(fqdn), sg.kind, sg.keyId, now()), sg)
                _message.value = FSStrings.get(R.string.is_back_to_compatibility_turning_strict, row.name)
                loadNow()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Throwable) {
                _message.value = e.message ?: FSStrings.get(R.string.quantum_safe_protection_wasnt_changed)
            } finally {
                _busy.value = false
            }
        }
    }

    companion object {
        fun sentence(code: String): String = when (code) {
            "not-prepared" -> FSStrings.get(R.string.the_server_isnt_ready_yet_every)
            "classical-signer-refused", "strict-requires-hybrid", "strict-requires-binding" -> FSStrings.get(R.string.this_devices_post_quantum_key_isnt_3)
            "stale-generation", "fork" -> FSStrings.get(R.string.another_device_changed_this_at_the)
            "reentry-incomplete" -> FSStrings.get(R.string.turning_strict_on_again_needs_a)
            else -> "flagshipserver.com didn't accept the change ($code)."
        }
    }
}
