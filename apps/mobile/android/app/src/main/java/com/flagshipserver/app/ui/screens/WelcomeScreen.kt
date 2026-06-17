package com.flagshipserver.app.ui.screens

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS

/**
 * D.2.1 — WelcomeScreen.
 *
 * Two CTAs: "Create account" / "I already have a server".
 * Subtle pulsing illustration of the box. Single primary action.
 */
@Composable
fun WelcomeScreen(nav: NavController) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Spacer(Modifier.height(FS.space.s16))

        // Illustration
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(220.dp),
            contentAlignment = Alignment.Center,
        ) {
            BoxIllustration()
        }

        // Headline + lede
        Column {
            Text(
                text = "Your stuff,\non your hardware.",
                color = FS.colors.text,
                style = TextStyle(
                    fontSize = 40.sp,
                    lineHeight = 48.sp,
                    fontWeight = FontWeight.Medium,
                ),
            )
            Spacer(Modifier.height(FS.space.s4))
            Text(
                text = "A personal cloud you actually own. Your phone holds the keys; your box runs the services.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 17.sp, lineHeight = 26.sp),
            )
        }

        // CTAs
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            FSPrimaryButton(
                label = "Create your account",
                onClick = { nav.navigate("username") },
                block = true,
                large = true,
            )
            FSGhostButton(
                // Username-first Join (JoinAccountContainer): type your
                // account handle → resolveAccount branches to demo /
                // single / multi / unknown. Replaces the old
                // assert-passkey-first entry that 404'd on a missing
                // local recovery passkey.
                label = "I already have an account",
                onClick = { nav.navigate("recover") },
                block = true,
                large = true,
            )
            FSGhostButton(
                // Phase 3b — cross-device pairing (collaborators). Opens
                // the in-app scanner; scanning the admin's "Add a device"
                // QR joins their account out-of-band. (The admin's QR is
                // also an App-Links URL, so the native camera routes here
                // directly.)
                label = "Join with a pairing code",
                onClick = { nav.navigate("join-device") },
                block = true,
            )
            Spacer(Modifier.height(FS.space.s4))
        }
    }
}

@Composable
private fun BoxIllustration() {
    val transition = rememberInfiniteTransition(label = "led-pulse")
    val ledAlpha by transition.animateFloat(
        initialValue = 0.5f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(1400, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "led-pulse-alpha",
    )
    Box(
        modifier = Modifier
            .size(width = 240.dp, height = 180.dp)
            .clip(RoundedCornerShape(FS.radius.lg))
            .background(
                Brush.radialGradient(
                    listOf(
                        FS.colors.primary.copy(alpha = 0.18f),
                        FS.colors.surfaceSunken,
                    ),
                ),
            )
            .border(1.dp, FS.colors.border, RoundedCornerShape(FS.radius.lg)),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(width = 140.dp, height = 80.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(FS.colors.surface)
                .border(1.dp, FS.colors.border, RoundedCornerShape(8.dp)),
            contentAlignment = Alignment.BottomEnd,
        ) {
            // LED
            Box(
                modifier = Modifier
                    .padding(10.dp)
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(FS.colors.success.copy(alpha = ledAlpha)),
            )
        }
    }
}

