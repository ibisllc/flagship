// The one place the watch path learns a server's key (its STK). Interim, pending the owner's
// decision on Security's proposal: trust on first use. The key this phone first recorded for a
// server is kept per server and never silently replaced; a different key later is refused until an
// explicit re-trust (reburn or re-pair calls [ServerKeyPins.forget]). A real box's key is random
// (install-helper gen-identity), so it can't be derived from the account key.

package com.flagshipserver.app.core

/** Where the recorded keys live (device-local). */
interface ServerKeyPinStore {
    fun get(serverDomain: String): String?
    fun put(serverDomain: String, stkPubHex: String)
    fun remove(serverDomain: String)
}

class ServerKeyPins(private val store: ServerKeyPinStore) {
    sealed interface Record {
        data object Recorded : Record
        data object AlreadyPinned : Record
        /** The key offered isn't the one recorded first: nothing changes. */
        data object Mismatch : Record
        data object Unknown : Record
    }

    /** The pinned key for [serverDomain], or null when none was recorded. Every watch-path check goes through this. */
    fun pinnedStk(serverDomain: String): ByteArray? =
        store.get(serverDomain.lowercase())?.let(HexUtil::decode)?.takeIf { it.size == 32 }

    /** Record [stkPubHex] if nothing is recorded yet; never replace a recorded key. */
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

    /** The explicit re-trust after a reburn or re-pair: the next key seen is recorded. */
    fun forget(serverDomain: String) = store.remove(serverDomain.lowercase())

    private companion object {
        val HEX64 = Regex("^[0-9a-f]{64}$")
    }
}

/** This server's key isn't the one this phone recorded for it. */
class ServerKeyChangedException : Exception(FSStrings.get(com.flagshipserver.app.R.string.watch_boot_key_mismatch))
