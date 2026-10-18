// docs/account-gone.md on Android: a 404 account-not-found for THIS device's own
// account flips the state once; another account's 404, a 404 without the code
// and every other status change nothing; after that every call naming the
// account is answered locally with the same 404, and the error toasts stop.

package com.flagshipserver.app.core

import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class AccountGoneTest {
    private val sent = ArrayList<Request>()
    private var status = 404
    private var body = AccountGone.responseBody()

    private fun client() = OkHttpClient.Builder()
        .addInterceptor(AccountGoneInterceptor())
        .addInterceptor(Interceptor { chain ->
            sent.add(chain.request())
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(status).message("x")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        })
        .build()

    private fun get(url: String): Response = client().newCall(Request.Builder().url(url).get().build()).execute()

    @Before fun setUp() {
        AccountGone.clear()
        AccountGone.ownNames = { listOf("Alice") }
    }

    @After fun tearDown() {
        AccountGone.clear()
        AccountGone.ownNames = { emptyList() }
        AccountGone.createNext = false
    }

    @Test fun theOwnAccountsNotFoundFlipsTheStateOnce() {
        assertNull(AccountGone.gone.value)
        get("https://flagshipserver.com/api/users/alice/pods").close()
        assertEquals("alice", AccountGone.gone.value)
        assertTrue(AccountGone.isGone)
    }

    @Test fun afterThatEveryCallNamingTheAccountIsAnsweredLocally() {
        get("https://flagshipserver.com/api/accounts/Alice/read-token").close()
        assertTrue(AccountGone.isGone)
        sent.clear()
        for (p in listOf("/api/users/alice/pods", "/api/users/ALICE/stream", "/api/accounts/alice/read-token", "/api/users/alice/device-grants")) {
            val r = get("https://flagshipserver.com$p")
            assertEquals(p, 404, r.code)
            assertTrue(AccountGone.bodyIsAccountGone(r.body!!.string()))
        }
        assertEquals("nothing was sent", 0, sent.size)
        // Another account's call still goes out.
        get("https://flagshipserver.com/api/users/bob/pods").close()
        assertEquals(1, sent.size)
    }

    @Test fun anotherAccountsNotFoundChangesNothing() {
        get("https://flagshipserver.com/api/users/bob/pods").close()
        assertFalse(AccountGone.isGone)
    }

    @Test fun a404WithoutTheCodeAndOtherStatusesChangeNothing() {
        body = """{"error":"not found"}"""
        get("https://flagshipserver.com/api/users/alice/pods").close()
        assertFalse(AccountGone.isGone)
        body = "<html>nope</html>"
        get("https://flagshipserver.com/api/users/alice/pods").close()
        assertFalse(AccountGone.isGone)
        body = AccountGone.responseBody()
        for (s in listOf(200, 401, 403, 500)) {
            status = s
            get("https://flagshipserver.com/api/users/alice/pods").close()
            assertFalse("status $s", AccountGone.isGone)
        }
    }

    @Test fun onlyTheControlApexCounts() {
        get("https://home.alice.flagship.services/api/users/alice/pods").close()
        assertFalse(AccountGone.isGone)
    }

    @Test fun theNameInAPath() {
        assertEquals("alice", AccountGone.accountNameInPath("/api/users/Alice/pods"))
        assertEquals("alice", AccountGone.accountNameInPath("/api/accounts/alice"))
        assertNull(AccountGone.accountNameInPath("/api/users/check"))
        assertNull(AccountGone.accountNameInPath("/api/health"))
    }

    @Test fun signingOutClearsTheState() {
        AccountGone.markGone("alice")
        AppState().signOut()
        assertFalse(AccountGone.isGone)
    }

    @Test fun errorToastsStopWhileTheScreenIsUp() {
        val toasts = ToastCenter()
        AccountGone.markGone("alice")
        toasts.error("Couldn't load")
        toasts.warning("Status paused")
        assertTrue(toasts.queue.value.isEmpty())
        toasts.info("Saved")
        assertEquals(1, toasts.queue.value.size)
    }

    @Test fun theWordsAreTheOwnersAndMirrorTheDoc() {
        assertEquals("This account was removed", AccountGoneCopy.TITLE)
        assertEquals("This account no longer exists on Flagship. This can happen after a reset.", AccountGoneCopy.BODY)
        assertEquals("Save my servers' data", AccountGoneCopy.SAVE)
        assertEquals("Coming soon", AccountGoneCopy.COMING_SOON)
        assertEquals("Create a new account", AccountGoneCopy.CREATE)
        assertEquals("Remove it from this device", AccountGoneCopy.REMOVE)
        assertEquals("Account: alice", AccountGoneCopy.account("alice"))
        assertEquals("Remove this account from this device?", AdminKeyWarning.REMOVE_TITLE)
        assertEquals(
            "This also removes this device's admin key. Without it you can no longer save your servers' data. Save it first, or remove anyway.",
            AdminKeyWarning.REMOVE_MESSAGE,
        )
        assertEquals("Save my data first", AdminKeyWarning.SAVE_FIRST)
        assertEquals("Remove anyway", AdminKeyWarning.REMOVE_ANYWAY)
        assertEquals("Sign out?", AdminKeyWarning.SIGN_OUT_TITLE)
        assertEquals(
            "Signing out removes this device's admin key. Without it you can no longer save your servers' data. Save it first, or sign out anyway.",
            AdminKeyWarning.SIGN_OUT_NOT_BACKED_UP,
        )
        assertEquals(
            "Signing out removes this device's admin key. You backed up your account key, so keep that file and its passphrase safe: with them you can still save your servers' data.",
            AdminKeyWarning.SIGN_OUT_BACKED_UP,
        )
        assertEquals("Sign out anyway", AdminKeyWarning.SIGN_OUT_ANYWAY)
        for (t in listOf(AccountGoneCopy.BODY, AdminKeyWarning.REMOVE_MESSAGE, AdminKeyWarning.SIGN_OUT_NOT_BACKED_UP, AdminKeyWarning.SIGN_OUT_BACKED_UP)) {
            assertFalse("no em dash", t.contains('\u2014'))
        }
    }

    @Test fun onlyADeviceHoldingTheAdminKeyOrAServerSessionIsWarnedBeforeRemoving() {
        assertTrue(AdminKeyWarning.needsRemovalWarning(holdsAdminRoot = true, holdsServerSession = false))
        assertTrue(AdminKeyWarning.needsRemovalWarning(holdsAdminRoot = false, holdsServerSession = true))
        assertFalse(AdminKeyWarning.needsRemovalWarning(holdsAdminRoot = false, holdsServerSession = false))
    }

    @Test fun signOutWarnsOnAnAdminDeviceAndSaysWhatToKeepOnceTheKeyFileIsWritten() {
        assertNull(AdminKeyWarning.signOut(isAdminDevice = false, keyFileWritten = false))
        assertNull(AdminKeyWarning.signOut(isAdminDevice = false, keyFileWritten = true))
        assertEquals(AdminKeyWarning.SignOutWarning.NotBackedUp, AdminKeyWarning.signOut(true, false))
        assertEquals(AdminKeyWarning.SignOutWarning.BackedUp, AdminKeyWarning.signOut(true, true))
    }
}
