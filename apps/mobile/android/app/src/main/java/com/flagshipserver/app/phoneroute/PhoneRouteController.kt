// The app's wiring of the phone route (docs/architecture-v2/phone-route.md section 4): a
// foreground-only facility. Coming to the foreground, every device says hello to the phone holding
// the bare name; an admin device then makes the TLS key if there is none, orders a certificate only
// when one is due, and, while a valid one is held, opens the tunnel and claims (refused while
// another phone holds it: it waits as a standby). Leaving the foreground closes the tunnel; the
// relay makes the route vacant at once.

package com.flagshipserver.app.phoneroute

import android.content.Context
import com.flagshipserver.app.core.AccountReadTokens
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
    private val _holderPresent = MutableStateFlow<Boolean?>(null)
    /** Whether a phone answered this device's hello on the last foreground (null: not asked yet). */
    val holderPresent: StateFlow<Boolean?> = _holderPresent

    /** Give the held route up so another admin phone can claim it (the trigger, an ask through `.com`, is a follow-up). */
    fun release(): Boolean = client?.release() == true

    /** The signed hello: `GET https://<account>.<apex>/` with the presence headers. True on a 2xx. */
    fun sayHello(http: OkHttpClient, account: String, apex: String, deviceKey: com.google.crypto.tink.subtle.Ed25519Sign, devicePub: String): Boolean {
        val host = PhoneRoute.hostname(account, apex)
        val at = System.currentTimeMillis()
        val sig = PhoneRoute.sign(PhoneRoute.canonicalPresence(account, devicePub, host, at), deviceKey)
        val quick = http.newBuilder().callTimeout(5, java.util.concurrent.TimeUnit.SECONDS).build()
        return runCatching {
            quick.newCall(
                Request.Builder().url("https://$host/").get()
                    .header("x-flagship-presence-device", devicePub)
                    .header("x-flagship-presence-at", at.toString())
                    .header("x-flagship-presence-sig", sig)
                    .build(),
            ).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

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
        if (app.isDemoAccountNow() || !Keystore.hasUmkSeed()) return
        val deviceId = app.activeProfile?.deviceId?.takeIf { it.isNotEmpty() } ?: return
        val admin = Keystore.hasAdminRoot()
        job = scope.launch {
            val umk = runCatching { Keystore.currentUmkSeed() }.getOrNull() ?: return@launch
            val deviceKey = Keystore.accountDeviceSigner(umk, user, deviceId)
            val devicePub = HexUtil.encode(Keystore.accountDevicePublicKey(umk, user, deviceId))
            val apex = Endpoints.dataApex
            // "I'm here" to the phone holding the bare name (every device of the account). A 2xx means a holder
            // exists: an admin phone's claim will then be refused and it waits as a standby; no answer: it claims.
            _holderPresent.value = sayHello(http, user, apex, deviceKey, devicePub)
            if (!admin) return@launch
            val key = PhoneTlsKey.loadOrCreate(user) ?: return@launch
            val certs = PhoneCertManager(store, ComPhoneCertIssuer(http, Endpoints.controlBaseUrl))
            certs.ensure(user, apex, key, deviceKey, devicePub)
            val chain = certs.current(user) ?: return@launch
            val hub = tunnelHub(http) ?: return@launch
            val grants = beginGrants(http, user, devicePub)
            val ep = PhoneEndpoint(
                user, PhoneRoute.hostname(user, apex), devicePub,
                web = VoiciPhoneWebHandler,
                origins = if (Endpoints.voiciOrigin == "https://voi.ci") com.flagshipserver.app.core.voici.VoiciPhoneWeb.PHONE_WEB_ORIGINS
                else com.flagshipserver.app.core.voici.VoiciPhoneWeb.PHONE_WEB_ORIGINS_GYM,
            )
            val c = PhoneTunnelClient(
                okHttp = http,
                url = PhoneTunnelClient.phoneTunnelUrl(hub),
                account = user,
                apex = apex,
                deviceKey = deviceKey,
                deviceKeyPub = devicePub,
                tls = PhoneKeyManager.sslContext(key.privateKey, chain),
                endpoint = ep,
                grants = grants,
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

    /**
     * This device's admin grants from `.com` (`/api/users/:u/device-grants`, read token), for the tunnel's `begin`.
     * Empty when they can't be read: a relay without the mesh doesn't need them, a mesh relay then refuses the claim.
     */
    private suspend fun beginGrants(http: OkHttpClient, account: String, devicePub: String): List<kotlinx.serialization.json.JsonObject> = runCatching {
        val url = "${Endpoints.controlBaseUrl.trimEnd('/')}/api/users/${java.net.URLEncoder.encode(account.lowercase(), "UTF-8")}/device-grants"
        AccountReadTokens.authorize(account) { auth ->
            val req = Request.Builder().url(url).get().apply { auth.forEach { (k, v) -> header(k, v) } }.build()
            http.newCall(req).execute().use { res ->
                if (!res.isSuccessful) return@use emptyList<kotlinx.serialization.json.JsonObject>()
                PhoneRoute.beginGrants(Json.parseToJsonElement(res.body?.string().orEmpty()), account, devicePub, System.currentTimeMillis())
            }
        }
    }.getOrDefault(emptyList())

    private fun tunnelHub(http: OkHttpClient): String? = runCatching {
        http.newCall(Request.Builder().url("${Endpoints.controlBaseUrl}/api/services/endpoints").get().build()).execute().use { res ->
            if (!res.isSuccessful) return null
            Json.parseToJsonElement(res.body?.string().orEmpty()).jsonObject["tunnelHub"]?.jsonPrimitive?.content
        }
    }.getOrNull()?.takeIf { it.startsWith("wss://") }
}

/** The phone endpoint's voi.ci operations, answered by the app's VoiciCenter (none yet: `live` is a 404). */
object VoiciPhoneWebHandler : PhoneWebHandler {
    override fun live() = com.flagshipserver.app.core.voici.VoiciCenter.shared?.phoneLive()
    override fun deliver(body: ByteArray, phoneRoutePub: String): Pair<Int, String> =
        com.flagshipserver.app.core.voici.VoiciCenter.shared?.phoneDeliver(body, phoneRoutePub)
            ?: (404 to """{"error":"not found","code":"not-found"}""")
}
