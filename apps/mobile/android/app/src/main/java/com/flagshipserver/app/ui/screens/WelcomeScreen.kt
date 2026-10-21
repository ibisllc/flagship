package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.R
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material3.Icon
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
import com.flagshipserver.app.ui.components.FSActionFooter
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout

/**
 * D.2.1 — WelcomeScreen.
 *
 * Two CTAs: "Create your account" / "Connect to an existing account".
 * Subtle pulsing illustration of the box. Single primary action.
 */
@Composable
fun WelcomeScreen(nav: NavController) {
    // Edge-to-edge: keep the buttons and the footer above the navigation bar.
    Column(
        modifier = Modifier.fillMaxSize().navigationBarsPadding(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      // Reading column — clamp + center on expanded panes; a no-op on phones. At the
      // largest text sizes it scrolls instead of clipping.
      BoxWithConstraints(Modifier.widthIn(max = FSLayout.readingMaxWidth).fillMaxWidth().fillMaxHeight()) {
      Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .heightIn(min = maxHeight)
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
                text = androidx.compose.ui.text.buildAnnotatedString {
                    append(stringResource(R.string.your_stuff_on))
                    withStyle(androidx.compose.ui.text.SpanStyle(color = FS.colors.accent)) { append(stringResource(R.string.your_hardware)) }
                },
                color = FS.colors.text,
                style = MaterialTheme.typography.displaySmall.copy(fontSize = 40.sp, lineHeight = 48.sp),
            )
            Spacer(Modifier.height(FS.space.s4))
            Text(
                text = stringResource(R.string.a_personal_cloud_you_actually_own),
                color = FS.colors.textMuted,
                style = MaterialTheme.typography.titleMedium,
            )
        }

        // One page for both ways back in (ConnectAccountScreen): sign in with
        // the account name, or join with a pairing code from another device
        // of the account. Same footer as the app lock.
        FSActionFooter(
            primary = stringResource(R.string.create_your_account),
            primaryTag = "welcome-create",
            onPrimary = { nav.navigate("username") },
            secondary = stringResource(R.string.connect_to_an_existing_account),
            secondaryTag = "welcome-connect",
            onSecondary = { nav.navigate("connect") },
            secondaryDescription = stringResource(R.string.connect_to_an_existing_account_sign),
        )
      }
      }
    }
}

/**
 * The product in one picture: your phone (the key), a dashed line it signs
 * across, and your server (two drive bays with live LEDs). A dot travels the
 * line; the server's LEDs breathe. Drawn, not an icon, so it scales with the
 * screen and follows both themes.
 */
@Composable
private fun BoxIllustration() {
    val transition = rememberInfiniteTransition(label = "welcome")
    val travel by transition.animateFloat(
        initialValue = 0f, targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(2600, easing = androidx.compose.animation.core.FastOutSlowInEasing), RepeatMode.Restart),
        label = "travel",
    )
    val led by transition.animateFloat(
        initialValue = 0.45f, targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1400, easing = LinearEasing), RepeatMode.Reverse),
        label = "led",
    )
    val teal = FS.colors.fill
    val ink = FS.colors.text
    val line = FS.colors.border
    val card = FS.colors.surface
    val ok = FS.colors.success
    androidx.compose.foundation.Canvas(
        modifier = Modifier
            .fillMaxWidth()
            .height(200.dp)
            .semantics { contentDescription = FSStrings.get(R.string.your_phone_and_your_server_connected) },
    ) {
        val w = size.width
        val h = size.height
        val cy = h / 2f
        // Glow behind the pair
        drawCircle(
            brush = Brush.radialGradient(listOf(teal.copy(alpha = 0.20f), Color.Transparent), center = androidx.compose.ui.geometry.Offset(w / 2f, cy), radius = w * 0.46f),
            radius = w * 0.46f,
            center = androidx.compose.ui.geometry.Offset(w / 2f, cy),
        )
        // Phone
        val pw = 78.dp.toPx(); val ph = 140.dp.toPx()
        val px = w * 0.16f; val py = cy - ph / 2f
        drawRoundRect(card, androidx.compose.ui.geometry.Offset(px, py), androidx.compose.ui.geometry.Size(pw, ph), androidx.compose.ui.geometry.CornerRadius(16.dp.toPx()))
        drawRoundRect(ink.copy(alpha = 0.85f), androidx.compose.ui.geometry.Offset(px, py), androidx.compose.ui.geometry.Size(pw, ph), androidx.compose.ui.geometry.CornerRadius(16.dp.toPx()), style = androidx.compose.ui.graphics.drawscope.Stroke(2.dp.toPx()))
        drawRoundRect(ink.copy(alpha = 0.5f), androidx.compose.ui.geometry.Offset(px + pw / 2f - 9.dp.toPx(), py + 8.dp.toPx()), androidx.compose.ui.geometry.Size(18.dp.toPx(), 3.dp.toPx()), androidx.compose.ui.geometry.CornerRadius(2.dp.toPx()))
        // Key on the phone: a ring and a shaft
        val kc = androidx.compose.ui.geometry.Offset(px + pw / 2f, cy - 8.dp.toPx())
        drawCircle(teal, radius = 11.dp.toPx(), center = kc, style = androidx.compose.ui.graphics.drawscope.Stroke(4.dp.toPx()))
        drawLine(teal, androidx.compose.ui.geometry.Offset(kc.x, kc.y + 11.dp.toPx()), androidx.compose.ui.geometry.Offset(kc.x, kc.y + 34.dp.toPx()), strokeWidth = 4.dp.toPx(), cap = androidx.compose.ui.graphics.StrokeCap.Round)
        drawLine(teal, androidx.compose.ui.geometry.Offset(kc.x, kc.y + 26.dp.toPx()), androidx.compose.ui.geometry.Offset(kc.x + 9.dp.toPx(), kc.y + 26.dp.toPx()), strokeWidth = 4.dp.toPx(), cap = androidx.compose.ui.graphics.StrokeCap.Round)
        // Server: two bays
        val sw = 104.dp.toPx(); val bay = 52.dp.toPx(); val gap = 8.dp.toPx()
        val sx = w * 0.84f - sw; val sy = cy - (bay * 2 + gap) / 2f
        for (i in 0..1) {
            val y = sy + i * (bay + gap)
            drawRoundRect(card, androidx.compose.ui.geometry.Offset(sx, y), androidx.compose.ui.geometry.Size(sw, bay), androidx.compose.ui.geometry.CornerRadius(10.dp.toPx()))
            drawRoundRect(ink.copy(alpha = 0.85f), androidx.compose.ui.geometry.Offset(sx, y), androidx.compose.ui.geometry.Size(sw, bay), androidx.compose.ui.geometry.CornerRadius(10.dp.toPx()), style = androidx.compose.ui.graphics.drawscope.Stroke(2.dp.toPx()))
            for (k in 0..2) drawLine(line, androidx.compose.ui.geometry.Offset(sx + 14.dp.toPx(), y + (16 + k * 9).dp.toPx()), androidx.compose.ui.geometry.Offset(sx + sw - 38.dp.toPx(), y + (16 + k * 9).dp.toPx()), strokeWidth = 2.dp.toPx(), cap = androidx.compose.ui.graphics.StrokeCap.Round)
            drawCircle(ok.copy(alpha = if (i == 0) led else 1f), radius = 4.dp.toPx(), center = androidx.compose.ui.geometry.Offset(sx + sw - 18.dp.toPx(), y + bay / 2f))
        }
        // Dashed line phone -> server, a dot travelling along it
        val x0 = px + pw + 10.dp.toPx(); val x1 = sx - 10.dp.toPx()
        drawLine(teal.copy(alpha = 0.55f), androidx.compose.ui.geometry.Offset(x0, cy), androidx.compose.ui.geometry.Offset(x1, cy), strokeWidth = 2.dp.toPx(), pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 6.dp.toPx())))
        drawCircle(teal, radius = 5.dp.toPx(), center = androidx.compose.ui.geometry.Offset(x0 + (x1 - x0) * travel, cy))
    }
}
