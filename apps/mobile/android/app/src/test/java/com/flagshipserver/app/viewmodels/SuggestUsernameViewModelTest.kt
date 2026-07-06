package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.UsernameSuggestion
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SuggestUsernameViewModelTest {

    @Test fun load_populatesNameAndArmsCooldown() = runTest {
        val vm = SuggestUsernameViewModel(suggest = { UsernameSuggestion("happy-otter", 2000, false) })
        vm.load()
        assertEquals("happy-otter", vm.current.value)
        assertEquals(2, vm.cooldownRemaining.value) // ceil(2000ms)
        assertFalse(vm.canRegenerate())             // cooling down
        assertTrue(vm.canContinue())
    }

    @Test fun load_isIdempotent() = runTest {
        var n = 0
        val vm = SuggestUsernameViewModel(suggest = { n++; UsernameSuggestion("name$n", 0, false) })
        vm.load()
        vm.load() // no-op once we have a name
        assertEquals(1, n)
        assertEquals("name1", vm.current.value)
    }

    @Test fun regenerateFetchesNewNameWhenCooldownClear() = runTest {
        val names = listOf("one-fox", "two-owl", "three-elk")
        var i = 0
        val vm = SuggestUsernameViewModel(suggest = {
            val nm = names[minOf(i, names.size - 1)]; i++
            UsernameSuggestion(nm, 0, false) // no cooldown → ready
        })
        vm.load()
        assertEquals("one-fox", vm.current.value)
        assertTrue(vm.canRegenerate())
        vm.regenerate()
        assertEquals("two-owl", vm.current.value)
    }

    @Test fun regenerateIsGatedNoOpWhileCoolingDown() = runTest {
        var n = 0
        val vm = SuggestUsernameViewModel(suggest = { n++; UsernameSuggestion("name$n", 2000, false) })
        vm.load()
        assertEquals("name1", vm.current.value)
        assertFalse(vm.canRegenerate())
        vm.regenerate() // gated → no second fetch
        assertEquals("name1", vm.current.value)
        assertEquals(1, n)
    }

    @Test fun throttledResponseKeepsNameAndArmsCooldown() = runTest {
        var n = 0
        val vm = SuggestUsernameViewModel(suggest = {
            n++
            if (n == 1) UsernameSuggestion("first-fox", 0, false)
            else UsernameSuggestion(null, 5000, true)
        })
        vm.load()       // first-fox, cooldown clear
        vm.regenerate() // server says throttled
        assertEquals("first-fox", vm.current.value) // unchanged
        assertEquals(5, vm.cooldownRemaining.value)
    }

    @Test fun errorSurfacesAndLeavesNoName() = runTest {
        val vm = SuggestUsernameViewModel(suggest = { throw RuntimeException("boom") })
        vm.load()
        assertNull(vm.current.value)
        assertNotNull(vm.error.value)
        assertFalse(vm.canContinue())
    }

    @Test fun tickCooldownDecrementsAndFloorsAtZero() = runTest {
        val vm = SuggestUsernameViewModel(suggest = { UsernameSuggestion("a-b", 3000, false) })
        vm.load()
        assertEquals(3, vm.cooldownRemaining.value)
        repeat(4) { vm.tickCooldown() }
        assertEquals(0, vm.cooldownRemaining.value)
        assertTrue(vm.canRegenerate())
    }

    @Test fun randomDeviceKeyIs32HexCharsAndVaries() {
        val k = SuggestUsernameViewModel.randomDeviceKey()
        assertEquals(32, k.length)
        assertTrue(k.all { it in "0123456789abcdef" })
        assertNotEquals(k, SuggestUsernameViewModel.randomDeviceKey())
    }
}
