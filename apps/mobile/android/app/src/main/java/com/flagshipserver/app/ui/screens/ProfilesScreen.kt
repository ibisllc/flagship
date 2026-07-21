// W3 — list of clouds (profiles) this phone is a member of. Tapping
// a row switches the active profile; the rest of the UI re-renders
// against the new cloud's session state.
//
// Phase F demo case is one profile per phone, so the typical user
// sees a single row. Multi-profile is the v2 capability that lets
// corporate / family setups co-exist on one phone.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.Profile
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS

@Composable
fun ProfilesScreen(nav: NavController) {
    val app = LocalAppState.current
    val profiles by app.profiles.collectAsState()
    val activeName by app.activeCloudName.collectAsState()
    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "← Back", onClick = { nav.popBackStack() })
        Spacer(Modifier.height(FS.space.s3))
        Text(
            "Your clouds",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "One phone, multiple clouds. Each profile is a separate cloud (personal, family, work) with its own root key.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        )
        Spacer(Modifier.height(FS.space.s4))

        if (profiles.isEmpty()) {
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Text(
                        "No profiles yet",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
                    )
                    Text(
                        "Set one up to bind this phone to a cloud.",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 14.sp),
                    )
                    FSPrimaryButton(label = "Set one up", onClick = {
                        // Drop to Welcome by signing the session out;
                        // OnboardingFlow takes over.
                        app.signOut()
                    })
                }
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                profiles.forEach { p ->
                    ProfileRow(p, isActive = p.cloudName == activeName) {
                        app.setActiveProfile(p.cloudName)
                    }
                }
            }
        }
    }
}

@Composable
private fun ProfileRow(profile: Profile, isActive: Boolean, onClick: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clickable { onClick() },
        ) {
            Column(modifier = Modifier.padding(end = FS.space.s3)) {
                Text(
                    profile.accountDisplayName ?: "@${profile.cloudName}",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                )
                if (profile.accountDisplayName != null) {
                    Text(
                        "@${profile.cloudName}",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp),
                    )
                }
                profile.deviceDisplayName?.let { deviceName ->
                    Text("This device: $deviceName", color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp))
                }
            }
            if (isActive) {
                Text(
                    "ACTIVE",
                    color = FS.colors.primary,
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
                )
            }
        }
    }
}
