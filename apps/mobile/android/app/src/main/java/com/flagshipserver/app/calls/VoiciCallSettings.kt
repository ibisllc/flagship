// The owner's calls settings (docs/voici-calls.md §8), Settings → Messages → Calls. Same rules as iOS
// VoiciCallSettings.swift.
//
// Calls on/off and who may call are part of the signed page index (`flagship/voici-page/v2`, §6): `.com` reads them
// before ringing, so they change only by a publish from an admin device and every device sees them in the index.
// Writers sign v2 only while calls are on; the last "who can call" choice is remembered on the device.
//
// The app has no Do Not Disturb of its own (owner, 2026-11-20): the phone's Do Not Disturb decides, through the
// incoming-call notification (CATEGORY_CALL on a channel that never bypasses it). The owner's business hours are the
// synced, sealed setting (VoiciCallHoursSettings), never in the page.

package com.flagshipserver.app.calls

import android.content.Context
import com.flagshipserver.app.api.VoiciMissedCallItem
import com.flagshipserver.app.core.voici.VoiciCalls

object VoiciCallSettings {
    const val FROM_ACCEPTED = "accepted"
    const val FROM_SIGNED_IN = "signed-in"
    /**
     * The modes the Social page offers (owner-approved 2026-11-15). "signed-in" (the 2026-11-16 first-publish default)
     * and "accepted" stay readable in old indexes; the picker shows them as "callback" and the next publish writes that.
     */
    const val FROM_ANYONE = "anyone"
    const val FROM_CALLBACK = "callback"
    val FROM_VALUES = listOf(FROM_ACCEPTED, FROM_SIGNED_IN, FROM_ANYONE, FROM_CALLBACK)
    val FROM_CHOICES = listOf(FROM_ANYONE, FROM_CALLBACK)

    /** What a publish carries forward from the index it replaces: "signed-in" (no longer offered) becomes "callback". */
    fun carried(from: String): String = if (from == FROM_SIGNED_IN) FROM_CALLBACK else from

    /** What the picker shows for a stored mode: one of [FROM_CHOICES]. */
    fun mode(from: String?): String = if (from in FROM_CHOICES) from!! else FROM_CALLBACK

    /**
     * What a page's first publish carries (owner decisions 2026-11-16 and 2026-11-20, docs/voici-and-messages.md §5.4):
     * calls on from people who let you call them back (signed in, never anonymous); messages on is
     * VoiciOwner.FIRST_PUBLISH_ACCEPTS_MESSAGES. A later publish keeps the owner's choices.
     */
    val FIRST_PUBLISH: Pair<Boolean, String> = true to FROM_CALLBACK

    /** The index fields for a calls setting: v2 fields while on, none (a v1 index) while off. */
    fun indexFields(on: Boolean, from: String): Pair<Int?, String?> =
        if (on) 1 to (if (from in FROM_VALUES) from else FROM_ACCEPTED) else null to null

    /** What a calls setting in a published index reads as: (on, from). */
    fun read(acceptsCalls: Int?, callsFrom: String?): Pair<Boolean, String> =
        (acceptsCalls == 1) to (callsFrom?.takeIf { it in FROM_VALUES } ?: FROM_ACCEPTED)

    /**
     * The editor's form of the owner's call hours (a synced setting, never in the page: VoiciCallHoursSettings).
     * [days] are 0 = Monday to 6 = Sunday; [start] and [end] minutes of the day (an end before the start runs past midnight).
     */
    data class CallHours(val days: Set<Int>, val start: Int, val end: Int, val zone: String) {
        fun toHours(): com.flagshipserver.app.core.voici.VoiciCallHours {
            fun hm(m: Int) = "%02d%02d".format(java.util.Locale.ROOT, m / 60, m % 60)
            return com.flagshipserver.app.core.voici.VoiciCallHours((0..6).joinToString("") { if (it in days) "1" else "0" }, hm(start), hm(end), zone)
        }
        /** Hours the setting takes (a day picked, start ≠ end, a known zone). */
        val valid: Boolean get() = com.flagshipserver.app.core.voici.VoiciCallHoursSettings.parseHours(toHours().toJson()) != null

        companion object {
            /** Weekdays 9:00 to 17:00 in this device's zone: what the editor starts from. */
            fun default(zone: String) = CallHours((0..4).toSet(), 9 * 60, 17 * 60, zone)

            fun from(h: com.flagshipserver.app.core.voici.VoiciCallHours?): CallHours? {
                val v = h?.let { com.flagshipserver.app.core.voici.VoiciCallHoursSettings.parseHours(it.toJson()) } ?: return null
                fun m(x: String) = x.substring(0, 2).toInt() * 60 + x.substring(2).toInt()
                return CallHours((0..6).filter { v.days[it] == '1' }.toSet(), m(v.from), m(v.to), v.zone)
            }
        }
    }

    enum class Note { PublishFirst, AdminOnly }

    data class ViewState(val canEdit: Boolean, val showsWho: Boolean, val note: Note?)

    fun viewState(isAdmin: Boolean, isPublic: Boolean, callsOn: Boolean): ViewState {
        val note = when {
            !isPublic -> Note.PublishFirst
            !isAdmin -> Note.AdminOnly
            else -> null
        }
        return ViewState(canEdit = note == null, showsWho = isPublic && callsOn, note = note)
    }
}

/** This device's own calls preferences (SharedPreferences; nothing synced). */
class CallSettingsStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("flagship.voici.calls", Context.MODE_PRIVATE).also(::dropQuietHours)

    /**
     * The owner's call hours as last synced (VoiciCallHoursSettings): kept here, on this device, so a call that arrives
     * while the account is locked is still held to them.
     */
    fun callHours(): com.flagshipserver.app.core.voici.VoiciCallHours? =
        prefs.getString("hours", null)?.let { com.flagshipserver.app.core.voici.VoiciJs.parseJson(it) }?.let(com.flagshipserver.app.core.voici.VoiciCallHoursSettings::parseHours)

    fun setCallHours(h: com.flagshipserver.app.core.voici.VoiciCallHours?) {
        if (h == null) prefs.edit().remove("hours").apply() else prefs.edit().putString("hours", h.toJson().toString()).apply()
    }

    /** The last "who can call" picked here, for turning calls on again. */
    fun lastFrom(): String = VoiciCallSettings.mode(prefs.getString("from", null) ?: VoiciCallSettings.FIRST_PUBLISH.second)

    fun setLastFrom(from: String) {
        if (from in VoiciCallSettings.FROM_VALUES) prefs.edit().putString("from", from).apply()
    }
}

/**
 * The app's own Do Not Disturb hours are gone (owner, 2026-11-20): the phone's Do Not Disturb decides. The stored range
 * meant "quiet on this device", the opposite of business hours, so it is dropped, not carried over.
 */
internal fun dropQuietHours(prefs: android.content.SharedPreferences) {
    if (prefs.contains("quietOn") || prefs.contains("quietStart") || prefs.contains("quietEnd")) {
        prefs.edit().remove("quietOn").remove("quietStart").remove("quietEnd").apply()
    }
}

/** A missed call, opened and checked on this device, shown in its conversation's thread. */
data class VoiciMissedCallRow(
    val callId: String,
    val conv: String,
    val pseudonymPub: String,
    val reason: String,
    val ringingAt: Long,
    val video: Boolean,
)

object VoiciMissedCalls {
    /** Opens each item under the inbox seeds (newest epoch first) and checks it; what fails is dropped. */
    fun open(items: List<VoiciMissedCallItem>, seeds: List<ByteArray>, pageId: String, origin: String, caKeys: Collection<String>): List<VoiciMissedCallRow> {
        val out = LinkedHashMap<String, VoiciMissedCallRow>()
        for (item in items) {
            if (item.callId in out) continue
            val sealed = com.flagshipserver.app.core.voici.WebEnvelopes.b64Decode(item.sealed) ?: continue
            for (seed in seeds) {
                val m = VoiciCalls.openMissedCall(seed, item.callId, sealed, pageId, origin, caKeys) ?: continue
                out[item.callId] = VoiciMissedCallRow(item.callId, m.request.conv, m.request.from, m.reason, m.ringingAt, m.request.hasVideo)
                break
            }
        }
        return out.values.sortedBy { it.ringingAt }
    }
}

/** One thread line: a message (by its time) or a missed call. */
sealed class VoiciThreadEntry<out M> {
    abstract val key: String
    data class Message<M>(val message: M, val id: String) : VoiciThreadEntry<M>() { override val key get() = "m:$id" }
    data class MissedCall(val call: VoiciMissedCallRow) : VoiciThreadEntry<Nothing>() { override val key get() = "c:${call.callId}" }

    companion object {
        /** Messages keep their order; each missed call goes in before the first message sent after it rang. */
        fun <M> timeline(messages: List<M>, id: (M) -> String, sentAt: (M) -> Long, calls: List<VoiciMissedCallRow>, conv: String): List<VoiciThreadEntry<M>> {
            val pending = ArrayDeque(calls.filter { it.conv == conv }.sortedBy { it.ringingAt })
            val out = mutableListOf<VoiciThreadEntry<M>>()
            for (m in messages) {
                while (pending.isNotEmpty() && pending.first().ringingAt <= sentAt(m)) out += MissedCall(pending.removeFirst())
                out += Message(m, id(m))
            }
            pending.forEach { out += MissedCall(it) }
            return out
        }
    }
}
