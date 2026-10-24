// The app-name certificate grant (`flagship/server-wildcard-grant/v1`, docs/first-contact.md):
// signed once per server by the sensitive-order key over the PINNED key, in the first blessing's
// biometric session, and posted to the box at `POST /api/screens/server-wildcard-grant`. The box
// can't be reached until the blessing lets it serve, so a signed grant waits here and goes on the
// next pass. An admin device that finds a server answering `granted: false` signs one silently,
// only while its session is unlocked.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.ScreensClient
import com.google.crypto.tink.subtle.Ed25519Sign

/** A signed grant not yet taken by its box. */
data class PendingWildcardGrant(val stkPubHex: String, val issuedAt: Long, val signatureHex: String)

interface WildcardGrantOutbox {
    fun get(serverDomain: String): PendingWildcardGrant?
    fun put(serverDomain: String, grant: PendingWildcardGrant)
    fun remove(serverDomain: String)
}

class InMemoryWildcardGrantOutbox : WildcardGrantOutbox {
    val map = java.util.concurrent.ConcurrentHashMap<String, PendingWildcardGrant>()
    override fun get(serverDomain: String) = map[serverDomain.lowercase()]
    override fun put(serverDomain: String, grant: PendingWildcardGrant) { map[serverDomain.lowercase()] = grant }
    override fun remove(serverDomain: String) { map.remove(serverDomain.lowercase()) }
}

object WildcardGrants {
    /** The process-wide outbox; MainActivity installs the Keystore-backed one. */
    @Volatile
    var outbox: WildcardGrantOutbox = InMemoryWildcardGrantOutbox()

    /** Hands a signed grant to the box serving [serverDomain]; false when it can't be reached. MainActivity wires it. */
    @Volatile
    var deliver: suspend (serverDomain: String, issuedAt: Long, signatureHex: String) -> Boolean = { _, _, _ -> false }

    /** Sign the grant for [serverDomain] over [stkPubHex] (the pinned key), or null when the names don't fit. */
    fun sign(username: String, serverDomain: String, stkPubHex: String, issuedAt: Long, signer: Ed25519Sign): PendingWildcardGrant? {
        val bytes = runCatching { ServerWildcardGrant.canonicalBytes(username, serverDomain, stkPubHex, issuedAt) }.getOrNull() ?: return null
        return PendingWildcardGrant(stkPubHex.lowercase(), issuedAt, HexUtil.encode(signer.sign(bytes)))
    }
}

class WildcardGrantUpkeep(
    private val username: String,
    private val pins: ServerKeyPins = ServerKeyPins.shared,
    private val outbox: WildcardGrantOutbox = WildcardGrants.outbox,
    /** True on an admin device of the account (holds the admin root, or a demo account's device). */
    private val isAdminDevice: () -> Boolean,
    /** The sensitive-order key without a prompt, or null when the session isn't unlocked. */
    private val silentSigner: suspend () -> Ed25519Sign?,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    /** One pass over the servers this device can reach. Returns how many grants a box took. */
    suspend fun run(servers: List<Pair<String, ScreensClient>>): Int {
        var taken = 0
        for ((domain, client) in servers) {
            val pin = pins.pinnedHex(domain) ?: continue
            val granted = try {
                client.serverWildcardGrantGranted()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Throwable) {
                continue
            }
            if (granted) {
                outbox.remove(domain)
                continue
            }
            val grant = outbox.get(domain)?.takeIf { it.stkPubHex == pin }
                ?: if (isAdminDevice()) {
                    val signer = silentSigner() ?: continue
                    WildcardGrants.sign(username, domain, pin, now(), signer) ?: continue
                } else {
                    continue
                }
            try {
                client.postServerWildcardGrant(grant.issuedAt, grant.signatureHex)
                outbox.remove(domain)
                taken++
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (t: Throwable) {
                outbox.put(domain, grant)
                ErrorLog.caught("wildcard-grant", t, NetworkErrorHumanizer.errorCode(t))
            }
        }
        return taken
    }
}
