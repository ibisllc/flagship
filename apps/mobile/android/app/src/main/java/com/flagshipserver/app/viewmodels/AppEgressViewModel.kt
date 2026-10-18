// A live app's internet access, on its page. A live app reaches no internet
// host until the owner signs an approval for hosts its manifest declares
// (flagship/app-egress/v1, sensitive-order key); "Stop access" signs an empty
// list. The signature is the consent the box verifies, never a boolean.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.UserErrorText
import com.flagshipserver.app.api.AppEgress
import com.flagshipserver.app.api.AppEgressGrantBody
import com.flagshipserver.app.api.AppEgressRequest
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.AppEgressGrant
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class AppEgressViewModel(
    private val serviceId: String,
    private val client: ScreensClient,
    initial: AppEgress?,
    /** The box's FQDN when the client can't say (it's what the grant names). */
    private val fallbackServerDomain: () -> String?,
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val _egress = MutableStateFlow(initial)
    val egress: StateFlow<AppEgress?> = _egress.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    /** The page reloaded the app: take the box's latest view. */
    fun update(egress: AppEgress?) {
        if (!_busy.value) _egress.value = egress
    }

    /** Allow every host the app declares. */
    suspend fun allow(): Boolean {
        val declared = _egress.value?.declared ?: return false
        return send(declared, "Allow $serviceId to reach the internet")
    }

    /** Revoke: the app reaches no internet host again. */
    suspend fun stopAccess(): Boolean = send(emptyList(), "Stop $serviceId reaching the internet")

    private suspend fun send(hosts: List<String>, reason: String): Boolean {
        if (_busy.value) return false
        _busy.value = true
        _error.value = null
        try {
            val domain = runCatching { client.boxFqdn() }.getOrNull() ?: fallbackServerDomain()
            if (domain.isNullOrEmpty()) {
                _error.value = "Couldn't tell which server this app is on."
                return false
            }
            val sorted = AppEgressGrant.normalizeHosts(hosts)
            val issuedAt = now()
            val signature = try {
                signer(reason).sign(AppEgressGrant.canonicalBytes(domain, serviceId, sorted, issuedAt))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                _error.value = "Couldn't access your account key: ${UserErrorText.reason(e)}"
                return false
            }
            val r = client.serviceEgressSet(
                serviceId,
                AppEgressRequest(
                    grant = AppEgressGrantBody(domain, serviceId, sorted, issuedAt),
                    signature = HexUtil.encode(signature),
                ),
            )
            r.egress?.let { _egress.value = it }
            return true
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            _error.value = friendlyError(t)
            return false
        } finally {
            _busy.value = false
        }
    }

    companion object {
        const val PENDING_TITLE = "This app wants to reach the internet"
        const val PENDING_NOTE =
            "Until you allow them, the app can't reach any of these. Only allow hosts you expect this app to need."
        const val ALLOW = "Allow"
        const val APPROVED_TITLE = "Internet access"
        const val APPROVED_NOTE = "The app can reach only these hosts."
        const val STOP = "Stop access"
        const val BADGE = "Wants internet"

        fun friendlyError(t: Throwable): String {
            if (t !is ScreensError.Http) return t.userFacing()
            val box = t.boxError()
            return when (t.status) {
                400 -> "The server couldn't read this approval${box?.let { ": $it" } ?: ""}."
                403 -> "The server refused this approval${box?.let { ": $it" } ?: ""}. Check this phone's clock and try again."
                404 -> "This app is no longer installed on the server."
                409 -> "A newer approval is already in place. Reload the page and try again."
                422 -> box ?: "The app doesn't declare one of these hosts."
                else -> box ?: t.userFacing()
            }
        }
    }
}

/** What the app page shows for its internet access. */
data class EgressCardState(
    /** Declared hosts awaiting approval; the "wants to reach the internet" card. */
    val pending: List<String>,
    /** Hosts the app can reach now. */
    val approved: List<String>,
    /** The owner can sign (a restricted companion profile can't). */
    val canSign: Boolean,
) {
    val showsPending: Boolean get() = pending.isNotEmpty()
    val showsApproved: Boolean get() = approved.isNotEmpty()

    companion object {
        /** Null: an older box without the egress gateway, or nothing to show. */
        fun from(egress: AppEgress?, restricted: Boolean): EgressCardState? {
            egress ?: return null
            val state = EgressCardState(egress.pending, egress.approved, canSign = !restricted)
            return state.takeIf { it.showsPending || it.showsApproved }
        }

        /** The app list row's badge: approval pending. */
        fun showsBadge(egress: AppEgress?): Boolean = egress?.pending?.isNotEmpty() == true
    }
}
