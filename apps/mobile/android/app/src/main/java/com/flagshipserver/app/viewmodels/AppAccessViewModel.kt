// A live app's access list (docs/ai-privacy-and-staging.md §3a): the service
// page's "Internet access" section, the list editor, and the alert's Allow /
// Deny all end in one signed order. Each change is signed with the
// sensitive-order key over the list's hash; the box enforces only a list the
// owner signed.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppAccessGrantBody
import com.flagshipserver.app.api.AppAccessLineError
import com.flagshipserver.app.api.AppAccessPending
import com.flagshipserver.app.api.AppAccessRefusal
import com.flagshipserver.app.api.AppAccessSetRequest
import com.flagshipserver.app.api.AppAccessState
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.AppAccessList
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json

/** Signs and sends one access list to one box. */
class AppAccessOrder(
    private val client: ScreensClient,
    /** The box's FQDN when the client can't say (it's what the grant names). */
    private val fallbackServerDomain: () -> String? = { null },
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    sealed interface Outcome {
        data class Applied(val state: AppAccessState) : Outcome
        /** The box found errors in the list (a 400 with line errors). */
        data class Invalid(val errors: List<AppAccessLineError>, val message: String) : Outcome
        data class Failed(val message: String) : Outcome
    }

    suspend fun send(serviceId: String, list: String, reason: String): Outcome {
        val normalized = AppAccessList.normalize(list)
        val parsed = AppAccessList.parse(normalized)
        if (!parsed.ok) {
            return Outcome.Invalid(parsed.errors.map { AppAccessLineError(it.line, it.message) }, LIST_HAS_ERRORS)
        }
        return try {
            val domain = runCatching { client.boxFqdn() }.getOrNull() ?: fallbackServerDomain()
            if (domain.isNullOrEmpty()) return Outcome.Failed("Couldn't tell which server this app is on.")
            val key = try {
                signer(reason)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                return Outcome.Failed("Couldn't access your account key: ${e.message}")
            }
            val signed = AppAccessList.sign(key, domain, serviceId, normalized, now())
            val r = client.serviceAccessSet(
                serviceId,
                AppAccessSetRequest(
                    list = signed.list,
                    grant = AppAccessGrantBody(domain, serviceId, signed.listSha256, signed.issuedAt),
                    signature = signed.signatureHex,
                ),
            )
            val state = r.state(LENIENT)
                ?: runCatching { client.serviceAccess(serviceId) }.getOrNull()
                ?: AppAccessState(signed.list, signed.listSha256)
            Outcome.Applied(state)
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            refusal(t)
        }
    }

    companion object {
        const val LIST_HAS_ERRORS = "Fix the lines marked below, then save."
        private val LENIENT = Json { ignoreUnknownKeys = true }

        fun refusal(t: Throwable): Outcome {
            if (t !is ScreensError.Http) return Outcome.Failed(t.userFacing())
            val box = t.boxError()
            return when (t.status) {
                400 -> {
                    val errors = runCatching { LENIENT.decodeFromString(AppAccessRefusal.serializer(), t.body).errors }
                        .getOrNull().orEmpty()
                    if (errors.isNotEmpty()) Outcome.Invalid(errors, "The server found errors in this list.")
                    else Outcome.Failed("The server couldn't read this list${box?.let { ": $it" } ?: ""}.")
                }
                403 -> Outcome.Failed(
                    "The server refused this change${box?.let { ": $it" } ?: ""}. Check this phone's clock and try again.",
                )
                404 -> Outcome.Failed("This app is no longer installed on the server.")
                409 -> Outcome.Failed("The list changed since you opened it. Reload it and try again.")
                else -> Outcome.Failed(box ?: t.userFacing())
            }
        }
    }
}

class AppAccessViewModel(
    private val serviceId: String,
    private val client: ScreensClient,
    private val order: AppAccessOrder = AppAccessOrder(client),
    /** For the signing prompt and the confirmations. */
    private val appName: String = serviceId,
) {
    private val _state = MutableStateFlow<AppAccessState?>(null)
    val state: StateFlow<AppAccessState?> = _state.asStateFlow()

    private val _loadError = MutableStateFlow<String?>(null)
    val loadError: StateFlow<String?> = _loadError.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    /** Line errors the box reported for the last save. */
    private val _boxErrors = MutableStateFlow<List<AppAccessLineError>>(emptyList())
    val boxErrors: StateFlow<List<AppAccessLineError>> = _boxErrors.asStateFlow()

    val ruleCount: Int get() = _state.value?.let { AppAccessList.parse(it.list).rules.size } ?: 0

    suspend fun load() {
        try {
            _state.value = client.serviceAccess(serviceId)
            _loadError.value = null
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            if (_state.value == null) _loadError.value = t.userFacing()
        }
    }

    /** Allow or deny one pending host: the new rule goes on top so it decides. */
    suspend fun answer(host: String, allow: Boolean): Boolean {
        val base = runCatching { client.serviceAccess(serviceId) }.getOrNull() ?: _state.value
            ?: AppAccessState()
        val list = try {
            AppAccessList.withRule(base.list, if (allow) AppAccessList.ALLOW else AppAccessList.DENY, host)
        } catch (e: IllegalArgumentException) {
            _error.value = "\"$host\" can't go in an access list: ${e.message}"
            return false
        }
        return save(list, if (allow) "Allow $appName to reach $host" else "Stop $appName reaching $host")
    }

    /** Ignore: forget the request without changing the list. */
    suspend fun dismiss(host: String): Boolean {
        if (_busy.value) return false
        _busy.value = true
        _error.value = null
        return try {
            client.serviceAccessDismiss(serviceId, host)
            _state.value = _state.value?.let { s -> s.copy(pending = s.pending.filter { it.host != host }) }
            true
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            _error.value = t.boxError() ?: t.userFacing()
            false
        } finally {
            _busy.value = false
        }
    }

    suspend fun save(list: String, reason: String = "Change which hosts $appName can reach"): Boolean {
        if (_busy.value) return false
        _busy.value = true
        _error.value = null
        _boxErrors.value = emptyList()
        try {
            return when (val r = order.send(serviceId, list, reason)) {
                is AppAccessOrder.Outcome.Applied -> {
                    _state.value = r.state
                    true
                }
                is AppAccessOrder.Outcome.Invalid -> {
                    _boxErrors.value = r.errors
                    _error.value = r.message
                    false
                }
                is AppAccessOrder.Outcome.Failed -> {
                    _error.value = r.message
                    false
                }
            }
        } finally {
            _busy.value = false
        }
    }

    companion object {
        const val TITLE = "Internet access"
        const val VIEW_LIST = "View access list"
        const val ALLOW = "Allow"
        const val DENY = "Deny"
        const val IGNORE = "Ignore"
        const val NOT_NOW = "Not now"
        const val BADGE = "Wants internet"
        const val READ_ONLY_NOTE = "This device can see the list but not change it."
        const val EDITOR_HELP =
            "One rule per line, checked from the top: the first rule that matches decides, and a host no rule matches is denied. " +
                "Write allow or deny, then a host, *.example.com for its subdomains, or all. # starts a comment."

        fun ruleCountText(n: Int): String = when (n) {
            0 -> "No rules yet, so the app can't reach the internet."
            1 -> "1 rule"
            else -> "$n rules"
        }

        fun sourceText(source: String, attempts: Int): String = when (source) {
            AppAccessPending.SOURCE_APP -> "Asked for this when it was installed."
            else -> if (attempts > 1) "Tried to connect $attempts times." else "Tried to connect."
        }

        fun asksText(app: String, host: String) = "$app wants to reach $host"
        fun allowedText(app: String, host: String) = "$app can now reach $host"
        fun deniedText(app: String, host: String) = "$app won't reach $host"

        /** The app list badge: a host is waiting for an answer. A box from
         *  before access lists falls back to the v1 egress approval. */
        fun showsBadge(app: com.flagshipserver.app.api.AppSummary): Boolean =
            app.access?.let { it.pending > 0 } ?: EgressCardState.showsBadge(app.egress)

        /** Errors to show, by line: the box's after a refused save, else the live parse's. */
        fun lineErrors(draft: String, boxErrors: List<AppAccessLineError>): List<AppAccessLineError> {
            val local = AppAccessList.parse(draft).errors.map { AppAccessLineError(it.line, it.message) }
            return local.ifEmpty { boxErrors }
        }
    }
}
