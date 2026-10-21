// "This account was removed" (docs/account-gone.md): the state and its words.
//
// After a reset or a wipe an account no longer exists on `.com`, but a phone
// that was already signed in keeps its identity and keeps calling. Every
// own-account route then answers one stable `404 { code: "account-not-found" }`.
// The shared OkHttp client hands each such answer to [AccountGoneInterceptor];
// when it names THIS device's own account the state flips once, the screen
// (ui/shell/AccountGoneScreen.kt) takes over, and from then on every call that
// names that account is answered here with the same 404 without touching the
// network, so no poller keeps asking and no error toast repeats.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody

object AccountGone {
    const val CODE = "account-not-found"

    private val state = MutableStateFlow<String?>(null)

    /** The lowercase name of this device's own account once `.com` has said it is gone, else null. */
    val gone: StateFlow<String?> get() = state
    val isGone: Boolean get() = state.value != null

    /** Set by the screen's "Create a new account": the welcome flow opens at the create step once. */
    @Volatile var createNext: Boolean = false

    fun consumeCreateNext(): Boolean = createNext.also { createNext = false }

    /** Which names are this device's own account (its username and its cloud name). */
    @Volatile var ownNames: () -> List<String> = { emptyList() }

    private val OWN_ACCOUNT_PATH = Regex("/api/(?:users|accounts)/([^/?#]+)(?:[/?#]|$)")

    /** The account a `.com` path names, lowercased, or null. */
    fun accountNameInPath(path: String): String? {
        val m = OWN_ACCOUNT_PATH.find(path) ?: return null
        val name = try {
            java.net.URLDecoder.decode(m.groupValues[1], "UTF-8").lowercase()
        } catch (_: Throwable) {
            return null
        }
        return if (name == "check") null else name
    }

    private fun isOwn(name: String) = try {
        ownNames().any { it.equals(name, ignoreCase = true) }
    } catch (_: Throwable) {
        false
    }

    /** The body `.com` sends, also used for calls answered locally. */
    fun responseBody(): String = """{"error":"$CODE","code":"$CODE"}"""

    fun bodyIsAccountGone(body: String): Boolean = try {
        (SecurityNoticeProtocol.json.parseToJsonElement(body) as? kotlinx.serialization.json.JsonObject)
            ?.get("code")?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { p -> p.isString }?.content } == CODE
    } catch (_: Throwable) {
        false
    }

    /** Mark the account gone (idempotent). */
    fun markGone(name: String) {
        state.value = name.lowercase()
    }

    /** The person removed it from this device (or signed out). */
    fun clear() {
        state.value = null
    }

    /**
     * Look at a control-apex answer. When it is `404 account-not-found` for this
     * device's own account, the account is gone. Another account's name (a shared
     * server's owner, an invite author) never flips it.
     */
    fun note(path: String, status: Int, body: () -> String): Boolean {
        if (status != 404) return false
        val name = accountNameInPath(path) ?: return false
        if (!isOwn(name)) return false
        if (!bodyIsAccountGone(body())) return false
        markGone(name)
        return true
    }

    /** True when a call naming the removed account should be answered locally. */
    fun answersLocally(path: String): Boolean {
        val g = state.value ?: return false
        return accountNameInPath(path) == g
    }
}

/** Installed on the app's OkHttp client right after the update lock's gate. */
class AccountGoneInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val onApex = req.url.host.equals(Endpoints.controlHost, ignoreCase = true)
        if (onApex && AccountGone.answersLocally(req.url.encodedPath)) {
            return Response.Builder()
                .request(req).protocol(Protocol.HTTP_1_1).code(404).message(FSStrings.get(R.string.not_found))
                .header("cache-control", "no-store")
                .body(AccountGone.responseBody().toResponseBody("application/json".toMediaType()))
                .build()
        }
        val res = chain.proceed(req)
        if (onApex && res.code == 404) {
            AccountGone.note(req.url.encodedPath, res.code) { res.peekBody(4096).string() }
        }
        return res
    }
}

/** The screen's words (docs/account-gone.md "The admin key is the way out: exact strings", phone variants). */
object AccountGoneCopy {
    val TITLE get() = FSStrings.get(R.string.this_account_was_removed)
    val BODY get() = FSStrings.get(R.string.this_account_no_longer_exists_on)
    val RESTORE_HINT get() = FSStrings.get(R.string.if_you_saved_a_backup_of)
    val CREATE get() = FSStrings.get(R.string.create_a_new_account)
    val REMOVE get() = FSStrings.get(R.string.remove_it_from_this_device)
    fun account(name: String) = "Account: $name"
}

/**
 * The warnings that keep a person from throwing away the admin key: it is what
 * signs this device in to their servers, so removing it (or signing out, which
 * removes it) says so first and offers to save a backup of the account key.
 */
object AdminKeyWarning {
    val REMOVE_TITLE get() = FSStrings.get(R.string.remove_this_account_from_this_device)
    val REMOVE_MESSAGE get() =
        FSStrings.get(R.string.this_also_removes_this_devices_admin)
    val SAVE_FIRST get() = FSStrings.get(R.string.save_my_account_key_first)
    val REMOVE_ANYWAY get() = FSStrings.get(R.string.remove_anyway)

    val SIGN_OUT_TITLE get() = FSStrings.get(R.string.sign_out)
    val SIGN_OUT_NOT_BACKED_UP get() =
        FSStrings.get(R.string.signing_out_removes_this_devices_admin)
    val SIGN_OUT_BACKED_UP get() =
        FSStrings.get(R.string.signing_out_removes_this_devices_admin_2)
    val SIGN_OUT_ANYWAY get() = FSStrings.get(R.string.sign_out_anyway)

    /** Who is warned before a removal: a device that holds the admin root or a session for any server. */
    fun needsRemovalWarning(holdsAdminRoot: Boolean, holdsServerSession: Boolean) = holdsAdminRoot || holdsServerSession

    /** What Sign out says on an admin device; null on any other. */
    sealed interface SignOutWarning {
        /** No account-key file was written: Save my account key first / Sign out anyway. */
        data object NotBackedUp : SignOutWarning

        /** A key file was written on this device: Cancel / Sign out, with the reminder to keep it. */
        data object BackedUp : SignOutWarning
    }

    fun signOut(isAdminDevice: Boolean, keyFileWritten: Boolean): SignOutWarning? = when {
        !isAdminDevice -> null
        keyFileWritten -> SignOutWarning.BackedUp
        else -> SignOutWarning.NotBackedUp
    }
}
