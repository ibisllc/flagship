// LLM provider keys. Mirrors apps/web/public/webapp/providers.js +
// FlagshipUI/Screens/ProvidersScreen.swift (or its iOS equivalent
// embedded in Settings).
//
// Each provider has: enabled toggle, API key field (masked), optional
// custom base URL. Keys are stored on the user's pod via
// /api/screens/orders/send (the daemon never returns keys back; we
// only show "configured" / "not configured").

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.R
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import com.flagshipserver.app.ui.components.Switch
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
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
            ProviderForm("anthropic", FSStrings.get(R.string.anthropic_claude), "https://api.anthropic.com"),
            ProviderForm("openai", "OpenAI", "https://api.openai.com/v1"),
            ProviderForm("google", FSStrings.get(R.string.google_ai), "https://generativelanguage.googleapis.com"),
            ProviderForm("groq", "Groq", "https://api.groq.com/openai/v1"),
            ProviderForm("ollama", FSStrings.get(R.string.ollama_local), "http://localhost:11434"),
        )
    }

    FSScreen(
        title = stringResource(R.string.ai_providers),
        onBack = { nav.popBackStack() },
        subtitle = stringResource(R.string.plug_in_your_own_keys_flagship),
        spacing = FS.space.s3,
    ) {
        providers.forEach { p ->
            ProviderCard(
                provider = p,
                onToggle = { p.enabled = it },
                onApiKey = { p.apiKey = it },
                onBaseUrl = { p.baseUrl = it },
            )
        }

        FSPrimaryButton(
            label = stringResource(R.string.save),
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
            modifier = Modifier.padding(top = FS.space.s3),
        )
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

    FSCard(padding = PaddingValues(0.dp)) {
        Column {
            FSRow(
                title = provider.displayName,
                subtitle = provider.defaultBaseUrl,
                onClick = { enabled = !enabled; onToggle(enabled) },
                trailing = {
                    Switch(
                        checked = enabled,
                        onCheckedChange = { enabled = it; onToggle(it) },
                    )
                },
            )
            if (enabled) {
                Column(
                    verticalArrangement = Arrangement.spacedBy(FS.space.s2),
                    modifier = Modifier.padding(start = FS.space.s4, end = FS.space.s4, bottom = FS.space.s4),
                ) {
                    FSField(
                        value = apiKey,
                        onValueChange = { apiKey = it; onApiKey(it) },
                        label = stringResource(R.string.api_key),
                        placeholder = stringResource(R.string.sk),
                    )
                    FSField(
                        value = baseUrl,
                        onValueChange = { baseUrl = it; onBaseUrl(it) },
                        label = stringResource(R.string.custom_base_url_optional),
                        placeholder = provider.defaultBaseUrl,
                    )
                }
            }
        }
    }
}

data class ProviderConfig(
    val key: String,
    val apiKey: String,
    val baseUrl: String,
)
