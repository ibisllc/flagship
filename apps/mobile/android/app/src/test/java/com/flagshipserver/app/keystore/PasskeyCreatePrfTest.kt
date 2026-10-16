// First-time cloud recovery failed on a Samsung phone (device bug 2026-10-16):
// Samsung Pass saved the passkey but returned no PRF output on create, and the
// check right after didn't answer at once, so set-up said "Something went
// wrong" although the passkey existed. A fake passkey app drives each case.

package com.flagshipserver.app.keystore

import android.app.Activity
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.NoCredentialException
import com.flagshipserver.app.core.NetworkErrorHumanizer
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Base64

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PasskeyCreatePrfTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).get()
    private val secret = ByteArray(32) { 7 }
    private val credId = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
    private fun b64(b: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(b)

    private fun authData(aaguidHex: String): ByteArray {
        val b = ByteArray(55)
        val aaguid = aaguidHex.chunked(2).map { it.toInt(16).toByte() }
        aaguid.forEachIndexed { i, v -> b[37 + i] = v }
        return b
    }

    /** A passkey app: PRF on create or not; a scripted list of get answers. */
    private inner class FakePasskeyApp(
        val prfOnCreate: Boolean,
        val gets: MutableList<() -> GetCredentialResponse>,
        val aaguid: String? = null,
    ) : CredentialCalls {
        var getCalls = 0
        override suspend fun create(activity: Activity, request: CreatePublicKeyCredentialRequest): CreateCredentialResponse {
            val json = JSONObject().apply {
                put("id", b64(credId))
                put("response", JSONObject().apply {
                    aaguid?.let { put("authenticatorData", b64(authData(it))) }
                })
                put("clientExtensionResults", JSONObject().apply {
                    put("prf", JSONObject().apply {
                        put("enabled", true)
                        if (prfOnCreate) put("results", JSONObject().apply { put("first", b64(secret)) })
                    })
                })
            }
            return CreatePublicKeyCredentialResponse(json.toString())
        }

        override suspend fun get(activity: Activity, request: GetCredentialRequest): GetCredentialResponse {
            getCalls++
            return gets.removeAt(0)()
        }
    }

    private fun assertion(withPrf: Boolean): () -> GetCredentialResponse = {
        val json = JSONObject().apply {
            put("id", b64(credId))
            put("clientExtensionResults", JSONObject().apply {
                if (withPrf) put("prf", JSONObject().apply { put("results", JSONObject().apply { put("first", b64(secret)) }) })
            })
        }
        GetCredentialResponse(PublicKeyCredential(json.toString()))
    }

    @Test fun prfOnCreateNeedsNoSecondPrompt() = runTest {
        val app = FakePasskeyApp(prfOnCreate = true, gets = mutableListOf())
        var prompted = 0
        val created = PasskeyRecoveryManager(app, retryDelayMs = 0).createPasskey(activity, "harry", onSecondPrompt = { prompted++ })
        assertArrayEquals(secret, created.prfSecret)
        assertEquals(0, app.getCalls)
        assertEquals(0, prompted)
    }

    @Test fun noPrfOnCreateAsksOnceMoreAndSucceeds() = runTest {
        val app = FakePasskeyApp(prfOnCreate = false, gets = mutableListOf(assertion(true)))
        var prompted = 0
        val created = PasskeyRecoveryManager(app, retryDelayMs = 0).createPasskey(activity, "harry", onSecondPrompt = { prompted++ })
        assertArrayEquals(secret, created.prfSecret)
        assertEquals("0102030405060708090a", created.credentialId)
        assertEquals(1, prompted)
    }

    @Test fun aPasskeyAppNotReadyRightAfterCreateIsAskedAgain() = runTest {
        val app = FakePasskeyApp(
            prfOnCreate = false,
            gets = mutableListOf({ throw NoCredentialException() }, assertion(true)),
        )
        val created = PasskeyRecoveryManager(app, retryDelayMs = 0).createPasskey(activity, "harry")
        assertArrayEquals(secret, created.prfSecret)
        assertEquals(2, app.getCalls)
    }

    @Test fun noKeyEverSaysWhatWentWrong() = runTest {
        val app = FakePasskeyApp(
            prfOnCreate = false,
            gets = MutableList(PasskeyRecoveryManager.CREATE_ASSERT_ATTEMPTS) { assertion(false) },
        )
        try {
            PasskeyRecoveryManager(app, retryDelayMs = 0).createPasskey(activity, "harry")
            fail("expected KeyNotReturned")
        } catch (e: PasskeyRecoveryManager.RecoveryError.KeyNotReturned) {
            assertEquals(NetworkErrorHumanizer.PASSKEY_NO_KEY, NetworkErrorHumanizer.humanize(e))
            assertTrue(!NetworkErrorHumanizer.humanize(e).contains("Something went wrong"))
        }
    }

    @Test fun cancellingTheSecondPromptStopsAtOnce() = runTest {
        val app = FakePasskeyApp(prfOnCreate = false, gets = mutableListOf({ throw GetCredentialCancellationException() }))
        try {
            PasskeyRecoveryManager(app, retryDelayMs = 0).createPasskey(activity, "harry")
            fail("expected GetFailed")
        } catch (e: PasskeyRecoveryManager.RecoveryError.GetFailed) {
            assertEquals(1, app.getCalls)
            assertTrue(NetworkErrorHumanizer.humanize(e).startsWith("You cancelled"))
        }
    }

    @Test fun theProviderIsNamedFromItsAaguid() = runTest {
        val samsung = FakePasskeyApp(prfOnCreate = true, gets = mutableListOf(), aaguid = "53414d53554e47000000000000000000")
        assertEquals("Samsung Pass", PasskeyRecoveryManager(samsung).createPasskey(activity, "harry").provider)
        val unknown = FakePasskeyApp(prfOnCreate = true, gets = mutableListOf(), aaguid = "00000000000000000000000000000000")
        assertNull(PasskeyRecoveryManager(unknown).createPasskey(activity, "harry").provider)
    }
}
