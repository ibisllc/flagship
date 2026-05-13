// Smoke checks on the LoadingState sum type so the tests catch
// breakage if the algebra is ever broken.

package com.flagship.viewmodels

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LoadingStateTest {
    @Test fun idleIsDistinctFromLoaded() {
        val a: LoadingState<Int> = LoadingState.Idle
        val b: LoadingState<Int> = LoadingState.Loaded(42)
        assertTrue(a is LoadingState.Idle)
        assertTrue(b is LoadingState.Loaded)
        assertEquals(42, (b as LoadingState.Loaded).value)
    }

    @Test fun failedCarriesMessage() {
        val f: LoadingState<String> = LoadingState.Failed("oops")
        assertEquals("oops", (f as LoadingState.Failed).message)
    }
}
