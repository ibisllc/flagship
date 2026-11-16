// The owner's calls settings (docs/voici-calls.md §8), Settings → Messages → Calls. Same rules as iOS
// VoiciCallSettings.swift.
//
// Calls on/off and who may call are part of the signed page index (`flagship/voici-page/v2`, §6): `.com` reads them
// before ringing, so they change only by a publish from an admin device and every device sees them in the index.
// Writers sign v2 only while calls are on; the last "who can call" choice is remembered on the device.
//
// Do Not Disturb is per device and never leaves it: a quiet device doesn't ring and stays out of the room, so another
// device can still answer and an unanswered call becomes a missed call. Keeping the hours off `.com` and the page
// index means no server learns the owner's time zone or habits.

package com.flagshipserver.app.calls

import android.content.Context
import com.flagshipserver.app.api.VoiciMissedCallItem
import com.flagshipserver.app.core.voici.VoiciCalls
import java.util.Calendar

object VoiciCallSettings {
    const val FROM_ACCEPTED = "accepted"
    const val FROM_SIGNED_IN = "signed-in"
    /** The two modes the Social page offers (owner-approved 2026-11-15); the older two stay readable. */
    const val FROM_ANYONE = "anyone"
    const val FROM_CALLBACK = "callback"
    val FROM_VALUES = listOf(FROM_ACCEPTED, FROM_SIGNED_IN, FROM_ANYONE, FROM_CALLBACK)
    val FROM_CHOICES = listOf(FROM_ANYONE, FROM_CALLBACK)

    /** The index fields for a calls setting: v2 fields while on, none (a v1 index) while off. */
    fun indexFields(on: Boolean, from: String): Pair<Int?, String?> =
        if (on) 1 to (if (from in FROM_VALUES) from else FROM_ACCEPTED) else null to null

    /** What a calls setting in a published index reads as: (on, from). */
    fun read(acceptsCalls: Int?, callsFrom: String?): Pair<Boolean, String> =
        (acceptsCalls == 1) to (callsFrom?.takeIf { it in FROM_VALUES } ?: FROM_ACCEPTED)

    /**
     * Call hours as the page index carries them: "<7 day bits, Mon..Sun> <HHMM>-<HHMM> <time zone>". [days] are 0 = Monday
     * to 6 = Sunday; [start] and [end] minutes of the day (an end before the start runs past midnight).
     */
    data class CallHours(val days: Set<Int>, val start: Int, val end: Int, val zone: String) {
        fun value(): String {
            val bits = (0..6).joinToString("") { if (it in days) "1" else "0" }
            fun hm(m: Int) = "%02d%02d".format(java.util.Locale.ROOT, m / 60, m % 60)
            return "$bits ${hm(start)}-${hm(end)} $zone"
        }
        /** A value the page index takes (a day picked, start ≠ end, a known zone). */
        val valid: Boolean get() = com.flagshipserver.app.core.voici.VoiciPage.isVoiciCallHours(value())

        companion object {
            /** Weekdays 9:00 to 17:00 in this device's zone: what the editor starts from. */
            fun default(zone: String) = CallHours((0..4).toSet(), 9 * 60, 17 * 60, zone)

            fun parse(v: String?): CallHours? {
                if (!com.flagshipserver.app.core.voici.VoiciPage.isVoiciCallHours(v)) return null
                val (bits, span, zone) = v!!.split(" ")
                val (a, b) = span.split("-")
                fun m(x: String) = x.substring(0, 2).toInt() * 60 + x.substring(2).toInt()
                return CallHours((0..6).filter { bits[it] == '1' }.toSet(), m(a), m(b), zone)
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

/** This device's Do Not Disturb hours for calls, minutes after local midnight. Start == end means all day. */
data class CallQuietHours(val on: Boolean, val startMinute: Int, val endMinute: Int) {
    fun normalized() = copy(startMinute = clamp(startMinute), endMinute = clamp(endMinute))

    fun isQuiet(minuteOfDay: Int): Boolean {
        if (!on) return false
        val m = clamp(minuteOfDay)
        val s = clamp(startMinute)
        val e = clamp(endMinute)
        if (s == e) return true
        return if (s < e) m in s until e else m >= s || m < e
    }

    fun isQuiet(atMs: Long, calendar: Calendar = Calendar.getInstance()): Boolean {
        calendar.timeInMillis = atMs
        return isQuiet(calendar.get(Calendar.HOUR_OF_DAY) * 60 + calendar.get(Calendar.MINUTE))
    }

    companion object {
        val STANDARD = CallQuietHours(false, 22 * 60, 7 * 60)
        fun clamp(m: Int) = ((m % 1440) + 1440) % 1440
    }
}

/** This device's own calls preferences (SharedPreferences; nothing synced). */
class CallSettingsStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("flagship.voici.calls", Context.MODE_PRIVATE)

    fun quietHours(): CallQuietHours =
        if (!prefs.contains("quietStart")) CallQuietHours.STANDARD
        else CallQuietHours(prefs.getBoolean("quietOn", false), prefs.getInt("quietStart", 0), prefs.getInt("quietEnd", 0)).normalized()

    fun setQuietHours(q: CallQuietHours) {
        val n = q.normalized()
        prefs.edit().putBoolean("quietOn", n.on).putInt("quietStart", n.startMinute).putInt("quietEnd", n.endMinute).apply()
    }

    /** The last "who can call" picked here, for turning calls on again. */
    fun lastFrom(): String = prefs.getString("from", null)?.takeIf { it in VoiciCallSettings.FROM_CHOICES } ?: VoiciCallSettings.FROM_CALLBACK

    fun setLastFrom(from: String) {
        if (from in VoiciCallSettings.FROM_VALUES) prefs.edit().putString("from", from).apply()
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
