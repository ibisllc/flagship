// Saves the owner's server order (docs/server-order.md). Home's drag and a
// server page's "Make leader" both come through here, so both read and write
// the same AppState order: the new order shows at once, is signed (silently
// when the session already holds the key, else one prompt), posted, and put
// back if anything fails. Once `.com` has it, every server that is up gets the
// same signed order straight away (each still gets it from `.com` otherwise).

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.api.ScreensClient
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import java.security.SecureRandom

class ServerOrderSaver(
    private val app: AppState,
    private val post: suspend (username: String, wire: ServerOrderWire) -> Unit,
    /** The account's current order from `.com`, after a 409. */
    private val fetchOrder: suspend (username: String) -> ServerOrderWire?,
    /** The sensitive-order key (admin root when held, else the IRK). */
    private val signer: suspend (reason: String) -> Ed25519Sign,
    private val isDemo: () -> Boolean,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val randomBytes: (Int) -> ByteArray = { n -> ByteArray(n).also(SecureRandom()::nextBytes) },
    /** A screens client bound to that server's own session, or null. */
    private val screensFor: (PodInfo) -> ScreensClient? = { null },
    /** Where a saved order is handed to the servers; outlives the screen that saved it. */
    private val deliveryScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    sealed interface Outcome {
        data object Saved : Outcome
        /** Demo accounts hold no keys: the order changes on this device only. */
        data object Local : Outcome
        data object Unchanged : Outcome
        /** Another device saved a newer order; it is on screen now. */
        data object Superseded : Outcome
        data class Failed(val message: String) : Outcome
    }

    companion object {
        val REASON get() = FSStrings.get(R.string.confirm_the_new_server_order)
    }

    /** Make [podId] the first server in the order. */
    suspend fun makeLeader(podId: String): Outcome {
        val ranked = app.orderedPods.value
        val pod = ranked.firstOrNull { it.podId == podId } ?: return Outcome.Unchanged
        return reorder(listOf(pod.podId) + ranked.filter { it.podId != podId }.map { it.podId })
    }

    /** Save the servers in [podIds] order (pods it leaves out keep their rank after them). */
    suspend fun reorder(podIds: List<String>): Outcome {
        val username = app.currentUser.value?.lowercase() ?: return Outcome.Unchanged
        val byId = app.pods.value.associateBy { it.podId }
        val named = podIds.mapNotNull { byId[it] } +
            app.orderedPods.value.filter { it.podId !in podIds }
        val stks = named.filter(ServerOrderProtocol::orderable)
            .map { it.identityPubKeyHex.lowercase() }
            .distinct()
            .take(ServerOrderProtocol.MAX)
        if (stks.isEmpty()) return Outcome.Unchanged
        val current = app.orderedPods.value.filter(ServerOrderProtocol::orderable).map { it.identityPubKeyHex.lowercase() }
        if (stks == current) return Outcome.Unchanged

        val (previous, previousIssuedAt) = app.serverOrderSnapshot()
        val order = ServerOrder(username, stks, now(), HexUtil.encode(randomBytes(32)))
        app.setServerOrder(stks, order.issuedAt)
        if (isDemo()) {
            // A demo order never leaves the phone: no box will acknowledge it.
            app.recordServerOrderAcks(app.pods.value.associate { it.podId to order.issuedAt })
            app.makeLeaderCurrent()
            return Outcome.Local
        }
        return try {
            val signature = ServerOrderProtocol.sign(order, signer(REASON))
            val wire = ServerOrderWire(order, signature)
            post(username, wire)
            app.makeLeaderCurrent()
            deliveryScope.launch { deliver(wire) }
            Outcome.Saved
        } catch (e: HttpException) {
            if (e.status == 409) {
                val latest = runCatching { fetchOrder(username) }.getOrNull()
                app.setServerOrder(previous, previousIssuedAt)
                app.applyDirectoryServerOrder(latest)
                Outcome.Superseded
            } else {
                app.setServerOrder(previous, previousIssuedAt)
                Outcome.Failed(FSStrings.get(R.string.couldnt_save_the_new_order_your, e.status))
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            app.setServerOrder(previous, previousIssuedAt)
            throw e
        } catch (e: Throwable) {
            app.setServerOrder(previous, previousIssuedAt)
            Outcome.Failed(
                if (e is com.flagshipserver.app.keystore.BiometricCancelled) FSStrings.get(R.string.order_not_changed_you_didnt_confirm)
                else FSStrings.get(R.string.couldnt_save_the_new_order_your_2),
            )
        }
    }

    /** Hand [wire] to every server that is up and record the order each says
     *  it holds. A box that can't be reached, or is too old to take it (404),
     *  is skipped: it still gets the order from `.com`. */
    suspend fun deliver(wire: ServerOrderWire) {
        val targets = app.pods.value.filter {
            it.status == PodInfo.Status.ONLINE && !it.isRevoked && it.fqdn.isNotEmpty()
        }
        val acks = coroutineScope {
            targets.map { pod ->
                async {
                    val client = screensFor(pod) ?: return@async null
                    runCatching { client.deliverServerOrder(wire).heldIssuedAt }
                        .getOrNull()
                        ?.takeIf { it > 0 }
                        ?.let { pod.podId to it }
                }
            }.awaitAll().filterNotNull().toMap()
        }
        app.recordServerOrderAcks(acks)
    }
}
