import XCTest
@testable import FlagshipBuilderCore

/// The `debugGrant` sibling detector must mirror the canonical engine's
/// `readSiblings`/`asStr` semantics exactly — it gates the serial console.
final class RecipeSiblingsTests: XCTestCase {

    private func data(_ obj: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: obj)
    }

    func testAbsentGrantIsNil() {
        XCTAssertNil(RecipeSiblings.debugGrant(inRecipeJSON: data(["version": 2])))
    }

    func testStringGrantPassesThrough() {
        let grant = "{\"grant\":{\"serverDomain\":\"h\"},\"signatureHex\":\"ab\"}"
        XCTAssertEqual(RecipeSiblings.debugGrant(inRecipeJSON: data(["debugGrant": grant])), grant)
    }

    func testEmptyStringGrantIsAbsent() {
        XCTAssertNil(RecipeSiblings.debugGrant(inRecipeJSON: data(["debugGrant": ""])))
    }

    func testObjectGrantIsStringified() throws {
        let raw = data(["debugGrant": ["grant": ["issuedAt": 1], "signatureHex": "ab"]])
        let s = try XCTUnwrap(RecipeSiblings.debugGrant(inRecipeJSON: raw))
        let back = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any])
        XCTAssertEqual(back["signatureHex"] as? String, "ab")
    }

    func testEnvelopeShapeReadsTheTopLevelSibling() {
        // {blob, blobSignature, debugGrant} — the sibling is TOP-level, beside
        // the blob, exactly where readSiblings(parsed) looks.
        let raw = data(["blob": ["version": 2], "blobSignature": "f1", "debugGrant": "g"])
        XCTAssertEqual(RecipeSiblings.debugGrant(inRecipeJSON: raw), "g")
    }

    func testGrantNestedInsideTheBlobOnlyDoesNotCount() {
        // Wrong layer — the engine never reads it from inside the blob.
        let raw = data(["blob": ["version": 2, "debugGrant": "g"], "blobSignature": "f1"])
        XCTAssertNil(RecipeSiblings.debugGrant(inRecipeJSON: raw))
    }

    func testNonJSONAndNonObjectInputsAreNil() {
        XCTAssertNil(RecipeSiblings.debugGrant(inRecipeJSON: Data("not json".utf8)))
        XCTAssertNil(RecipeSiblings.debugGrant(inRecipeJSON: Data("[1,2]".utf8)))
        XCTAssertNil(RecipeSiblings.debugGrant(inRecipeJSON: data(["debugGrant": 42])))
    }

    func testGoldenVectorRecipeWithGrantIsDetected() throws {
        // The shared cross-engine vectors carry a debugGrant case — the same
        // bytes the preseed engine consumes must trip the detector.
        let url = try XCTUnwrap(Bundle.module.url(forResource: "preseed-vectors", withExtension: "json"))
        let vectors = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let cases = try XCTUnwrap(vectors["vectors"] as? [[String: Any]])
        var sawGrant = false
        for c in cases {
            guard let recipeJson = c["recipeJson"] as? String else { continue }
            let detected = RecipeSiblings.debugGrant(inRecipeJSON: Data(recipeJson.utf8))
            let expected = (try? JSONSerialization.jsonObject(with: Data(recipeJson.utf8)) as? [String: Any])
                .flatMap { $0?["debugGrant"] as? String }
            if let expected, !expected.isEmpty {
                sawGrant = true
                XCTAssertEqual(detected, expected)
            } else {
                XCTAssertNil(detected)
            }
        }
        XCTAssertTrue(sawGrant, "expected at least one golden vector carrying a debugGrant")
    }
}
