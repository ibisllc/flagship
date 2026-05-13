// LLM provider keys. Mirrors apps/web/public/webapp/providers.js +
// FlagshipUI/Screens/ProvidersScreen.swift (or its iOS equivalent
// embedded in Settings).
//
// Each provider has: enabled toggle, API key field (masked), optional
// custom base URL. Keys are stored on the user's pod via
// /api/screens/orders/send (the daemon never returns keys back; we
// only show "configured" / "not configured").

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Switch
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
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS

private data class ProviderForm(
    val key: String,
    val displayName: String,
    val defaultBaseUrl: String,
    var enabled: Boolean = false,
    var apiKey: String = "",
    var baseUrl: String = "",
)

@Composable
fun ProvidersScreen(nav: NavController, onSave: ((List<ProviderConfig>) -> Unit)? = null) {
    val providers = remember {
        mutableListOf(
            ProviderForm("anthropic", "Anthropic Claude", "https://api.anthropic.com"),
            ProviderForm("openai", "OpenAI", "https://api.openai.com/v1"),
            ProviderForm("google", "Google AI", "https://generativelanguage.googleapis.com"),
            ProviderForm("groq", "Groq", "https://api.groq.com/openai/v1"),
            ProviderForm("ollama", "Ollama (local)", "http://localhost:11434"),
        )
    }

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
            "AI providers",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "Plug in your own keys. Flagship never proxies LLM traffic — calls go direct from your pod to the provider you pick.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        )
        Spacer(Modifier.height(FS.space.s4))

        providers.forEach { p ->
            ProviderCard(
                provider = p,
                onToggle = { p.enabled = it },
                onApiKey = { p.apiKey = it },
                onBaseUrl = { p.baseUrl = it },
            )
            Spacer(Modifier.height(FS.space.s3))
        }

        FSPrimaryButton(
            label = "Save",
            onClick = {
                onSave?.invoke(
                    providers.filter { it.enabled && it.apiKey.isNotBlank() }.map {
                        ProviderConfig(
                            key = it.key,
                            apiKey = it.apiKey,
                            baseUrl = it.baseUrl.ifBlank { it.defaultBaseUrl },
                        )
                    },
                )
                nav.popBackStack()
            },
            block = true,
        )
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun ProviderCard(
    provider: ProviderForm,
    onToggle: (Boolean) -> Unit,
    onApiKey: (String) -> Unit,
    onBaseUrl: (String) -> Unit,
) {
    var enabled by remember { mutableStateOf(provider.enabled) }
    var apiKey by remember { mutableStateOf(provider.apiKey) }
    var baseUrl by remember { mutableStateOf(provider.baseUrl) }

    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        provider.displayName,
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                    )
                    Text(
                        provider.defaultBaseUrl,
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp),
                    )
                }
                Switch(
                    checked = enabled,
                    onCheckedChange = { enabled = it; onToggle(it) },
                )
            }
            if (enabled) {
                Spacer(Modifier.height(FS.space.s3))
                FSField(
                    value = apiKey,
                    onValueChange = { apiKey = it; onApiKey(it) },
                    label = "API key",
                    placeholder = "sk-…",
                )
                Spacer(Modifier.height(FS.space.s2))
                FSField(
                    value = baseUrl,
                    onValueChange = { baseUrl = it; onBaseUrl(it) },
                    label = "Custom base URL (optional)",
                    placeholder = provider.defaultBaseUrl,
                )
            }
        }
    }
}

data class ProviderConfig(
    val key: String,
    val apiKey: String,
    val baseUrl: String,
)
