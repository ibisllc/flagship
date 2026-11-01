import XCTest
@testable import FlagshipAPI

/// The server page's Runtime section against the webapp's presentation,
/// `packages/protocol/test-vectors/runtime-verification/vectors.json`, loaded from disk.
final class RuntimeVerificationVectorTests: XCTestCase {

    private func cases() throws -> [[String: Any]] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/runtime-verification/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
                return try XCTUnwrap(root["cases"] as? [[String: Any]])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    /// Decodes the case's view inside a server-detail answer, the way the app receives it.
    private func decode(_ view: Any) throws -> RuntimeVerificationView? {
        var detail: [String: Any] = [
            "serverFqdn": "home.harry.flagship.services", "username": "harry", "daemonVersion": "0.3.0",
            "startedAt": 1, "uptimeMs": 2, "serviceCount": 0, "pairedSessionCount": 0, "recentInstallEvents": [],
        ]
        if !(view is NSNull) { detail["runtime"] = view }
        let data = try JSONSerialization.data(withJSONObject: detail)
        return try JSONDecoder().decode(ServerDetailResponse.self, from: data).runtime
    }

    private func pill(_ p: RuntimeVerificationView.Pill) -> [String: String] { ["tone": p.tone.rawValue, "label": p.label] }

    func test_everyCaseMatchesTheWebapp() throws {
        let all = try cases()
        XCTAssertGreaterThanOrEqual(all.count, 10)
        for c in all {
            let name = c["name"] as? String ?? "?"
            let expect = try XCTUnwrap(c["expect"] as? [String: Any])
            let v = try decode(c["view"] ?? NSNull())
            let present = v?.isUsable ?? false
            XCTAssertEqual(present, expect["present"] as? Bool, name)
            guard present, let v else { continue }
            XCTAssertEqual(v.platform, expect["platform"] as? String, name)
            XCTAssertEqual(pill(v.flagshipStatus), expect["flagship"] as? [String: String], name)
            XCTAssertEqual(pill(v.upstreamStatus), expect["upstream"] as? [String: String], name)
            XCTAssertEqual(pill(v.localStatus), expect["local"] as? [String: String], name)
            XCTAssertEqual(v.notes.map { ["tone": $0.tone.rawValue, "text": $0.text] },
                           expect["notes"] as? [[String: String]], name)
            XCTAssertEqual(v.commands.map { ["title": $0.title, "text": $0.text] },
                           expect["commands"] as? [[String: String]], name)
        }
    }

    func test_aMalformedSectionStillLetsThePageLoad() throws {
        let v = try decode(["version": 3, "flagship": ["status": 1]])
        XCTAssertEqual(v?.isUsable, false)
    }
}
