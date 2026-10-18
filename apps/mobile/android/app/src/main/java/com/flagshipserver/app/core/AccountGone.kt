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
                .request(req).protocol(Protocol.HTTP_1_1).code(404).message("Not Found")
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
    const val TITLE = "This account was removed"
    const val BODY = "This account no longer exists on Flagship. This can happen after a reset."
    const val RESTORE_HINT = "If you saved a backup of your servers, you can restore it into a new account."
    const val CREATE = "Create a new account"
    const val REMOVE = "Remove it from this device"
    fun account(name: String) = "Account: $name"
}

/**
 * The warnings that keep a person from throwing away the admin key: it is what
 * signs this device in to their servers, so removing it (or signing out, which
 * removes it) says so first and offers to save a backup of the account key.
 */
object AdminKeyWarning {
    const val REMOVE_TITLE = "Remove this account from this device?"
    const val REMOVE_MESSAGE =
        "This also removes this device's admin key, which you need to sign in to your servers. " +
            "Save a backup of your account key first, or remove anyway."
    const val SAVE_FIRST = "Save my account key first"
    const val REMOVE_ANYWAY = "Remove anyway"

    const val SIGN_OUT_TITLE = "Sign out?"
    const val SIGN_OUT_NOT_BACKED_UP =
        "Signing out removes this device's admin key. Save a backup of your account key first, or sign out anyway."
    const val SIGN_OUT_BACKED_UP =
        "Signing out removes this device's admin key. You backed up your account key, so keep that file and " +
            "its passphrase safe."
    const val SIGN_OUT_ANYWAY = "Sign out anyway"

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
