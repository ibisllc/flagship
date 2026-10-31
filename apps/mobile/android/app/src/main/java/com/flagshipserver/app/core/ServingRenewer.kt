// Renewal on use (serving-wiring.md section 4): each time the app opens on an admin device, sign
// the serving lease of every server whose policy has a time limit and post them to `.com` in one
// call, best effort also to each box. Never a prompt: the renewal key signs without one. Until the
// key is delegated (one admin-root signature, at a biometric the owner does anyway) a lease is
// signed with the admin root only while the session already holds it; otherwise nothing is signed.
// Mirror of iOS ServingRenewer.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.AccountServingEntry
import com.flagshipserver.app.api.BoxServingLease
import com.flagshipserver.app.api.BoxServingPost
import com.flagshipserver.app.api.RenewalDelegationPost
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.api.ServingLeasesPost
import com.flagshipserver.app.keystore.RenewalSigner
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope

class ServingRenewer(
    username: String,
    private val mailbox: SecretMailboxClient,
    /** The box's own client, for the best-effort copy; null skips it. */
    private val box: (suspend (serverDomain: String) -> ScreensClient?)? = null,
    /** The renewal key, made if there is none. Null where the device can't hold one. */
    private val renewalKey: () -> RenewalSigner?,
    /** The admin root without a prompt (the session holds it), else null. */
    private val silentAdminRoot: () -> Ed25519Sign?,
    /** This device's account device key (64 hex), without a prompt; null when not at hand. */
    private val deviceKeyPub: () -> String?,
    private val delegation: (username: String, currentPub: String?) -> SignedRenewalDelegation?,
    private val recordDelegation: (SignedRenewalDelegation) -> Unit,
    /** Remembers each server's policy and deadline (bounds auto-unlock leases). */
    private val record: (serverDomain: String, onLapse: ServingOnLapse, grace: ServingGrace, until: Long?) -> Unit = { _, _, _, _ -> },
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    val username: String = username.lowercase()

    private fun currentDelegation(): SignedRenewalDelegation? = delegation(username, renewalKey()?.publicKeyHex)

    /** Delegate this device's renewal key with the admin root (already opened by the caller), once. */
    suspend fun delegate(adminRoot: Ed25519Sign): SignedRenewalDelegation? {
        currentDelegation()?.let { return it }
        val key = renewalKey() ?: return null
        val device = deviceKeyPub() ?: return null
        val record = RenewalKeyDelegation(account = username, renewalPub = key.publicKeyHex, deviceId = device, issuedAt = now())
        val sig = runCatching { ServingAuthority.signEd25519(ServingAuthority.canonical(record), adminRoot) }.getOrNull() ?: return null
        val ok = runCatching { mailbox.postRenewalDelegation(username, RenewalDelegationPost(record, sig)) }.isSuccess
        if (!ok) return null
        return SignedRenewalDelegation(record, sig).also(recordDelegation)
    }

    /** Sign a lease for `policy` with the renewal key when it is delegated, else with `adminRoot`. */
    fun signLease(policy: ServingPolicy, adminRoot: Ed25519Sign?): SignedServingLease? {
        val lease = ServingAuthority.leaseFor(policy, now(), ServingAuthority.randomLeaseId()) ?: return null
        val key = renewalKey()
        val d = delegation(username, key?.publicKeyHex)
        if (key != null && d != null) {
            runCatching { ServingAuthority.signLeaseP256Der(lease, key.signDer) }.getOrNull()?.let {
                return SignedServingLease(lease, it, d)
            }
        }
        adminRoot ?: return null
        val sig = runCatching { ServingAuthority.signEd25519(ServingAuthority.canonical(lease), adminRoot) }.getOrNull() ?: return null
        return SignedServingLease(lease, sig)
    }

    /** Post signed leases to `.com` in one call, and to each lease's box (best effort). */
    suspend fun post(leases: List<Pair<String, SignedServingLease>>): Boolean {
        if (leases.isEmpty()) return true
        val body = ServingLeasesPost(leases.map { (_, l) -> ServingLeasesPost.Item(l.record, l.signature, l.delegation?.record?.renewalPub) })
        val posted = runCatching { mailbox.postServingLeases(username, body) }.isSuccess
        val box = box
        if (box != null) coroutineScope {
            leases.map { (domain, l) ->
                async {
                    runCatching {
                        box(domain)?.postServing(BoxServingPost(
                            leases = listOf(BoxServingLease(l.record, l.signature, l.delegation?.record?.renewalPub)),
                            delegations = l.delegation?.let { listOf(it) },
                        ))
                    }
                }
            }.awaitAll()
        }
        return posted
    }

    /** One renewal pass over the account's servers. Returns how many leases were signed. */
    suspend fun renew(): Int {
        val servers: List<AccountServingEntry> = runCatching { mailbox.fetchServing(username).servers }.getOrNull() ?: return 0
        for (s in servers) {
            val grace = ServingGrace.fromWire(s.policy?.record?.grace ?: s.grace) ?: ServingGrace.INDEFINITE
            val onLapse = ServingOnLapse.fromWire(s.policy?.record?.onLapse ?: s.onLapse) ?: ServingOnLapse.STOP_APPS
            record(s.serverDomain, onLapse, grace, s.until)
        }
        val finite = servers.mapNotNull { s ->
            val p = s.policy?.record ?: return@mapNotNull null
            val g = ServingGrace.fromWire(p.grace) ?: return@mapNotNull null
            if (p.account != username || g == ServingGrace.INDEFINITE) null else s.serverDomain to p
        }
        if (finite.isEmpty()) return 0
        val root = silentAdminRoot()
        if (currentDelegation() == null && root != null) delegate(root)
        val signed = finite.mapNotNull { (domain, p) -> signLease(p, root)?.let { domain to it } }
        if (signed.isEmpty()) return 0
        if (post(signed)) {
            for ((domain, l) in signed) {
                val p = finite.first { it.first == domain }.second
                record(domain, ServingOnLapse.fromWire(p.onLapse) ?: ServingOnLapse.STOP_APPS,
                    ServingGrace.fromWire(p.grace) ?: ServingGrace.INDEFINITE, l.record.notAfter)
            }
        }
        return signed.size
    }
}
