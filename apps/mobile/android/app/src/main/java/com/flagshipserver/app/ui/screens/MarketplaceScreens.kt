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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.collectAsState
import androidx.navigation.NavController
import com.flagshipserver.app.api.DeviceScope
import com.flagshipserver.app.api.MarketplaceListing
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.LoadingState
import com.flagshipserver.app.viewmodels.MarketplaceViewModel
import kotlinx.coroutines.launch

/**
 * Marketplace list — the catalog of public apps, loaded from the pod's BFF.
 * Tap a card to open MarketplaceDetailScreen which has the install flow.
 * Mirror of iOS MarketplaceContainer.
 */
@Composable
fun MarketplaceListScreen(nav: NavController) {
    val client = LocalScreensClient.current
    val app = LocalAppState.current
    val scope = rememberCoroutineScope()
    val pods by app.pods.collectAsState()
    val vm = remember { MarketplaceViewModel(client) }
    val state by vm.state.collectAsState()
    val query by vm.searchQuery.collectAsState()

    // The marketplace runs services on your own box, so there's nothing to
    // install onto until a server exists; load only once paired.
    LaunchedEffect(pods.isNotEmpty()) {
        if (pods.isNotEmpty() && state is LoadingState.Idle) vm.load()
    }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s10))
        Text(
            text = "Marketplace",
            color = FS.colors.text,
            style = TextStyle(fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            text = "Apps your neighbours built. One tap to install on any of your boxes.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
        )

        Spacer(Modifier.height(FS.space.s4))

        if (pods.isEmpty()) {
            // Browsable-before-you-own-a-server is a future capability; until a
            // central catalog ships, guide the user to add a box first.
            FSCard(padding = PaddingValues(FS.space.s5)) {
                Text(
                    text = "Add a server first. Marketplace apps run on your own box.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
                )
            }
            Spacer(Modifier.height(FS.space.s12))
            return@Column
        }

        FSField(
            value = query,
            onValueChange = { vm.setSearchQuery(it) },
            label = "",
            placeholder = "Search apps",
        )

        Spacer(Modifier.height(FS.space.s4))
        when (val s = state) {
            is LoadingState.Failed -> ErrorCard(s.message, onRetry = { scope.launch { vm.load() } })
            is LoadingState.Loaded -> {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    vm.filtered.forEach { l ->
                        ListingRow(l, onClick = { nav.navigate("marketplace-detail/${l.creator}/${l.slug}") })
                    }
                }
            }
            else -> {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    ServerCardSkeleton(); ServerCardSkeleton(); ServerCardSkeleton()
                }
            }
        }
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun ListingRow(l: MarketplaceListing, onClick: () -> Unit) {
    FSCard(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        padding = PaddingValues(FS.space.s4),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.fillMaxWidth().padding(end = FS.space.s2)) {
                Text(text = l.title, color = FS.colors.text, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold))
                Spacer(Modifier.height(FS.space.s1))
                Text(text = "by ${l.creator}", color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
                Spacer(Modifier.height(FS.space.s1))
                Text(text = l.summary, color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
                Spacer(Modifier.height(FS.space.s2))
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    FSPill(label = "${l.installCount} deploys", kind = if (l.installCount > 0) FSPillKind.Online else FSPillKind.Idle)
                    if (l.requiresLlmKey) FSPill(label = "Needs LLM key", kind = FSPillKind.Provisioning)
                    if (l.alreadyInstalled) FSPill(label = "Deployed", kind = FSPillKind.Idle)
                }
            }
        }
    }
}

/**
 * Marketplace detail — the install destination. The owner picks one of their
 * REAL boxes; the phone signs the install order with the owner IRK and POSTs
 * it straight to that box. Mirror of iOS MarketplaceDetailContainer.
 */
@Composable
fun MarketplaceDetailScreen(nav: NavController, creator: String, slug: String) {
    val client = LocalScreensClient.current
    val app = LocalAppState.current
    val scope = rememberCoroutineScope()
    val vm = remember { MarketplaceViewModel(client) }
    val pods by app.pods.collectAsState()
    val installState by vm.installState.collectAsState()

    // Resolve the listing's display fields from the catalog (browse returns
    // metadata; the manifest is fetched lazily inside install()).
    var listing by remember { mutableStateOf<MarketplaceListing?>(null) }
    LaunchedEffect(creator, slug) {
        listing = vm.let {
            it.load()
            (it.state.value as? LoadingState.Loaded)?.value?.firstOrNull { l -> l.creator == creator && l.slug == slug }
        }
    }

    var selectedPod by remember { mutableStateOf<String?>(null) }
    // v2 device-addressing — a restricted sub-identity without `install-service`
    // can't install; the CTA is disabled with an explanation. A null capability
    // (legacy single-IRK) implicitly holds every scope.
    val cap = app.deviceCapability.collectAsState().value
    val canInstall = cap == null || DeviceScope.INSTALL_SERVICE in cap.scopeSet

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s10))
        Text(
            text = listing?.title ?: slug.replaceFirstChar { it.uppercase() },
            color = FS.colors.text,
            style = TextStyle(fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            text = "by $creator",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
        )

        Spacer(Modifier.height(FS.space.s6))
        FSCard(padding = PaddingValues(FS.space.s5)) {
            Text(
                text = listing?.summary ?: "An app from the marketplace. The phone will sign the install order and ship it to the box you pick.",
                color = FS.colors.text,
                style = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
            )
        }
        listing?.let { l ->
            if (l.requiresLlmKey) {
                Spacer(Modifier.height(FS.space.s2))
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    FSPill(label = "${l.installCount} deploys", kind = FSPillKind.Online)
                    FSPill(label = "Needs LLM key", kind = FSPillKind.Provisioning)
                }
            }
        }

        Spacer(Modifier.height(FS.space.s8))
        Text(
            text = "INSTALL ON",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
            modifier = Modifier.padding(bottom = FS.space.s3),
        )
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            pods.forEach { pod ->
                FSCard(
                    modifier = Modifier.fillMaxWidth().clickable { selectedPod = pod.podId },
                    padding = PaddingValues(FS.space.s4),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(modifier = Modifier.fillMaxWidth().padding(end = FS.space.s2)) {
                            Text(text = pod.name, color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
                            Text(text = pod.fqdn, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
                        }
                        if (selectedPod == pod.podId) FSPill(label = "Selected", kind = FSPillKind.Online)
                    }
                }
            }
        }

        Spacer(Modifier.height(FS.space.s8))
        if (!canInstall) {
            Text(
                text = "This device cannot install services. Use a primary device.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                modifier = Modifier.padding(bottom = FS.space.s2),
            )
        }

        when (val st = installState) {
            is MarketplaceViewModel.InstallState.Succeeded -> {
                FSCard(padding = PaddingValues(FS.space.s4)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = "Installed as ${st.serviceId}.",
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                        )
                    }
                }
            }
            is MarketplaceViewModel.InstallState.Failed -> {
                ErrorCard("Install failed: ${st.message}", onRetry = { vm.resetInstall() })
            }
            else -> {
                val installing = st is MarketplaceViewModel.InstallState.Installing
                val selectedFqdn = pods.firstOrNull { it.podId == selectedPod }?.fqdn
                FSPrimaryButton(
                    label = if (installing) "Installing…" else "Install",
                    onClick = {
                        val fqdn = selectedFqdn ?: return@FSPrimaryButton
                        scope.launch { vm.install(creator = creator, slug = slug, serverId = fqdn) }
                    },
                    block = true,
                    enabled = selectedPod != null && canInstall && !installing,
                )
            }
        }
        Spacer(Modifier.height(FS.space.s3))
        FSGhostButton(
            label = "View source",
            // Marketplace listings don't carry a repo URL in the browse/detail
            // wire shape today; leave this as a no-op until the catalog exposes
            // one (matches the iOS "View source" stub).
            onClick = { },
            block = true,
        )
        Spacer(Modifier.height(FS.space.s12))
    }
}
