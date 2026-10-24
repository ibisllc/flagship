package com.flagshipserver.app.core

import android.content.Context
import com.flagshipserver.app.api.PodDirectoryEntry
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/**
 * Box key pins (packages/protocol/src/boxKeyPin.ts; shared vectors in
 * packages/protocol/test-vectors/box-key-pin/).
 *
 * Everything this phone seals for a server (the disk-key reply, an
 * auto-unlock lease, the SWK / CGK / pairing deposits) goes to the box key
 * `.com`'s `/pods` lists. The phone pins that key per server the first time
 * it learns it and refuses to seal to any other afterwards, so a `.com` that
 * turns hostile can't swap in its own key and collect the disk key. A key
 * changes legitimately only when the server is reinstalled, replaced or
 * moved: the device that does it re-pins, and any other device asks its
 * owner first ("Trust its new key").
 */
class BoxKeyChangedException(
    val username: String,
    val serverDomain: String,
    val pinnedHex: String,
    val reportedHex: String,
) : Exception(MESSAGE) {
    companion object {
        const val MESSAGE =
            "This server's identity key changed since this device first saw it, so Flagship won't send it your disk key. " +
                "If you reinstalled, replaced or moved this server, choose Trust its new key. If you didn't, someone may be impersonating it."
    }
}

class BoxKeyPins(private val persistence: Persistence? = null, private val now: () -> Long = { System.currentTimeMillis() }) {
    enum class Verdict { FIRST, MATCH, MISMATCH, INVALID }

    interface Persistence {
        fun load(key: String): String?
        fun save(key: String, value: String)
    }

    @Serializable
    data class Pin(
        val stk: String,
        val pinnedAt: Long,
        val boot: String? = null,
        val bootIssuedAt: Long? = null,
        /** Architecture v2: the ML-DSA-65 key the pinned STK bound (pq/BoxPqKeyPin.kt). */
        val mldsa: String? = null,
        val mldsaIssuedAt: Long? = null,
    )

    private val memory = HashMap<String, String>()
    private val serializer = MapSerializer(String.serializer(), Pin.serializer())
    private val json = Json { ignoreUnknownKeys = true }

    companion object {
        @Volatile var shared: BoxKeyPins = BoxKeyPins()

        const val BOOT_KEY_BINDING_TAG = "flagship/boot-key-binding/v1"
        private val HEX32 = Regex("^[0-9a-f]{64}$")

        fun decide(pinned: String?, reported: String): Verdict {
            val r = reported.lowercase()
            if (!HEX32.matches(r)) return Verdict.INVALID
            if (pinned == null) return Verdict.FIRST
            return if (pinned.lowercase() == r) Verdict.MATCH else Verdict.MISMATCH
        }

        fun canonicalBootKeyBinding(serverDomain: String, bootPubHex: String, issuedAt: Long): ByteArray? {
            if (!HEX32.matches(bootPubHex) || issuedAt < 0) return null
            if (serverDomain.any { it == '|' || it.code < 0x20 || it.code == 0x7f }) return null
            return listOf(BOOT_KEY_BINDING_TAG, serverDomain.lowercase(), bootPubHex, issuedAt.toString())
                .joinToString("|").toByteArray(Charsets.UTF_8)
        }

        /** The STK's v2 hybrid signature over a boot-key binding, under the pinned STK + ML-DSA keys. */
        fun verifyBootKeyBindingV2(
            bindingDomain: String, bootPubHex: String, issuedAt: Long,
            hybridSignatureHex: String?, stkHex: String, mldsaPubHex: String,
        ): Boolean = com.flagshipserver.app.core.pq.BoxPqKeyPin.verifyBootKeyBindingV2(
            bindingDomain, bootPubHex, issuedAt, hybridSignatureHex, stkHex, mldsaPubHex,
        )

        fun verifyBootKeyBinding(
            bindingDomain: String, bootPubHex: String, issuedAt: Long,
            signature: ByteArray, pinnedStkPub: ByteArray, forServer: String,
        ): Boolean {
            if (bindingDomain.lowercase() != forServer.lowercase()) return false
            val msg = canonicalBootKeyBinding(bindingDomain, bootPubHex, issuedAt) ?: return false
            return try {
                Ed25519Verify(pinnedStkPub).verify(signature, msg)
                true
            } catch (_: Exception) {
                false
            }
        }
    }

    fun pinned(username: String, serverDomain: String): String? = read(username)[serverDomain.lowercase()]?.stk

    fun pinnedBootKey(username: String, serverDomain: String): String? = read(username)[serverDomain.lowercase()]?.boot

    /** The key this phone may seal to: pins [reportedHex] the first time, returns it while it
     *  matches, throws [BoxKeyChangedException] when it differs. */
    @Synchronized
    fun require(username: String, serverDomain: String, reportedHex: String): String {
        val domain = serverDomain.lowercase()
        val reported = reportedHex.lowercase()
        val pins = read(username).toMutableMap()
        when (decide(pins[domain]?.stk, reported)) {
            Verdict.INVALID, Verdict.MISMATCH ->
                throw BoxKeyChangedException(username.lowercase(), domain, pins[domain]?.stk.orEmpty(), reported)
            Verdict.FIRST -> {
                pins[domain] = Pin(reported, now())
                write(username, pins)
            }
            Verdict.MATCH -> Unit
        }
        return reported
    }

    /** Pin every listed server not pinned yet, so the pin predates any request. */
    @Synchronized
    fun observe(username: String, pods: List<PodDirectoryEntry>) {
        val pins = read(username).toMutableMap()
        var changed = false
        for (p in pods) {
            val domain = p.serverDomain.lowercase()
            val stk = p.identityPubKey.lowercase()
            if (p.revokedAt != null || domain.isEmpty() || pins.containsKey(domain) || !HEX32.matches(stk)) continue
            pins[domain] = Pin(stk, now())
            changed = true
        }
        if (changed) write(username, pins)
    }

    /** Replace the pin: only for a change the owner made or confirmed here. Drops any boot key
     *  the old STK had bound. */
    @Synchronized
    fun repin(username: String, serverDomain: String, stkHex: String) {
        val stk = stkHex.lowercase()
        if (!HEX32.matches(stk)) return
        write(username, read(username) + (serverDomain.lowercase() to Pin(stk, now())))
    }

    /** This device is (re)creating [serverDomain]: pin its next registered key fresh. */
    @Synchronized
    fun forget(username: String, serverDomain: String) {
        val pins = read(username)
        val domain = serverDomain.lowercase()
        if (pins.containsKey(domain)) write(username, pins - domain)
    }

    /** Adopt a box's boot-only key only through a binding the PINNED STK signed. Once this
     *  server's ML-DSA key is pinned (or its installation is [strict]), the STK's v2 hybrid
     *  signature is required too, so stripping it cannot downgrade the server. */
    @Synchronized
    fun acceptBootKeyBinding(
        username: String,
        serverDomain: String,
        bootPubHex: String,
        issuedAt: Long,
        signatureHex: String,
        hybridSignatureHex: String? = null,
        strict: Boolean = false,
    ): String? {
        val domain = serverDomain.lowercase()
        val pins = read(username)
        val pin = pins[domain] ?: return null
        val stk = HexUtil.decode(pin.stk) ?: return null
        val sig = HexUtil.decode(signatureHex) ?: return null
        if (!verifyBootKeyBinding(domain, bootPubHex, issuedAt, sig, stk, domain)) return null
        if ((pin.bootIssuedAt ?: -1) > issuedAt) return null
        if (strict && pin.mldsa == null) return null
        if (pin.mldsa != null && !verifyBootKeyBindingV2(domain, bootPubHex, issuedAt, hybridSignatureHex, pin.stk, pin.mldsa)) return null
        write(username, pins + (domain to pin.copy(boot = bootPubHex, bootIssuedAt = issuedAt)))
        return bootPubHex
    }

    /**
     * Pin the ML-DSA key a box's STK bound, through a binding the PINNED STK and that key both
     * signed. Returns the ML-DSA key, or null when there is no STK pin or the binding is refused.
     * A binding naming another ML-DSA key than the pinned one throws [BoxKeyChangedException].
     */
    @Synchronized
    fun acceptStkPqBinding(username: String, serverDomain: String, wire: kotlinx.serialization.json.JsonElement?): String? {
        val domain = serverDomain.lowercase()
        val pins = read(username)
        val pin = pins[domain] ?: return null
        val v = com.flagshipserver.app.core.pq.BoxPqKeyPin.decide(pin.stk, pin.mldsa, pin.mldsaIssuedAt, domain, wire, now())
        when (v) {
            is com.flagshipserver.app.core.pq.BoxPqKeyPin.Verdict.Pinned -> {
                if (pin.mldsa != v.mldsaPubHex || pin.mldsaIssuedAt != v.issuedAt) {
                    write(username, pins + (domain to pin.copy(mldsa = v.mldsaPubHex, mldsaIssuedAt = v.issuedAt)))
                }
                return v.mldsaPubHex
            }
            is com.flagshipserver.app.core.pq.BoxPqKeyPin.Verdict.Mismatch ->
                throw BoxKeyChangedException(username.lowercase(), domain, pin.mldsa.orEmpty(), v.reportedHex)
            is com.flagshipserver.app.core.pq.BoxPqKeyPin.Verdict.Invalid -> return null
        }
    }

    fun pinnedBoxPqKey(username: String, serverDomain: String): String? = read(username)[serverDomain.lowercase()]?.mldsa

    private fun key(username: String) = "flagship.boxKeyPins.v1:${username.lowercase()}"

    private fun read(username: String): Map<String, Pin> {
        val raw = persistence?.load(key(username)) ?: memory[key(username)] ?: return emptyMap()
        return runCatching { json.decodeFromString(serializer, raw) }.getOrDefault(emptyMap())
    }

    private fun write(username: String, pins: Map<String, Pin>) {
        val raw = json.encodeToString(serializer, pins)
        if (persistence != null) persistence.save(key(username), raw) else memory[key(username)] = raw
    }
}

/** Keeps the box key pins (public keys) on the phone. */
class BoxKeyPinPrefs(context: Context) : BoxKeyPins.Persistence {
    private val prefs = context.getSharedPreferences("flagship.boxkeypins.v1", Context.MODE_PRIVATE)
    override fun load(key: String): String? = prefs.getString(key, null)
    override fun save(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }
}
