// Opening a vibe-code session so that Back lands on the build chooser.
// Mirror of iOS `[AppsRoute].openVibeSession`.

package com.flagshipserver.app.ui.shell.tabs

import androidx.navigation.NavController

const val BUILD_CHOOSER_ROUTE = "build/source"

fun vibeSessionChatRoute(sessionId: String) = "vibe-code-chat/$sessionId"

/**
 * The back stack after opening [sessionRoute]: the AI-key and describe steps
 * (or the session list) that led here are dropped, and a session reached from
 * elsewhere gets the chooser under it.
 */
fun openVibeSessionStack(stack: List<String>, sessionRoute: String): List<String> {
    val i = stack.indexOf(BUILD_CHOOSER_ROUTE)
    val base = if (i >= 0) stack.subList(0, i + 1) else stack + BUILD_CHOOSER_ROUTE
    return base + sessionRoute
}

/** Applies [openVibeSessionStack] to the live back stack. */
fun NavController.openVibeSession(sessionRoute: String) {
    val hasChooser = runCatching { getBackStackEntry(BUILD_CHOOSER_ROUTE) }.isSuccess
    if (!hasChooser) navigate(BUILD_CHOOSER_ROUTE)
    navigate(sessionRoute) { popUpTo(BUILD_CHOOSER_ROUTE) }
}
