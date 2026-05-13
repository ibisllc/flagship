package com.flagship.ui.screens

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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagship.ui.components.FSCard
import com.flagship.ui.components.FSField
import com.flagship.ui.components.FSGhostButton
import com.flagship.ui.components.FSPill
import com.flagship.ui.components.FSPillKind
import com.flagship.ui.components.FSPrimaryButton
import com.flagship.ui.theme.FS

/**
 * Marketplace list — paged list of public apps. Tap a card to open
 * MarketplaceDetailScreen which has the install flow.
 */
@Composable
fun MarketplaceListScreen(nav: NavController) {
    var query by remember { mutableStateOf("") }
    val listings by remember { mutableStateOf(sampleListings()) }

    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = FS.space.s6),
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
        FSField(
            value = query,
            onValueChange = { query = it },
            label = "",
            placeholder = "Search apps",
        )

        Spacer(Modifier.height(FS.space.s4))
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            listings.filter { it.matches(query) }.forEach { l ->
                ListingRow(l, onClick = { nav.navigate("marketplace/${l.creator}/${l.slug}") })
            }
        }
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun ListingRow(l: ListingSummary, onClick: () -> Unit) {
    FSCard(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        padding = PaddingValues(FS.space.s4),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.fillMaxWidth().padding(end = FS.space.s2)) {
                Text(text = l.name, color = FS.colors.text, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold))
                Spacer(Modifier.height(FS.space.s1))
                Text(text = l.tagline, color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
                Spacer(Modifier.height(FS.space.s2))
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    FSPill(label = l.category, kind = FSPillKind.Idle)
                    if (l.installCount > 0) {
                        FSPill(label = "${l.installCount} installs", kind = FSPillKind.Online)
                    }
                    if (l.scanGrade != null) {
                        FSPill(label = "Scan: ${l.scanGrade}", kind = FSPillKind.Provisioning)
                    }
                }
            }
        }
    }
}

/**
 * Marketplace detail — the install destination. Visitor picks a box
 * to install on; the phone signs the install order and ships it.
 */
@Composable
fun MarketplaceDetailScreen(nav: NavController, creator: String, slug: String) {
    val listing = remember { sampleDetail(creator, slug) }
    val pods = remember { samplePodsForInstall() }
    var selectedPod by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s10))
        Text(
            text = listing.name,
            color = FS.colors.text,
            style = TextStyle(fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            text = "by ${listing.creator}",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
        )

        Spacer(Modifier.height(FS.space.s6))
        FSCard(padding = PaddingValues(FS.space.s5)) {
            Text(text = listing.description, color = FS.colors.text, style = TextStyle(fontSize = 15.sp, lineHeight = 22.sp))
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
                            Text(text = pod.label, color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
                            Text(text = pod.fqdn, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
                        }
                        if (selectedPod == pod.podId) FSPill(label = "Selected", kind = FSPillKind.Online)
                    }
                }
            }
        }

        Spacer(Modifier.height(FS.space.s8))
        FSPrimaryButton(
            label = "Install",
            onClick = {
                // TODO: phone signs InstallAppRequest + ships to .com /api/marketplace/<creator>/<slug>/install
            },
            block = true,
            enabled = selectedPod != null,
        )
        Spacer(Modifier.height(FS.space.s3))
        FSGhostButton(
            label = "View source",
            onClick = { /* TODO: open canonical repo */ },
            block = true,
        )
    }
}

private fun sampleListings(): List<ListingSummary> = emptyList()
private fun sampleDetail(creator: String, slug: String) = ListingDetail(
    name = slug.replaceFirstChar { it.uppercase() },
    creator = creator,
    slug = slug,
    description = "An app from the marketplace. The phone will sign the install order and ship it to the box you pick.",
)
private fun samplePodsForInstall() = listOf(
    PodSummary("home", "Home box", "home.alice.flagship.services"),
    PodSummary("office", "Office box", "office.alice.flagship.services"),
)

data class ListingSummary(
    val creator: String,
    val slug: String,
    val name: String,
    val tagline: String,
    val category: String,
    val installCount: Int,
    val scanGrade: String?,
) {
    fun matches(q: String): Boolean {
        if (q.isBlank()) return true
        val lower = q.lowercase()
        return name.lowercase().contains(lower) ||
            tagline.lowercase().contains(lower) ||
            category.lowercase().contains(lower)
    }
}

data class ListingDetail(
    val name: String,
    val creator: String,
    val slug: String,
    val description: String,
)
