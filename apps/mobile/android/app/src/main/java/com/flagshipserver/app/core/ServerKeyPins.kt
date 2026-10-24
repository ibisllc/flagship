// The one place this device learns a server's key (its STK): docs/first-contact.md. A server makes
// its own random key at install, so nothing can derive it. The phone pins the key the first time it
// blesses the server (the first approval, checked by the enrollment proof and the six-digit code)
// and checks everything against the pin from then on. `.com`'s word about a key is never a trust
// input. A pin is never silently replaced: a different key later is refused until an explicit
// re-trust (a reinstall from a new recipe or a re-pair calls [ServerKeyPins.forget]).

package com.flagshipserver.app.core

/** Where the pinned keys live (device-local, never backed up). */
interface ServerKeyPinStore {
    fun get(serverDomain: String): String?
    fun put(serverDomain: String, stkPubHex: String)
    fun remove(serverDomain: String)
}

/** A pin store held in memory: tests, previews, and until the app installs the Keystore one. */
class InMemoryServerKeyPinStore : ServerKeyPinStore {
    val map = java.util.concurrent.ConcurrentHashMap<String, String>()
    override fun get(serverDomain: String) = map[serverDomain]
    override fun put(serverDomain: String, stkPubHex: String) { map[serverDomain] = stkPubHex }
    override fun remove(serverDomain: String) { map.remove(serverDomain) }
}

class ServerKeyPins(private val store: ServerKeyPinStore) {
    sealed interface Record {
        data object Recorded : Record
        data object AlreadyPinned : Record
        /** The key offered isn't the one pinned: nothing changes. */
        data object Mismatch : Record
        data object Unknown : Record
    }

    /** How a key a server names compares with the pin. */
    sealed interface Check {
        /** Nothing pinned yet: first sight. */
        data object Unpinned : Check
        data object Matches : Check
        /** Another key than the pinned one: refuse and say "This server's key changed". */
        data class Changed(val pinnedHex: String) : Check
    }

    /** The pinned key for [serverDomain], or null when none was pinned. Every check goes through this. */
    fun pinnedStk(serverDomain: String): ByteArray? =
        pinnedHex(serverDomain)?.let(HexUtil::decode)?.takeIf { it.size == 32 }

    /** The pinned key as lowercase hex, or null. */
    fun pinnedHex(serverDomain: String): String? =
        store.get(serverDomain.lowercase())?.lowercase()?.takeIf { HEX64.matches(it) }

    fun check(serverDomain: String, offeredStkHex: String?): Check {
        val have = pinnedHex(serverDomain) ?: return Check.Unpinned
        return if (offeredStkHex?.lowercase() == have) Check.Matches else Check.Changed(have)
    }

    /** Pin [stkPubHex] if nothing is pinned yet; never replace a pinned key. */
    fun recordFirstSeen(serverDomain: String, stkPubHex: String?): Record {
        val d = serverDomain.lowercase()
        val offered = stkPubHex?.lowercase()?.takeIf { HEX64.matches(it) }
        val have = store.get(d)?.lowercase()
        return when {
            have != null && offered != null && have != offered -> Record.Mismatch
            have != null -> Record.AlreadyPinned
            offered == null -> Record.Unknown
            else -> {
                store.put(d, offered)
                Record.Recorded
            }
        }
    }

    /** The explicit re-trust after a reinstall from a new recipe or a re-pair: the next key blessed is pinned. */
    fun forget(serverDomain: String) = store.remove(serverDomain.lowercase())

    companion object {
        private val HEX64 = Regex("^[0-9a-f]{64}$")

        /** The process-wide pins. MainActivity installs the Keystore-backed store at start. */
        @Volatile
        var shared: ServerKeyPins = ServerKeyPins(InMemoryServerKeyPinStore())
    }
}

/** This server's key isn't the one this device pinned for it. */
class ServerKeyChangedException : Exception(FSStrings.get(com.flagshipserver.app.R.string.server_key_changed))

/** This device has no pin for the server yet: its next approval on this phone pins it. */
class ServerKeyNotPinnedException : Exception(FSStrings.get(com.flagshipserver.app.R.string.server_key_not_pinned))
