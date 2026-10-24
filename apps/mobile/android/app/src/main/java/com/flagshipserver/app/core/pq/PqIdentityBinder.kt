package com.flagshipserver.app.core.pq

import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.keystore.PqKeyStore
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The `.com` side of identity key bindings:
 *   PUT /api/accounts/<u>/pq-key-bindings   body = a PqKeyBindingWire (no other auth: the binding
 *                                           proves both keys, `.com` checks the Ed25519 one is
 *                                           the account's current IRK, admin root or device key)
 *   GET /api/accounts/<u>/pq-key-bindings   read token → { accountIrk, adminRoot, devices[] }
 */
interface PqKeyBindingClient {
    sealed class PutResult {
        data object Stored : PutResult()
        /** Already on file (same or newer binding): done. */
        data object Stale : PutResult()
        /** Another ML-DSA key is bound to this Ed25519 key: another device won. */
        data object KeyChanged : PutResult()
        /** Refused for now (e.g. a re-pair still waiting), unknown account, or no network. */
        data class Deferred(val reason: String) : PutResult()
    }

    data class Bindings(val accountIrk: PqTrust.Wire?, val adminRoot: PqTrust.Wire?, val devices: List<PqTrust.Wire>)

    suspend fun put(username: String, wire: PqTrust.Wire): PutResult
    suspend fun get(username: String): Bindings?
}

class LivePqKeyBindingClient(
    private val transport: JsonHttpTransport,
    private val baseUrl: () -> String,
    private val authorize: suspend (String, suspend (Map<String, String>) -> PqKeyBindingClient.Bindings?) -> PqKeyBindingClient.Bindings? = { u, call ->
        com.flagshipserver.app.core.AccountReadTokens.authorize(u, call)
    },
) : PqKeyBindingClient {
    private fun path(username: String) =
        "${baseUrl().trimEnd('/')}/api/accounts/${java.net.URLEncoder.encode(username.lowercase(), "UTF-8")}/pq-key-bindings"

    override suspend fun put(username: String, wire: PqTrust.Wire): PqKeyBindingClient.PutResult {
        val r = try {
            transport.execute(
                "PUT", path(username), body = wire.toJson().toString().toByteArray(Charsets.UTF_8),
                contentType = "application/json", accept = setOf(200, 403, 404, 409),
            )
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            return PqKeyBindingClient.PutResult.Deferred(t.javaClass.simpleName)
        }
        return PqBindingAnswers.put(r.status, String(r.body, Charsets.UTF_8))
    }

    override suspend fun get(username: String): PqKeyBindingClient.Bindings? = try {
        authorize(username) { auth ->
            val r = transport.execute("GET", path(username), extraHeaders = auth, accept = setOf(200, 404))
            if (r.status != 200) null else PqBindingAnswers.bindings(String(r.body, Charsets.UTF_8))
        }
    } catch (e: CancellationException) {
        throw e
    } catch (_: Throwable) {
        null
    }
}

/** How the phone reads `.com`'s answers (kept apart so tests pin the contract). */
object PqBindingAnswers {
    private val json = Json { ignoreUnknownKeys = true }

    fun put(status: Int, body: String): PqKeyBindingClient.PutResult {
        val error = runCatching { ((json.parseToJsonElement(body) as? JsonObject)?.get("error") as? JsonPrimitive)?.content }.getOrNull()
        return when {
            status == 200 -> PqKeyBindingClient.PutResult.Stored
            status == 409 && error == "stale" -> PqKeyBindingClient.PutResult.Stale
            status == 409 && error == "pq-key-changed" -> PqKeyBindingClient.PutResult.KeyChanged
            else -> PqKeyBindingClient.PutResult.Deferred("$status ${error.orEmpty()}".trim())
        }
    }

    fun bindings(body: String): PqKeyBindingClient.Bindings? {
        val o = runCatching { json.parseToJsonElement(body) as? JsonObject }.getOrNull() ?: return null
        fun wire(e: kotlinx.serialization.json.JsonElement?) =
            if (e == null || e is JsonNull) null else runCatching { PqTrust.pqKeyBindingFromWire(e) }.getOrNull()
        return PqKeyBindingClient.Bindings(
            accountIrk = wire(o["accountIrk"]),
            adminRoot = wire(o["adminRoot"]),
            devices = (o["devices"] as? JsonArray)?.mapNotNull { wire(it) }.orEmpty(),
        )
    }
}

/**
 * Creates and sends this phone's identity bindings (`flagship/pq-key-binding/v1`).
 *
 * One identity at a time, never more than one fresh ML-DSA key per identity and Ed25519 key:
 *  - already BOUND or BOUND_ELSEWHERE here: nothing to do;
 *  - `.com` already holds a binding for this Ed25519 key: mark it (ours ⇒ BOUND, another
 *    device's ⇒ BOUND_ELSEWHERE) and never make a competing key;
 *  - otherwise make (or reuse) the key, sign the binding and PUT it. 409 pq-key-changed means
 *    another device won (BOUND_ELSEWHERE); a refusal or no network leaves it UNSENT for the next
 *    unlock.
 * Callers run it only while the app session is unlocked, so no Ed25519 or seed access prompts.
 */
class PqIdentityBinder(
    private val store: PqKeyStore,
    private val client: PqKeyBindingClient,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    /** One identity this phone holds: its role, subject and Ed25519 half. */
    class Identity(
        val role: String,
        val subjectId: String,
        val ed25519PubHex: String,
        val edSign: (ByteArray) -> ByteArray,
    )

    enum class Outcome { BOUND, BOUND_ELSEWHERE, DEFERRED, SKIPPED }

    suspend fun bindAll(username: String, identities: List<Identity>): Map<String, Outcome> {
        val user = username.lowercase()
        val todo = identities.filter { id ->
            val e = store.entry(id.role, id.subjectId)
            !(e != null && e.ed25519PubHex == id.ed25519PubHex.lowercase() && e.bindingState != PqKeyStore.BindingState.UNSENT)
        }
        val out = LinkedHashMap<String, Outcome>()
        for (id in identities) if (id !in todo) out[id.role] = Outcome.SKIPPED
        if (todo.isEmpty()) return out
        val served = client.get(user)
        for (id in todo) out[id.role] = bindOne(user, id, served)
        return out
    }

    private fun servedFor(served: PqKeyBindingClient.Bindings?, id: Identity): PqTrust.Wire? = when (id.role) {
        "account-irk" -> served?.accountIrk
        "admin-root" -> served?.adminRoot
        "device" -> served?.devices?.firstOrNull { it.subjectId == id.subjectId }
        else -> null
    }?.takeIf { it.role == id.role && it.subjectId == id.subjectId && it.ed25519PubHex == id.ed25519PubHex.lowercase() }

    private suspend fun bindOne(user: String, id: Identity, served: PqKeyBindingClient.Bindings?): Outcome {
        val ed = id.ed25519PubHex.lowercase()
        val mine = store.entry(id.role, id.subjectId)?.takeIf { it.ed25519PubHex == ed }
        servedFor(served, id)?.let { s ->
            // Re-verify what `.com` served before believing it.
            val ok = runCatching {
                PqTrust.verifyPqKeyBinding(s, PqTrust.Expectation(id.role, id.subjectId, ed, now = maxOf(now(), s.issuedAt)))
            }.isSuccess
            if (ok) {
                if (mine != null && mine.mldsaPubHex == s.mldsaPubHex) {
                    store.setState(id.role, id.subjectId, PqKeyStore.BindingState.BOUND)
                    return Outcome.BOUND
                }
                store.recordElsewhere(id.role, id.subjectId, ed, s.mldsaPubHex, now())
                return Outcome.BOUND_ELSEWHERE
            }
        }
        val entry = try {
            store.getOrCreate(id.role, id.subjectId, ed, now())
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            return Outcome.DEFERRED
        }
        val statement = PqTrust.Statement(id.role, id.subjectId, ed, entry.mldsaPubHex, now())
        val wire = try {
            PqTrust.signPqKeyBinding(statement) { m -> store.sign(entry, PqTrust.TAG_PQ_KEY_BINDING, m, id.edSign) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            // The seed's Keystore key wants a fresh authentication: try at the next unlock.
            return Outcome.DEFERRED
        }
        return when (client.put(user, wire)) {
            PqKeyBindingClient.PutResult.Stored, PqKeyBindingClient.PutResult.Stale -> {
                store.setState(id.role, id.subjectId, PqKeyStore.BindingState.BOUND)
                Outcome.BOUND
            }
            PqKeyBindingClient.PutResult.KeyChanged -> {
                store.setState(id.role, id.subjectId, PqKeyStore.BindingState.BOUND_ELSEWHERE)
                Outcome.BOUND_ELSEWHERE
            }
            is PqKeyBindingClient.PutResult.Deferred -> Outcome.DEFERRED
        }
    }
}
