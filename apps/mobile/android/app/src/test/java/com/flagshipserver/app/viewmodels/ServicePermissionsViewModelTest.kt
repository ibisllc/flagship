package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.core.PermissionRevokeResult
import com.flagshipserver.app.core.PermissionWords
import com.flagshipserver.app.core.ServicePermissionGrant
import com.flagshipserver.app.core.ServicePermissions
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServicePermissionsViewModelTest {
    private fun world(): Pair<MockScreensClient, ServicePermissionsViewModel> {
        val mock = MockScreensClient()
        mock.permissions["alice--chess"] = ServicePermissions(
            grants = listOf(
                ServicePermissionGrant("k1", "app-api-key", "read"),
                ServicePermissionGrant("k2", "mcp-key", "ide", secretAccess = true, openWork = listOf("a download")),
            ),
        )
        return mock to ServicePermissionsViewModel("alice--chess", mock)
    }

    @Test
    fun loadsEveryGrant() = runBlocking {
        val (_, vm) = world()
        vm.load()
        assertEquals(listOf("k1", "k2"), vm.permissions.value?.grants?.map { it.id })
    }

    @Test
    fun endingOneLeavesTheOther() = runBlocking {
        val (mock, vm) = world()
        vm.load()
        vm.revoke("k2")
        assertEquals("alice--chess" to "k2", mock.permissionRevokes.first())
        assertEquals(listOf("k1"), vm.permissions.value?.grants?.map { it.id })
        assertEquals("Access ended.", vm.notice.value)
    }

    @Test
    fun endingAllClearsThePage() = runBlocking {
        val (_, vm) = world()
        vm.load()
        vm.revoke(null)
        assertEquals(0, vm.permissions.value?.grants?.size)
        assertEquals("2 accesses ended.", vm.notice.value)
    }

    @Test
    fun anOlderBoxShowsNothing() = runBlocking {
        val mock = MockScreensClient()
        mock.shouldFail = true
        val vm = ServicePermissionsViewModel("x", mock)
        vm.load()
        assertNull(vm.permissions.value)
    }

    @Test
    fun wordsNameStuckWork() {
        assertTrue(PermissionWords.outcome(PermissionRevokeResult(1, stuckWork = listOf("a build"))).contains("a build"))
    }
}
