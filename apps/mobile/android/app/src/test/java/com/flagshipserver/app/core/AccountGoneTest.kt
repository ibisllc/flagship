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
        AccountGone.onDeviceRemoved = null
        AccountGone.joinNext = false
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
        assertEquals("If you saved a backup of your servers, you can restore it into a new account.", AccountGoneCopy.RESTORE_HINT)
        assertEquals("Create a new account", AccountGoneCopy.CREATE)
        assertEquals("Remove it from this device", AccountGoneCopy.REMOVE)
        assertEquals("Account: alice", AccountGoneCopy.account("alice"))
        assertEquals("Remove this account from this device?", AdminKeyWarning.REMOVE_TITLE)
        assertEquals(
            "This also removes this device's admin key, which you need to sign in to your servers. Save a backup of your account key first, or remove anyway.",
            AdminKeyWarning.REMOVE_MESSAGE,
        )
        assertEquals("Save my account key first", AdminKeyWarning.SAVE_FIRST)
        assertEquals("Remove anyway", AdminKeyWarning.REMOVE_ANYWAY)
        assertEquals("Sign out?", AdminKeyWarning.SIGN_OUT_TITLE)
        assertEquals(
            "Signing out removes this device's admin key. Save a backup of your account key first, or sign out anyway.",
            AdminKeyWarning.SIGN_OUT_NOT_BACKED_UP,
        )
        assertEquals(
            "Signing out removes this device's admin key. You backed up your account key, so keep that file and its passphrase safe.",
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

    // docs/revocation-ui.md: `.com` says this device was removed.
    private val removedBody = """{"error":"device-removed","code":"device-removed"}"""

    @Test fun theOwnAccountsDeviceRemovedErasesOnceAndShowsTheRemovedScreen() {
        val erased = ArrayList<String>()
        AccountGone.onDeviceRemoved = { erased.add(it) }
        status = 403
        body = removedBody
        get("https://flagshipserver.com/api/accounts/Alice/read-token").close()
        assertEquals("alice", AccountGone.gone.value)
        assertEquals(AccountGone.Reason.DEVICE_REMOVED, AccountGone.reason.value)
        assertTrue(AccountGone.isDeviceRemoved)
        assertEquals(listOf("alice"), erased)
        // Further calls naming the account stay on the phone, and nothing erases twice.
        sent.clear()
        get("https://flagshipserver.com/api/users/alice/pods").close()
        assertEquals(0, sent.size)
        AccountGone.markDeviceRemoved("alice")
        assertEquals(listOf("alice"), erased)
        // A later account-gone answer for the same account does not turn the removed screen into the other one.
        AccountGone.markGone("alice")
        assertEquals(AccountGone.Reason.DEVICE_REMOVED, AccountGone.reason.value)
    }

    @Test fun aDeviceRemovedFromABoxAnotherAccountOrWithoutTheCodeChangesNothing() {
        val erased = ArrayList<String>()
        AccountGone.onDeviceRemoved = { erased.add(it) }
        status = 403
        body = removedBody
        get("https://home.alice.flagship.services/api/users/alice/pods").close()
        get("https://flagshipserver.com/api/users/bob/pods").close()
        get("https://flagshipserver.com/api/health").close()
        body = """{"error":"not authorized"}"""
        get("https://flagshipserver.com/api/users/alice/pods").close()
        for (s in listOf(401, 404, 200)) {
            status = s
            body = removedBody
            get("https://flagshipserver.com/api/users/alice/pods").close()
        }
        assertFalse(AccountGone.isDeviceRemoved)
        assertEquals(emptyList<String>(), erased)
    }

    @Test fun signingOutClearsTheRemovedState() {
        AccountGone.markDeviceRemoved("alice")
        assertTrue(AccountGone.isGone)
        AppState().signOut()
        assertFalse(AccountGone.isGone)
        assertEquals(AccountGone.Reason.ACCOUNT_GONE, AccountGone.reason.value)
    }

    @Test fun aDeviceRemovedPushOnlyAsksDotComAgain() {
        val asked = java.util.concurrent.CountDownLatch(1)
        val erased = ArrayList<String>()
        AccountGone.onDeviceRemoved = { erased.add(it) }
        DeviceRemovedCheck.check = { asked.countDown() }
        try {
            assertTrue(DeviceRemovedCheck.matches(mapOf("category" to "device-removed", "kind" to "device-removed")))
            assertTrue(DeviceRemovedCheck.matches(mapOf("kind" to "device-removed")))
            assertFalse(DeviceRemovedCheck.matches(mapOf("category" to "secret-request")))
            assertTrue(DeviceRemovedCheck.request())
            assertTrue(asked.await(5, java.util.concurrent.TimeUnit.SECONDS))
            assertFalse("the push itself erases nothing", AccountGone.isGone)
            assertEquals(emptyList<String>(), erased)
            DeviceRemovedCheck.check = null
            assertFalse("no check wired (cold start): nothing to do until the next open", DeviceRemovedCheck.request())
        } finally {
            DeviceRemovedCheck.check = null
        }
    }
}
