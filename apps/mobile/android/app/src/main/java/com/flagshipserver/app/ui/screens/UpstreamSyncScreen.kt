// "Check for updates from <repo>" (N12): an optional branch, tag or commit, then the box's proposal
// (the version, what the merge takes and keeps, conflicts, and capability changes shown apart), then
// the existing deploy step for the build that holds it. Driven by [UpstreamSyncViewModel].

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.GppMaybe
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.navigation.NavController
import com.flagshipserver.app.R
import com.flagshipserver.app.api.BuildSyncResponse
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.LocalBuildClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.UpstreamSyncText
import com.flagshipserver.app.viewmodels.UpstreamSyncViewModel

object UpstreamSync {
    fun route(serviceId: String, repo: String): String = "app-sync/$serviceId?repo=${android.net.Uri.encode(repo)}"
    fun reviewRoute(buildId: String): String = "build/sync/$buildId"
}

@Composable
fun UpstreamSyncScreen(nav: NavController, serviceId: String, repo: String) {
    val client = LocalBuildClient.current
    val vm = remember(serviceId, client) { UpstreamSyncViewModel(serviceId, client) }
    val phase by vm.phase.collectAsState()
    var ref by rememberSaveable { mutableStateOf("") }
    // Leaving a proposal's build without deploying discards it, so it doesn't hold the app's name
    // (an up-to-date answer opened none).
    var handedOver by remember { mutableStateOf(false) }
    DisposableEffect(vm) { onDispose { if (!handedOver) vm.discard() } }

    FSScreen(title = FSStrings.get(R.string.sync_check_from, repo), onBack = { nav.popBackStack() }) {
        when (val p = phase) {
            is UpstreamSyncViewModel.Phase.Idle, is UpstreamSyncViewModel.Phase.Failed -> {
                FSField(
                    value = ref,
                    onValueChange = { ref = it },
                    label = stringResource(R.string.sync_ref_label),
                    modifier = Modifier.testTag("app-sync-ref"),
                )
                (p as? UpstreamSyncViewModel.Phase.Failed)?.let {
                    Text(it.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("app-sync-error"))
                }
                FSPrimaryButton(
                    stringResource(R.string.sync_check_button),
                    onClick = { vm.check(ref) },
                    block = true,
                    modifier = Modifier.testTag("app-sync-check"),
                )
            }
            is UpstreamSyncViewModel.Phase.Checking -> FSCard {
                Text(FSStrings.get(R.string.sync_checking, repo), modifier = Modifier.testTag("app-sync-checking"))
            }
            is UpstreamSyncViewModel.Phase.UpToDate -> {
                FSCard {
                    Text(FSStrings.get(R.string.sync_up_to_date, repo), modifier = Modifier.testTag("app-sync-up-to-date"))
                }
                FSSecondaryButton(stringResource(R.string.close), onClick = { nav.popBackStack() }, block = true, modifier = Modifier.testTag("app-sync-close"))
            }
            is UpstreamSyncViewModel.Phase.Proposal -> ProposalView(
                repo = repo,
                r = p.result,
                onReview = {
                    handedOver = true
                    nav.navigate(UpstreamSync.reviewRoute(p.buildId)) { popUpTo("app-sync/{serviceId}?repo={repo}") { inclusive = true } }
                },
                onDiscard = {
                    vm.discard()
                    handedOver = true
                    nav.popBackStack()
                },
            )
        }
    }
}

@Composable
private fun ProposalView(repo: String, r: BuildSyncResponse, onReview: () -> Unit, onDiscard: () -> Unit) {
    val p = r.proposal
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3), modifier = Modifier.testTag("app-sync-proposal")) {
        FSCard {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(FSStrings.get(R.string.sync_title, repo), style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("app-sync-title"))
                UpstreamSyncText.version(r.candidateCommit)?.let {
                    Text(it, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), modifier = Modifier.testTag("app-sync-version"))
                }
                UpstreamSyncText.counts(r).forEach {
                    Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("app-sync-count"))
                }
            }
        }
        if (p.capabilityChanges.isNotEmpty()) {
            FSCard(modifier = Modifier.testTag("app-sync-permissions")) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        Icon(Icons.Outlined.GppMaybe, contentDescription = null, tint = FS.colors.warning)
                        Text(stringResource(R.string.sync_permissions_title), color = FS.colors.warning, style = MaterialTheme.typography.titleSmall)
                    }
                    Text(stringResource(R.string.sync_permissions_body), style = MaterialTheme.typography.bodyMedium)
                    p.capabilityChanges.forEach { c ->
                        Text(UpstreamSyncText.section(c.section), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("app-sync-capability"))
                        UpstreamSyncText.changeLines(c).forEach {
                            Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
                        }
                    }
                }
            }
        }
        if (p.conflicts.isNotEmpty()) {
            FSCard(modifier = Modifier.testTag("app-sync-conflicts")) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                    Text(UpstreamSyncText.conflictsHeading(p.conflicts.size), style = MaterialTheme.typography.titleSmall, modifier = Modifier.testTag("app-sync-conflicts-title"))
                    p.conflicts.forEach { Text(it, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)) }
                    Text(stringResource(R.string.sync_conflicts_note), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        Text(stringResource(R.string.sync_nothing_live), color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium)
        FSPrimaryButton(stringResource(R.string.sync_review_deploy), onClick = onReview, block = true, modifier = Modifier.testTag("app-sync-review"))
        FSSecondaryButton(stringResource(R.string.sync_discard), onClick = onDiscard, block = true, modifier = Modifier.testTag("app-sync-discard"))
    }
}
