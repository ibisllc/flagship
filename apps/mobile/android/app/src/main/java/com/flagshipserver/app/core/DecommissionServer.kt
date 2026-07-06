package com.flagshipserver.app.core

import com.flagshipserver.app.api.AuthCodeRevokeRequest
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.ReleaseServerNameRequest
import com.flagshipserver.app.core.AuthCodeRevoke as AuthCodeRevokeBytes
import com.flagshipserver.app.core.ReleaseServerName as ReleaseServerNameBytes
import com.flagshipserver.app.keystore.Keystore

/**
 * Decommission a pending OR registered-but-dead (never-came-online) server:
 * release the reserved name (un-pin the routing record so the name frees up),
 * belt-and-braces revoke the install auth-code, then drop the pod locally.
 *
 * Mirror of iOS `cancelPendingServer` (HomeTab.swift) + the webapp
 * `deleteDeadServer` — the SAME owner-IRK-signed `ReleaseServerName` →
 * `/api/server/release` path. Distinct from the lost/stolen revoke (this is
 * for a box that never checked in). On a release FAILURE the pod is KEPT (the
 * name is still reserved, so dropping it locally would just hide a name the
 * user can't re-use) with a warning toast.
 */
suspend fun decommissionServer(
    pod: PodInfo,
    app: AppState,
    server: FlagshipServerClient,
    toasts: ToastCenter,
) {
    val username = app.currentUser.value
    if (username == null) {
        app.removePod(pod.podId)
        return
    }
    try {
        // Slice D — release-server-name is SENSITIVE (serverRevoke.ts gates it
        // on the admin master root): sign with the admin root when this device
        // holds one, else the owner IRK (legacy). The belt-and-braces auth-code
        // revoke below rides the same key (best-effort — failures are swallowed).
        val irk = Keystore.adminSigningKey("Delete server ${pod.name}")
        val now = System.currentTimeMillis()
        // 1. Release the name (the real free-the-name mechanism).
        val releaseBytes = ReleaseServerNameBytes.canonicalBytes(username, pod.fqdn, now)
        val releaseSig = HexUtil.encode(irk.sign(releaseBytes))
        server.releaseServerName(
            ReleaseServerNameRequest(
                request = ReleaseServerNameRequest.Inner(
                    username = username, serverDomain = pod.fqdn, issuedAt = now,
                ),
                signature = releaseSig,
            ),
        )
        // 2. Belt-and-braces auth-code revoke (the release already revoked
        // active codes server-side; 403/404 is treated as success).
        val serial = pod.pendingAuthCodeSerial
        if (serial != null) {
            val revokeBytes = AuthCodeRevokeBytes.canonicalBytes(serial, username, now)
            val revokeSig = HexUtil.encode(irk.sign(revokeBytes))
            runCatching {
                server.revokeAuthCode(
                    AuthCodeRevokeRequest(
                        request = AuthCodeRevokeRequest.Inner(
                            serial = serial, username = username, issuedAt = now,
                        ),
                        signature = revokeSig,
                    ),
                )
            }
        }
        toasts.success("Server \"${pod.name}\" deleted — the name is free again.")
        app.removePod(pod.podId)
    } catch (_: Throwable) {
        toasts.warning("Couldn't delete — the name is still reserved. Check your connection and try again.")
    }
}
