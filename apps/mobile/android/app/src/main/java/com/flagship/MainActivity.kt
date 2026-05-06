package com.flagship

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.flagship.ui.screens.ApproveUnlockScreen
import com.flagship.ui.screens.BiometricSetupScreen
import com.flagship.ui.screens.BuildCodeScreen
import com.flagship.ui.screens.ChooseUsernameScreen
import com.flagship.ui.screens.HomeScreen
import com.flagship.ui.screens.WelcomeScreen
import com.flagship.ui.theme.FS
import com.flagship.ui.theme.FlagshipTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            FlagshipTheme {
                Surface(
                    color = FS.colors.bg,
                    modifier = Modifier.fillMaxSize(),
                ) {
                    FlagshipApp()
                }
            }
        }
    }
}

/**
 * Top-level navigation. Routes match the screen IDs in `docs/build-tasks.md`.
 *
 * Onboarding flow:
 *   welcome → username → biometric → home
 *
 * Server flow:
 *   home → byoh → build-code → home (after server registers)
 *
 * Push entry points (handled by NotificationManager intents):
 *   approve-unlock?host=X
 *   browser-input?ref=X
 *   update-ready?app=X
 */
@Composable
fun FlagshipApp() {
    val nav = rememberNavController()
    NavHost(navController = nav, startDestination = "welcome") {
        composable("welcome") { WelcomeScreen(nav) }
        composable("username") { ChooseUsernameScreen(nav) }
        composable("biometric") { BiometricSetupScreen(nav) }
        composable("home") { HomeScreen(nav) }
        composable("build-code") { BuildCodeScreen(nav) }
        composable("approve-unlock") { ApproveUnlockScreen(nav) }
    }
}
