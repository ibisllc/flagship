package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Mock-mode `.com` free-AI endpoints (the mock clients' twin; iOS
 * MockFlagshipServerClient answers the same): 1,840 credits left, 500 added
 * each week. Never touches the network, so a demo or gym session can't reach
 * the real `.com` with a made-up account.
 */
class MockFreeAiClient : FreeAiClient() {
    private val credits = FreeAiCreditsInfo(
        usedTokens = 660_000,
        allowanceTokens = 2_500_000,
        remainingTokens = 1_840_000,
        week = FreeAiWeek(used = 0, allowance = 500_000, remaining = 500_000),
        starter = FreeAiStarter(used = 660_000, allowance = 2_000_000, remaining = 1_340_000),
        remainingCredits = 1_840,
        weeklyCredits = 500,
        tokensPerCredit = 1_000,
    )

    override suspend fun token(body: FreeAiSignedBody): FreeAiMint = FreeAiMint.Ok(
        AiCredential(provider = "openai", apiKey = "mock-free-ai", baseUrl = null, relay = true, source = "promo"),
        credits,
    )

    override suspend fun status(body: FreeAiSignedBody): FreeAiStatusResponse =
        FreeAiStatusResponse(available = true, credits = credits)
}
