import XCTest
@testable import FlagshipCore

/// The Swift PQ half of security notices against
/// packages/protocol/test-vectors/security-notice/pq-vectors.json.
final class SecurityNoticePqVectorTests: XCTestCase {
    private func root() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("packages/protocol").path) { return dir }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("repo root not found above \(#filePath)")
    }

    func testEveryCaseUnderBothPins() throws {
        let url = try root().appendingPathComponent("packages/protocol/test-vectors/security-notice/pq-vectors.json")
        let v = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let auth = v["authorityKeys"] as! [String]
        let pinned = v["pinnedKeyIds"] as! [String]
        for c in v["cases"] as! [[String: Any]] {
            let expect = c["expect"] as! [String: String]
            func verdict(_ pin: [String]) -> String {
                guard let n = SecurityNotice.parse(c["notice"]) else { return "malformed" }
                return SecurityNoticeVerifier.verify(n, authorityKeys: auth, pqKeyIds: pin)?.rawValue ?? "ok"
            }
            XCTAssertEqual(verdict([]), expect["emptyPin"], "\(c["name"]!) empty pin")
            XCTAssertEqual(verdict(pinned), expect["pinned"], "\(c["name"]!) pinned")
        }
    }

    func testTheBakedPinMatchesTheProtocolPin() throws {
        let src = try String(contentsOf: try root().appendingPathComponent("packages/protocol/src/releasePqPin.ts"), encoding: .utf8)
        let block = try XCTUnwrap(src.range(of: #"keyIds: Object\.freeze\(\[([^\]]*)\]\)"#, options: .regularExpression).map { String(src[$0]) })
        let ids = block.components(separatedBy: "\"").enumerated().filter { $0.offset % 2 == 1 }.map(\.element)
        XCTAssertEqual(ids, ReleasePqPin.keyIds)
    }
}
