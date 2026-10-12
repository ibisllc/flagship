// Which owner AID each box we were invited to belongs to (docs/app-apis.md §5,
// "Who the app sees"). Mirror of the webapp's lib/knockIdentity.js.
//
// Invites bind the friend's PER-AUTHOR contact AID, deriveContactAccountId(UMK,
// ownerAID), so a knock on a friend's box has to be signed with that same
// contact AID or the box answers 401. The knock link carries no owner AID (the
// knock page discloses nothing about the owner), so the redeem flow remembers
// the owner AID from the invite link, keyed by the box host.
//
// Holds only public keys and box names, so plain SharedPreferences.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

interface InviteOwnerBook {
    /** Remember that [serverDomain]'s owner is [ownerAidHex]. The latest redeem
     *  wins (a transferred box has a new owner). */
    fun remember(serverDomain: String, ownerAidHex: String)

    /** The owner AID (lowercase hex) remembered for the box [serverId], or null.
     *  An invite opened on an app's own host (`<app>.<box>`) counts for the box. */
    fun ownerFor(serverId: String): String?

    companion object {
        private val HEX64 = Regex("^[0-9a-f]{64}$")

        fun normHost(host: String): String = host.trim().lowercase().trimEnd('.')

        fun normAid(aidHex: String): String? = aidHex.trim().lowercase().takeIf { HEX64.matches(it) }

        internal fun lookup(all: Map<String, String>, serverId: String): String? {
            val host = normHost(serverId)
            if (host.isEmpty()) return null
            val hit = all[host] ?: all.entries.firstOrNull { it.key.endsWith(".$host") }?.value
            return hit?.let { normAid(it) }
        }
    }
}

class SharedPreferencesInviteOwnerBook(
    private val prefs: SharedPreferences,
    private val storageKey: String = "flagship.inviteOwners.v1",
) : InviteOwnerBook {
    private val json = Json { ignoreUnknownKeys = true }
    private val mapSerializer = MapSerializer(String.serializer(), String.serializer())

    @Synchronized
    override fun remember(serverDomain: String, ownerAidHex: String) {
        val host = InviteOwnerBook.normHost(serverDomain)
        val aid = InviteOwnerBook.normAid(ownerAidHex) ?: return
        if (host.isEmpty()) return
        val next = readAll().toMutableMap()
        next[host] = aid
        prefs.edit().putString(storageKey, json.encodeToString(mapSerializer, next)).apply()
    }

    @Synchronized
    override fun ownerFor(serverId: String): String? = InviteOwnerBook.lookup(readAll(), serverId)

    private fun readAll(): Map<String, String> {
        val raw = prefs.getString(storageKey, null) ?: return emptyMap()
        return runCatching { json.decodeFromString(mapSerializer, raw) }.getOrDefault(emptyMap())
    }

    companion object {
        fun fromContext(context: Context): SharedPreferencesInviteOwnerBook =
            SharedPreferencesInviteOwnerBook(
                context.getSharedPreferences("flagship.inviteOwners", Context.MODE_PRIVATE),
            )
    }
}

class InMemoryInviteOwnerBook : InviteOwnerBook {
    val entries = mutableMapOf<String, String>()

    @Synchronized
    override fun remember(serverDomain: String, ownerAidHex: String) {
        val host = InviteOwnerBook.normHost(serverDomain)
        val aid = InviteOwnerBook.normAid(ownerAidHex) ?: return
        if (host.isNotEmpty()) entries[host] = aid
    }

    @Synchronized
    override fun ownerFor(serverId: String): String? = InviteOwnerBook.lookup(entries, serverId)
}

/** The process-wide book, attached to SharedPreferences at app start. */
object InviteOwners {
    @Volatile
    var book: InviteOwnerBook = InMemoryInviteOwnerBook()
        private set

    fun attach(context: Context) {
        if (book is SharedPreferencesInviteOwnerBook) return
        book = SharedPreferencesInviteOwnerBook.fromContext(context.applicationContext)
    }
}
