// The app's wiring of the phone route (docs/architecture-v2/phone-route.md section 4): a
// foreground-only facility on an admin device. Coming to the foreground: make the TLS key if there
// is none, order a certificate only when one is due, and, while a valid one is held, open the
// tunnel and claim the bare name. Leaving the foreground: release and close. A refusal or a lost
// route is final until the next foreground (no automatic re-acquisition).

package com.flagshipserver.app.phoneroute

import android.content.Context
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.keystore.Keystore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request

object PhoneRouteController {
    private var appState: AppState? = null
    private var okHttp: OkHttpClient? = null
    private var store: PhoneCertStore? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null
    @Volatile private var client: PhoneTunnelClient? = null
    @Volatile var endpoint: PhoneEndpoint? = null
        private set
    private val _state = MutableStateFlow<PhoneTunnelState?>(null)
    val state: StateFlow<PhoneTunnelState?> = _state

    fun install(context: Context, appState: AppState, okHttp: OkHttpClient) {
        this.appState = appState
        this.okHttp = okHttp
        store = PhoneCertStore(context.applicationContext.getSharedPreferences("flagship.phone-route", Context.MODE_PRIVATE))
    }

    @Synchronized
    fun appForeground() {
        if (job?.isActive == true || client != null) return
        val app = appState ?: return
        val http = okHttp ?: return
        val store = store ?: return
        val user = app.currentUser.value?.takeIf { it.isNotEmpty() } ?: return
        if (app.isDemoAccountNow() || !Keystore.hasAdminRoot() || !Keystore.hasUmkSeed()) return
        val deviceId = app.activeProfile?.deviceId?.takeIf { it.isNotEmpty() } ?: return
        job = scope.launch {
            val umk = runCatching { Keystore.currentUmkSeed() }.getOrNull() ?: return@launch
            val deviceKey = Keystore.accountDeviceSigner(umk, user, deviceId)
            val devicePub = HexUtil.encode(Keystore.accountDevicePublicKey(umk, user, deviceId))
            val key = PhoneTlsKey.loadOrCreate(user) ?: return@launch
            val apex = Endpoints.dataApex
            val certs = PhoneCertManager(store, ComPhoneCertIssuer(http, Endpoints.controlBaseUrl))
            certs.ensure(user, apex, key, deviceKey, devicePub)
            val chain = certs.current(user) ?: return@launch
            val hub = tunnelHub(http) ?: return@launch
            val ep = PhoneEndpoint(user, PhoneRoute.hostname(user, apex), devicePub)
            val c = PhoneTunnelClient(
                okHttp = http,
                url = PhoneTunnelClient.phoneTunnelUrl(hub),
                account = user,
                apex = apex,
                deviceKey = deviceKey,
                deviceKeyPub = devicePub,
                tls = PhoneKeyManager.sslContext(key.privateKey, chain),
                endpoint = ep,
                onState = { _state.value = it },
            )
            synchronized(this@PhoneRouteController) {
                if (job?.isCancelled == true) return@launch
                endpoint = ep
                client = c
            }
            c.start()
        }
    }

    @Synchronized
    fun appBackground() {
        job?.cancel()
        job = null
        client?.stop()
        client = null
        endpoint = null
        _state.value = null
    }

    private fun tunnelHub(http: OkHttpClient): String? = runCatching {
        http.newCall(Request.Builder().url("${Endpoints.controlBaseUrl}/api/services/endpoints").get().build()).execute().use { res ->
            if (!res.isSuccessful) return null
            Json.parseToJsonElement(res.body?.string().orEmpty()).jsonObject["tunnelHub"]?.jsonPrimitive?.content
        }
    }.getOrNull()?.takeIf { it.startsWith("wss://") }
}
