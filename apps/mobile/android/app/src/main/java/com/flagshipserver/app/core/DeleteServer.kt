package com.flagshipserver.app.core

import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.ReleaseServerNameRequest
import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CancellationException
import com.flagshipserver.app.core.ReleaseServerName as ReleaseServerNameBytes

/**
 * "Delete server" for any registered server, whatever its state (online,
 * offline, never came online, revoked). A still-pending order keeps
 * [decommissionServer].
 *
 * One sensitive-order key covers the whole flow. A box that ever registered is
 * first sent a `wipe-now` ServerDecommission order (best-effort: an offline box
 * picks it up if it ever comes back), then the name is released. Only a
 * release failure aborts, because the name is what stays reserved.
 */
object DeleteServerFlow {

    sealed interface Outcome {
        data class Deleted(val erasureRequested: Boolean) : Outcome
        data class Failed(val message: String) : Outcome
    }

    fun confirmationMatches(typed: String, pod: PodInfo): Boolean =
        typed.trim().equals(pod.serverLabel, ignoreCase = true) && pod.serverLabel.isNotEmpty()

    fun deletedMessage(name: String, erasureRequested: Boolean): String =
        "Deleted $name." + if (erasureRequested) {
            " If it's online it will erase itself and power off."
        } else {
            " It couldn't be asked to erase itself."
        }

    suspend fun run(
        pod: PodInfo,
        username: String,
        server: FlagshipServerClient,
        mailbox: SecretMailboxClient,
        orderKey: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
        // The decommission deposit's mailbox auth is the owner IRK credential,
        // as in the replace flow; it rides the same unlocked biometric session.
        mailboxKey: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
        mailboxPubHex: suspend () -> String = { Keystore.irkPubHex() },
        now: () -> Long = { System.currentTimeMillis() },
    ): Outcome {
        val reason = "Delete server ${pod.name}"
        val key = try {
            orderKey(reason)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            return Outcome.Failed("Couldn't access your account key: ${UserErrorText.reason(e)}")
        }

        var erasureRequested = false
        if (pod.identityPubKeyHex.isNotEmpty()) {
            try {
                val body = ReplaceServerFlow.buildDeposit(
                    serverFqdn = pod.fqdn,
                    username = username,
                    irk = mailboxKey(reason),
                    irkPubHex = mailboxPubHex(),
                    orderKey = key,
                    retiredStkPubHex = pod.identityPubKeyHex,
                    finalBackup = false,
                    disposition = ReplaceServerFlow.Disposition.WipeNow,
                    issuedAt = now(),
                    backupEpoch = 0L,
                )
                mailbox.depositDecommission(pod.fqdn, body)
                erasureRequested = true
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
            }
        }

        val issuedAt = now()
        try {
            server.releaseServerName(
                ReleaseServerNameRequest(
                    request = ReleaseServerNameRequest.Inner(
                        username = username, serverDomain = pod.fqdn, issuedAt = issuedAt,
                    ),
                    signature = HexUtil.encode(
                        key.sign(ReleaseServerNameBytes.canonicalBytes(username, pod.fqdn, issuedAt)),
                    ),
                ),
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            val detail = (e as? HttpException)?.let { " (${it.status})" } ?: ""
            return Outcome.Failed(
                "Couldn't delete ${pod.name}$detail. The name is still reserved. Check your connection and try again.",
            )
        }
        return Outcome.Deleted(erasureRequested)
    }
}

/** Runs [DeleteServerFlow] for a list or detail screen. On success [onDeleted]
 *  runs first (so a detail page can pop before its pod disappears), then the
 *  pod is dropped and a toast says whether the box was asked to erase itself.
 *  On failure the pod is kept. */
suspend fun deleteServer(
    pod: PodInfo,
    app: AppState,
    server: FlagshipServerClient,
    mailbox: SecretMailboxClient,
    toasts: ToastCenter,
    onDeleted: () -> Unit = {},
): Boolean {
    val username = app.currentUser.value
    if (username.isNullOrEmpty()) {
        toasts.error("No active account on this device.")
        return false
    }
    return when (val outcome = DeleteServerFlow.run(pod, username, server, mailbox)) {
        is DeleteServerFlow.Outcome.Failed -> {
            toasts.error(outcome.message)
            false
        }
        is DeleteServerFlow.Outcome.Deleted -> {
            onDeleted()
            app.removePod(pod.podId)
            val message = DeleteServerFlow.deletedMessage(pod.name, outcome.erasureRequested)
            if (outcome.erasureRequested) toasts.success(message) else toasts.warning(message)
            true
        }
    }
}
