package com.flagshipserver.app.core

import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * A box's boot key (packages/protocol/src/bootKey.ts): the only key a box keeps on its unencrypted
 * /boot, used before its disk is open. Disk-key replies and auto-unlock leases are sealed to it,
 * never to the STK (which stays inside the encrypted root). This phone adopts a boot key only
 * through a binding the server's PINNED STK signed ([BoxKeyPins.acceptBootKeyBinding]), never
 * because `.com` lists it. A box installed before boot keys has none: callers then seal to the STK.
 * Mirror of the webapp's lib/bootKey.js.
 */
@Serializable
data class BootKeyBindingWire(
    val binding: Binding,
    val signature: String,
    /** Architecture v2: the STK's hybrid signature over `flagship/boot-key-binding/v2|...`. */
    val hybridSignature: String? = null,
    /** Boot unlock v2: the boot key's ML-DSA half and lease key, vouched for by the STK's hybrid key. */
    val pq: kotlinx.serialization.json.JsonElement? = null,
) {
    @Serializable
    data class Binding(val serverDomain: String, val bootPubHex: String, val issuedAt: Long)
}

object BootKey {
    private val HEX32 = Regex("^[0-9a-f]{64}$")
    private val json = Json { ignoreUnknownKeys = true }

    /** The body of `GET /api/server/:host/boot-key`, normalised, or null when it is not a binding. */
    fun parse(body: String): BootKeyBindingWire? {
        val w = runCatching { json.decodeFromString(BootKeyBindingWire.serializer(), body) }.getOrNull() ?: return null
        return normalise(w)
    }

    private fun normalise(w: BootKeyBindingWire): BootKeyBindingWire? {
        val boot = w.binding.bootPubHex.lowercase()
        if (!HEX32.matches(boot)) return null
        return w.copy(binding = w.binding.copy(bootPubHex = boot), signature = w.signature.lowercase(), hybridSignature = w.hybridSignature?.lowercase())
    }

    /** The boot key [wire] binds for [serverDomain] under [stkPubHex], or null. A boot key equal to
     *  the STK is refused: it would put the STK back on /boot. */
    fun verified(wire: BootKeyBindingWire, stkPubHex: String, serverDomain: String): String? {
        val w = normalise(wire) ?: return null
        val stkHex = stkPubHex.lowercase()
        if (w.binding.bootPubHex == stkHex) return null
        val stk = HexUtil.decode(stkHex)?.takeIf { it.size == 32 } ?: return null
        val sig = HexUtil.decode(w.signature)?.takeIf { it.size == 64 } ?: return null
        val ok = BoxKeyPins.verifyBootKeyBinding(
            w.binding.serverDomain, w.binding.bootPubHex, w.binding.issuedAt, sig, stk, serverDomain,
        )
        return if (ok) w.binding.bootPubHex else null
    }

    private suspend fun fetchQuietly(fetch: suspend (String) -> BootKeyBindingWire?, serverDomain: String): BootKeyBindingWire? =
        try {
            fetch(serverDomain.lowercase())?.let(::normalise)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        }

    /**
     * The boot key to seal to for [serverDomain] on [username]'s account, or null when the server
     * has none. A binding that does not verify under the pinned STK is ignored (the pinned boot
     * key, if any, still wins).
     */
    suspend fun bootKeyFor(
        username: String,
        serverDomain: String,
        fetch: suspend (String) -> BootKeyBindingWire?,
        pins: BoxKeyPins = BoxKeyPins.shared,
        fetchPqBinding: suspend (String) -> kotlinx.serialization.json.JsonElement? = { null },
    ): String? {
        // Pin the box's ML-DSA key first (only through the pinned STK), so a boot-key binding
        // stripped of its hybrid signature is refused below. A changed ML-DSA key throws
        // BoxKeyChangedException, as a changed STK does.
        val pq = try {
            fetchPqBinding(serverDomain.lowercase())
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        }
        if (pq != null) pins.acceptStkPqBinding(username, serverDomain, pq)
        val w = fetchQuietly(fetch, serverDomain)
        val stk = pins.pinned(username, serverDomain)
        if (w != null && stk != null && w.binding.bootPubHex != stk.lowercase()) {
            pins.acceptBootKeyBinding(username, serverDomain, w.binding.bootPubHex, w.binding.issuedAt, w.signature, w.hybridSignature)
                ?.let { return it }
        }
        return pins.pinnedBootKey(username, serverDomain)
    }

    /**
     * Boot unlock v2: the box's v2 material, verified under the STK's hybrid binding this phone
     * pinned and naming the boot key it pinned; null when the box has none or it does not verify.
     */
    suspend fun v2Material(
        username: String,
        serverDomain: String,
        bootPubHex: String,
        fetch: suspend (String) -> BootKeyBindingWire?,
        pins: BoxKeyPins = BoxKeyPins.shared,
        now: Long = System.currentTimeMillis(),
    ): com.flagshipserver.app.core.pq.BootUnlockV2.Material? {
        val stk = pins.verifiedBoxPqBinding(username, serverDomain) ?: return null
        val pq = fetchQuietly(fetch, serverDomain)?.pq ?: return null
        return try {
            com.flagshipserver.app.core.pq.BootUnlockV2.verifyMaterial(pq, serverDomain, bootPubHex, stk, now)
        } catch (_: com.flagshipserver.app.core.pq.BootUnlockV2.Failure) {
            null
        }
    }

    /**
     * The STK `.com` lists for [serverDomain]. Only a candidate, for a server this phone has not
     * pinned yet whose disk unlock is signed by a boot key: the boot key must be bound by it, and
     * the owner checks its code before Approve pins it (docs/first-contact.md).
     */
    suspend fun listedStk(mailbox: com.flagshipserver.app.api.SecretMailboxClient, username: String, serverDomain: String): String? =
        try {
            mailbox.fetchPods(username).identityPubKey(serverDomain)?.lowercase()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        }

    /** For a shared server: the boot key the STK pinned in the owner's offer vouches for, or null. */
    suspend fun sharedBootKeyFor(
        serverDomain: String,
        pinnedStkHex: String,
        fetch: suspend (String) -> BootKeyBindingWire?,
    ): String? {
        val w = fetchQuietly(fetch, serverDomain) ?: return null
        return verified(w, pinnedStkHex, serverDomain)
    }
}
