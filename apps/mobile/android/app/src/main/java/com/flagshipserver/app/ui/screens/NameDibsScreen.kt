// Settings → "Claim your .com name" (name dibs). Mirrors iOS NameDibsScreen.swift.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.DibsClaim
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalNameDibsClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.NameDibsPhase
import com.flagshipserver.app.viewmodels.NameDibsViewModel
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

@Composable
fun NameDibsScreen() {
    val client = LocalNameDibsClient.current
    val app = LocalAppState.current
    val user = app.currentUser.collectAsState().value ?: ""
    val vm = remember(user) { NameDibsViewModel(client, user) }
    val phase by vm.phase.collectAsState()
    val inlineError by vm.inlineError.collectAsState()
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }

    LaunchedEffect(vm) { vm.load() }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        Text(
            "Claim your .com name",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s4))
        when (val p = phase) {
            NameDibsPhase.Loading, NameDibsPhase.Working -> CircularProgressIndicator()
            is NameDibsPhase.Closed -> Muted(
                p.opensAt?.let { "The dibs window opens on ${formatDibsDate(it)}." }
                    ?: "The dibs window isn't open, so no names are held for .com holders — any free name can be bought as an ordinary name change.",
            )
            is NameDibsPhase.EnterName -> {
                Muted(
                    "Until ${p.closesAt?.let(::formatDibsDate) ?: "the window closes"}, a name matching a registered .com " +
                        "is held for whoever controls that domain. Enter the name of the .com you control.",
                )
                Spacer(Modifier.height(FS.space.s3))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        singleLine = true,
                        placeholder = { Text("acme") },
                        modifier = Modifier.weight(1f).testTag("dibs-name"),
                    )
                    Text(" .com", color = FS.colors.textMuted)
                }
                Spacer(Modifier.height(FS.space.s3))
                FSPrimaryButton(
                    "Get my code",
                    onClick = { scope.launch { vm.start(name) } },
                    enabled = name.isNotBlank(),
                    block = true,
                    modifier = Modifier.testTag("dibs-start"),
                )
            }
            is NameDibsPhase.Publish -> Publish(
                p.claim,
                onCheck = { scope.launch { vm.check() } },
                onRestart = { vm.restart() },
            )
            is NameDibsPhase.Proven -> Text(
                "You've proven you control ${p.name}.com, so the name ${p.name} is held for you. " +
                    "Switching your account to it is a one-time $20 name change — your servers move with you.",
                color = FS.colors.text,
                modifier = Modifier.testTag("dibs-proven"),
            )
            is NameDibsPhase.Failed -> Text(p.message, color = FS.colors.danger)
        }
        inlineError?.let {
            Spacer(Modifier.height(FS.space.s3))
            Text(it, color = FS.colors.danger, modifier = Modifier.testTag("dibs-error"))
        }
        Spacer(Modifier.height(FS.space.s8))
    }
}

@Composable
private fun Muted(text: String) = Text(text, color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp))

@Composable
private fun Publish(claim: DibsClaim, onCheck: () -> Unit, onRestart: () -> Unit) {
    Muted(
        "Publish this code in one of these two places, then check. It's tied to your account's key, so nobody " +
            "else can use it. DNS changes can take a while — you can leave and come back.",
    )
    Spacer(Modifier.height(FS.space.s3))
    Place("Option 1 — DNS TXT record", listOf("Name" to claim.publishAt.dns.name, "Value" to claim.record))
    Spacer(Modifier.height(FS.space.s2))
    Place("Option 2 — a file on your website", listOf("URL" to claim.publishAt.https.url, "Text" to claim.record))
    Spacer(Modifier.height(FS.space.s3))
    FSPrimaryButton("Check now", onClick = onCheck, block = true, modifier = Modifier.testTag("dibs-check"))
    Spacer(Modifier.height(FS.space.s2))
    FSSecondaryButton("Use a different name", onClick = onRestart, block = true)
}

@Composable
private fun Place(title: String, lines: List<Pair<String, String>>) {
    val clipboard = LocalClipboardManager.current
    FSCard(Modifier.fillMaxWidth()) {
        Column {
            Text(title, color = FS.colors.text, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium))
            for ((label, value) in lines) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(label, color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp))
                        Text(value, color = FS.colors.text, style = TextStyle(fontSize = 13.sp, fontFamily = FontFamily.Monospace))
                    }
                    TextButton(onClick = { clipboard.setText(AnnotatedString(value)) }) { Text("Copy") }
                }
            }
        }
    }
}

fun formatDibsDate(ms: Long): String = DateFormat.getDateInstance(DateFormat.LONG).format(Date(ms))
