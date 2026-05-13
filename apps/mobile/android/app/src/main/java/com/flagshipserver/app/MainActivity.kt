package com.flagshipserver.app

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
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.DeepLinker
import com.flagshipserver.app.core.DeveloperSettings
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalDeepLinker
import com.flagshipserver.app.core.LocalDeveloperSettings
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalQrRelayClient
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.MockQrRelayClient
import com.flagshipserver.app.core.ToastCenter
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
