// Exercise the SESSION-SCOPED freshness latch in BiometricAuthority. The
// production constructor binds a real FragmentActivity for the BiometricPrompt;
// tests use the forTest() factory to inject a custom prompter so we can pin the
// prompt-once-per-session / ride-the-session / no-activity-skip / invalidate
// branches deterministically. There is no clock: once authenticated the session
// stays fresh until invalidate() (lock / background / sign-out) — the mirror of
// iOS's in-memory session-key cache.

package com.flagshipserver.app.keystore

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

private class FailingPrompter : BiometricPrompter {
    var calls = 0
    override suspend fun prompt(title: String, subtitle: String) {
        calls += 1
        throw BiometricCancelled()
    }
}

class BiometricAuthorityTest {

    @Test fun firstCall_promptsAndLatchesSession() = runTest {
        val prompter = CountingPrompter()
        val authority = BiometricAuthority.forTest(prompter)
        assertFalse("cold before first auth", authority.isFresh())
        authority.ensureFresh("Authorize", "Sign request")
        assertEquals(1, prompter.calls)
        assertEquals("Authorize", prompter.lastTitle)
        assertEquals("Sign request", prompter.lastSubtitle)
        assertTrue("session latched fresh after auth", authority.isFresh())
    }

    @Test fun secondCall_ridesSession_noPrompt() = runTest {
        // Session-scoped: once authenticated, every later derive rides the same
        // session with NO second prompt — regardless of how much time passed.
        val prompter = CountingPrompter()
        val authority = BiometricAuthority.forTest(prompter)
        authority.ensureFresh("A", "S")
        assertEquals(1, prompter.calls)
        authority.ensureFresh("A", "S")
        authority.ensureFresh("A", "S")
        assertEquals("an unlocked session suppresses every later prompt", 1, prompter.calls)
    }

    @Test fun nullPrompter_skipsSilentlyAndDoesNotLatch() = runTest {
        // Background-service callers (FCM) construct with no foreground activity →
        // no prompter → ensureFresh is a no-op AND must NOT latch the session.
        val authority = BiometricAuthority.forTest(prompter = null)
        authority.ensureFresh("A", "S")  // must not throw
        authority.ensureFresh("A", "S")
        assertFalse("a silent background call never latches the session", authority.isFresh())
    }

    @Test fun nullPrompter_doesNotLatch_foregroundStillPrompts() = runTest {
        // If a service-context call happens first (null prompter, no latch), a
        // subsequent foreground call MUST still prompt.
        val backgroundAuth = BiometricAuthority.forTest(prompter = null)
        backgroundAuth.ensureFresh("bg", "bg")  // silent, no latch

        val prompter = CountingPrompter()
        val foregroundAuth = BiometricAuthority.forTest(prompter)
        foregroundAuth.ensureFresh("fg", "fg")
        assertEquals(1, prompter.calls)
    }

    @Test fun invalidate_forcesNextCallToPrompt() = runTest {
        val prompter = CountingPrompter()
        val authority = BiometricAuthority.forTest(prompter)
        authority.ensureFresh("A", "S")
        assertEquals(1, prompter.calls)
        assertTrue(authority.isFresh())
        authority.invalidate()
        assertFalse("invalidate ends the session", authority.isFresh())
        authority.ensureFresh("A", "S")
        assertEquals("a re-locked session must re-authenticate", 2, prompter.calls)
    }

    @Test fun promptFailure_doesNotLatchSession() = runTest {
        val prompter = FailingPrompter()
        val authority = BiometricAuthority.forTest(prompter)
        try {
            authority.ensureFresh("A", "S")
            fail("expected cancellation to bubble up")
        } catch (_: BiometricCancelled) {
            // expected
        }
        assertFalse("a failed prompt must not latch the session", authority.isFresh())
        // The second call should prompt again (session stayed cold).
        try {
            authority.ensureFresh("A", "S")
            fail("expected cancellation again")
        } catch (_: BiometricCancelled) {
            // expected
        }
        assertEquals(2, prompter.calls)
    }

    @Test fun staticHolder_setAndCurrent() {
        val a = BiometricAuthority.forTest(prompter = null)
        BiometricAuthority.set(a)
        assertEquals(a, BiometricAuthority.current())
        BiometricAuthority.set(null)
        assertEquals(null, BiometricAuthority.current())
    }
}
