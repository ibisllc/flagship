// How the phone reaches a retail box (docs/retail-box-setup.md §7.1, §11.2, §15.1). The claim flow
// only sees these: BluetoothLeScanner on Android, the blind `.com` mailbox for the sharing method,
// and a scripted box for the mock gym. Kotlin twin of iOS FlagshipCore/RetailClaimTransport.swift.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.core.pq.BoxClaim
import kotlinx.coroutines.delay
import java.util.Base64

/** One unclaimed box the radio hears. [advertId] is the box's random per-boot id (scan response);
 *  [peripheral] is the radio's own handle for connecting. */
data class BoxClaimAdvert(val peripheral: String, val advertId: String, val state: BoxClaim.AdvertState)

class BoxClaimRadioException(val kind: Kind) : Exception(kind.name) {
    enum class Kind { BLUETOOTH_OFF, NOT_ALLOWED, UNSUPPORTED, CONNECT_FAILED, LINK_CLOSED }
}

/** A link carries whole claim messages ([BoxClaim.encodeMessage]) in order. */
interface BoxClaimLink {
    suspend fun send(message: ByteArray)
    /** The next whole message from the box; throws LINK_CLOSED when the link ends. */
    suspend fun receive(): ByteArray
    fun close()
}

interface BoxClaimRadio {
    /** Starts scanning; [onAdverts] gets every claim advert heard in the last few seconds, again on
     *  each change. Throws when Bluetooth is off or not allowed. */
    suspend fun startScan(onAdverts: (List<BoxClaimAdvert>) -> Unit)
    fun stopScan()
    suspend fun connect(advert: BoxClaimAdvert): BoxClaimLink
}

/** The presence rule (§7.1): no unclaimed box before power-on, then exactly one new one, and the
 *  same one until the claim completes. */
class BoxClaimPresence {
    sealed interface Verdict {
        data object Waiting : Verdict
        data class One(val advert: BoxClaimAdvert) : Verdict
        data object AnotherBoxNearby : Verdict
        data object TwoBoxes : Verdict
    }

    var baselineDone = false
        private set
    var chosen: BoxClaimAdvert? = null
        private set
    private var stopped: Verdict? = null

    /** Adverts heard before the buyer plugged the box in. Any at all stops the setup. */
    fun baseline(adverts: List<BoxClaimAdvert>): Verdict {
        stopped?.let { return it }
        if (adverts.isNotEmpty()) return Verdict.AnotherBoxNearby.also { stopped = it }
        return Verdict.Waiting
    }

    fun endBaseline() { baselineDone = true }

    /** Adverts heard after. A second id, or the first replaced by another, stops the setup for good. */
    fun observe(adverts: List<BoxClaimAdvert>): Verdict {
        stopped?.let { return it }
        if (!baselineDone) return baseline(adverts)
        val ids = adverts.map { it.advertId }.toSet()
        if (ids.size > 1) return Verdict.TwoBoxes.also { stopped = it }
        chosen?.let { c ->
            val id = ids.firstOrNull()
            if (id != null && id != c.advertId) return Verdict.TwoBoxes.also { stopped = it }
            return Verdict.One(c)
        }
        val first = adverts.firstOrNull() ?: return Verdict.Waiting
        chosen = first
        return Verdict.One(first)
    }
}

/** A [BoxClaimLink] over the `.com` mailbox named by a hash of the setup code (§15.1). `.com` sees
 *  only that some bytes passed through a mailbox with an opaque name. */
class MailboxClaimLink(
    private val client: FlagshipServerClient,
    private val mailboxId: String,
    private val pollEveryMs: Long = 1_000,
) : BoxClaimLink {
    private var after = 0
    private val queued = ArrayDeque<ByteArray>()
    @Volatile private var closed = false

    override suspend fun send(message: ByteArray) {
        if (closed) throw BoxClaimRadioException(BoxClaimRadioException.Kind.LINK_CLOSED)
        client.postBoxClaimMailbox(mailboxId, "to-box", Base64.getEncoder().encodeToString(message))
    }

    override suspend fun receive(): ByteArray {
        while (true) {
            if (closed) throw BoxClaimRadioException(BoxClaimRadioException.Kind.LINK_CLOSED)
            synchronized(queued) { queued.removeFirstOrNull() }?.let { return it }
            val msgs = runCatching { client.readBoxClaimMailbox(mailboxId, "to-phone", after) }.getOrDefault(emptyList())
            synchronized(queued) {
                for (m in msgs) if (m.seq > after) {
                    after = m.seq
                    runCatching { Base64.getDecoder().decode(m.body) }.getOrNull()?.let { queued.addLast(it) }
                }
            }
            if (synchronized(queued) { queued.isEmpty() }) delay(pollEveryMs)
        }
    }

    override fun close() { closed = true }
}
