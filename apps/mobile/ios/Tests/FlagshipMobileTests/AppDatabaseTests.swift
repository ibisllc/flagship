import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipUI
import FlagshipCore

/// The owner's Database section (docs/app-apis.md §6) on iOS: the entry on
/// the app's page, tables, paged rows, Export CSV, and Run SQL with the
/// signed write order.
@MainActor
final class AppDatabaseTests: XCTestCase {

    private let plants = "bright-maple--plants"

    private func makeClient(pod: String = "home") -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        c.podContext = pod
        return c
    }

    // MARK: - Wire

    func test_decodesTheBoxAnswers() throws {
        let stores = try JSONDecoder().decode(AppDbStoresResponse.self, from: Data(#"""
            {"stores":[{"store":"default","tables":[{"name":"items","kind":"table","rows":12,"bytes":16384},
                                                     {"name":"audit.log_view","kind":"view","rows":null,"bytes":0}]}]}
            """#.utf8))
        XCTAssertEqual(stores.stores.first?.tables.map(\.name), ["items", "audit.log_view"])
        XCTAssertEqual(stores.stores.first?.tables.last?.rows, nil)
        XCTAssertEqual(stores.stores.first?.tables.last?.isView, true)

        let rows = try JSONDecoder().decode(AppDbTableRows.self, from: Data(#"""
            {"columns":[{"name":"id","type":"int4"},{"name":"big","type":"int8"},{"name":"ok","type":"bool"},
                        {"name":"n","type":"float8"},{"name":"note","type":"text"},{"name":"j","type":"jsonb"}],
             "rows":[[1,"9007199254740993",true,1.5,null,{"a":[1]}]],"total":1}
            """#.utf8))
        let r = try XCTUnwrap(rows.rows.first)
        XCTAssertEqual(r[0], .int(1))
        XCTAssertEqual(r[1], .string("9007199254740993"), "bigint stays a string")
        XCTAssertEqual(r[2], .bool(true))
        XCTAssertEqual(r[3].display, "1.5")
        XCTAssertEqual(r[4], .null)
        XCTAssertEqual(r[4].display, "NULL")
        XCTAssertEqual(r[5].display, #"{"a":[1]}"#)
        XCTAssertEqual(AppDbValue.bool(false).display, "false")

        let q = try JSONDecoder().decode(AppDbQueryResult.self, from: Data(
            #"{"command":"DELETE","columns":[],"rows":[],"rowCount":null,"truncated":false}"#.utf8))
        XCTAssertEqual(q.command, "DELETE")
        XCTAssertNil(q.rowCount)

        let refusal = AppDbRefusal.decode(#"{"error":"cannot execute UPDATE in a read-only transaction","sqlState":"25006","needsGrant":true}"#)
        XCTAssertEqual(refusal?.needsGrant, true)
        XCTAssertEqual(refusal?.sqlState, "25006")
    }

    func test_pathSegmentsAreFullyEscaped() {
        XCTAssertEqual(LiveScreensClient.pathSegment("audit.log"), "audit.log")
        XCTAssertEqual(LiveScreensClient.pathSegment("a/b?c#d e"), "a%2Fb%3Fc%23d%20e")
        XCTAssertEqual(LiveScreensClient.pathSegment("café"), "caf%C3%A9")
    }

    func test_copy() {
        XCTAssertEqual(AppDbCopy.pageLabel(offset: 100, count: 100, total: 1234), "Rows 101–200 of 1,234")
        XCTAssertEqual(AppDbCopy.pageLabel(offset: 0, count: 0, total: 0), "No rows")
        XCTAssertEqual(AppDbCopy.resultSummary(AppDbQueryResult(command: "UPDATE", rowCount: 3)), "UPDATE · 3 rows")
        XCTAssertEqual(AppDbCopy.resultSummary(AppDbQueryResult(command: "INSERT", rowCount: 1)), "INSERT · 1 row")
        XCTAssertTrue(AppDbCopy.tableDetail(AppDbTable(name: "t", rows: 1200, bytes: 2048)).hasPrefix("~1,200 rows"))
        XCTAssertEqual(AppDbCopy.tableDetail(AppDbTable(name: "v", kind: "view", rows: nil, bytes: 0)), "View")
        XCTAssertEqual(AppDbTableController.csvFilename("audit.log"), "audit.log.csv")
        XCTAssertEqual(AppDbTableController.csvFilename("my table/2"), "my_table_2.csv")
        XCTAssertEqual(AppDbTableController.csvFilename("///"), "_.csv")
    }

    // MARK: - The entry on the app's page

    private func detail(_ client: MockScreensClient, restricted: Bool = false,
                        serviceId: String = "bright-maple--plants") -> ServiceDetailViewModel {
        ServiceDetailViewModel(serviceId: serviceId, client: client, allPods: [],
                               serverDomain: "home.bright-maple.flagship.services",
                               egressSigner: { _ in Curve25519.Signing.PrivateKey() },
                               accessCanChange: !restricted)
    }

    func test_entry_showsForTheOwnerOfAnAppWithPostgres() async {
        let vm = detail(makeClient())
        await vm.load()
        XCTAssertTrue(vm.showsDatabase)
        XCTAssertEqual(vm.database?.tableCount, 2)
    }

    func test_entry_hiddenOnARestrictedProfile_withoutAsking() async {
        let client = makeClient()
        let vm = detail(client, restricted: true)
        await vm.load()
        XCTAssertFalse(vm.showsDatabase)
        XCTAssertNil(vm.database)
    }

    func test_entry_hiddenWhenTheBoxRefusesACompanion() async {
        let client = makeClient()
        client.mockDbStatus = 403
        let vm = detail(client)
        await vm.load()
        XCTAssertFalse(vm.showsDatabase)
    }

    func test_entry_hiddenOnAnOlderBox() async {
        let client = makeClient()
        client.mockDb = [:]
        let vm = detail(client)
        await vm.load()
        XCTAssertFalse(vm.showsDatabase)
        XCTAssertEqual(vm.database?.isHidden, true)
    }

    func test_entry_stillShowsWhenTheDatabaseIsDown() async {
        let client = makeClient()
        client.mockDbStatus = 503
        let vm = detail(client)
        await vm.load()
        XCTAssertTrue(vm.showsDatabase, "the screen explains the outage")
        guard case .failed(let msg)? = vm.database?.state else { return XCTFail("expected a failure") }
        XCTAssertTrue(msg.contains("isn't reachable"))
    }

    // MARK: - Tables and rows

    func test_tables_listEachStore() async throws {
        let c = AppDatabaseController(serviceId: plants, client: makeClient())
        await c.load()
        let store = try XCTUnwrap(c.stores.first)
        XCTAssertEqual(store.store, "default")
        XCTAssertEqual(store.tables.map(\.name), ["plants", "waterings"])
        XCTAssertEqual(store.tables.first?.rows, 240)
    }

    func test_rows_pageA100AtATime() async throws {
        let client = makeClient()
        let t = AppDbTableController(serviceId: plants, store: "default", table: "plants", client: client)
        await t.load()
        XCTAssertEqual(t.page?.rows.count, 100)
        XCTAssertEqual(t.page?.columns.map(\.type), ["int4", "text", "text", "bool"])
        XCTAssertEqual(t.pageLabel, "Rows 1–100 of 240")
        XCTAssertFalse(t.hasPrevious)
        XCTAssertTrue(t.hasNext)
        await t.next()
        XCTAssertEqual(t.offset, 100)
        XCTAssertEqual(t.page?.rows.first?.first, .int(101))
        await t.next()
        XCTAssertEqual(t.pageLabel, "Rows 201–240 of 240")
        XCTAssertFalse(t.hasNext)
        await t.next()
        XCTAssertEqual(t.offset, 200, "no page past the end")
        await t.previous()
        XCTAssertEqual(t.offset, 100)
        XCTAssertEqual(client.serviceDbTableRowsCalls.map(\.offset), [0, 100, 200, 100])
        XCTAssertTrue(client.serviceDbTableRowsCalls.allSatisfy { $0.limit == 100 })
    }

    func test_rows_unknownTable() async {
        let t = AppDbTableController(serviceId: plants, store: "default", table: "nope", client: makeClient())
        await t.load()
        guard case .failed(let msg) = t.state else { return XCTFail("expected failure") }
        XCTAssertTrue(msg.lowercased().contains("not found"))
    }

    func test_exportCsv_writesAFileForTheShareSheet() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("dbtest-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let client = makeClient()
        let t = AppDbTableController(serviceId: plants, store: "default", table: "plants", client: client,
                                     exportDirectory: dir)
        let exported = await t.exportCsv()
        let url = try XCTUnwrap(exported)
        XCTAssertEqual(url.lastPathComponent, "plants.csv")
        XCTAssertEqual(t.exportedFile, url)
        let text = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(text.hasPrefix("id,name,room,thirsty\n1,Plant 1,Hall,false\n"))
        XCTAssertEqual(client.serviceDbExportCalls, ["plants"])
        t.finishExport()
        XCTAssertNil(t.exportedFile)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    // MARK: - Run SQL

    private func query(_ client: MockScreensClient, key: Curve25519.Signing.PrivateKey,
                       prompts: (() -> Void)? = nil,
                       fallback: String? = "home.bright-maple.flagship.services") -> AppDbQueryController {
        AppDbQueryController(serviceId: plants, store: "default", appName: "Plants", client: client,
                             serverDomain: fallback, signer: { _ in prompts?(); return key })
    }

    func test_read_runsUnsigned() async throws {
        let client = makeClient()
        var prompts = 0
        let q = query(client, key: Curve25519.Signing.PrivateKey(), prompts: { prompts += 1 })
        q.sql = "SELECT * FROM waterings"
        await q.run()
        let r = try XCTUnwrap(q.result)
        XCTAssertEqual(r.command, "SELECT")
        XCTAssertEqual(r.rows.count, 2)
        XCTAssertFalse(r.truncated)
        XCTAssertEqual(prompts, 0)
        XCTAssertNil(client.serviceDbQueryCalls.last?.req.grant)
        XCTAssertNil(client.serviceDbQueryCalls.last?.req.signature)
    }

    func test_read_showsPostgresErrors() async {
        let q = query(makeClient(), key: Curve25519.Signing.PrivateKey())
        q.sql = "SELECT * FROM missing"
        await q.run()
        XCTAssertEqual(q.phase, .failed(#"relation "missing" does not exist"#))
    }

    func test_write_needsGrant_thenFaceID_signsTheExactStatementForThisBox() async throws {
        let client = makeClient(pod: "home2")
        let key = Curve25519.Signing.PrivateKey()
        client.mockDbVerifyKey = key.publicKey.rawRepresentation
        var prompts = 0
        // The fallback names the leader; the order must name the box the
        // client talks to (home2).
        let q = query(client, key: key, prompts: { prompts += 1 }, fallback: "home.bright-maple.flagship.services")
        let sql = "UPDATE plants SET thirsty = false WHERE id = 7;"
        q.sql = sql
        await q.run()
        XCTAssertEqual(q.phase, .needsConfirm)
        XCTAssertEqual(prompts, 0, "nothing is signed until the owner confirms")
        XCTAssertEqual(client.serviceDbQueryCalls.count, 1)

        await q.confirmWrite()
        XCTAssertEqual(prompts, 1)
        let r = try XCTUnwrap(q.result, "\(q.phase)")
        XCTAssertEqual(r.command, "UPDATE")
        XCTAssertEqual(r.rowCount, 1)
        let req = try XCTUnwrap(client.serviceDbQueryCalls.last?.req)
        let grant = try XCTUnwrap(req.grant)
        XCTAssertEqual(req.sql, sql)
        XCTAssertEqual(grant.serverDomain, "home2.bright-maple.flagship.services")
        XCTAssertEqual(grant.serviceId, plants)
        XCTAssertEqual(grant.store, "default")
        XCTAssertEqual(grant.sqlSha256, AppDbWriteGrant.sqlSha256(sql))
        XCTAssertTrue(key.publicKey.isValidSignature(HexUtil.decode(req.signature!)!, for: grant.canonicalBytes()))
    }

    func test_write_cancelSendsNothing_andEditingDropsTheConfirm() async {
        let client = makeClient()
        let q = query(client, key: Curve25519.Signing.PrivateKey())
        q.sql = "DELETE FROM plants"
        await q.run()
        XCTAssertEqual(q.phase, .needsConfirm)
        q.cancelConfirm()
        XCTAssertEqual(q.phase, .idle)
        await q.run()
        XCTAssertEqual(q.phase, .needsConfirm)
        q.sql = "DELETE FROM plants WHERE id = 1"
        XCTAssertEqual(q.phase, .idle, "a changed statement must be run (and confirmed) again")
        await q.confirmWrite()
        XCTAssertEqual(client.serviceDbQueryCalls.filter { $0.req.grant != nil }.count, 0)
    }

    func test_write_409ReSignsWithANewIssuedAt() async throws {
        let client = makeClient()
        let key = Curve25519.Signing.PrivateKey()
        client.mockDbVerifyKey = key.publicKey.rawRepresentation
        client.mockDbForceReplays = 1
        var prompts = 0
        let q = query(client, key: key, prompts: { prompts += 1 })
        q.sql = "DELETE FROM waterings"
        await q.run()
        await q.confirmWrite()
        XCTAssertEqual(q.result?.command, "DELETE", "\(q.phase)")
        let signed = client.serviceDbQueryCalls.compactMap(\.req.grant)
        XCTAssertEqual(signed.count, 2)
        XCTAssertGreaterThan(signed[1].issuedAt, signed[0].issuedAt)
        XCTAssertEqual(prompts, 1, "the re-sign reuses the key from the one Face ID")
    }

    func test_write_aSecond409GivesUp() async {
        let client = makeClient()
        client.mockDbForceReplays = 2
        let q = query(client, key: Curve25519.Signing.PrivateKey())
        q.sql = "DELETE FROM waterings"
        await q.run()
        await q.confirmWrite()
        guard case .failed(let msg) = q.phase else { return XCTFail("expected failure, got \(q.phase)") }
        XCTAssertTrue(msg.contains("already used"))
    }

    func test_write_signerRefused() async {
        let client = makeClient()
        let q = AppDbQueryController(serviceId: plants, store: "default", appName: "Plants", client: client,
                                     serverDomain: nil, signer: { _ in throw CancellationError() })
        q.sql = "DELETE FROM waterings"
        await q.run()
        await q.confirmWrite()
        guard case .failed(let msg) = q.phase else { return XCTFail("expected failure") }
        XCTAssertTrue(msg.contains("account key"))
        XCTAssertTrue(client.serviceDbQueryCalls.allSatisfy { $0.req.grant == nil })
    }

    func test_signedOrderIsGoodOnce() async throws {
        // The box (mock) refuses a replayed order: what the 409 re-sign is for.
        let client = makeClient()
        let key = Curve25519.Signing.PrivateKey()
        let domain = await client.boxDomain()!
        let req = try AppDbOrder.signed(sql: "DELETE FROM waterings", serviceId: plants, store: "default",
                                        serverDomain: domain, key: key, issuedAt: Int64(Date().timeIntervalSince1970 * 1000))
        _ = try await client.serviceDbQuery(serviceId: plants, store: "default", req)
        do {
            _ = try await client.serviceDbQuery(serviceId: plants, store: "default", req)
            XCTFail("a replay must fail")
        } catch ScreensClientError.http(let status, _) {
            XCTAssertEqual(status, 409)
        }
    }
}
