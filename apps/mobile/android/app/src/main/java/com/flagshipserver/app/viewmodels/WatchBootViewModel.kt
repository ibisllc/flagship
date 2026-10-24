// The per-server switches under "Quick approve from watch": approve a start-up from the watch
// with this phone locked (core/WatchBootKey.kt). Off by default; on deposits a copy of the
// server's disk key for the watch's boot-only key, off takes every copy away.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.UserErrorText
import com.flagshipserver.app.core.WatchBootOptIn
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class WatchBootViewModel(
    private val optIn: WatchBootOptIn,
    /** The enrolled delegate's public key, or null when Quick approve is off. */
    private val delegatePubHex: () -> String?,
) {
    private val _copies = MutableStateFlow(optIn.live())
    /** Server FQDN (lowercase) → when its copy ends. */
    val copies: StateFlow<Map<String, Long>> = _copies.asStateFlow()

    private val _busy = MutableStateFlow<String?>(null)
    val busy: StateFlow<String?> = _busy.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    fun reload() { _copies.value = optIn.live() }

    suspend fun set(serverDomain: String, serverName: String, on: Boolean, delegateExpiresAt: Long?) {
        val domain = serverDomain.lowercase()
        _busy.value = domain
        _error.value = null
        try {
            if (on) {
                val pub = delegatePubHex()
                if (pub == null || delegateExpiresAt == null) {
                    _error.value = FSStrings.get(R.string.turn_on_quick_approve_from_watch)
                    return
                }
                optIn.enable(domain, pub, delegateExpiresAt, FSStrings.get(R.string.watch_boot_enable_reason, serverName))
            } else {
                optIn.disable(domain, FSStrings.get(R.string.watch_boot_disable_reason, serverName))
            }
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            _error.value = FSStrings.get(R.string.watch_boot_failed, UserErrorText.reason(t))
        } finally {
            _copies.value = optIn.live()
            _busy.value = null
        }
    }

    /** Before the delegate itself goes: take every copy away. */
    suspend fun disableAll(names: Map<String, String>) {
        for (domain in optIn.live().keys) {
            runCatching { optIn.disable(domain, FSStrings.get(R.string.watch_boot_disable_reason, names[domain] ?: domain)) }
        }
        _copies.value = optIn.live()
    }
}
