package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.BuildCredential
import com.flagshipserver.app.api.VibeCodeStartRequest
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.PendingBuildCredential
import kotlinx.coroutines.launch

/**
 * D.6.1 — VibeCodeProviderPickView.
 *
 * Two cards: free-tier promo (with daily/lifetime usage display) and
 * BYOK. Picking one navigates to the describe screen; BYOK first
 * routes through APIKeyView to set up the key.
 */
@Composable
fun VibeCodeProviderPickScreen(nav: NavController) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s12))
        Text(
            text = "How would you like to build it?",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s4))
        Text(
            text = "Pick the AI that writes the code. You can change this any time.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        )
        Spacer(Modifier.height(FS.space.s8))

        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            // Free-tier card
            FSCard(padding = PaddingValues(FS.space.s6)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = Modifier.fillMaxWidth(0.7f)) {
                        Text(
                            text = "Use Flagship's credits",
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
                        )
                        Spacer(Modifier.height(FS.space.s2))
                        Text(
                            text = "50 free calls a day · 200 lifetime · we cover the API bill.",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                        )
                    }
                    Spacer(Modifier.fillMaxWidth(0.0f))
                    PromoUsageBadge(used = 12, cap = 50)
                }
                Spacer(Modifier.height(FS.space.s4))
                Text(
                    text = "Honest note: your prompts go directly to Anthropic, not through us.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                )
                Spacer(Modifier.height(FS.space.s4))
                FSPrimaryButton(
                    label = "Use the promo →",
                    onClick = { nav.navigate("vibe/describe") },
                    block = true,
                )
            }
            // BYOK card
            FSCard(padding = PaddingValues(FS.space.s6)) {
                Text(
                    text = "Bring your own key",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
                )
                Spacer(Modifier.height(FS.space.s2))
                Text(
                    text = "Anthropic, OpenAI, or Google. No daily limits. Your key, your bill, your choice of model.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                )
                Spacer(Modifier.height(FS.space.s4))
                FSSecondaryButton(
                    label = "Set up a key",
                    onClick = { nav.navigate("vibe/key") },
                    block = true,
                )
            }
        }
    }
}

@Composable
private fun PromoUsageBadge(used: Int, cap: Int) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(FS.radius.pill))
            .background(FS.colors.primary.copy(alpha = 0.12f))
            .padding(horizontal = 12.dp, vertical = 4.dp),
    ) {
        Text(
            text = "$used / $cap today",
            color = FS.colors.primary,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
        )
    }
}

/**
 * D.6.3 — VibeCodeDescribeView.
 *
 * Free-text textarea (the textarea IS the hero), a few example
 * chips, structured fields below (name, visibility, AI provider).
 * Permissions preview surfaces below the fold.
 */
@Composable
fun VibeCodeDescribeScreen(nav: NavController) {
    var prompt by remember {
        mutableStateOf(
            "A little site to track which of my houseplants I've watered, with a photo per plant. Send me a push when one's been thirsty 5+ days.",
        )
    }
    var name by remember { mutableStateOf("plants") }

    val screens = LocalScreensClient.current
    val scope = rememberCoroutineScope()
    // A credential picked at the AI-key step (BYOK path) — null for promo.
    val credential = remember { PendingBuildCredential.peek() }
    var starting by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s12))
        Text(
            text = "New service",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s3))
        Text(
            text = "Describe what you want. Your Flagship will build it and run it at $name.harry.flagship.services.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 22.sp),
        )
        Spacer(Modifier.height(FS.space.s6))

        // Textarea
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(180.dp)
                .clip(RoundedCornerShape(FS.radius.sm))
                .background(FS.colors.surfaceSunken)
                .border(1.dp, FS.colors.border, RoundedCornerShape(FS.radius.sm))
                .padding(14.dp),
        ) {
            BasicTextField(
                value = prompt,
                onValueChange = { prompt = it },
                cursorBrush = SolidColor(FS.colors.primary),
                textStyle = TextStyle(color = FS.colors.text, fontSize = 16.sp, lineHeight = 22.sp),
                modifier = Modifier.fillMaxSize(),
            )
            Box(
                contentAlignment = Alignment.BottomEnd,
                modifier = Modifier.fillMaxSize(),
            ) {
                Text(
                    text = "${prompt.length}",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 12.sp, fontFamily = FontFamily.Monospace),
                )
            }
        }

        Spacer(Modifier.height(FS.space.s6))

        // Examples row
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            for (ex in listOf("Habit tracker", "Family wishlist", "Recipe jar", "Sleep journal")) {
                ExampleChip(ex) { prompt = it }
            }
        }

        Spacer(Modifier.height(FS.space.s8))

        // Structured below-the-fold fields
        FSCard(padding = PaddingValues(FS.space.s4)) {
            LabelRow("Name", name)
            LabelRow("Visible to", "Just me")
            LabelRow("AI", "Claude (Flagship credits)")
        }

        Spacer(Modifier.height(FS.space.s4))

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Text(
                text = "It'll ask for these:",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
            )
            Spacer(Modifier.height(FS.space.s2))
            Text(
                text = "· Postgres (a 'plants' table)\n· Object store (photos)\n· Push notifications",
                color = FS.colors.text,
                style = TextStyle(fontSize = 14.sp, lineHeight = 22.sp),
            )
        }

        Spacer(Modifier.height(FS.space.s8))

        FSPrimaryButton(
            label = if (starting) "Starting…" else "Build it",
            onClick = {
                if (starting) return@FSPrimaryButton
                starting = true
                scope.launch {
                    try {
                        val cred = PendingBuildCredential.peek()?.let {
                            BuildCredential(it.provider, it.apiKey, it.baseUrl)
                        }
                        val resp = screens.vibeCodeStart(
                            VibeCodeStartRequest(prompt = prompt, credential = cred),
                        )
                        if (resp.needsCredential) {
                            // Box wants a key — route into the AI-key step.
                            starting = false
                            nav.navigate("vibe/key")
                        } else {
                            PendingBuildCredential.take()
                            nav.navigate("vibe/generating/${resp.sessionId}")
                        }
                    } catch (_: Exception) {
                        starting = false
                    }
                }
            },
            enabled = !starting,
            block = true,
            large = true,
        )
        Spacer(Modifier.height(FS.space.s2))
        Text(
            text = "about 90 seconds",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp),
            modifier = Modifier.fillMaxWidth().padding(top = FS.space.s1),
        )
    }
}

@Composable
private fun ExampleChip(text: String, onPick: (String) -> Unit) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(FS.radius.pill))
            .background(FS.colors.surfaceSunken)
            .border(1.dp, FS.colors.border, RoundedCornerShape(FS.radius.pill))
            .padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Text(
            text = text,
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
        )
    }
}

@Composable
private fun LabelRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = FS.space.s2),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp))
        Text(value, color = FS.colors.text, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium))
    }
}

/**
 * D.6.4 — VibeCodeGeneratingScreen.
 *
 * Live stream from /api/llm/sessions/<id>/stream WS. Renders chat-with-
 * thinking events: "thinking" lines as faint, file-start as separators,
 * each file's content streamed monospace. User can interject mid-stream
 * (sends a follow-up message).
 */
@Composable
fun VibeCodeGeneratingScreen(nav: NavController, sessionId: String = "") {
    @Suppress("UNUSED_VARIABLE") val _sid = sessionId
    val events by remember { mutableStateOf(sampleStream()) }

    Column(modifier = Modifier.fillMaxSize().padding(horizontal = FS.space.s6)) {
        Spacer(Modifier.height(FS.space.s12))
        Text(
            text = "Building plants…",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s3))
        Text(
            text = "Streaming live. You can interrupt with a follow-up at any time.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp),
        )

        Spacer(Modifier.height(FS.space.s6))

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.7f)
                .clip(RoundedCornerShape(FS.radius.md))
                .background(FS.colors.surface)
                .border(1.dp, FS.colors.border, RoundedCornerShape(FS.radius.md))
                .padding(FS.space.s4),
        ) {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                items(events) { e ->
                    when (e) {
                        is StreamEvent.Thinking -> Text(
                            text = e.text,
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 14.sp),
                        )
                        is StreamEvent.FileStart -> Text(
                            text = "── ${e.filename} ──",
                            color = FS.colors.primary,
                            style = TextStyle(fontSize = 12.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium),
                            modifier = Modifier.padding(top = FS.space.s2),
                        )
                        is StreamEvent.Chunk -> Text(
                            text = e.text,
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 12.sp, lineHeight = 18.sp, fontFamily = FontFamily.Monospace),
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(FS.space.s4))

        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSGhostButton("Interrupt", onClick = { /* TODO */ })
            FSSecondaryButton("Save & continue later", onClick = { /* TODO */ }, block = true)
        }
    }
}

private sealed class StreamEvent {
    data class Thinking(val text: String) : StreamEvent()
    data class FileStart(val filename: String) : StreamEvent()
    data class Chunk(val text: String) : StreamEvent()
}

private fun sampleStream(): List<StreamEvent> = listOf(
    StreamEvent.Thinking("Sketching the schema. One table for plants, one for waterings."),
    StreamEvent.FileStart("flagship.app.json"),
    StreamEvent.Chunk("{\n  \"schema_version\": 1,\n  \"name\": \"plants\",\n  \"version\": \"0.1.0\",\n  \"data\": { \"stores\": { \"postgres\": true, \"objects\": true } },\n  \"network\": { \"subdomain\": \"plants\" }\n}"),
    StreamEvent.FileStart("Dockerfile"),
    StreamEvent.Chunk("FROM node:20-alpine\nWORKDIR /app\nCOPY package.json .\nRUN npm ci\nCOPY src ./src\nCMD [\"node\", \"src/index.js\"]"),
    StreamEvent.FileStart("src/index.ts"),
    StreamEvent.Chunk("import express from 'express';\nconst app = express();\napp.get('/', (req, res) => { ... });"),
)
