package com.flagship

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import com.flagship.api.MockFlagshipServerClient
import com.flagship.api.MockScreensClient
import com.flagship.core.AppState
import com.flagship.core.DeepLinker
import com.flagship.core.DeveloperSettings
import com.flagship.core.LocalAppState
import com.flagship.core.LocalDeepLinker
import com.flagship.core.LocalDeveloperSettings
import com.flagship.core.LocalFlagshipServerClient
import com.flagship.core.LocalQrRelayClient
import com.flagship.core.LocalScreensClient
import com.flagship.core.LocalToastCenter
import com.flagship.core.MockQrRelayClient
import com.flagship.core.ToastCenter
import com.flagship.keystore.Keystore
import com.flagship.push.FlagshipFcmService
import com.flagship.push.PushHolder
import com.flagship.push.PushRegistrar
import com.flagship.ui.components.Toaster
import com.flagship.ui.onboarding.OnboardingFlow
import com.flagship.ui.shell.RootShell
import com.flagship.ui.shell.WindowWidthSizeClass
import com.flagship.ui.theme.FS
import com.flagship.ui.theme.FlagshipTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Keystore.attach(applicationContext)
        FlagshipFcmService.ensureChannel(applicationContext)

        val appState = AppState()
        val flagshipServer = MockFlagshipServerClient()
        val screens = MockScreensClient()
        val qrRelay = MockQrRelayClient()
        val toasts = ToastCenter()
        val deepLinker = DeepLinker()
        val devSettings = DeveloperSettings.create(applicationContext)
        val registrar = PushRegistrar(appState, flagshipServer)
        PushHolder.registrar = registrar

        setContent {
            FlagshipTheme {
                CompositionLocalProvider(
                    LocalAppState provides appState,
                    LocalScreensClient provides screens,
                    LocalFlagshipServerClient provides flagshipServer,
                    LocalQrRelayClient provides qrRelay,
                    LocalToastCenter provides toasts,
                    LocalDeepLinker provides deepLinker,
                    LocalDeveloperSettings provides devSettings,
                ) {
                    Surface(color = FS.colors.bg, modifier = Modifier.fillMaxSize()) {
                        AppRoot()
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        PushHolder.registrar = null
    }
}

@Composable
private fun AppRoot() {
    val app = LocalAppState.current
    val isPaired by app.isPaired.collectAsState()
    val toasts = LocalToastCenter.current
    val toastQueue by toasts.queue.collectAsState()

    Box(Modifier.fillMaxSize()) {
        if (isPaired) {
            // TODO: hook into WindowSizeClass once Compose-foundation
            // emits a stable API; default to COMPACT.
            RootShell(widthSizeClass = WindowWidthSizeClass.COMPACT)
        } else {
            OnboardingFlow(onFinished = { /* AppState.completeOnboarding flips isPaired */ })
        }
        Toaster(queue = toastQueue, onDismiss = { toasts.dismiss(it) })
    }
}
