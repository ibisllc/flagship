// SEC-REPAIR-001 on the phone: `.com` checks the recovery passkey's signature before it releases
// a recovery record. What the app says when that check refuses, the once-per-account offer to
// update a record made before the check, and the passphrase kept in memory right after a
// recovery so that offer needs no second passphrase. Wording matches the webapp and iOS.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences
import com.flagshipserver.app.R
import com.flagshipserver.app.api.ScreensError
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** `.com` refused the passkey part of a recovery; [message] is the sentence to show. */
class PasskeyCheckError(val code: String, message: String) : Exception(message)

object RecoveryPasskeyText {
    const val REQUIRED = "passkey-required"
    const val CHALLENGE = "passkey-challenge"
    const val INVALID = "passkey-invalid"
    const val UNAVAILABLE = "passkey-unavailable"

    fun forCode(code: String?): String? = when (code) {
        REQUIRED -> FSStrings.get(R.string.recovery_passkey_required)
        CHALLENGE -> FSStrings.get(R.string.recovery_passkey_challenge)
        INVALID -> FSStrings.get(R.string.recovery_passkey_invalid)
        UNAVAILABLE -> FSStrings.get(R.string.recovery_passkey_unavailable)
        else -> null
    }

    /** The `code` of a `.com` refusal body (`{error, code}`), when there is one. */
    fun codeOf(t: Throwable): String? {
        val body = when (t) {
            is HttpException -> t.body
            is ScreensError.Http -> t.body
            else -> return null
        }
        return runCatching {
            Json.parseToJsonElement(body).jsonObject["code"]?.jsonPrimitive?.content
        }.getOrNull()?.takeIf { it.startsWith("passkey-") }
    }

    /** A passkey refusal turned into the error the screens show; anything else unchanged. */
    fun translate(t: Throwable): Throwable {
        val code = codeOf(t) ?: return t
        return PasskeyCheckError(code, forCode(code) ?: return t)
    }
}

/** "Update your account recovery" is offered once per account on this device. */
class RecoveryUpdatePromptStore(private val prefs: SharedPreferences) {
    private fun key(username: String) = "asked.${username.lowercase()}"

    fun asked(username: String): Boolean = prefs.getBoolean(key(username), false)

    fun markAsked(username: String) {
        prefs.edit().putBoolean(key(username), true).apply()
    }

    companion object {
        fun fromContext(ctx: Context): RecoveryUpdatePromptStore =
            RecoveryUpdatePromptStore(ctx.getSharedPreferences("flagship.recoveryUpdate", Context.MODE_PRIVATE))

        /** Whether to raise the prompt: a record exists, `.com` doesn't check its passkey yet, and
         *  this device hasn't asked for this account. */
        fun shouldAsk(recordExists: Boolean, passkeyRequired: Boolean, asked: Boolean): Boolean =
            recordExists && !passkeyRequired && !asked
    }
}

/**
 * A recovery that `.com` released on the passphrase alone (`passkeyLegacy`). Held in memory only,
 * until the prompt runs or is declined, so the update right after a recovery asks for no
 * passphrase again.
 */
object RecoveryUpdateOffer {
    data class Pending(val username: String, val passphrase: String)

    private val _pending = MutableStateFlow<Pending?>(null)
    val pending: StateFlow<Pending?> = _pending.asStateFlow()

    fun offer(username: String, passphrase: String) {
        _pending.value = Pending(username, passphrase)
    }

    fun take(username: String): Pending? = _pending.value?.takeIf { it.username.equals(username, ignoreCase = true) }

    fun clear() {
        _pending.value = null
    }

    private val _checks = MutableStateFlow(0)
    /** Bumped to look at the account's record again (a recovery finished, a test seeded one). */
    val checks: StateFlow<Int> = _checks.asStateFlow()

    fun recheck() {
        _checks.value += 1
    }
}
