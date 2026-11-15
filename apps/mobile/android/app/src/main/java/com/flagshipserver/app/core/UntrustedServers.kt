// Servers this device stopped trusting (docs/retail-box-setup.md §7.7): the box that came online
// after a retail claim was not the box the phone paired with. Kept per device until the owner
// deletes the server. While a server is listed the phone opens no connection to it
// ([CertPinRegistry] treats it as a known box without a pin), seals nothing to it
// ([ServerKeyPins] has no pin for it, [BoxKeyPins.require] refuses) and Home shows it with a red
// badge. Twin of iOS FlagshipCore/UntrustedServers.swift.

package com.flagshipserver.app.core

import com.flagshipserver.app.R

interface UntrustedServerStore {
    fun all(): Set<String>
    fun put(serverDomain: String, untrusted: Boolean)
}

class InMemoryUntrustedServerStore : UntrustedServerStore {
    private val set = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    override fun all(): Set<String> = set.toSet()
    override fun put(serverDomain: String, untrusted: Boolean) { if (untrusted) set.add(serverDomain) else set.remove(serverDomain) }
}

class UntrustedServers(private val store: UntrustedServerStore) {
    private val changes = kotlinx.coroutines.flow.MutableStateFlow(0)
    /** Bumps on every change, so Home redraws its badges. */
    val version: kotlinx.coroutines.flow.StateFlow<Int> = changes

    fun all(): Set<String> = runCatching { store.all() }.getOrDefault(emptySet())

    fun mark(serverDomain: String) {
        val d = normalize(serverDomain)
        if (d.isEmpty()) return
        store.put(d, true)
        changes.value++
    }

    /** The server was deleted: its name may come back as a new server. */
    fun forget(serverDomain: String) {
        val d = normalize(serverDomain)
        if (d !in all()) return
        store.put(d, false)
        changes.value++
    }

    /** True for the server itself and every name under it (its apps). */
    fun contains(host: String): Boolean {
        val h = normalize(host)
        if (h.isEmpty()) return false
        return all().any { h == it || h.endsWith(".$it") }
    }

    companion object {
        fun normalize(domain: String) = domain.trim().trimEnd('.').lowercase()

        /** The process-wide list. MainActivity installs the Keystore-backed store at start. */
        @Volatile
        var shared: UntrustedServers = UntrustedServers(InMemoryUntrustedServerStore())
    }
}

/** Sealing to a server this device marked untrusted. */
class ServerUntrustedException(val serverDomain: String) : Exception(FSStrings.get(R.string.retail_untrusted_refused))
