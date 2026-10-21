// W3 — list of clouds (profiles) this phone is a member of. Tapping
// a row switches the active profile; the rest of the UI re-renders
// against the new cloud's session state.
//
// Phase F demo case is one profile per phone, so the typical user
// sees a single row. Multi-profile is the v2 capability that lets
// corporate / family setups co-exist on one phone.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.navigation.NavController
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.Profile
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.theme.FS

@Composable
fun ProfilesScreen(nav: NavController) {
    val app = LocalAppState.current
    val profiles by app.profiles.collectAsState()
    val activeName by app.activeCloudName.collectAsState()
    FSScreen(
        title = stringResource(R.string.profiles),
        onBack = { nav.popBackStack() },
        subtitle = stringResource(R.string.switch_the_cloud_this_phone_is),
    ) {
        if (profiles.isEmpty()) {
            FSEmptyState(
                title = stringResource(R.string.no_profiles_yet),
                message = stringResource(R.string.set_one_up_to_bind_this),
                icon = Icons.Outlined.Cloud,
                action = {
                    FSPrimaryButton(label = stringResource(R.string.set_one_up), block = true, onClick = {
                        // Drop to Welcome by signing the session out;
                        // OnboardingFlow takes over.
                        app.signOut()
                    })
                },
            )
        } else {
            FSGroup {
                profiles.forEachIndexed { idx, p ->
                    ProfileRow(p, isActive = p.cloudName == activeName) {
                        app.setActiveProfile(p.cloudName)
                    }
                    if (idx < profiles.size - 1) FSDivider()
                }
            }
        }
    }
}

@Composable
private fun ProfileRow(profile: Profile, isActive: Boolean, onClick: () -> Unit) {
    val lines = buildList {
        if (profile.accountDisplayName != null) add("@${profile.cloudName}")
        profile.deviceDisplayName?.let { add(fsString(R.string.this_device_2, it)) }
    }
    FSRow(
        title = profile.accountDisplayName ?: "@${profile.cloudName}",
        subtitle = lines.joinToString("\n").ifEmpty { null },
        icon = Icons.Outlined.Cloud,
        iconTint = if (isActive) FS.colors.primary else null,
        onClick = onClick,
        trailing = if (isActive) ({ FSPill(stringResource(R.string.active_2), FSPillKind.Provisioning) }) else null,
    )
}
