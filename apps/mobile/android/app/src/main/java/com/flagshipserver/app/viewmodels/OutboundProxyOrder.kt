// The server page's "Outbound proxy" change (docs/outbound-proxy.md): the
// owner's form becomes a `flagship/box-proxy/v1` order signed with the
// sensitive-order key behind biometrics, posted to the box over the paired
// session. The box tests the proxy before it switches, so a refusal leaves
// the old setting in place.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.api.OutboundProxySetRequest
import com.flagshipserver.app.api.OutboundProxySummary
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.BoxProxyDraft
import com.flagshipserver.app.core.BoxProxyProtocol
import com.flagshipserver.app.keystore.BiometricCancelled
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CancellationException
import java.security.SecureRandom

class OutboundProxyOrder(
    private val client: ScreensClient,
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
    private val randomBytes: (Int) -> ByteArray = { n -> ByteArray(n).also(SecureRandom()::nextBytes) },
) {
    sealed interface Outcome {
        data class Saved(val summary: OutboundProxySummary?, val message: String) : Outcome
        data class Failed(val message: String) : Outcome
    }

    companion object {
        val REASON get() = FSStrings.get(R.string.confirm_the_proxy_change)
        val SAVED_PROXY get() = FSStrings.get(R.string.saved_the_server_is_reconnecting_through)
        val SAVED_DIRECT get() = FSStrings.get(R.string.saved_the_server_now_connects_directly)

        /**
         * Whether the order says the proxy needs a password: when the owner typed
         * credentials, or kept the box's ones by leaving the fields empty on the
         * same proxy (then nothing is sent and the box keeps what it has).
         */
        fun needsAuth(draft: BoxProxyDraft, current: OutboundProxySummary?): Boolean {
            if (draft.kind == "none") return false
            if (draft.hasCredentials) return true
            val p = current?.proxy ?: return false
            val same = p.kind == draft.kind &&
                p.host == BoxProxyProtocol.normalizeHost(draft.host) &&
                p.port.toString() == draft.port.trim()
            return same && p.auth && current.hasCredentials
        }
    }

    suspend fun save(serverDomain: String, draft: BoxProxyDraft, current: OutboundProxySummary?): Outcome {
        draft.error()?.let { return Outcome.Failed(it) }
        val order = draft.order(serverDomain, needsAuth(draft, current), now(), randomBytes)
        return try {
            val key = try {
                signer(REASON)
            } catch (e: CancellationException) {
                throw e
            } catch (e: BiometricCancelled) {
                return Outcome.Failed(FSStrings.get(R.string.not_changed_you_didnt_confirm_it))
            } catch (e: Throwable) {
                return Outcome.Failed(FSStrings.get(R.string.couldnt_access_your_account_key_2))
            }
            val signature = BoxProxyProtocol.sign(order, key)
            val r = client.outboundProxySet(OutboundProxySetRequest(order, signature, draft.credentials()))
            Outcome.Saved(r.outboundProxy, if (order.kind == "none") SAVED_DIRECT else SAVED_PROXY)
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            val box = t.boxError()
            Outcome.Failed(
                when {
                    box != null -> box
                    t is ScreensError.Http && t.status == 403 -> FSStrings.get(R.string.the_server_refused_this_change_check_2)
                    else -> t.userFacing()
                },
            )
        }
    }
}
