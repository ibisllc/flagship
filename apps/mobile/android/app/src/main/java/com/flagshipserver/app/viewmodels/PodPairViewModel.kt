// Pairs THIS device with a server's box so the `/api/screens/*` BFF becomes
// reachable. Kotlin mirror of iOS FlagshipUI/ViewModels/PodPairViewModel.swift +
// the webapp lib/podPair.js.
//
// The BFF is gated on a paired-session token in the `x-flagship-session` header.
// The phone mints one by signing an `add-paired-session` order with the OWNER IRK
// (biometric) and POSTing it to `<podBaseUrl>/api/orders-from-user`; on HTTP 200
// the daemon stores the 32-byte token verbatim and the phone persists it.
//
// Pairing-for-use is NOT a sensitive op (docs/device-admin-entitlements.md
// Slice B) — every control device is meant to see every server — so this is
// admin-independent and safe to run automatically. Two entry points:
//   • [PodPairViewModel] — one pod, one biometric. The MANUAL fallback (a "Pair
//     this device" affordance) + the iOS-parity unit-tested idempotency guard.
//   • [PodAutoPairCoordinator] — on app unlock, derives the IRK ONCE and pairs
//     every visible pod that lacks a token in the background.
//
// IDEMPOTENT: a pod with a stored per-pod token is skipped — never re-paired,
// never re-prompted (mirror of iOS `pair()` Fix-B per-pod keying).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AddPairedSessionInner
import com.flagshipserver.app.api.AddPairedSessionRequest
import com.flagshipserver.app.api.LockPowerClient
import com.flagshipserver.app.api.SessionStoring
import com.flagshipserver.app.core.AddPairedSessionOrder
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface PodPairPhase {
    data object Idle : PodPairPhase
    /** A per-pod token already exists — nothing to do. */
    data object AlreadyPaired : PodPairPhase
    data object Signing : PodPairPhase
    data object Posting : PodPairPhase
    data object Paired : PodPairPhase
    data class Failed(val message: String) : PodPairPhase
}

class PodPairViewModel(
    private val store: SessionStoring,
    private val serverDomain: String,
    /** Biometric-gated owner-IRK signer. */
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
    private val client: LockPowerClient = LockPowerClient(),
    private val label: String = "Android",
    private val now: () -> Long = { System.currentTimeMillis() },
    private val makeToken: () -> String = { AddPairedSessionOrder.freshToken() },
) {
    private val _phase = MutableStateFlow<PodPairPhase>(PodPairPhase.Idle)
    val phase: StateFlow<PodPairPhase> = _phase.asStateFlow()

    /** One pairing attempt. Fire once per user tap — the biometric fires inside
     *  [signer], so never call this in a loop or on appearance. Idempotent: a
     *  present per-pod token no-ops without a biometric. */
    suspend fun pair() {
        val podId = PodInfo.podId(serverDomain)
        val existing = store.sessionToken(forPodId = podId)
        if (!existing.isNullOrEmpty()) {
            _phase.value = PodPairPhase.AlreadyPaired
            return
        }

        _phase.value = PodPairPhase.Signing
        val irk: Ed25519Sign
        try {
            irk = signer("Pair this device with $serverDomain")
        } catch (e: Throwable) {
            _phase.value = PodPairPhase.Failed("Couldn't access your account key: ${e.message}")
            return
        }

        val token = makeToken()
        val cleaned = AddPairedSessionOrder.sanitizeLabel(label)
        val issuedAt = now()
        val signature: ByteArray
        try {
            signature = irk.sign(AddPairedSessionOrder.canonicalBytes(serverDomain, token, cleaned, issuedAt))
        } catch (e: Throwable) {
            _phase.value = PodPairPhase.Failed("Couldn't sign: ${e.message}")
            return
        }

        _phase.value = PodPairPhase.Posting
        try {
            client.pairSession(
                serverDomain,
                AddPairedSessionRequest(
                    request = AddPairedSessionInner(serverId = serverDomain, token = token, label = cleaned, issuedAt = issuedAt),
                    signature = HexUtil.encode(signature),
                ),
            )
        } catch (e: HttpException) {
            _phase.value = PodPairPhase.Failed(
                when (e.status) {
                    403 -> "The box rejected the request. Sign in again and retry."
                    404, 502, 503 -> "The box isn't reachable right now."
                    else -> "Server error (${e.status})."
                },
            )
            return
        } catch (e: Throwable) {
            _phase.value = PodPairPhase.Failed("Couldn't reach the box: ${e.message}")
            return
        }

        // Persist ONLY after the box accepted the order — a token the daemon
        // never stored would auth nothing and defeat the idempotency guard.
        // Write under THIS pod's id + mirror into the active slots so the
        // just-paired box's BFF auths immediately.
        store.setSessionToken(token, forPodId = podId)
        store.setPodBaseUrl("https://$serverDomain")
        store.setSessionToken(token)
        _phase.value = PodPairPhase.Paired
    }
}

/**
 * Background auto-pairing (Slice B). On app unlock with pods loaded, derives the
 * owner IRK ONCE (one biometric) and pairs every visible pod that lacks a stored
 * session token, reusing the single derived key for all of them. Idempotent — it
 * does NOT prompt the biometric when nothing is pending — and a per-pod failure
 * is swallowed so a single unreachable box never blocks the others (it retries on
 * the next unlock). Persists ONLY the per-pod token (never the single active
 * slot — `PodSessionSync` owns activation), so it never clobbers the current
 * pod's session.
 */
class PodAutoPairCoordinator(
    private val store: SessionStoring,
    private val client: LockPowerClient = LockPowerClient(),
    private val label: String = "Android",
    private val now: () -> Long = { System.currentTimeMillis() },
    private val makeToken: () -> String = { AddPairedSessionOrder.freshToken() },
) {
    /** FQDNs of the given pods that have an address but no stored per-pod token. */
    fun pending(pods: List<PodInfo>): List<String> =
        pods.asSequence()
            .filter { it.fqdn.isNotEmpty() && store.sessionToken(forPodId = it.podId).isNullOrEmpty() }
            .map { it.fqdn }
            .distinct()
            .toList()

    /** Pair every pending pod behind ONE biometric. Returns the FQDNs freshly
     *  paired. No-op (no biometric) when nothing is pending. [deriveIrk] is the
     *  biometric-gated owner-IRK signer (passed explicitly — a suspend default on
     *  a suspend fn hits a Kotlin ICE; callers use `Keystore::deriveIRK`). */
    suspend fun pairAll(
        pods: List<PodInfo>,
        deriveIrk: suspend (reason: String) -> Ed25519Sign,
    ): List<String> {
        val targets = pending(pods)
        if (targets.isEmpty()) return emptyList()

        val irk: Ed25519Sign = try {
            deriveIrk("Set up secure access to your servers")
        } catch (_: Throwable) {
            return emptyList()
        }
        val cleaned = AddPairedSessionOrder.sanitizeLabel(label)
        val paired = mutableListOf<String>()
        for (fqdn in targets) {
            try {
                val token = makeToken()
                val issuedAt = now()
                val sig = irk.sign(AddPairedSessionOrder.canonicalBytes(fqdn, token, cleaned, issuedAt))
                client.pairSession(
                    fqdn,
                    AddPairedSessionRequest(
                        request = AddPairedSessionInner(serverId = fqdn, token = token, label = cleaned, issuedAt = issuedAt),
                        signature = HexUtil.encode(sig),
                    ),
                )
                // Persist only after the 200 — never before (would auth nothing
                // and defeat idempotency). Per-pod only; activation is separate.
                store.setSessionToken(token, forPodId = PodInfo.podId(fqdn))
                paired.add(fqdn)
            } catch (_: Throwable) {
                // Silent — a per-pod failure retries on the next unlock.
            }
        }
        return paired
    }
}
