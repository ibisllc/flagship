// The security sliver's data (SECURITY-HARDENING-PLAN.md 18.14) and the owner's answer to a waiting
// publisher key (18.11). The box decides severities; this only reads them and, for a waiting key,
// signs exactly "this service, this old key to this new key" with the account's sensitive key.
// Mirror of FlagshipUI/SecuritySliverViewModel.swift.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.SliverLine
import com.flagshipserver.app.core.WaitingPublisherResponse
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class SecuritySliverViewModel(
    private val client: ScreensClient,
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val _lines = MutableStateFlow<List<SliverLine>>(emptyList())
    val lines: StateFlow<List<SliverLine>> = _lines.asStateFlow()
    private val _lostHistory = MutableStateFlow(false)
    val lostHistory: StateFlow<Boolean> = _lostHistory.asStateFlow()
    private val _waiting = MutableStateFlow<Map<String, WaitingPublisherResponse.Waiting>>(emptyMap())
    val waiting: StateFlow<Map<String, WaitingPublisherResponse.Waiting>> = _waiting.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    suspend fun refresh() {
        try {
            val r = client.securitySliver()
            _lines.value = r.lines
            _lostHistory.value = r.lostHistory
            val w = mutableMapOf<String, WaitingPublisherResponse.Waiting>()
            for (l in r.lines) {
                if (l.kind != "publisher-key" || !l.isActive) continue
                val s = try { client.publisherState(l.target).waiting } catch (e: CancellationException) { throw e } catch (_: Throwable) { null }
                if (s != null && !s.rejected) w[l.target] = s
            }
            _waiting.value = w
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            // A box that does not have the sliver yet simply shows nothing.
        }
    }

    suspend fun trust(serviceId: String) {
        try {
            val statement = _waiting.value[serviceId]?.trust
            if (statement == null) {
                _error.value = "No new key is waiting for this service."
                return
            }
            val stamped = statement.copy(issuedAt = now())
            val key = signer("Trust a new publisher key for $serviceId")
            client.trustPublisher(serviceId, stamped, stamped.sign { key.sign(it) })
            _error.value = null
            refresh()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            _error.value = e.userFacing()
        }
    }

    suspend fun reject(serviceId: String) {
        try {
            client.rejectPublisher(serviceId)
            _error.value = null
            refresh()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            _error.value = e.userFacing()
        }
    }
}
