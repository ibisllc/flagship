// Pairs THIS phone-driven order with a control device's target box: signs an
// owner-IRK `add-paired-session` order for the scanned pod FQDN and POSTs it
// to the box's /api/orders-from-user. Kotlin mirror of iOS
// FlagshipUI/ViewModels/PodPairViewModel.swift + the webapp lib/podPair.js.
//
// On HTTP 200 the daemon stores the fresh 32-byte token verbatim as the
// x-flagship-session paired-session token; the phone persists it so the BFF
// authenticates from then on.
//
// IDEMPOTENT: if a session token already exists, send() no-ops — it never
// re-pairs and never re-prompts the biometric (mirrors iOS pair()).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AddPairedSessionInner
import com.flagshipserver.app.api.AddPairedSessionRequest
import com.flagshipserver.app.api.LockPowerClient
import com.flagshipserver.app.api.SessionStoring
import com.flagshipserver.app.core.AddPairedSessionOrder
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface AddControlDevicePhase {
    data object Idle : AddControlDevicePhase
    /** A session token already exists — nothing to do. */
    data object AlreadyPaired : AddControlDevicePhase
    data object Signing : AddControlDevicePhase
    data object Posting : AddControlDevicePhase
    data object Paired : AddControlDevicePhase
    data class Failed(val message: String) : AddControlDevicePhase
}

class AddControlDeviceViewModel(
    private val store: SessionStoring,
    /** Biometric-gated owner-IRK signer; mirrors PowerOffViewModel. */
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
    private val client: LockPowerClient = LockPowerClient(),
    private val label: String = "Android",
    private val now: () -> Long = { System.currentTimeMillis() },
    private val makeToken: () -> String = { AddPairedSessionOrder.freshToken() },
) {
    private val _phase = MutableStateFlow<AddControlDevicePhase>(AddControlDevicePhase.Idle)
    val phase: StateFlow<AddControlDevicePhase> = _phase.asStateFlow()

    /**
     * Resolve the target pod FQDN from a scanned QR string. The control device
     * shows its server's FQDN, optionally wrapped as `https://<fqdn>` or a URL.
     * Returns null when nothing resembling a flagship pod host is present.
     */
    fun resolveServerDomain(scanned: String): String? {
        val raw = scanned.trim()
        if (raw.isEmpty()) return null
        val host = if (raw.contains("://")) {
            runCatching { java.net.URI(raw).host }.getOrNull() ?: return null
        } else {
            raw.substringBefore('/').substringBefore('?')
        }
        val clean = host.trim().lowercase()
        if (clean.isEmpty() || clean.contains(' ')) return null
        return clean
    }

    /** Fire once per user confirm (the biometric fires inside [signer]). */
    suspend fun send(scanned: String) {
        val serverDomain = resolveServerDomain(scanned)
        if (serverDomain == null) {
            _phase.value = AddControlDevicePhase.Failed(
                "That QR didn't carry a server address. Make sure you're scanning the pairing QR.",
            )
            return
        }
        // Idempotency (Fix B) — a PER-POD token already on disk for THIS box means
        // this device is paired with it. Keyed per pod so pairing a 2nd box isn't
        // blocked by the 1st box's token (the old single-slot guard did exactly
        // that).
        val podId = com.flagshipserver.app.core.PodInfo.podId(serverDomain)
        val existing = store.sessionToken(forPodId = podId)
        if (!existing.isNullOrEmpty()) {
            _phase.value = AddControlDevicePhase.AlreadyPaired
            return
        }

        _phase.value = AddControlDevicePhase.Signing
        val irk: Ed25519Sign
        try {
            irk = signer("Pair this device with $serverDomain")
        } catch (e: Throwable) {
            _phase.value = AddControlDevicePhase.Failed("Couldn't access your account key: ${e.message}")
            return
        }

        val token = makeToken()
        val cleaned = AddPairedSessionOrder.sanitizeLabel(label)
        val issuedAt = now()
        val signature: ByteArray
        try {
            signature = irk.sign(AddPairedSessionOrder.canonicalBytes(serverDomain, token, cleaned, issuedAt))
        } catch (e: Throwable) {
            _phase.value = AddControlDevicePhase.Failed("Couldn't sign: ${e.message}")
            return
        }

        _phase.value = AddControlDevicePhase.Posting
        try {
            client.pairSession(
                serverDomain,
                AddPairedSessionRequest(
                    request = AddPairedSessionInner(
                        serverId = serverDomain,
                        token = token,
                        label = cleaned,
                        issuedAt = issuedAt,
                    ),
                    signature = HexUtil.encode(signature),
                ),
            )
        } catch (e: HttpException) {
            val friendly = when (e.status) {
                403 -> "The box rejected the request. Sign in again and retry."
                404, 502, 503 -> "The box isn't reachable right now."
                else -> "Server error (${e.status}): ${e.body}"
            }
            _phase.value = AddControlDevicePhase.Failed(friendly)
            return
        } catch (e: Throwable) {
            _phase.value = AddControlDevicePhase.Failed("Couldn't reach the box: ${e.message}")
            return
        }

        // Persist ONLY after the box accepted the order — a token the daemon
        // never stored would auth nothing and defeat the idempotency guard.
        // MULTI-POD (Fix B): write the token under THIS pod's id
        // (`pod-<lowercased-fqdn>`) so a 2nd box's pairing can't overwrite the
        // 1st's; then activate it into the single active slots. Base URL is
        // deterministic from the fqdn (`https://<fqdn>`).
        store.setSessionToken(token, forPodId = podId)
        store.setPodBaseUrl("https://$serverDomain")
        store.setSessionToken(token)
        _phase.value = AddControlDevicePhase.Paired
    }
}
