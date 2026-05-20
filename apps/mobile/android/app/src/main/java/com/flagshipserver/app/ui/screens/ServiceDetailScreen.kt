package com.flagshipserver.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.lifecycle.viewmodel.initializer
import androidx.navigation.NavController
import com.flagshipserver.app.api.AppLinksResponse
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.CustomDomainCooldownStore
import com.flagshipserver.app.viewmodels.CustomDomainPrompt
import com.flagshipserver.app.viewmodels.RenameServicePhase
import com.flagshipserver.app.viewmodels.RenameServiceViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Service detail — the canonical surface for the FINAL DESIGN UX:
 *
 *   Where should it run?
 *     ☑ home box
 *     ☑ office box
 *     ☐ garage box
 *     ☐ run on all current and future boxes
 *
 *   Let instances talk to each other?
 *     ● Yes  ○ No
 *
 *   [ Save ]
 *
 * Plus a URL section listing each FQDN's kind / owner / claim controls.
 *
 * Toggling "let them talk" on a previously-deployed multi-pod service
 * triggers a vibe-code-session re-open with the existing files
 * preloaded plus the N0k system-prompt chapter — that is NOT a
 * runtime config change; it's a regenerate workflow.
 */
@Composable
fun ServiceDetailScreen(nav: NavController, serviceId: String) {
    val app = remember { sampleApp(serviceId) }
    val pods = remember { samplePods() }
    val urls = remember { sampleUrls() }
    var policy by remember { mutableStateOf(app.policy) }
    var siblingsEnabled by remember { mutableStateOf(app.siblingsEnabled) }
    // V3 — Replace ceremony VM. Stored in the composition so the
    // phase StateFlow survives recompositions of the WEB DOMAINS
    // section.
    val appState = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val ctx = LocalContext.current
    val renameVm: RenameServiceViewModel = viewModel(
        factory = viewModelFactory {
            initializer {
                RenameServiceViewModel(
                    server = server,
                    serviceId = serviceId,
                    username = { appState.currentUser.value },
                    cooldownStore = CustomDomainCooldownStore.fromContext(ctx),
                )
            }
        },
    )
    var showReplaceDialog by remember { mutableStateOf(false) }
    var replaceDraft by remember { mutableStateOf("") }
    val phase by renameVm.phase.collectAsState()
    val appLinks by renameVm.links.collectAsState()
    val scope = rememberCoroutineScope()

    LaunchedEffect(serviceId) { renameVm.loadLinks() }

    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s10))
        Text(
            text = app.name,
            color = FS.colors.text,
            style = TextStyle(fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            text = "by ${app.creator}",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
        )
        // `id:` is the IMMUTABLE composite package id (`<creator>-<slug>`,
        // single dash). It never changes — Replace only rotates the
        // user-facing URL stem, not this. `ver:` rides on the same line
        // with a middle-dot separator (design-system convention).
        Text(
            text = buildString {
                app.version?.let { append("ver: ").append(it).append("  ·  ") }
                append("id: ").append(app.serviceId)
            },
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
            modifier = Modifier.padding(top = FS.space.s1),
        )

        Spacer(Modifier.height(FS.space.s8))

        // ── Where should it run?
        SectionHeader("Where should it run?")
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                pods.forEach { pod ->
                    val checked = policy.specificPods.contains(pod.podId)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = checked || policy.allCurrentAndFuture,
                            enabled = !policy.allCurrentAndFuture,
                            onCheckedChange = { on ->
                                policy = policy.copy(
                                    specificPods = if (on) policy.specificPods + pod.podId
                                    else policy.specificPods - pod.podId,
                                )
                            },
                        )
                        Spacer(Modifier.padding(start = FS.space.s2))
                        Column {
                            Text(text = pod.label, color = FS.colors.text, style = TextStyle(fontSize = 16.sp))
                            Text(
                                text = pod.fqdn,
                                color = FS.colors.textMuted,
                                style = TextStyle(fontSize = 13.sp),
                            )
                        }
                    }
                }
                Spacer(Modifier.height(FS.space.s2))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(
                        checked = policy.allCurrentAndFuture,
                        onCheckedChange = { policy = policy.copy(allCurrentAndFuture = it) },
                    )
                    Spacer(Modifier.padding(start = FS.space.s2))
                    Text(
                        text = "Run on all current and future boxes",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 16.sp),
                    )
                }
            }
        }

        Spacer(Modifier.height(FS.space.s6))

        // ── Let instances talk?
        SectionHeader("Let instances talk to each other?")
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                RadioButton(
                    selected = siblingsEnabled,
                    onClick = { siblingsEnabled = true },
                )
                Spacer(Modifier.padding(start = FS.space.s2))
                Text(text = "Yes", color = FS.colors.text, style = TextStyle(fontSize = 16.sp))
                Spacer(Modifier.padding(start = FS.space.s6))
                RadioButton(
                    selected = !siblingsEnabled,
                    onClick = { siblingsEnabled = false },
                )
                Spacer(Modifier.padding(start = FS.space.s2))
                Text(text = "No", color = FS.colors.text, style = TextStyle(fontSize = 16.sp))
            }
            if (app.siblingsEnabled != siblingsEnabled) {
                Spacer(Modifier.height(FS.space.s2))
                Text(
                    text = if (siblingsEnabled)
                        "Saving will re-open vibe-code with this app's files. The AI will rewrite it to be sibling-aware."
                    else
                        "Saving will re-open vibe-code. The AI will rewrite it as per-pod independent state.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                )
            }
        }

        Spacer(Modifier.height(FS.space.s6))

        // ── V3 — WEB DOMAINS section (shared space; replaces tabs).
        // V6 — the INDIVIDUAL INSTANCES list reflects the pods the user
        // has ticked in "Where should it run?" above, not .com's view.
        val selectedPods = pods.filter {
            policy.allCurrentAndFuture || policy.specificPods.contains(it.podId)
        }
        WebDomainsSection(
            fallbackLabel = app.name.lowercase().replace(" ", "-"),
            links = appLinks,
            selectedPods = selectedPods,
            onReplaceTap = {
                replaceDraft = appLinks?.displayLabel ?: app.name.lowercase().replace(" ", "-")
                showReplaceDialog = true
            },
        )

        Spacer(Modifier.height(FS.space.s3))
        SetCustomDomainSection(
            rootDomain = "${appState.currentUser.value ?: "you"}.flagship.services",
            cooldownUntilMs = renameVm.customDomainCooldownUntilMs.collectAsState().value,
            onSubmit = { draft -> scope.launch { renameVm.submitCustomDomain(draft) } },
        )

        val cdPrompt by renameVm.customDomainPrompt.collectAsState()
        cdPrompt?.let { p ->
            CustomDomainPromptDialog(
                prompt = p,
                onConfirm = {
                    scope.launch {
                        renameVm.dismissCustomDomainPrompt()
                        p.onConfirm?.invoke()
                    }
                },
                onDismiss = { renameVm.dismissCustomDomainPrompt() },
            )
        }

        if (showReplaceDialog) {
            ReplaceStemDialog(
                draft = replaceDraft,
                currentStem = appLinks?.displayLabel ?: app.name.lowercase().replace(" ", "-"),
                onDraftChange = { replaceDraft = it },
                phase = phase,
                onCancel = { showReplaceDialog = false },
                onConfirm = {
                    scope.launch {
                        val ok = renameVm.rename(replaceDraft)
                        if (ok) showReplaceDialog = false
                    }
                },
            )
        }

        Spacer(Modifier.height(FS.space.s8))
        FSPrimaryButton(
            label = "Save",
            onClick = { /* TODO: persist policy + (re-open vibe-code if siblings toggled) */ },
            block = true,
        )
        Spacer(Modifier.height(FS.space.s4))
        FSGhostButton(
            label = "Uninstall",
            onClick = { /* TODO */ },
            block = true,
        )
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun SectionHeader(label: String) {
    Text(
        text = label,
        color = FS.colors.text,
        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
        modifier = Modifier.padding(bottom = FS.space.s3),
    )
}

@Composable
private fun UrlRow(url: UrlEntry) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.fillMaxWidth().padding(end = FS.space.s2)) {
                Text(text = url.fqdn, color = FS.colors.text, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold))
                Spacer(Modifier.height(FS.space.s1))
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    FSPill(label = url.kind, kind = FSPillKind.Idle)
                    FSPill(
                        label = when (url.ownedBy) {
                            "self" -> "On this pod"
                            null -> "Unclaimed"
                            else -> "On ${url.ownedBy}"
                        },
                        kind = if (url.ownedBy == "self") FSPillKind.Online else FSPillKind.Idle,
                    )
                }
            }
            if (url.canClaim && url.ownedBy != "self") {
                FSGhostButton(label = "Claim", onClick = { /* TODO: POST /api/url/claim */ })
            } else if (url.ownedBy == "self" && url.kind != "canonical") {
                FSGhostButton(label = "Release", onClick = { /* TODO: POST /api/url/release */ })
            }
        }
    }
}

private fun sampleApp(serviceId: String) = AppDetail(
    serviceId = serviceId,
    name = "Notes",
    creator = "alice",
    version = "0.1.0",
    siblingsEnabled = false,
    policy = InstallPolicy(specificPods = setOf("home"), allCurrentAndFuture = false),
)

private fun samplePods() = listOf(
    PodSummary("home", "Home box", "home.alice.flagship.services"),
    PodSummary("office", "Office box", "office.alice.flagship.services"),
    PodSummary("garage", "Garage box", "garage.alice.flagship.services"),
)

private fun sampleUrls() = listOf(
    UrlEntry("notes.home.alice.flagship.services", "canonical", "self", canClaim = false),
    UrlEntry("notes.alice.flagship.services", "alias", null, canClaim = true),
)

// ---------------------------------------------------------------
// V3 — WEB DOMAINS section + Replace stem dialog
// ---------------------------------------------------------------

/** Three labelled groups: short redirect (top, bold), canonical
 *  (shared by all instances), and individual instances. A Replace
 *  button floats top-right of the section header. */
@Composable
private fun WebDomainsSection(
    fallbackLabel: String,
    links: AppLinksResponse?,
    selectedPods: List<PodSummary>,
    onReplaceTap: () -> Unit,
) {
    val stem = links?.displayLabel ?: fallbackLabel
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = "WEB DOMAINS",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
            modifier = Modifier.weight(1f),
        )
        FSDangerButton(
            label = "Replace",
            onClick = onReplaceTap,
            block = false,
        )
    }
    Spacer(Modifier.height(FS.space.s3))
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            // CUSTOM DOMAIN sits at the very top, only when one is
            // bound — it's the user's own name. Shown as soon as the
            // order is recorded (even pending); the apps-list short→
            // custom swap is what waits for .com to confirm. Mirrors
            // iOS AppDetailScreen.customDomainGroup.
            val cd = links?.customDomain
            if (!cd.isNullOrEmpty()) {
                UrlGroupLabel("CUSTOM DOMAIN")
                UrlRowProminent(url = "https://$cd")
                HorizontalRule()
            }
            UrlGroupLabel("SHORT REDIRECT")
            val short = links?.shortUrl
            if (!short.isNullOrEmpty()) {
                UrlRowProminent(url = short)
            } else {
                Text(
                    text = "No short link yet. Tap Replace to mint one.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
            }
            HorizontalRule()

            UrlGroupLabel("CANONICAL (SHARED BY ALL INSTANCES)")
            UrlRowNormal(url = links?.canonicalUrl ?: "https://$stem.flagship.services")

            if (selectedPods.isNotEmpty()) {
                HorizontalRule()
                UrlGroupLabel("INDIVIDUAL INSTANCES")
                selectedPods.forEach { pod ->
                    UrlRowMuted(url = "https://$stem.${pod.fqdn}")
                }
            }
        }
    }
}

/** #80 — SET CUSTOM DOMAIN. Mock-faithful with the iOS client:
 *  section label + right-floated M:SS countdown while cooling, input
 *  + Add (disabled during the 300s on-device cooldown), and the CNAME
 *  guidance line — all byte-identical to AppDetailScreen.swift. The
 *  decoupled request / apex→www / destructive-replace logic lives in
 *  the VM (submitCustomDomain); this is presentation only. */
@Composable
private fun SetCustomDomainSection(
    rootDomain: String,
    cooldownUntilMs: Long?,
    onSubmit: (String) -> Unit,
) {
    var draft by remember { mutableStateOf("") }
    // Tick every second so the countdown + disabled state stay live
    // (mirrors the iOS TimelineView(.periodic, by: 1)).
    var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(cooldownUntilMs) {
        while (cooldownUntilMs != null && cooldownUntilMs > System.currentTimeMillis()) {
            nowMs = System.currentTimeMillis()
            delay(1000)
        }
        nowMs = System.currentTimeMillis()
    }
    val remainingMs = (cooldownUntilMs ?: 0L) - nowMs
    val cooling = remainingMs > 0
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                UrlGroupLabel("SET CUSTOM DOMAIN")
                Spacer(Modifier.weight(1f))
                if (cooling) {
                    Text(
                        text = cooldownLabel(remainingMs),
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
                    )
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    singleLine = true,
                    label = { Text("www.mydomain.com") },
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.padding(start = FS.space.s2))
                FSGhostButton(
                    label = "Add",
                    enabled = !cooling,
                    onClick = {
                        val v = draft
                        draft = ""
                        onSubmit(v)
                    },
                )
            }
            Text(
                text = "Prior to claiming a FQDN, you must set a CNAME record targeting $rootDomain.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 11.sp),
            )
        }
    }
}

/** M:SS — ceil seconds, matching the iOS cooldownLabel + the webapp. */
private fun cooldownLabel(remainingMs: Long): String {
    val s = ((remainingMs + 999) / 1000).coerceAtLeast(0)
    return "%d:%02d".format(s / 60, s % 60)
}

/** One-at-a-time alert mirroring the iOS .alert(presenting:). A
 *  confirm+Cancel when [CustomDomainPrompt.confirmLabel] is set, else
 *  an informational single-dismiss alert. */
@Composable
private fun CustomDomainPromptDialog(
    prompt: CustomDomainPrompt,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(prompt.title) },
        text = {
            Text(
                text = prompt.message,
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
        },
        confirmButton = {
            if (prompt.confirmLabel != null) {
                TextButton(onClick = onConfirm) {
                    Text(
                        prompt.confirmLabel,
                        color = if (prompt.destructive) FS.colors.danger else FS.colors.text,
                    )
                }
            } else {
                TextButton(onClick = onDismiss) { Text("OK") }
            }
        },
        dismissButton = {
            if (prompt.confirmLabel != null) {
                TextButton(onClick = onDismiss) { Text("Cancel") }
            }
        },
    )
}

@Composable
private fun UrlGroupLabel(label: String) {
    Text(
        text = label,
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
    )
}

@Composable
private fun HorizontalRule() {
    Box(
        modifier = Modifier.fillMaxWidth()
            .height(1.dp)
            .padding(vertical = 0.dp),
    ) {
        Text("", color = FS.colors.border)
    }
}

@Composable
private fun UrlRowProminent(url: String) {
    val ctx = LocalContext.current
    Row(verticalAlignment = Alignment.Top) {
        Text(
            text = wrapAtDots(stripScheme(url)),
            color = FS.colors.text,
            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
            modifier = Modifier.weight(1f),
        )
        FSGhostButton(label = "Copy", onClick = { copyToClipboard(ctx, url) })
    }
}

@Composable
private fun UrlRowNormal(url: String) {
    val ctx = LocalContext.current
    Row(verticalAlignment = Alignment.Top) {
        Text(
            text = wrapAtDots(stripScheme(url)),
            color = FS.colors.text,
            style = TextStyle(fontSize = 14.sp),
            modifier = Modifier.weight(1f),
        )
        FSGhostButton(label = "Copy", onClick = { copyToClipboard(ctx, url) })
    }
}

@Composable
private fun UrlRowMuted(url: String) {
    Text(
        text = wrapAtDots(stripScheme(url)),
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 13.sp),
        modifier = Modifier.padding(start = FS.space.s2),
    )
}

// Insert a zero-width space after each dot so an FQDN wraps between
// segments instead of mid-label. The clipboard path uses the raw url
// (no ZWSP) so a paste is still clean — mirrors iOS wrapAtDots.
private fun wrapAtDots(s: String): String = s.replace(".", ".\u200B")

// Mirrors the Worker's DNS_LABEL_RE in appRename.ts. Keep in sync —
// drift means the button enables for stems the server then rejects.
private val STEM_RE = Regex("^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$")

@Composable
private fun ReplaceStemDialog(
    draft: String,
    currentStem: String,
    onDraftChange: (String) -> Unit,
    phase: RenameServicePhase,
    onCancel: () -> Unit,
    onConfirm: () -> Unit,
) {
    val busy = phase is RenameServicePhase.Signing || phase is RenameServicePhase.Posting
    val trimmed = draft.trim()
    val stemValid = STEM_RE.matches(trimmed) && trimmed != currentStem
    AlertDialog(
        onDismissRequest = { if (!busy) onCancel() },
        title = { Text("Replace access URLs") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    text = "This will update all the links to this service, replacing " +
                        "“$currentStem” with a new stem. All existing links break " +
                        "immediately, including the short link. If you have attached " +
                        "external domains, those stay unaffected.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
                OutlinedTextField(
                    value = draft,
                    onValueChange = onDraftChange,
                    singleLine = true,
                    label = { Text("New stem") },
                )
                Text(
                    text = "Lowercase letters, digits, or hyphens. 1–40 chars. No leading or trailing hyphen.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 11.sp),
                )
                (phase as? RenameServicePhase.Failed)?.let { f ->
                    Text(f.message, color = FS.colors.danger, style = TextStyle(fontSize = 12.sp))
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                enabled = !busy && stemValid,
            ) {
                Text(
                    when (phase) {
                        is RenameServicePhase.Signing -> "Signing…"
                        is RenameServicePhase.Posting -> "Replacing…"
                        else -> "Replace"
                    },
                    color = FS.colors.danger,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = { if (!busy) onCancel() }) { Text("Cancel") }
        },
    )
}

private fun stripScheme(s: String): String =
    s.removePrefix("https://").removePrefix("http://")

private fun copyToClipboard(context: Context, text: String) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    cm?.setPrimaryClip(ClipData.newPlainText("flagship", text))
}

data class AppDetail(
    val serviceId: String,
    val name: String,
    val creator: String,
    val version: String?,
    val siblingsEnabled: Boolean,
    val policy: InstallPolicy,
)

data class InstallPolicy(
    val specificPods: Set<String>,
    val allCurrentAndFuture: Boolean,
)

data class PodSummary(val podId: String, val label: String, val fqdn: String)

data class UrlEntry(
    val fqdn: String,
    val kind: String,
    val ownedBy: String?,
    val canClaim: Boolean,
)
