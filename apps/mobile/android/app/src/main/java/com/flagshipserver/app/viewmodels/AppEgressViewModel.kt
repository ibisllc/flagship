// A live app's internet access, on its page. A live app reaches no internet
// host until the owner signs an approval for hosts its manifest declares
// (flagship/app-egress/v1, sensitive-order key); "Stop access" signs an empty
// list. The signature is the consent the box verifies, never a boolean.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
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
        return send(declared, FSStrings.get(R.string.allow_to_reach_the_internet, serviceId))
    }

    /** Revoke: the app reaches no internet host again. */
    suspend fun stopAccess(): Boolean = send(emptyList(), FSStrings.get(R.string.stop_reaching_the_internet, serviceId))

    private suspend fun send(hosts: List<String>, reason: String): Boolean {
        if (_busy.value) return false
        _busy.value = true
        _error.value = null
        try {
            val domain = runCatching { client.boxFqdn() }.getOrNull() ?: fallbackServerDomain()
            if (domain.isNullOrEmpty()) {
                _error.value = FSStrings.get(R.string.couldnt_tell_which_server_this_app)
                return false
            }
            val sorted = AppEgressGrant.normalizeHosts(hosts)
            val issuedAt = now()
            val signature = try {
                signer(reason).sign(AppEgressGrant.canonicalBytes(domain, serviceId, sorted, issuedAt))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                _error.value = FSStrings.get(R.string.couldnt_access_your_account_key, UserErrorText.reason(e))
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
        val PENDING_TITLE get() = FSStrings.get(R.string.this_app_wants_to_reach_the)
        val PENDING_NOTE get() =
            FSStrings.get(R.string.until_you_allow_them_the_app)
        const val ALLOW = "Allow"
        val APPROVED_TITLE get() = FSStrings.get(R.string.internet_access)
        val APPROVED_NOTE get() = FSStrings.get(R.string.the_app_can_reach_only_these)
        val STOP get() = FSStrings.get(R.string.stop_access)
        val BADGE get() = FSStrings.get(R.string.wants_internet)

        fun friendlyError(t: Throwable): String {
            if (t !is ScreensError.Http) return t.userFacing()
            val box = t.boxError()
            return when (t.status) {
                400 -> FSStrings.get(R.string.the_server_couldnt_read_this_approval, box?.let { ": $it" } ?: "")
                403 -> FSStrings.get(R.string.the_server_refused_this_approval_check, box?.let { ": $it" } ?: "")
                404 -> FSStrings.get(R.string.this_app_is_no_longer_installed)
                409 -> FSStrings.get(R.string.a_newer_approval_is_already_in)
                422 -> box ?: FSStrings.get(R.string.the_app_doesnt_declare_one_of)
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
