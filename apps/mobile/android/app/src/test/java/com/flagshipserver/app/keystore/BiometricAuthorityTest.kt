// Exercise the freshness-window logic in BiometricAuthority. The
// production constructor binds a real FragmentActivity for the
// BiometricPrompt; tests use the forTest() factory to inject a
// custom prompter + clock so we can pin the cache-while-fresh /
// prompt-when-stale / no-activity-skip branches deterministically.

package com.flagshipserver.app.keystore

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

private class CountingPrompter : BiometricPrompter {
    var calls = 0
    var lastTitle: String? = null
    var lastSubtitle: String? = null
    override suspend fun prompt(title: String, subtitle: String) {
        calls += 1
        lastTitle = title
        lastSubtitle = subtitle
    }
}

private class FailingPrompter(private val message: String = "user cancelled") : BiometricPrompter {
    var calls = 0
    override suspend fun prompt(title: String, subtitle: String) {
        calls += 1
        throw BiometricCancelled()
    }
}

class BiometricAuthorityTest {

    @Test fun firstCall_promptsAndCachesWindow() = runTest {
        val prompter = CountingPrompter()
        var t = 1_000L
        val authority = BiometricAuthority.forTest(prompter, clock = { t })
        authority.ensureFresh("Authorize", "Sign request")
        assertEquals(1, prompter.calls)
        assertEquals("Authorize", prompter.lastTitle)
        assertEquals("Sign request", prompter.lastSubtitle)
    }

    @Test fun secondCallWithinFreshness_skipsPrompt() = runTest {
        val prompter = CountingPrompter()
        var t = 1_000L
        val authority = BiometricAuthority.forTest(prompter, clock = { t })
        authority.ensureFresh("A", "S")
        assertEquals(1, prompter.calls)
        t += 30_000L  // 30s later — still inside default 60s window
        authority.ensureFresh("A", "S")
        assertEquals("freshness window must suppress the second prompt", 1, prompter.calls)
    }

    @Test fun callAfterFreshnessExpired_promptsAgain() = runTest {
        val prompter = CountingPrompter()
        var t = 1_000L
        val authority = BiometricAuthority.forTest(prompter, clock = { t })
        authority.ensureFresh("A", "S")
        t += 60_001L  // just past the 60s window
        authority.ensureFresh("A", "S")
        assertEquals(2, prompter.calls)
    }

    @Test fun nullPrompter_skipsSilentlyEvenWhenWindowExpired() = runTest {
        // Background-service callers (FCM) construct with no foreground
        // activity → no prompter → ensureFresh is a no-op.
        val authority = BiometricAuthority.forTest(prompter = null, clock = { 1_000L })
        authority.ensureFresh("A", "S")  // must not throw
        // Calling again still doesn't prompt
        authority.ensureFresh("A", "S")
    }

    @Test fun nullPrompter_doesNotExtendFreshnessWindow() = runTest {
        // If a service-context call happens first (null prompter, no
        // extension), a subsequent foreground call MUST still prompt.
        val prompter = CountingPrompter()
        var t = 0L

        val backgroundAuth = BiometricAuthority.forTest(prompter = null, clock = { t })
        backgroundAuth.ensureFresh("bg", "bg")  // silent, no window set

        val foregroundAuth = BiometricAuthority.forTest(prompter, clock = { t })
        foregroundAuth.ensureFresh("fg", "fg")
        assertEquals(1, prompter.calls)
    }

    @Test fun customWindow_isHonored() = runTest {
        val prompter = CountingPrompter()
        var t = 0L
        val authority = BiometricAuthority.forTest(prompter, clock = { t })
        authority.ensureFresh("A", "S", window = kotlin.time.Duration.parse("10s"))
        t += 5_000
        authority.ensureFresh("A", "S")
        assertEquals("within window — no second prompt", 1, prompter.calls)
        t += 6_000  // now 11s — past the 10s custom window
        authority.ensureFresh("A", "S")
        assertEquals(2, prompter.calls)
    }

    @Test fun invalidate_forcesNextCallToPrompt() = runTest {
        val prompter = CountingPrompter()
        val authority = BiometricAuthority.forTest(prompter, clock = { 1_000L })
        authority.ensureFresh("A", "S")
        assertEquals(1, prompter.calls)
        authority.invalidate()
        authority.ensureFresh("A", "S")
        assertEquals("invalidate must reset the window", 2, prompter.calls)
    }

    @Test fun promptFailure_doesNotCacheWindow() = runTest {
        val prompter = FailingPrompter()
        val authority = BiometricAuthority.forTest(prompter, clock = { 1_000L })
        try {
            authority.ensureFresh("A", "S")
            fail("expected cancellation to bubble up")
        } catch (_: BiometricCancelled) {
            // expected
        }
        // The second call should prompt again (window was NOT extended)
        try {
            authority.ensureFresh("A", "S")
            fail("expected cancellation again")
        } catch (_: BiometricCancelled) {
            // expected — verifies the window stayed unfresh
        }
        assertEquals(2, prompter.calls)
    }

    @Test fun staticHolder_setAndCurrent() {
        val a = BiometricAuthority.forTest(prompter = null, clock = { 0L })
        BiometricAuthority.set(a)
        assertEquals(a, BiometricAuthority.current())
        BiometricAuthority.set(null)
        assertEquals(null, BiometricAuthority.current())
    }
}
