// The three owner controls from the 0.3 security work (see core/SecurityControls.kt).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.AppAccessOrders
import com.flagshipserver.app.core.CompanionDelegation
import com.flagshipserver.app.core.CompanionDelegationBody
import com.flagshipserver.app.core.CompanionDelegationRequest
import com.flagshipserver.app.core.CompanionDelegationRow
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.RestoredAccessApproveBody
import com.flagshipserver.app.core.RestoredAccessDraft
import com.flagshipserver.app.core.RestoredApproveRequest
import com.flagshipserver.app.core.UpdateModeState
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

private val defaultSigner: suspend (String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) }

/** Permissions a restore held back for ONE app: approve the exact draft, or discard it (N09). */
class RestoredAccessViewModel(
    private val serviceRef: String,
    private val client: ScreensClient,
    private val signer: suspend (String) -> Ed25519Sign = defaultSigner,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val _draft = MutableStateFlow<RestoredAccessDraft?>(null)
    val draft: StateFlow<RestoredAccessDraft?> = _draft.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    suspend fun load() {
        _draft.value = try {
            client.restoredAccessDrafts().drafts.firstOrNull { it.serviceRef == serviceRef }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        }
    }

    suspend fun approve() {
        val d = _draft.value ?: return
        try {
            val order = AppAccessOrders.RestoredApprove(serviceRef, d.sha256, now())
            val key = signer("Approve the permissions restored for $serviceRef")
            val sig = HexUtil.encode(key.sign(AppAccessOrders.canonicalBytes(order)))
            client.approveRestoredAccess(RestoredAccessApproveBody(RestoredApproveRequest(serviceRef, d.sha256, order.issuedAt), sig))
            _error.value = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            _error.value = e.userFacing()
        }
        load()
    }

    suspend fun discard() {
        try {
            client.discardRestoredAccess(serviceRef)
            _error.value = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            _error.value = e.userFacing()
        }
        load()
    }
}

/** How ONE app takes updates (N11). A box without the setting, or an app with no publisher, shows nothing. */
class UpdateModeViewModel(private val serviceId: String, private val client: ScreensClient) {
    private val _state = MutableStateFlow<UpdateModeState?>(null)
    val state: StateFlow<UpdateModeState?> = _state.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    suspend fun load() {
        _state.value = try {
            client.updateMode(serviceId)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        }
    }

    suspend fun choose(mode: String) {
        try {
            client.setUpdateMode(serviceId, mode)
            _error.value = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            _error.value = e.userFacing()
        }
        load()
    }
}

/** Letting ONE Remote browser session build or deploy ONE app (SEC-AUTH-002). */
class CompanionDelegationViewModel(
    private val sessionId: String,
    private val client: ScreensClient,
    private val signer: suspend (String) -> Ed25519Sign = defaultSigner,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val _rows = MutableStateFlow<List<CompanionDelegationRow>>(emptyList())
    val rows: StateFlow<List<CompanionDelegationRow>> = _rows.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    suspend fun load() {
        _rows.value = try {
            client.companionDelegations(sessionId).delegations
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            emptyList()
        }
    }

    /** Signs exactly this session, app, operations and window; the window is capped at a day. */
    suspend fun allow(serviceRef: String, ops: List<String>, durationMs: Long) {
        try {
            val issued = now()
            val sorted = ops.toSet().sorted()
            val order = CompanionDelegation.Order(sessionId, serviceRef, sorted, issued, issued + durationMs.coerceIn(60_000L, CompanionDelegation.MAX_MS))
            val bytes = CompanionDelegation.canonicalBytes(order)
            val key = signer("Let a browser change $serviceRef")
            client.allowCompanionBuild(CompanionDelegationBody(CompanionDelegationRequest(sessionId, serviceRef, sorted, order.issuedAt, order.expiresAt), HexUtil.encode(key.sign(bytes))))
            _error.value = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            _error.value = e.userFacing()
        }
        load()
    }

    suspend fun end(serviceRef: String) {
        try {
            client.endCompanionDelegation(sessionId, serviceRef)
            _error.value = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            _error.value = e.userFacing()
        }
        load()
    }
}
