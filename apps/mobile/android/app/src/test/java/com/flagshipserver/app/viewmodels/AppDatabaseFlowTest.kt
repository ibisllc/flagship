// The owner's Database section (docs/app-apis.md §6) against the mock box:
// who sees the entry, the tables, paging, CSV export, read-only queries, the
// needsGrant → signed resend, and the 409 re-sign.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppDbQueryRequest
import com.flagshipserver.app.api.AppDbQueryResult
import com.flagshipserver.app.api.AppDbRefusal
import com.flagshipserver.app.api.AppDbRows
import com.flagshipserver.app.api.AppDbTable
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.AppDbWrite
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.ServerKeys
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppDatabaseFlowTest {
    private val seed = ServerKeys.deriveProtocolIrkSeed(ByteArray(32) { 0x2a })
    private val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
    private val issuedAt = 1_700_000_000_000L
    private val plants = "bright-maple--plants"
    private val home = "home.bright-maple.flagship.services"

    private fun mock() = MockScreensClient(simulatedLatencyMs = 0)

    private fun queryVm(client: ScreensClient, reasons: MutableList<String> = mutableListOf(), clock: () -> Long = { issuedAt }) =
        AppDbQueryViewModel(plants, "default", client, "Plants", signer = { r -> reasons += r; Ed25519Sign(seed) }, now = clock)

    // ---- who sees it ----

    @Test fun entry_ownerOnly_andOnlyForAnAppWithPostgres() = runTest {
        val detail = mock().appDetail(plants)
        assertTrue(AppDatabaseViewModel.showsEntry(detail, restricted = false))
        assertFalse(AppDatabaseViewModel.showsEntry(detail, restricted = true))
        val filesOnly = detail.copy(dataLayerInstances = listOf(com.flagshipserver.app.api.AppDetailResponse.DataLayerInstance("files", "default")))
        assertFalse(AppDatabaseViewModel.showsEntry(filesOnly, restricted = false))
        assertFalse(AppDatabaseViewModel.showsEntry(detail.copy(dataLayerInstances = emptyList()), restricted = false))
    }

    @Test fun anOlderBox_404_hidesTheSection() = runTest {
        val m = mock().apply { dbFixture.remove(plants) }
        val vm = AppDatabaseViewModel(plants, m)
        vm.load()
        assertEquals(AppDatabaseViewModel.Phase.Hidden, vm.phase.value)
    }

    @Test fun aCompanionSession_403_hidesTheSection() = runTest {
        val m = mock().apply { dbError = ScreensError.Http(403, """{"error":"companion-write-not-allowed"}""") }
        val vm = AppDatabaseViewModel(plants, m)
        vm.load()
        assertEquals(AppDatabaseViewModel.Phase.Hidden, vm.phase.value)
    }

    @Test fun anUnreachableDatabaseIsAFailure_notHidden() = runTest {
        val m = mock().apply { dbError = ScreensError.Http(503, """{"error":"connection refused"}""") }
        val vm = AppDatabaseViewModel(plants, m)
        vm.load()
        assertEquals(
            AppDatabaseViewModel.Phase.Failed("The database isn't reachable right now. Try again in a moment."),
            vm.phase.value,
        )
    }

    // ---- the tables ----

    @Test fun listsEachStoresTables() = runTest {
        val vm = AppDatabaseViewModel(plants, mock())
        vm.load()
        val stores = (vm.phase.value as AppDatabaseViewModel.Phase.Loaded).stores
        assertEquals(listOf("default"), stores.map { it.store })
        assertEquals(listOf("plants", "waterings"), stores.single().tables.map { it.name })
        assertEquals("2 tables", AppDatabaseViewModel.summaryText(stores))
        assertEquals("about 230 rows", AppDatabaseViewModel.rowsText(stores.single().tables[0]))
    }

    @Test fun tableCopy() {
        assertEquals("rows unknown", AppDatabaseViewModel.rowsText(AppDbTable("t", "table", null, 0.0)))
        assertEquals("view", AppDatabaseViewModel.rowsText(AppDbTable("v", "view", null, 0.0)))
        assertEquals("about 1 row", AppDatabaseViewModel.rowsText(AppDbTable("t", "table", 1.0, 0.0)))
        assertEquals("about 12,345 rows", AppDatabaseViewModel.rowsText(AppDbTable("t", "table", 12345.0, 0.0)))
        assertEquals("16 KB", AppDatabaseViewModel.sizeText(16384.0))
        assertEquals("1.5 MB", AppDatabaseViewModel.sizeText(1.5 * 1024 * 1024))
        assertEquals("NULL", AppDatabaseViewModel.cellText(JsonNull))
        assertEquals("true", AppDatabaseViewModel.cellText(JsonPrimitive(true)))
        assertEquals("9007199254740993", AppDatabaseViewModel.cellText(JsonPrimitive("9007199254740993")))
        assertEquals("my_table.csv", AppDbTableViewModel.csvFileName("my table"))
        assertEquals("app.items.csv", AppDbTableViewModel.csvFileName("app.items"))
    }

    @Test fun wireShapesDecode() {
        val json = Json { ignoreUnknownKeys = true; classDiscriminator = "kind" }
        val rows = json.decodeFromString(
            AppDbRows.serializer(),
            """{"columns":[{"name":"id","type":"bigint"},{"name":"done","type":"boolean"},{"name":"note","type":"text"}],"rows":[["1",true,null]],"total":1}""",
        )
        assertEquals(listOf("1", "true", "NULL"), rows.rows.single().map { AppDatabaseViewModel.cellText(it) })
        val overview = json.decodeFromString(
            com.flagshipserver.app.api.AppDbOverview.serializer(),
            """{"stores":[{"store":"default","tables":[{"name":"items","kind":"table","rows":null,"bytes":8192},{"name":"app.v","kind":"view","rows":null,"bytes":0}]}]}""",
        )
        assertEquals(listOf("items", "app.v"), overview.stores.single().tables.map { it.name })
        val refusal = json.decodeFromString(
            AppDbRefusal.serializer(),
            """{"error":"cannot execute UPDATE in a read-only transaction","sqlState":"25006","needsGrant":true}""",
        )
        assertTrue(refusal.needsGrant)
        // An unsigned run sends only the SQL.
        val wire = Json { encodeDefaults = true; explicitNulls = false }
        assertEquals("""{"sql":"SELECT 1"}""", wire.encodeToString(AppDbQueryRequest.serializer(), AppDbQueryRequest("SELECT 1")))
    }

    @Test fun pages100AtATime() = runTest {
        val m = mock()
        val vm = AppDbTableViewModel(plants, "default", "plants", m)
        vm.load(0)
        assertEquals(100, vm.page.value!!.rows.size)
        assertEquals(230, vm.page.value!!.total)
        assertEquals("Rows 1–100 of 230", vm.rangeText())
        assertFalse(vm.hasPrevious)
        assertTrue(vm.hasNext)
        assertEquals(listOf("id", "name", "watered"), vm.page.value!!.columns.map { it.name })
        assertEquals("integer", vm.page.value!!.columns[0].type)

        vm.next()
        vm.next()
        assertEquals(200, vm.offset.value)
        assertEquals("Rows 201–230 of 230", vm.rangeText())
        assertFalse(vm.hasNext)
        vm.next() // no further page
        vm.previous()
        assertEquals("Rows 101–200 of 230", vm.rangeText())
        assertEquals(listOf(0 to 100, 100 to 100, 200 to 100, 100 to 100), m.dbTableCalls.map { it.third })
    }

    @Test fun exportsCsv_tooBigSaysHow() = runTest {
        val m = mock()
        val vm = AppDbTableViewModel(plants, "default", "waterings", m)
        val csv = String(vm.exportCsv()!!)
        assertTrue(csv.startsWith("id,plant_id,at\n1,3,"))

        val big = object : ScreensClient by m {
            override suspend fun serviceDbExportCsv(serviceId: String, store: String, table: String): ByteArray =
                throw ScreensError.Http(413, """{"error":"the table is over 64 MB as CSV"}""")
        }
        val vm2 = AppDbTableViewModel(plants, "default", "plants", big)
        assertNull(vm2.exportCsv())
        assertEquals("This table is too big to export in one file. Export it in parts with a query.", vm2.error.value)
    }

    // ---- Run SQL ----

    @Test fun aReadRunsUnsigned() = runTest {
        val m = mock()
        val vm = queryVm(m, clock = { error("a read never signs") })
        vm.run("SELECT * FROM plants")
        val done = vm.phase.value as AppDbQueryViewModel.Phase.Done
        assertFalse(done.signed)
        assertEquals(230, done.result.rows.size)
        assertEquals("SELECT · 230 rows", AppDbQueryViewModel.summaryText(done.result))
        assertNull(AppDbQueryViewModel.truncatedText(done.result))
        val sent = m.dbQueries.single().second
        assertNull(sent.grant)
        assertNull(sent.signature)
    }

    @Test fun aWrite_asksFirst_thenSignsForThePairedBox_andResends() = runTest {
        val m = mock()
        val reasons = mutableListOf<String>()
        val vm = queryVm(m, reasons)
        val sql = "UPDATE plants SET watered = true WHERE id = 7;"
        vm.run(sql)
        assertEquals(AppDbQueryViewModel.Phase.NeedsGrant(sql), vm.phase.value)
        assertTrue(reasons.isEmpty())
        assertEquals("This changes data. Confirm with your fingerprint, face or screen lock to run it.", AppDbQueryViewModel.NEEDS_GRANT)

        vm.confirmWrite()
        val done = vm.phase.value as AppDbQueryViewModel.Phase.Done
        assertTrue(done.signed)
        assertEquals("UPDATE · 1 row", AppDbQueryViewModel.summaryText(done.result))
        assertEquals(listOf("Change the data in Plants"), reasons)

        val (id, req) = m.dbQueries.last()
        val g = req.grant!!
        assertEquals(plants, id)
        assertEquals(sql, req.sql)
        assertEquals(home, g.serverDomain)
        assertEquals(plants, g.serviceId)
        assertEquals("default", g.store)
        assertEquals(AppDbWrite.sqlSha256(sql), g.sqlSha256)
        assertEquals(issuedAt, g.issuedAt)
        Ed25519Verify(pub).verify(
            HexUtil.decode(req.signature!!)!!,
            "flagship/app-db-write/v1|$home|$plants|default|${g.sqlSha256}|$issuedAt".toByteArray(),
        )
    }

    @Test fun theGrantNamesTheClientsBox_evenWhenTheFallbackDiffers() = runTest {
        val cabin = mock().apply { podContext = "cabin" }
        val vm = AppDbQueryViewModel(
            plants, "default", cabin, "Plants",
            fallbackServerDomain = { home },
            signer = { Ed25519Sign(seed) }, now = { issuedAt },
        )
        vm.run("DELETE FROM plants WHERE id = 1")
        vm.confirmWrite()
        assertTrue(vm.phase.value is AppDbQueryViewModel.Phase.Done)
        assertEquals("cabin.bright-maple.flagship.services", cabin.dbQueries.last().second.grant!!.serverDomain)
    }

    @Test fun a409_signsAgainWithANewIssuedAt() = runTest {
        val m = mock()
        var conflicts = 1
        val box = object : ScreensClient by m {
            override suspend fun serviceDbQuery(serviceId: String, store: String, req: AppDbQueryRequest): AppDbQueryResult {
                if (req.grant != null && conflicts-- > 0) {
                    m.dbQueries.add(serviceId to req)
                    throw ScreensError.Http(409, """{"error":"this signed order was already used: sign it again"}""")
                }
                return m.serviceDbQuery(serviceId, store, req)
            }
        }
        val vm = queryVm(box) // the clock stands still
        vm.run("DELETE FROM waterings")
        vm.confirmWrite()
        assertTrue(vm.phase.value is AppDbQueryViewModel.Phase.Done)
        val signed = m.dbQueries.mapNotNull { it.second.grant }
        assertEquals(2, signed.size)
        assertNotEquals(signed[0].issuedAt, signed[1].issuedAt)
    }

    @Test fun aRepeated409_isShown() = runTest {
        val m = mock()
        val box = object : ScreensClient by m {
            override suspend fun serviceDbQuery(serviceId: String, store: String, req: AppDbQueryRequest): AppDbQueryResult =
                if (req.grant != null) throw ScreensError.Http(409, """{"error":"used"}""") else m.serviceDbQuery(serviceId, store, req)
        }
        val vm = queryVm(box)
        vm.run("DELETE FROM waterings")
        vm.confirmWrite()
        assertEquals(
            AppDbQueryViewModel.Phase.Failed("That signed order was already used. Run it again to sign a new one."),
            vm.phase.value,
        )
    }

    @Test fun errorsAndRefusals() = runTest {
        val m = mock()
        val vm = queryVm(m)
        vm.run("SELECT * FROM nope")
        assertEquals(
            AppDbQueryViewModel.Phase.Failed("relation \"nope\" does not exist (SQLSTATE 42P01, at character 15)"),
            vm.phase.value,
        )
        vm.run("   ")
        assertEquals(AppDbQueryViewModel.Phase.Failed(AppDbQueryViewModel.SQL_REQUIRED), vm.phase.value)

        val stale = object : ScreensClient by m {
            override suspend fun serviceDbQuery(serviceId: String, store: String, req: AppDbQueryRequest): AppDbQueryResult =
                if (req.grant != null) throw ScreensError.Http(403, """{"error":"the order is stale: sign it again"}""")
                else m.serviceDbQuery(serviceId, store, req)
        }
        val vm2 = queryVm(stale)
        vm2.run("TRUNCATE plants")
        vm2.confirmWrite()
        assertEquals(
            AppDbQueryViewModel.Phase.Failed(
                "The server refused this change: the order is stale: sign it again. Check this phone's clock and try again.",
            ),
            vm2.phase.value,
        )
    }

    @Test fun aKeyThatWontUnlock_sendsNothing_andCancelLeavesItUnsent() = runTest {
        val m = mock()
        val vm = AppDbQueryViewModel(plants, "default", m, "Plants", signer = { throw IllegalStateException("cancelled") })
        vm.run("DELETE FROM plants")
        vm.confirmWrite()
        assertEquals(AppDbQueryViewModel.Phase.Failed("Couldn't access your account key: cancelled"), vm.phase.value)
        assertTrue(m.dbQueries.none { it.second.grant != null })

        vm.run("DELETE FROM plants")
        vm.cancelWrite()
        assertEquals(AppDbQueryViewModel.Phase.Idle, vm.phase.value)
        vm.confirmWrite() // nothing to confirm
        assertEquals(AppDbQueryViewModel.Phase.Idle, vm.phase.value)
    }

    @Test fun aTruncatedResultSaysSo() {
        val r = AppDbQueryResult("SELECT", rows = List(1000) { emptyList() }, rowCount = 1000, truncated = true)
        assertEquals(
            "Showing the first 1000 rows. There are more: narrow the query to see them.",
            AppDbQueryViewModel.truncatedText(r),
        )
    }
}
