// Kotlin/Compose mirror of FlagshipUI/Components/GlobalTrustBar.swift.
//
// The persistent alarming-RED trust sliver — a higher, non-dismissible variant
// of GlobalOperationsBar. It shows ONE line per failing CA cert ("Control
// server certificate expired · <slug>" / "Relay certificate expired · <slug>"),
// slugged by cert-hash. While the control server is untrusted it stays pinned —
// even after the owner overrides (the override un-halts backend traffic; the
// red line PERSISTS). Hidden under the biometric lock. Tapping a line opens the
// deliberate, biometric-gated OVERRIDE confirmation. It is intentionally NOT
// swipe-dismissible — it only leaves when the blessing verifies again.

package com.flagshipserver.app.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.spring
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.LiveTrustExceptionClient
import com.flagshipserver.app.api.TrustExceptionSignature
import com.flagshipserver.app.api.TrustExceptionWire
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.LocalTrustCenter
import com.flagshipserver.app.core.TrustException
import com.flagshipserver.app.core.TrustFailure
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

/**
 * The red trust sliver. Reads [LocalTrustCenter] for the failing certs +
 * [LocalAppState] for the biometric-lock gate. The whole bar animates in/out
 * vertically (a spring slide-down/up) and — because it sits above the rest of
 * the shell in a Column — pushes everything down.
 */
@Composable
fun GlobalTrustBar() {
    val trust = LocalTrustCenter.current
    val app = LocalAppState.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    val currentUser by app.currentUser.collectAsState()
    // Best-effort transmit of the signed exception to `.com` for fleet-wide
    // fan-out (constructed once; never throws).
    val trustExceptions = remember { LiveTrustExceptionClient() }

    val verdict by trust.verdict.collectAsState()
    val failuresState by trust.failures.collectAsState()
    val relayFailuresState by trust.relayFailures.collectAsState()
    val overridden by trust.overriddenCertHashes.collectAsState()
    val isUnlocked by app.isUnlocked.collectAsState()

    // Two failure SOURCES share the one red sliver. Locked ⇒ show nothing
    // (mirror the operations bar). The control-CA class shows only while the
    // verdict is positively UNTRUSTED (the `.com` global halt); the per-cert
    // RELAY failures aggregated across the user's pods show whenever unlocked
    // (a warning + override — NOT a halt).
    val failures = if (isUnlocked && verdict == com.flagshipserver.app.core.TrustVerdict.UNTRUSTED) {
        failuresState
    } else {
        emptyList()
    }
    val relayFailures = if (isUnlocked) relayFailuresState else emptyList()

    var overriding by remember { mutableStateOf<TrustFailure?>(null) }

    AnimatedVisibility(
        visible = failures.isNotEmpty() || relayFailures.isNotEmpty(),
        enter = fadeIn() + expandVertically(spring(dampingRatio = 0.9f, stiffness = 420f)),
        exit = fadeOut() + shrinkVertically(spring(dampingRatio = 0.9f, stiffness = 420f)),
    ) {
        Column(Modifier.fillMaxWidth()) {
            failures.forEach { f ->
                TrustSliverLine(
                    failure = f,
                    serverCount = 0,
                    overridden = f.certHash in overridden,
                    onTap = { overriding = f },
                )
            }
            // One line per DISTINCT faulty relay authority, spanning all
            // affected servers; the "continuing" marker is wire-driven (a
            // covering exception the box relayed) OR a local override.
            relayFailures.forEach { rf ->
                TrustSliverLine(
                    failure = rf.trustFailure,
                    serverCount = rf.serverCount,
                    overridden = rf.overridden || rf.certHash in overridden,
                    onTap = { overriding = rf.trustFailure },
                )
            }
        }
    }

    overriding?.let { f ->
        AlertDialog(
            onDismissRequest = { overriding = null },
            title = { Text("Continue anyway?") },
            text = {
                Text(
                    if (f.certClass == com.flagshipserver.app.core.TrustCertClass.CONTROL) {
                        "We couldn't verify the Flagship control server's certificate (${f.slug}). " +
                            "Connecting is paused. If you understand the risk, you can continue — " +
                            "this stays flagged."
                    } else {
                        "We couldn't verify the relay's certificate (${f.slug}). If you understand " +
                            "the risk, you can continue — this stays flagged."
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val failure = f
                    overriding = null
                    scope.launch {
                        try {
                            // Biometric-gated owner IRK signs the cert-scoped
                            // TrustException (the deriveIRK call fires Face/PIN).
                            val signer = Keystore.deriveIRK(
                                "Continue with an unverified Flagship control server",
                            )
                            val devicePub = Keystore.irkPubHex()
                            val grantedAt = System.currentTimeMillis()
                            val bytes = TrustException.canonicalBytes(
                                certClass = failure.certClass,
                                certHash = failure.certHash,
                                grantedAt = grantedAt,
                                grantedByDevicePub = devicePub,
                            )
                            val signatureHex = HexUtil.encode(signer.sign(bytes))
                            // Record the local override FIRST so this device
                            // un-sticks even if the transmit fails.
                            trust.recordOverride(failure.certHash)
                            // LOAD-BEARING FAN-OUT: transmit the signed WIRE
                            // envelope to `.com` so EVERY box the user owns pulls
                            // this exception and is satisfied on the same
                            // cert-hash. Previously the signature was computed
                            // then DISCARDED — the override never propagated.
                            val wire = TrustExceptionWire(
                                certClass = failure.certClass.wire,
                                certHash = failure.certHash,
                                grantedAt = grantedAt,
                                grantedByDevicePub = devicePub,
                                signatures = listOf(
                                    TrustExceptionSignature(pubkey = devicePub, sig = signatureHex),
                                ),
                            )
                            val user = currentUser
                            if (!user.isNullOrEmpty()) {
                                trustExceptions.post(user, wire)
                            }
                        } catch (t: Throwable) {
                            toasts.error("Couldn't continue: ${t.message}")
                        }
                    }
                }) { Text("Continue anyway") }
            },
            dismissButton = {
                TextButton(onClick = { overriding = null }) { Text("Not now") }
            },
        )
    }
}

@Composable
private fun TrustSliverLine(
    failure: TrustFailure,
    /** >1 for a relay-cert failure spanning multiple servers; 0 for the
     *  single-authority control-CA class (no count shown). */
    serverCount: Int,
    overridden: Boolean,
    onTap: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .background(FS.colors.danger)
            .clickable(onClick = onTap)
            .semantics {
                testTag = "global-trust-bar"
                contentDescription = failure.label
            }
            .padding(horizontal = FS.space.s4, vertical = FS.space.s2),
    ) {
        Text(
            text = "⚠",
            color = Color.White,
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
        )
        Box(Modifier.padding(start = FS.space.s2))
        Text(
            text = failure.label,
            color = Color.White,
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (serverCount > 1) {
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(FS.radius.pill))
                    .background(Color.White.copy(alpha = 0.18f))
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            ) {
                Text(
                    text = "$serverCount servers",
                    color = Color.White,
                    style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold),
                )
            }
            Box(Modifier.padding(start = FS.space.s2))
        }
        if (overridden) {
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(FS.radius.pill))
                    .background(Color.White.copy(alpha = 0.22f))
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            ) {
                Text(
                    text = "continuing",
                    color = Color.White,
                    style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold),
                )
            }
        } else {
            Text(
                text = "›",
                color = Color.White.copy(alpha = 0.85f),
                style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
            )
        }
    }
}
