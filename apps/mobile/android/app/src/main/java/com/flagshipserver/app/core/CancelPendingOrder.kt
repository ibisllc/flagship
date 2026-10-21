package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.api.AuthCodeRevokeRequest
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.ReleaseServerNameRequest
import com.flagshipserver.app.core.AuthCodeRevoke as AuthCodeRevokeBytes
import com.flagshipserver.app.core.ReleaseServerName as ReleaseServerNameBytes
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CancellationException

/**
 * Cancel a pending order: release the reserved name (`.com` drops the routing
 * claim so the name can be used again), then revoke the install auth-code.
 *
 * A failure comes back as the reason in plain words ([UserErrorText]) instead
 * of one fixed "check your connection" line, so a refusal `.com` sent and a
 * dropped connection no longer read the same. A row that names no
 * `<server>.<user>` (an old ghost) holds no name on `.com`, so it is removed
 * without a call.
 */
object CancelPendingOrder {

    sealed interface Outcome {
        data class Cancelled(val releasedName: Boolean) : Outcome
        data class Failed(val message: String) : Outcome
    }

    suspend fun run(
        pod: PodInfo,
        username: String,
        server: FlagshipServerClient,
        /** Releasing a name is a sensitive order: the admin root when this device holds one. */
        releaseKey: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
        /** The auth-code revoke stays an IRK order. */
        revokeKey: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
        now: () -> Long = { System.currentTimeMillis() },
    ): Outcome {
        if (!InstallFinishTarget.isWellFormed(pod.fqdn)) return Outcome.Cancelled(releasedName = false)
        val reason = FSStrings.get(R.string.cancel_server, pod.name.ifBlank { pod.serverLabel })
        try {
            val issuedAt = now()
            val key = releaseKey(reason)
            server.releaseServerName(
                ReleaseServerNameRequest(
                    request = ReleaseServerNameRequest.Inner(username = username, serverDomain = pod.fqdn, issuedAt = issuedAt),
                    signature = HexUtil.encode(key.sign(ReleaseServerNameBytes.canonicalBytes(username, pod.fqdn, issuedAt))),
                ),
            )
            val serial = pod.pendingAuthCodeSerial
            if (serial != null) {
                // The release already revoked active codes; this is belt and braces.
                runCatching {
                    val irk = revokeKey(reason)
                    server.revokeAuthCode(
                        AuthCodeRevokeRequest(
                            request = AuthCodeRevokeRequest.Inner(serial = serial, username = username, issuedAt = issuedAt),
                            signature = HexUtil.encode(irk.sign(AuthCodeRevokeBytes.canonicalBytes(serial, username, issuedAt))),
                        ),
                    )
                }
            }
            return Outcome.Cancelled(releasedName = true)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            return Outcome.Failed(failureSentence(e))
        }
    }

    /** What the person reads when the cancel didn't go through. */
    fun failureSentence(e: Throwable): String {
        val why = UserErrorText.of(e, where = "cancel-order")
        val keyProblem = NetworkErrorHumanizer.classify(e).kind == NetworkErrorHumanizer.Kind.BIOMETRIC
        return if (keyProblem) why else FSStrings.get(R.string.couldnt_cancel_this_order_the_name, why)
    }
}
