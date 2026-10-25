// Where this device last saw each of its servers on a local network (docs/data-sovereignty.md 4.9,
// "rescue-servers"): written whenever a box proves itself on the LAN (an accepted LAN-direct hint, a
// rescue hello) or a key file restores it, read by Offline control before anything else so a box
// can be tried with no `.com` and no NSD. Names and addresses only, never trusted: the box's signed
// hello decides. Device-local, not backed up, and kept when `.com` says the account is gone.

package com.flagshipserver.app.core

/** Where the records live: server name -> "<seenAt>|<addr>,<addr>" (no spaces). */
interface RescueBookStore {
    fun all(): Map<String, String>
    fun put(serverDomain: String, value: String?)
}

class InMemoryRescueBookStore : RescueBookStore {
    val map = java.util.concurrent.ConcurrentHashMap<String, String>()
    override fun all(): Map<String, String> = map.toMap()
    override fun put(serverDomain: String, value: String?) { if (value == null) map.remove(serverDomain) else map[serverDomain] = value }
}

class RescueServerBook(private val store: RescueBookStore) {
    data class Entry(val domain: String, val lan: List<String>, val seenAt: Long)

    private fun decode(domain: String, raw: String): Entry? {
        val bar = raw.indexOf('|')
        if (bar < 0) return null
        val at = raw.substring(0, bar).toLongOrNull() ?: return null
        val lan = raw.substring(bar + 1).split(',').filter { it.isNotEmpty() && it.length <= 64 }
        return Entry(domain, lan, at)
    }

    fun entries(): List<Entry> = runCatching { store.all() }.getOrDefault(emptyMap())
        .mapNotNull { (d, v) -> decode(d, v) }.sortedBy { it.domain }

    fun entry(domain: String): Entry? = entries().firstOrNull { it.domain == domain.lowercase() }

    private fun write(domain: String, lan: List<String>, seenAt: Long) {
        val clean = lan.filter { a -> a.isNotEmpty() && a.length <= 64 && a.none { it == ',' || it == '|' || it.isWhitespace() } }.distinct().take(MAX)
        runCatching { store.put(domain.lowercase(), "$seenAt|${clean.joinToString(",")}") }
    }

    /** Remember that [domain] answered at [address] (`host:port`) just now. */
    @Synchronized
    fun saw(domain: String, address: String, now: Long = System.currentTimeMillis()) {
        if (domain.isBlank()) return
        val old = entry(domain)?.lan.orEmpty()
        write(domain, listOf(address) + old.filter { it != address }, now)
    }

    /** Remember a server by name with no address yet (a restored key file). */
    @Synchronized
    fun remember(domain: String, lan: List<String> = emptyList()) {
        if (domain.isBlank()) return
        val old = entry(domain)
        write(domain, old?.lan.orEmpty() + lan, old?.seenAt ?: 0)
    }

    companion object {
        const val MAX = 8

        /** The process-wide book. MainActivity installs the Keystore-backed store at start. */
        @Volatile
        var shared: RescueServerBook = RescueServerBook(InMemoryRescueBookStore())
    }
}
