// The "update required" lock's switch (docs/security-notices.md section 6.3).
// Set by SecurityNoticeCenter when a verified, in-window update-required notice
// applies to this build; read by the network gate below, the lock screen and the
// background work that must pause.
//
// While locked the app refuses to act: no signed order and no call to a server
// leaves the phone. GET and HEAD to the control apex stay open (sign-out and
// the key backup need them, and they change nothing), and so does the notice
// fetch itself. Nothing is deleted.

package com.flagshipserver.app.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.Interceptor
import okhttp3.Request
import okhttp3.Response
import java.io.IOException

/** Thrown in place of a request the lock refuses; screens show it as "Update required". */
class UpdateRequiredException(
    message: String = UpdateLock.REFUSAL,
) : IOException(message)

object UpdateLock {
    const val REFUSAL = "Update required. Flagship is paused on this device until you update."

    private val state = MutableStateFlow(false)

    val locked: StateFlow<Boolean> get() = state

    val isLocked: Boolean get() = state.value

    fun set(value: Boolean) {
        state.value = value
    }

    /**
     * May this request go out while locked? A GET or HEAD to the control apex
     * (nothing it answers changes anything); nothing else (boxes, the data
     * plane, any write, any other host).
     */
    fun allows(method: String, host: String?, controlHost: String = Endpoints.controlHost): Boolean {
        if (!isLocked) return true
        val m = method.uppercase()
        return host != null && host.equals(controlHost, ignoreCase = true) && (m == "GET" || m == "HEAD")
    }

    /** Throws [UpdateRequiredException] when the lock refuses this request. */
    fun check(request: Request) {
        if (!allows(request.method, request.url.host)) throw UpdateRequiredException()
    }

    /** Guard for work with no HTTP request of its own (a signed approval, a socket). */
    fun requireUnlocked() {
        if (isLocked) throw UpdateRequiredException()
    }
}

/** Installed first on every app OkHttp client: the one gate the lock enforces on the network. */
class UpdateLockInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        UpdateLock.check(chain.request())
        return chain.proceed(chain.request())
    }
}
