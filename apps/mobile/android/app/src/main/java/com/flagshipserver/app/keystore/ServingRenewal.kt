// The app's wiring of ServingRenewer: on each app open (activity start) on an admin device, and
// when a biometric unlock opens the session (the renewal key is delegated then, once).
// Mirror of iOS ServingRenewal.

package com.flagshipserver.app.keystore

import android.content.Context
import android.content.SharedPreferences
import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.PodClients
import com.flagshipserver.app.core.ServerSettingsStore
import com.flagshipserver.app.core.ServingRenewer
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

object ServingRenewal {
    private var prefs: SharedPreferences? = null
    private var settings: ServerSettingsStore? = null
    private var appState: AppState? = null
    private var mailbox: SecretMailboxClient? = null
    private var podClients: PodClients? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val running = Mutex()
    @Volatile private var lastRun = 0L

    fun install(context: Context, appState: AppState, mailbox: SecretMailboxClient, podClients: PodClients?) {
        prefs = context.applicationContext.getSharedPreferences("flagship.serving", Context.MODE_PRIVATE)
        settings = ServerSettingsStore.from(context.applicationContext)
        this.appState = appState
        this.mailbox = mailbox
        this.podClients = podClients
    }

    /** The admin root without a prompt: only while the biometric session is fresh. */
    fun silentAdminRoot(): Ed25519Sign? {
        if (BiometricAuthority.current()?.isFresh() != true) return null
        return Keystore.adminRootSeed()?.let { Ed25519Sign(it) }
    }

    /** A renewer for the signed-in account on an admin device, else null. */
    fun renewer(): ServingRenewer? {
        val app = appState ?: return null
        val mailbox = mailbox ?: return null
        val prefs = prefs ?: return null
        val user = app.currentUser.value?.takeIf { it.isNotEmpty() } ?: return null
        if (app.isDemoAccountNow() || !Keystore.hasAdminRoot()) return null
        val deviceId = app.activeProfile?.deviceId.orEmpty()
        val clients = podClients
        val settings = settings
        return ServingRenewer(
            username = user,
            mailbox = mailbox,
            box = clients?.let { c -> { domain -> app.pods.value.firstOrNull { it.fqdn.equals(domain, ignoreCase = true) }?.let(c::screens) } },
            renewalKey = { RenewalKey.loadOrCreate(user) },
            silentAdminRoot = ::silentAdminRoot,
            deviceKeyPub = {
                if (!Keystore.hasUmkSeed() || deviceId.isEmpty()) null
                else runCatching { HexUtil.encode(Keystore.accountDevicePublicKey(Keystore.currentUmkSeed(), user, deviceId)) }.getOrNull()
            },
            delegation = { u, pub -> RenewalKey.delegation(prefs, u, pub) },
            recordDelegation = { RenewalKey.recordDelegation(prefs, it) },
            record = { domain, onLapse, grace, until -> settings?.recordServing(domain, onLapse, grace, until) },
        )
    }

    /** App open: renew, at most once a minute. Never prompts. */
    fun appOpened() {
        val now = System.currentTimeMillis()
        if (now - lastRun < 60_000) return
        scope.launch {
            if (!running.tryLock()) return@launch
            try {
                val r = renewer() ?: return@launch
                lastRun = System.currentTimeMillis()
                r.renew()
            } finally {
                running.unlock()
            }
        }
    }

    /** A biometric just opened the session: delegate the renewal key if it isn't yet, then renew. */
    fun sessionUnlocked() {
        scope.launch {
            running.withLock {
                val r = renewer() ?: return@launch
                val root = silentAdminRoot() ?: return@launch
                if (r.delegate(root) != null) {
                    lastRun = System.currentTimeMillis()
                    r.renew()
                }
            }
        }
    }
}
