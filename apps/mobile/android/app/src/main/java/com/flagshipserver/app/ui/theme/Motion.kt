package com.flagshipserver.app.ui.theme

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.navigation.NavBackStackEntry

/** Screen-to-screen motion for every NavHost: Material's shared-axis step
 *  (a short horizontal drift with a fade), quick enough to never be waited on.
 *  The system's animation-scale setting still turns it off. */
object FSMotion {
    private const val DRIFT = 14
    val enter: AnimatedContentTransitionScope<NavBackStackEntry>.() -> EnterTransition = {
        fadeIn(tween(210, delayMillis = 60)) + slideInHorizontally(tween(280)) { it / DRIFT }
    }
    val exit: AnimatedContentTransitionScope<NavBackStackEntry>.() -> ExitTransition = {
        fadeOut(tween(90))
    }
    val popEnter: AnimatedContentTransitionScope<NavBackStackEntry>.() -> EnterTransition = {
        fadeIn(tween(210, delayMillis = 60)) + slideInHorizontally(tween(280)) { -it / DRIFT }
    }
    val popExit: AnimatedContentTransitionScope<NavBackStackEntry>.() -> ExitTransition = {
        fadeOut(tween(90)) + slideOutHorizontally(tween(280)) { it / DRIFT }
    }
}
