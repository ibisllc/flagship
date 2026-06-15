// P7 — dedicated tier-status / subscription screen.
//
// Mirrors the canonical webapp `views/tier-status.js` + iOS
// FlagshipUI/Screens/TierStatusScreen.swift 1:1:
//
//   - tier badge (free / promo / BYOK pill)
//   - LLM credits (today + lifetime remaining)
//   - Dispatcher relay usage card with progress bar (usage vs free quota)
//   - Custom-domains list (else "none — your default subdomain is
//     forever-free")
//   - Reserved-names list (else "none — your username is FCFS-free")

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.TierStatusResponse
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.LoadingState
import com.flagshipserver.app.viewmodels.TierStatusViewModel
import java.text.NumberFormat
import java.util.Locale

@Composable
fun TierStatusScreen(@Suppress("UNUSED_PARAMETER") nav: NavController) {
    val client = LocalScreensClient.current
    val vm = remember { TierStatusViewModel(client) }
    val state by vm.state.collectAsState()

    LaunchedEffect(Unit) { vm.load() }

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        Text(
            "Tier & usage",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "Your subscription, LLM credits, dispatcher usage, custom domains, and reserved names.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp),
        )
        Spacer(Modifier.height(FS.space.s4))

        when (val s = state) {
            is LoadingState.Loaded -> Body(s.value)
            is LoadingState.Failed -> ErrorCard(s.message, onRetry = { vm.load() })
            else -> {
                ServerCardSkeleton()
                Spacer(Modifier.height(FS.space.s2))
                ServerCardSkeleton()
            }
        }
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun Body(t: TierStatusResponse) {
    TierBadgeCard(t)
    Spacer(Modifier.height(FS.space.s4))

    SectionHeader("LLM credits")
    Spacer(Modifier.height(FS.space.s2))
    LlmCard(t)

    Spacer(Modifier.height(FS.space.s4))
    SectionHeader("Dispatcher relay")
    Spacer(Modifier.height(FS.space.s2))
    DispatcherCard(t)

    Spacer(Modifier.height(FS.space.s4))
    SectionHeader("Custom domains")
    Spacer(Modifier.height(FS.space.s2))
    if (t.customDomains.isEmpty()) {
        PlaceholderCard("none — your default subdomain is forever-free")
    } else {
        t.customDomains.forEach { d ->
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Text(d, color = FS.colors.text, style = TextStyle(fontSize = 14.sp, fontFamily = FontFamily.Monospace))
            }
            Spacer(Modifier.height(FS.space.s2))
        }
    }

    Spacer(Modifier.height(FS.space.s4))
    SectionHeader("Reserved names")
    Spacer(Modifier.height(FS.space.s2))
    if (t.reservedNames.isEmpty()) {
        PlaceholderCard("none — your username is FCFS-free")
    } else {
        t.reservedNames.forEach { n ->
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Text(n, color = FS.colors.text, style = TextStyle(fontSize = 14.sp, fontFamily = FontFamily.Monospace))
            }
            Spacer(Modifier.height(FS.space.s2))
        }
    }
}

@Composable
private fun TierBadgeCard(t: TierStatusResponse) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .semantics { testTag = "tier-status-badge-row" },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Tier", color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp))
            Spacer(Modifier.weight(1f))
            FSPill(
                label = tierLabel(t.tier),
                kind = if (t.tier == "free") FSPillKind.Idle else FSPillKind.Online,
            )
        }
    }
}

@Composable
private fun LlmCard(t: TierStatusResponse) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            val day = t.llmCreditsRemainingDay
            if (day != null) {
                LabelValueRow("today remaining", grouped(day))
            } else {
                LabelValueRow("today", "— (BYOK or promo not in use)")
            }
            t.llmCreditsRemainingTotal?.let { total ->
                LabelValueRow("lifetime remaining", grouped(total))
            }
        }
    }
}

@Composable
private fun DispatcherCard(t: TierStatusResponse) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        val used = t.dispatcherUsageGBmonth
        if (used != null) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                LabelValueRow("this month", dispatcherValue(used, t.dispatcherFreeQuotaGBmonth))
                ProgressBar(percent = TierStatusViewModel.usagePercent(used, t.dispatcherFreeQuotaGBmonth))
            }
        } else {
            LabelValueRow("usage", "—")
        }
    }
}

@Composable
private fun ProgressBar(percent: Int) {
    val fraction = percent.coerceIn(0, 100) / 100f
    Box(
        Modifier
            .fillMaxWidth()
            .height(8.dp)
            .clip(RoundedCornerShape(50))
            .background(FS.colors.surfaceSunken)
            .semantics { testTag = "tier-status-dispatcher-progress" },
    ) {
        if (fraction > 0f) {
            Box(
                Modifier
                    .fillMaxWidth(fraction)
                    .height(8.dp)
                    .clip(RoundedCornerShape(50))
                    .background(FS.colors.primary),
            )
        }
    }
}

@Composable
private fun SectionHeader(title: String) {
    Text(title, color = FS.colors.text, style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold))
}

@Composable
private fun PlaceholderCard(text: String) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Text(text, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
    }
}

@Composable
private fun LabelValueRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp))
        Spacer(Modifier.weight(1f))
        Text(value, color = FS.colors.text, style = TextStyle(fontSize = 14.sp))
    }
}

private fun tierLabel(tier: String): String = when (tier) {
    "free"  -> "free"
    "promo" -> "promo"
    "byok"  -> "BYOK"
    else    -> tier
}

private fun dispatcherValue(used: Double, quota: Double?): String {
    val usedStr = String.format(Locale.US, "%.2f GB", used)
    return if (quota != null) {
        "$usedStr / ${String.format(Locale.US, "%.0f", quota)} GB free"
    } else {
        "$usedStr / —"
    }
}

private fun grouped(n: Long): String =
    NumberFormat.getIntegerInstance(Locale.US).format(n)
