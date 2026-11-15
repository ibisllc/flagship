// "Release this box" on a retail box's server page (docs/retail-box-setup.md §8.2): after a fresh
// biometric the admin root signs flagship/box-release/v1, with its hybrid signature when the
// account has a strict server, and the box wipes itself back to unclaimed. Admin devices only.
// Mirrors iOS.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.R
import com.flagshipserver.app.api.PqSignatureWire
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.ReleaseThisBox
import com.flagshipserver.app.core.Variant
import com.flagshipserver.app.keystore.BiometricAuthority
import com.flagshipserver.app.keystore.BiometricCancelled
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.QuantumSafetyService
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class ReleaseThisBoxViewModel(
    private val serverDomain: String,
    private val username: String,
    private val stkPubHex: String,
    private val client: ScreensClient,
    private val isAdminDevice: () -> Boolean = { Variant.forceAdminRoot || Keystore.hasAdminRoot() },
    /** A biometric for every release, even in an unlocked session. */
    private val confirm: suspend (reason: String) -> Unit = { r -> BiometricAuthority.confirmNow(r) },
    /** The admin root, read after [confirm]; never the IRK. */
    private val adminRoot: suspend () -> Ed25519Sign = { Ed25519Sign(Keystore.adminRootSeed() ?: throw IllegalStateException(FSStrings.get(R.string.release_box_admin_only))) },
    private val pqSignature: (canonical: ByteArray, key: Ed25519Sign) -> PqSignatureWire? = { canonical, key ->
        QuantumSafetyService.pqSignature(username, "admin-root", canonical, key, Keystore.adminRootPubHex().orEmpty())
    },
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {

    data class State(val busy: Boolean = false, val released: Boolean = false, val error: String? = null)

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    val canRelease: Boolean get() = isAdminDevice()

    suspend fun release(): Boolean {
        if (!isAdminDevice() || _state.value.busy || _state.value.released) return false
        _state.value = State(busy = true)
        return try {
            confirm(FSStrings.get(R.string.release_box_reason, serverDomain))
            val key = adminRoot()
            val order = ReleaseThisBox.make(serverDomain, stkPubHex, now())
            val sig = ReleaseThisBox.sign(order, key)
            val pq = pqSignature(ReleaseThisBox.canonicalBytes(order), key)
            client.releaseBox(ReleaseThisBox.bodyJson(order, sig, pq?.suite, pq?.signature))
            _state.value = State(released = true)
            true
        } catch (t: Throwable) {
            _state.value = State(error = message(t))
            false
        }
    }

    companion object {
        fun message(t: Throwable): String {
            if (t is BiometricCancelled) return FSStrings.get(R.string.release_box_cancelled)
            if (t is ScreensError.Http) {
                val obj = runCatching { Json.parseToJsonElement(t.body) as? JsonObject }.getOrNull()
                val code = ((obj?.get("code") ?: obj?.get("error")) as? JsonPrimitive)?.content
                if (code != null && code.startsWith("release-")) return ReleaseThisBox.refusal(code)
            }
            return t.userFacing()
        }
    }
}
