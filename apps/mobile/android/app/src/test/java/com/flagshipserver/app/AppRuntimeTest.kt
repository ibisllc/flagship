package com.flagshipserver.app

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.MockVoiciClient
import com.flagshipserver.app.core.AccountReadTokens
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.voici.MemoryVoiciVaultStore
import com.flagshipserver.app.api.VoiciAccountKeys
import com.flagshipserver.app.core.voici.VoiciCenter
import com.flagshipserver.app.api.VoiciDeviceSigner
import com.flagshipserver.app.core.voici.VoiciKeyring
import com.flagshipserver.app.core.voici.VoiciVault
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A call push that wakes a killed app and the main screen share one AppState, VoiciCenter and phone route. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class AppRuntimeTest {
    private object NoKeys : VoiciKeyring {
        override fun username(): String? = null
        override fun umk(): ByteArray? = null
        override fun holdsSensitiveKey(account: VoiciAccountKeys) = false
        override fun sensitiveNeedsPrompt() = true
        override suspend fun sensitiveSeed(reason: String): Pair<ByteArray, String> = throw IllegalStateException()
        override fun device(): VoiciDeviceSigner? = null
        override suspend fun confirm(reason: String) {}
        override fun displayName() = ""
    }

    private class Counting : AppRuntime.Parts {
        var attaches = 0
        var states = 0
        var centers = 0
        var tokens = 0
        var routes = 0
        val http = OkHttpClient()
        override fun attach(app: Context) { attaches++ }
        override fun okHttp() = http
        override fun newAppState(app: Context): AppState { states++; return AppState() }
        override fun newVoiciCenter(app: Context, appState: AppState, okHttp: OkHttpClient): VoiciCenter {
            centers++
            return VoiciCenter(MockVoiciClient(), NoKeys, VoiciVault(MemoryVoiciVaultStore()), { emptyList() })
        }
        override fun newReadTokens(appState: AppState, okHttp: OkHttpClient): AccountReadTokens {
            tokens++
            return AccountReadTokens(
                transport = com.flagshipserver.app.core.OkHttpJsonTransport(okHttp),
                store = object : com.flagshipserver.app.core.ReadTokenStore {
                    override fun get(username: String): com.flagshipserver.app.core.AccountReadTokenResponse? = null
                    override fun put(username: String, token: com.flagshipserver.app.core.AccountReadTokenResponse) {}
                    override fun remove(username: String) {}
                    override fun clear() {}
                },
                signers = { emptyList() },
                isDemo = { false },
            )
        }
        override fun routeInstalled() = routes > 0
        override fun installRoute(app: Context, appState: AppState, okHttp: OkHttpClient) { routes++ }
    }

    private lateinit var parts: Counting
    private val ctx: Context get() = ApplicationProvider.getApplicationContext()

    @Before fun setUp() {
        AppRuntime.resetForTest()
        VoiciCenter.shared = null
        AccountReadTokens.shared = null
        parts = Counting()
        AppRuntime.parts = parts
    }

    @After fun tearDown() {
        AppRuntime.resetForTest()
        VoiciCenter.shared = null
        AccountReadTokens.shared = null
    }

    @Test fun aCallPushMakesTheCallPathOnce() {
        AppRuntime.prepareCalls(ctx)
        AppRuntime.prepareCalls(ctx)
        assertEquals(1, parts.attaches)
        assertEquals(1, parts.states)
        assertEquals(1, parts.centers)
        assertEquals(1, parts.tokens)
        assertEquals(1, parts.routes)
        assertSame(VoiciCenter.shared, AppRuntime.voiciCenter(ctx))
    }

    @Test fun theMainScreenReusesWhatThePushMade() {
        AppRuntime.prepareCalls(ctx)
        val state = AppRuntime.appState(ctx)
        val center = VoiciCenter.shared
        // MainActivity's calls, after a push woke the process.
        assertSame(state, AppRuntime.appState(ctx))
        assertSame(center, AppRuntime.voiciCenter(ctx))
        assertSame(AccountReadTokens.shared, AppRuntime.readTokens(state))
        assertSame(parts.http, AppRuntime.okHttp())
        assertEquals(1, parts.states)
        assertEquals(1, parts.centers)
    }

    @Test fun aPushAfterTheMainScreenFindsItsObjects() {
        val state = AppRuntime.appState(ctx)
        val center = AppRuntime.voiciCenter(ctx)
        AppRuntime.prepareCalls(ctx)
        assertSame(state, AppRuntime.appState(ctx))
        assertSame(center, VoiciCenter.shared)
        assertEquals(1, parts.centers)
    }

    @Test fun aGymLaunchStartsFresh() {
        val first = AppRuntime.appState(ctx)
        val fresh = AppRuntime.freshAppState(ctx)
        assertNotSame(first, fresh)
        assertSame(fresh, AppRuntime.appState(ctx))
    }

    @Test fun aMockRunMakesNothingLive() {
        AppRuntime.mockRun = true
        AppRuntime.prepareCalls(ctx)
        assertEquals(0, parts.states + parts.centers + parts.tokens + parts.routes)
    }
}
