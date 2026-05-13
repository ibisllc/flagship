package com.flagshipserver.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.fragment.app.FragmentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowSizeClass
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass as MaterialWindowWidthSizeClass
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.flagshipserver.app.api.EncryptedSessionStore
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.LiveScreensClient
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.SessionStoring
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.DeepLink
import com.flagshipserver.app.core.DeepLinker
import com.flagshipserver.app.core.DeveloperSettings
import com.flagshipserver.app.core.LiveQrRelayClient
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalDeepLinker
import com.flagshipserver.app.core.LocalDeveloperSettings
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalQrRelayClient
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.MockQrRelayClient
import com.flagshipserver.app.core.QrRelayClient
import com.flagshipserver.app.core.ToastCenter
import com.flagshipserver.app.keystore.BiometricAuthority
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.push.FlagshipFcmService
import com.flagshipserver.app.push.PushHolder
import com.flagshipserver.app.push.PushRegistrar
import com.flagshipserver.app.ui.components.Toaster
import com.flagshipserver.app.ui.onboarding.OnboardingFlow
import com.flagshipserver.app.ui.shell.RootShell
import com.flagshipserver.app.ui.shell.WindowWidthSizeClass
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FlagshipTheme
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class MainActivity : FragmentActivity() {

    private lateinit var deepLinker: DeepLinker
    private lateinit var appState: AppState
    private lateinit var biometric: BiometricAuthority

    @OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Keystore.attach(applicationContext)
        FlagshipFcmService.ensureChannel(applicationContext)
        biometric = BiometricAuthority(this)
        BiometricAuthority.set(biometric)

        appState = AppState()
        val sessionStore = EncryptedSessionStore.create(applicationContext)
        val flagshipServer = MockFlagshipServerClient()
        val toasts = ToastCenter()
        deepLinker = DeepLinker()
        val devSettings = DeveloperSettings.create(applicationContext)
        val okHttp = buildOkHttp()

        val mockScreens = MockScreensClient()
        val liveScreens = LiveScreensClient(client = okHttp, store = sessionStore)
        val mockRelay = MockQrRelayClient()
        val liveRelay = LiveQrRelayClient(client = okHttp)

        val registrar = PushRegistrar(appState, flagshipServer)
        PushHolder.registrar = registrar

        // Handle the intent that launched the activity (push tap, custom
        // URL scheme, app-link). The shell consumes the queue once the
        // composition is alive.
        intent?.let { handleIntent(it) }

        setContent {
            // Pivot Mock vs Live on the developer toggle + presence of
            // a stored session token. The CompositionLocal swap is
            // automatic — every screen that reads LocalScreensClient
            // re-composes when the value changes.
            val useLive by devSettings.useLiveClient.collectAsState()
            val sessionToken by sessionStore.sessionToken.collectAsState()
            val effectiveScreens: ScreensClient =
                if (useLive && sessionToken != null) liveScreens else mockScreens
            val effectiveRelay: QrRelayClient =
                if (useLive) liveRelay else mockRelay

            val sizeClass = calculateWindowSizeClass(this)

            FlagshipTheme {
                CompositionLocalProvider(
                    LocalAppState provides appState,
                    LocalScreensClient provides effectiveScreens,
                    LocalFlagshipServerClient provides flagshipServer,
                    LocalQrRelayClient provides effectiveRelay,
                    LocalToastCenter provides toasts,
                    LocalDeepLinker provides deepLinker,
                    LocalDeveloperSettings provides devSettings,
                ) {
                    Surface(color = FS.colors.bg, modifier = Modifier.fillMaxSize()) {
                        AppRoot(widthSizeClass = mapWidth(sizeClass.widthSizeClass))
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onDestroy() {
        super.onDestroy()
        PushHolder.registrar = null
        BiometricAuthority.set(null)
    }

    /** Parse incoming launch intents (`flagship://...` and the
     *  https://flagshipserver.com/app/<…> universal-link form). Push
     *  notifications surface their deepLink via the same path. */
    private fun handleIntent(intent: Intent) {
        val uri = intent.data ?: return
        val link = parseLink(uri) ?: return
        deepLinker.enqueue(link)
    }

    private fun parseLink(uri: Uri): DeepLink? {
        // 1. flagship://<host>?<params> — primary scheme.
        DeepLink.parse(uri)?.let { return it }
        // 2. https://flagshipserver.com/app/<host>?<params> — app-link.
        if (uri.scheme in setOf("http", "https") && uri.host == "flagshipserver.com") {
            val segments = uri.pathSegments
            if (segments.size >= 2 && segments[0] == "app") {
                val translated = Uri.Builder()
                    .scheme("flagship")
                    .authority(segments[1])
                    .encodedQuery(uri.encodedQuery)
                    .build()
                return DeepLink.parse(translated)
            }
        }
        return null
    }

    private fun buildOkHttp(): OkHttpClient =
        com.flagshipserver.app.core.HttpClientFactory.build()

    private fun mapWidth(w: MaterialWindowWidthSizeClass): WindowWidthSizeClass = when (w) {
        MaterialWindowWidthSizeClass.Expanded -> WindowWidthSizeClass.EXPANDED
        MaterialWindowWidthSizeClass.Medium -> WindowWidthSizeClass.MEDIUM
        else -> WindowWidthSizeClass.COMPACT
    }
}

@Composable
private fun AppRoot(widthSizeClass: WindowWidthSizeClass) {
    val app = LocalAppState.current
    val isPaired by app.isPaired.collectAsState()
    val toasts = LocalToastCenter.current
    val toastQueue by toasts.queue.collectAsState()

    Box(Modifier.fillMaxSize()) {
        if (isPaired) {
            RootShell(widthSizeClass = widthSizeClass)
        } else {
            OnboardingFlow(onFinished = { /* AppState.completeOnboarding flips isPaired */ })
        }
        Toaster(queue = toastQueue, onDismiss = { toasts.dismiss(it) })
    }
}
