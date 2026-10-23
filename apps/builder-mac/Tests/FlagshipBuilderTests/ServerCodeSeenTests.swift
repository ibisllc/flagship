import XCTest
@testable import FlagshipBuilderCore

final class ServerCodeSeenTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<10 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/enrollment/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found")
    }

    private func unhex(_ h: String) -> Data {
        var d = Data(); var i = h.startIndex
        while i < h.endIndex { let n = h.index(i, offsetBy: 2); d.append(UInt8(h[i..<n], radix: 16)!); i = n }
        return d
    }

    func testTheMacMatchesTheSharedVectors() throws {
        let v = try vectors()
        let key = unhex(v["studioConfirmKeyHex"] as! String)
        for s in v["seen"] as! [[String: String]] {
            XCTAssertEqual(ServerCodeSeen.macHex(studioConfirmKey: key, serverDomain: s["serverDomain"]!, stkPubHex: s["stkPubHex"]!), s["macHex"])
        }
        XCTAssertNil(ServerCodeSeen.macHex(studioConfirmKey: Data(count: 16), serverDomain: "home.alice.flagship.services", stkPubHex: String(repeating: "ab", count: 32)))
    }

    func testOnlyThisServersWellFormedLineCounts() {
        let key = String(repeating: "ab", count: 32)
        XCTAssertEqual(ServerCodeSeen.parse("flagship-server-code Home.Alice.flagship.services 482913 \(key)\n", serverDomain: "home.alice.flagship.services"),
                       .init(code: "482913", stkPubHex: key))
        XCTAssertNil(ServerCodeSeen.parse("flagship-server-code home.bob.flagship.services 482913 \(key)", serverDomain: "home.alice.flagship.services"))
        XCTAssertNil(ServerCodeSeen.parse("flagship-server-code home.alice.flagship.services 48291 \(key)", serverDomain: "home.alice.flagship.services"))
        XCTAssertNil(ServerCodeSeen.parse("flagship-server-code home.alice.flagship.services 482913 \(key.uppercased())", serverDomain: "home.alice.flagship.services"))
        XCTAssertNil(ServerCodeSeen.parse("If your phone asks, this server's code is 482 913", serverDomain: "home.alice.flagship.services"))
        XCTAssertEqual(ServerCodeSeen.pretty("482913"), "482 913")
    }

    func testLinesSplitAcrossReadsAndAnOverlongLineIsDropped() {
        var s = ConsoleLineSplitter(maxLine: 32)
        XCTAssertEqual(s.feed(Data("flagship-ser".utf8)), [])
        XCTAssertEqual(s.feed(Data("ver-code x\nnext".utf8)), ["flagship-server-code x"])
        XCTAssertEqual(s.feed(Data(String(repeating: "z", count: 64).utf8)), [])
        XCTAssertEqual(s.feed(Data("ok\n".utf8)), ["ok"])
    }

    func testTheKeyLivesBesideTheBundleOnlyUntilDeleted() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let layout = VMBundleLayout(root: root)
        try FileManager.default.createDirectory(at: layout.bundleDir("home.alice.flagship.services"), withIntermediateDirectories: true)
        let key = Data(repeating: 0x88, count: 32)
        try StudioConfirmKeyFile.write(key, layout: layout, name: "home.alice.flagship.services")
        let attrs = try FileManager.default.attributesOfItem(atPath: StudioConfirmKeyFile.url(layout: layout, name: "home.alice.flagship.services").path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertEqual(StudioConfirmKeyFile.read(layout: layout, name: "home.alice.flagship.services"), key)
        StudioConfirmKeyFile.delete(layout: layout, name: "home.alice.flagship.services")
        XCTAssertNil(StudioConfirmKeyFile.read(layout: layout, name: "home.alice.flagship.services"))
        try? FileManager.default.removeItem(at: root)
    }
}
