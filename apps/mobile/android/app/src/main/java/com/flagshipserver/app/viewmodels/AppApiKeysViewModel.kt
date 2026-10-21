// An app's API keys (docs/app-apis.md §3): the service page lists them,
// creates one from a grant signed with the sensitive-order key (the box shows
// the secret once), and revokes one (unsigned: it only removes access).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.core.UserErrorText
import com.flagshipserver.app.api.AppApiKeyCreateRequest
import com.flagshipserver.app.api.AppApiKeyGrantBody
import com.flagshipserver.app.api.AppApiKeyInfo
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.AppApiKey
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

class AppApiKeysViewModel(
    private val serviceId: String,
    private val client: ScreensClient,
    /** For the signing prompt and the revoke confirmation. */
    private val appName: String = serviceId,
    /** The paired session's box when the client can't say (never the leader:
     *  the grant must name the box that receives it). */
    private val fallbackServerDomain: () -> String? = { null },
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
    private val newKeyId: () -> String = { AppApiKey.newKeyId() },
) {
    sealed interface Phase {
        data object Loading : Phase
        /** The box has no API keys (it answered 404): the section stays hidden. */
        data object Unsupported : Phase
        data class Failed(val message: String) : Phase
        data class Loaded(val keys: List<AppApiKeyInfo>) : Phase
    }

    /** A key the box just minted. Held only until the owner closes the dialog. */
    data class Created(val label: String, val key: String)

    private val _phase = MutableStateFlow<Phase>(Phase.Loading)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _created = MutableStateFlow<Created?>(null)
    val created: StateFlow<Created?> = _created.asStateFlow()

    private val keys: List<AppApiKeyInfo> get() = (_phase.value as? Phase.Loaded)?.keys.orEmpty()

    suspend fun load() {
        try {
            _phase.value = Phase.Loaded(client.serviceApiKeys(serviceId).keys)
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            when {
                t is ScreensError.NotImplemented || (t is ScreensError.Http && t.status == 404) ->
                    _phase.value = Phase.Unsupported
                _phase.value !is Phase.Loaded -> _phase.value = Phase.Failed(t.userFacing())
            }
        }
    }

    fun clearError() {
        _error.value = null
    }

    /** Signs a grant for a new key and sends it; on success [created] holds the
     *  key to show once. */
    suspend fun create(label: String, scope: String): Boolean {
        if (_busy.value) return false
        val name = label.trim()
        if (name.isEmpty()) {
            _error.value = LABEL_REQUIRED
            return false
        }
        if (name.length > LABEL_MAX) {
            _error.value = LABEL_TOO_LONG
            return false
        }
        _busy.value = true
        _error.value = null
        try {
            val domain = runCatching { client.boxFqdn() }.getOrNull()?.takeIf { it.isNotEmpty() }
                ?: fallbackServerDomain()?.takeIf { it.isNotEmpty() }
            if (domain == null) {
                _error.value = FSStrings.get(R.string.couldnt_tell_which_server_this_app)
                return false
            }
            val key = try {
                signer(FSStrings.get(R.string.create_an_api_key_for, appName))
            } catch (e: CancellationException) {
                throw e
            } catch (t: Throwable) {
                _error.value = FSStrings.get(R.string.couldnt_access_your_account_key, UserErrorText.reason(t))
                return false
            }
            val issuedAt = now()
            var signed = AppApiKey.sign(
                key,
                AppApiKey.Grant(domain, serviceId, newKeyId(), scope, AppApiKey.NEVER, issuedAt),
            )
            val r = try {
                send(signed, name)
            } catch (t: ScreensError.Http) {
                if (t.status != 409) throw t
                // A key id clash: once more with a fresh id, same signing key.
                signed = AppApiKey.sign(key, signed.grant.copy(keyId = newKeyId()))
                send(signed, name)
            }
            val g = signed.grant
            val added = keys + AppApiKeyInfo(g.keyId, name, g.scope, issuedAt, null, g.expiresAt)
            val secret = r.key?.takeIf { isKeyFor(it, g.keyId) }
            if (secret == null) {
                _error.value = NO_KEY_RETURNED
                reload(fallback = added)
                return false
            }
            _created.value = Created(name, secret)
            reload(fallback = added)
            return true
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            _error.value = createRefusal(t)
            return false
        } finally {
            _busy.value = false
        }
    }

    private suspend fun send(signed: AppApiKey.SignedGrant, label: String) = signed.grant.let { g ->
        client.serviceApiKeyCreate(
            serviceId,
            AppApiKeyCreateRequest(
                grant = AppApiKeyGrantBody(g.serverDomain, g.serviceId, g.keyId, g.scope, g.expiresAt, g.issuedAt),
                signature = signed.signatureHex,
                label = label,
            ),
        )
    }

    /** Forget the shown key: it can't be shown again. */
    fun dismissCreated() {
        _created.value = null
    }

    suspend fun revoke(keyId: String): Boolean {
        if (_busy.value) return false
        _busy.value = true
        _error.value = null
        try {
            try {
                client.serviceApiKeyRevoke(serviceId, keyId)
            } catch (e: CancellationException) {
                throw e
            } catch (t: Throwable) {
                // Already gone is what the owner asked for.
                if (!(t is ScreensError.Http && t.status == 404)) {
                    _error.value = revokeRefusal(t)
                    return false
                }
            }
            _phase.value = Phase.Loaded(keys.filter { it.keyId != keyId })
            return true
        } finally {
            _busy.value = false
        }
    }

    fun revokeConfirmText(key: AppApiKeyInfo): String =
        FSStrings.get(R.string.anything_using_loses_access_to_right, displayLabel(key), appName)

    private suspend fun reload(fallback: List<AppApiKeyInfo>) {
        val fresh = runCatching { client.serviceApiKeys(serviceId).keys }
        fresh.exceptionOrNull()?.let { if (it is CancellationException) throw it }
        _phase.value = Phase.Loaded(fresh.getOrNull() ?: fallback)
    }

    companion object {
        val TITLE get() = FSStrings.get(R.string.api_keys)
        val CREATE get() = FSStrings.get(R.string.create_key)
        const val REVOKE = "Revoke"
        const val COPY = "Copy"
        const val DONE = "Done"
        val EMPTY get() = FSStrings.get(R.string.no_api_keys_yet_a_key)
        val READ_ONLY_NOTE get() = FSStrings.get(R.string.this_device_can_see_the_keys)
        val ONCE_WARNING get() = FSStrings.get(R.string.copy_it_now_flagship_cant_show)
        val LABEL_REQUIRED get() = FSStrings.get(R.string.give_the_key_a_name)
        const val LABEL_MAX = 64
        val LABEL_TOO_LONG get() = FSStrings.get(R.string.keep_the_name_to_characters_or, LABEL_MAX)
        val NO_KEY_RETURNED get() = FSStrings.get(R.string.your_server_didnt_return_the_new)
        const val READ_HELP = "GET, HEAD and OPTIONS requests only."
        val WRITE_HELP get() = FSStrings.get(R.string.every_request_including_changes)

        /** The least access by default. Keys don't expire (owner decision). */
        const val DEFAULT_SCOPE = AppApiKey.SCOPE_READ

        val SCOPES = listOf(AppApiKey.SCOPE_READ, AppApiKey.SCOPE_WRITE)

        fun scopeText(scope: String): String = when (scope) {
            AppApiKey.SCOPE_WRITE -> FSStrings.get(R.string.read_write)
            else -> "Read"
        }

        /** `fsk_<keyId>_<secret>`, the secret base64url. */
        fun isKeyFor(key: String, keyId: String): Boolean {
            val prefix = "fsk_${keyId}_"
            return key.startsWith(prefix) && key.length > prefix.length &&
                key.substring(prefix.length).all { it.isLetterOrDigit() && it.code < 128 || it == '-' || it == '_' }
        }

        fun usageLine(key: String): String = "Authorization: Bearer $key"

        fun displayLabel(key: AppApiKeyInfo): String = key.label.ifBlank { key.keyId }

        fun isExpired(key: AppApiKeyInfo, now: Long): Boolean {
            val exp = key.expiresAt ?: 0L
            return exp > 0 && exp <= now
        }

        fun createdText(key: AppApiKeyInfo, zone: ZoneId = ZoneId.systemDefault()): String =
            if (key.createdAt > 0) FSStrings.get(R.string.created, dateText(key.createdAt, zone)) else FSStrings.get(R.string.created_earlier)

        fun lastUsedText(key: AppApiKeyInfo, now: Long, zone: ZoneId = ZoneId.systemDefault()): String {
            val used = key.lastUsedAt?.takeIf { it > 0 } ?: return FSStrings.get(R.string.never_used)
            val mins = (now - used).coerceAtLeast(0) / 60_000
            return when {
                mins < 1 -> FSStrings.get(R.string.last_used_just_now)
                mins < 60 -> FSStrings.get(R.string.last_used_min_ago, mins)
                mins < 60 * 24 -> FSStrings.get(R.string.last_used_hr_ago, mins / 60)
                mins < 60 * 24 * 30 -> FSStrings.get(R.string.last_used_d_ago, mins / (60 * 24))
                else -> FSStrings.get(R.string.last_used_2, dateText(used, zone))
            }
        }

        /** Only for a key a box says has lapsed; the app never sets an expiry. */
        fun expiredText(key: AppApiKeyInfo, now: Long, zone: ZoneId = ZoneId.systemDefault()): String? =
            if (isExpired(key, now)) FSStrings.get(R.string.expired_2, dateText(key.expiresAt!!, zone)) else null

        fun detailText(key: AppApiKeyInfo, now: Long, zone: ZoneId = ZoneId.systemDefault()): String =
            listOfNotNull(createdText(key, zone), lastUsedText(key, now, zone), expiredText(key, now, zone))
                .joinToString(" · ")

        private fun dateText(ms: Long, zone: ZoneId): String =
            DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.getDefault()).format(Instant.ofEpochMilli(ms).atZone(zone))

        fun createRefusal(t: Throwable): String {
            if (t !is ScreensError.Http) return t.userFacing()
            val box = t.boxError()
            return when (t.status) {
                400 -> FSStrings.get(R.string.the_server_couldnt_read_this_key, box?.let { ": $it" } ?: "")
                403 -> box?.let { FSStrings.get(R.string.the_server_refused_this_key, it) }
                    ?: FSStrings.get(R.string.the_server_refused_this_key_check)
                404 -> FSStrings.get(R.string.this_app_is_no_longer_installed)
                409 -> FSStrings.get(R.string.couldnt_pick_a_free_key_id)
                else -> box ?: t.userFacing()
            }
        }

        fun revokeRefusal(t: Throwable): String {
            if (t !is ScreensError.Http) return t.userFacing()
            val box = t.boxError()
            return when (t.status) {
                401, 403 -> FSStrings.get(R.string.this_device_cant_revoke_keys, box?.let { ": $it" } ?: "")
                else -> box ?: t.userFacing()
            }
        }
    }
}
