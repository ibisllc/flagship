// Two-card chooser used everywhere we ask "add a server": onboarding
// (zero servers yet) + the in-app + button on Home / Settings. Both
// branches navigate to existing flows. The screen is presentation-only;
// the caller owns the nav.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.QrCode2
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.theme.FS

enum class AddServerMode { ONBOARDING, IN_APP }

@Composable
fun AddServerChooserScreen(
    mode: AddServerMode = AddServerMode.IN_APP,
    onProvision: () -> Unit,
    onPair: () -> Unit,
    onCancel: (() -> Unit)? = null,
) {
    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(if (mode == AddServerMode.ONBOARDING) FS.space.s12 else FS.space.s4))
        Text(
            if (mode == AddServerMode.ONBOARDING) "Get your first server." else "Add a server.",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            if (mode == AddServerMode.ONBOARDING) {
                "Pick a path — both end with your stuff running on hardware you control."
            } else {
                "Add another box to your fleet. Each one is independent."
            },
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        )
        Spacer(Modifier.height(FS.space.s4))
        ChooserCard(
            icon = Icons.Outlined.Storage,
            accent = FS.colors.primary,
            title = "Provision a new box",
            body = "Mint a build code, then use the Flagship burner to write it to a USB stick and boot commodity hardware. Cert + tunnel come up automatically.",
            cta = "Provision →",
            onClick = onProvision,
            testTag = "chooser-provision",
        )
        Spacer(Modifier.height(FS.space.s3))
        ChooserCard(
            icon = Icons.Outlined.QrCode2,
            accent = FS.colors.success,
            title = "Pair an existing box",
            body = "Already have a Flagship server running somewhere? Scan its pairing QR or paste the 6-character code.",
            cta = "Pair →",
            onClick = onPair,
            testTag = "chooser-pair",
        )
        if (onCancel != null) {
            Spacer(Modifier.height(FS.space.s4))
            FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
        }
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun ChooserCard(
    icon: ImageVector,
    accent: androidx.compose.ui.graphics.Color,
    title: String,
    body: String,
    cta: String,
    onClick: () -> Unit,
    testTag: String? = null,
) {
    FSCard(
        padding = PaddingValues(FS.space.s6),
        modifier = if (testTag != null) Modifier.testTag(testTag) else Modifier,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .clip(RoundedCornerShape(FS.radius.sm))
                    .padding(0.dp),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier
                        .size(44.dp)
                        .clip(RoundedCornerShape(FS.radius.sm))
                        .padding(0.dp),
                )
                Icon(icon, contentDescription = title, tint = accent)
            }
            Text(title, color = FS.colors.text, style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold))
            Text(body, color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
            FSGhostButton(label = cta, onClick = onClick, block = true)
        }
    }
}
