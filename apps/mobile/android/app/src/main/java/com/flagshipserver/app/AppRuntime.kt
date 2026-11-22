// The process-wide objects a voi.ci call needs, made once per process from whichever entry point comes first: the main
// screen (MainActivity) or a call push that cold-started the app (push/PushMessageHandler -> VoiciCallCenter.onPush).
// Without them a killed app woken by a call had no AppState, no VoiciCenter and no phone route, so a phone with
// "Answer calls while Flagship is locked" on still said "Unlock to answer". MainActivity takes the same instances
// (it never builds a second AppState or VoiciCenter); a debug gym run on mocks swaps in its own and sets [mockRun].

package com.flagshipserver.app

import android.content.Context
import com.flagshipserver.app.core.AccountReadTokens
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.voici.VoiciCenter
import com.flagshipserver.app.keystore.Keystore
import okhttp3.OkHttpClient

object AppRuntime {
    /** How each object is made; the live parts in the app, a fake in the unit tests. */
    internal interface Parts {
        fun attach(app: Context)
        fun okHttp(): OkHttpClient
        fun newAppState(app: Context): AppState
        fun newVoiciCenter(app: Context, appState: AppState, okHttp: OkHttpClient): VoiciCenter
        fun newReadTokens(appState: AppState, okHttp: OkHttpClient): AccountReadTokens
        fun routeInstalled(): Boolean
        fun installRoute(app: Context, appState: AppState, okHttp: OkHttpClient)
    }

    @Volatile internal var parts: Parts = LiveParts
    private val lock = Any()
    @Volatile private var attached = false
    @Volatile private var okHttpRef: OkHttpClient? = null
    @Volatile private var appStateRef: AppState? = null

    /** A debug gym run on mock clients: MainActivity installs mock services, so nothing live is made here. */
    @Volatile var mockRun: Boolean = false

    private fun attach(context: Context) {
        if (attached) return
        synchronized(lock) {
            if (attached) return
            parts.attach(context.applicationContext)
            attached = true
        }
    }

    /** The one HTTP client of the process (the pinning factory's). */
    fun okHttp(): OkHttpClient = okHttpRef ?: synchronized(lock) { okHttpRef ?: parts.okHttp().also { okHttpRef = it } }

    /** The one AppState of the process: made on first use and restored from the Keystore like a cold start of the app. */
    fun appState(context: Context): AppState {
        appStateRef?.let { return it }
        attach(context)
        return synchronized(lock) { appStateRef ?: parts.newAppState(context.applicationContext).also { appStateRef = it } }
    }

    /** A gym launch starts from a fresh AppState (its scenarios never share one); the process keeps the new one. */
    fun freshAppState(context: Context): AppState {
        attach(context)
        return synchronized(lock) { parts.newAppState(context.applicationContext).also { appStateRef = it } }
    }

    /** The account read tokens for the process (kept when already there). */
    fun readTokens(appState: AppState): AccountReadTokens = synchronized(lock) {
        AccountReadTokens.shared ?: parts.newReadTokens(appState, okHttp()).also { AccountReadTokens.shared = it }
    }

    /** The one VoiciCenter of the process (also VoiciCenter.shared). */
    fun voiciCenter(context: Context): VoiciCenter {
        VoiciCenter.shared?.let { return it }
        val state = appState(context)
        return synchronized(lock) {
            VoiciCenter.shared ?: parts.newVoiciCenter(context.applicationContext, state, okHttp()).also { VoiciCenter.shared = it }
        }
    }

    /**
     * Everything a ringing call uses, made if missing: the locked call key (VoiciCenter), the read tokens the phone
     * route's grants need, and the phone route itself (signed with the kept account device key). Called by every call
     * push before it looks for keys; a no-op once the main screen made them, and on a gym run on mocks.
     */
    fun prepareCalls(context: Context) {
        if (mockRun) return
        val app = context.applicationContext
        val state = appState(app)
        readTokens(state)
        voiciCenter(app)
        if (!parts.routeInstalled()) parts.installRoute(app, state, okHttp())
    }

    internal fun resetForTest() = synchronized(lock) {
        attached = false
        okHttpRef = null
        appStateRef = null
        mockRun = false
        parts = LiveParts
    }

    private object LiveParts : Parts {
        override fun attach(app: Context) {
            Keystore.attach(app)
            // Box pins survive process death, so a cold start is not a window of ordinary web trust.
            com.flagshipserver.app.core.CertPinRegistry.shared.attach(com.flagshipserver.app.core.CertPinPrefs(app))
        }

        override fun okHttp(): OkHttpClient = com.flagshipserver.app.core.HttpClientFactory.build()

        override fun newAppState(app: Context): AppState {
            val privacy = com.flagshipserver.app.core.PrivacySettings.fromContext(app)
            val s = AppState(requireBiometricAtLaunch = privacy.requireBiometricAtLaunch.value)
            s.presentationNames = com.flagshipserver.app.core.PresentationNameStore.from(app)
            s.deviceIdStore = KeystoreDeviceIdStore
            // A paired device whose Keystore still holds the UMK seed opens on its account (behind the app lock the
            // constructor armed), unless the owner asked for a full passphrase sign-in on every open.
            if (!privacy.requirePassphraseAtLaunch.value) {
                Keystore.activeProfile()?.let { cloud -> if (Keystore.hasUmkSeed()) s.restorePersistedSession(cloud) }
            }
            return s
        }

        override fun newVoiciCenter(app: Context, appState: AppState, okHttp: OkHttpClient): VoiciCenter {
            val transport = com.flagshipserver.app.core.OkHttpJsonTransport(okHttp)
            return VoiciCenter(
                client = com.flagshipserver.app.api.LiveVoiciClient(transport, okHttp),
                keyring = com.flagshipserver.app.core.voici.VoiciKeystoreKeyring(appState, { com.flagshipserver.app.core.Variant.forceAdminRoot }),
                vault = com.flagshipserver.app.core.voici.VoiciVault(
                    com.flagshipserver.app.core.voici.FileVoiciVaultStore(java.io.File(app.filesDir, "voici")),
                ),
                caKeysSource = { com.flagshipserver.app.core.TrustChecker(transport).verifiedCaKeys() },
                http = okHttp,
                callKeyVault = com.flagshipserver.app.calls.KeystoreCallKeyVault(app),
                shareCard = com.flagshipserver.app.core.voici.AndroidShareCardRenderer,
            )
        }

        // Minted with the account device key (no prompt) or the IRK while the session is fresh: never a prompt.
        override fun newReadTokens(appState: AppState, okHttp: OkHttpClient) = AccountReadTokens(
            transport = com.flagshipserver.app.core.OkHttpJsonTransport(okHttp),
            store = com.flagshipserver.app.keystore.KeystoreReadTokenStore(),
            signers = { username ->
                com.flagshipserver.app.keystore.KeystoreReadTokenSigners.resolve(
                    username = username,
                    currentUser = appState.currentUser.value,
                    profile = appState.activeProfile,
                )
            },
            isDemo = { AppState.isDemoAccount(appState.activeProfile, appState.pods.value) },
        )

        override fun routeInstalled() = com.flagshipserver.app.phoneroute.PhoneRouteController.installed

        override fun installRoute(app: Context, appState: AppState, okHttp: OkHttpClient) =
            com.flagshipserver.app.phoneroute.PhoneRouteController.install(app, appState, okHttp)
    }
}

/** The Keystore keeps each account's registered device ID under that account's profile. */
internal object KeystoreDeviceIdStore : AppState.DeviceIdStore {
    private fun isActive(cloudName: String) = Keystore.activeProfile()?.lowercase() == cloudName.lowercase()
    override fun load(cloudName: String): String? =
        runCatching { if (isActive(cloudName)) Keystore.accountDeviceId() else null }.getOrNull()
    override fun save(cloudName: String, deviceId: String) {
        runCatching { if (isActive(cloudName)) Keystore.storeAccountDeviceId(deviceId) }
    }
}
