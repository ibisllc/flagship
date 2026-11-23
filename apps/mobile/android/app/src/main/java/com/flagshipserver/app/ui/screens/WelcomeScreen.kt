package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.R
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import androidx.compose.foundation.Image
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import com.flagshipserver.app.ui.theme.DarkColors
import com.flagshipserver.app.ui.components.FSActionFooter
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout

/**
 * D.2.1 — WelcomeScreen.
 *
 * Two CTAs: "Create your account" / "Connect to an existing account".
 * The owner's welcome art above the headline. Single primary action.
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
      val artMax = maxHeight * 0.4f
      Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .heightIn(min = maxHeight)
            .padding(horizontal = FS.space.s6),
        verticalArrangement = Arrangement.SpaceBetween,
      ) {
        Spacer(Modifier.height(FS.space.s6))

        // The picture, then the headline a fixed step under it; the leftover height goes between the top, this group
        // and the buttons. Square, the reading column's width, at most 40 % of the screen's height so a short phone
        // keeps its buttons on screen. At the largest text sizes (as iOS) the picture steps aside for the text.
        Column {
            if (LocalDensity.current.fontScale < 1.5f) {
                WelcomeArt(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(max = artMax)
                        .aspectRatio(1f, matchHeightConstraintsFirst = true)
                        .align(Alignment.CenterHorizontally),
                )
                Spacer(Modifier.height(FS.space.s12))
            }
            Text(
                text = stringResource(R.string.your_apps_live_where_you_live),
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
 * The owner's welcome art (0.4): the house at the end of the path with the server glowing inside and the phone in
 * front, as on iOS (WelcomeArt). A day and a night painting whose edges fade to transparent, so they bleed into the
 * screen: no card, border or shadow. Picked by the app's own theme (Settings can pin light or dark), not the system's,
 * so a drawable-night folder would choose wrong. Decorative: no content description.
 */
@Composable
private fun WelcomeArt(modifier: Modifier = Modifier) {
    val dark = FS.colors == DarkColors
    Image(
        painter = painterResource(if (dark) R.drawable.welcome_night else R.drawable.welcome_day),
        contentDescription = null,
        contentScale = ContentScale.Fit,
        modifier = modifier,
    )
}
