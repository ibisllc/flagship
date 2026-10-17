import XCTest
import SwiftUI
@testable import FlagshipUI

/// The iOS polish rules (docs: scratchpad polish pass, AGENTS.md owner decision
/// 2026-10-17): text follows Dynamic Type, no hand-typed all-caps section
/// labels, and user-facing text says "server", not "box". They are source
/// scans plus the type scale, so a regression fails here and not on a phone.
final class PolishRulesTests: XCTestCase {

    private func uiSources() throws -> [(path: String, text: String)] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("Sources/FlagshipUI")
            if FileManager.default.fileExists(atPath: candidate.path) {
                let files = FileManager.default.enumerator(at: candidate, includingPropertiesForKeys: nil)?
                    .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
                return try files.map { ($0.path, try String(contentsOf: $0, encoding: .utf8)) }
            }
            dir.deleteLastPathComponent()
        }
        throw XCTSkip("Sources/FlagshipUI not found above \(#filePath)")
    }

    func test_typeScaleMapsEverySizeToATextStyle() {
        XCTAssertEqual(FSFont.style(for: 10), .caption2)
        XCTAssertEqual(FSFont.style(for: 11), .caption2)
        XCTAssertEqual(FSFont.style(for: 12), .caption)
        XCTAssertEqual(FSFont.style(for: 13), .footnote)
        XCTAssertEqual(FSFont.style(for: 14), .subheadline)
        XCTAssertEqual(FSFont.style(for: 15), .subheadline)
        XCTAssertEqual(FSFont.style(for: 16), .callout)
        XCTAssertEqual(FSFont.style(for: 17), .body)
        XCTAssertEqual(FSFont.style(for: 20), .title3)
        XCTAssertEqual(FSFont.style(for: 22), .title2)
        XCTAssertEqual(FSFont.style(for: 28), .title)
        XCTAssertEqual(FSFont.style(for: 34), .largeTitle)
        XCTAssertNil(FSFont.style(for: 44), "the big pairing digits stay fixed")
    }

    func test_noFixedPointSizesOutsideTheTypeScale() throws {
        let allowed = ["Theme.swift", "GymProbeView.swift", "ComponentsList.swift", "WelcomeScreen.swift"]
        for (path, text) in try uiSources() where !allowed.contains(where: path.hasSuffix) {
            XCTAssertFalse(text.contains(".system(size:"),
                           "\(path) uses a fixed point size; use FS.font.scaled(...) or a text style so it follows Dynamic Type")
        }
    }

    func test_sectionLabelsAreNotHandTypedInCapitals() throws {
        let capitals = try NSRegularExpression(pattern: #"(?:Text|sectionHeader|sectionLabel|sectionWrap|section|FSSettingsGroup)\("[A-Z][A-Z &'-]{3,}""#)
        for (path, text) in try uiSources() where !path.contains("/Gym/") {
            let range = NSRange(text.startIndex..., in: text)
            XCTAssertNil(capitals.firstMatch(in: text, range: range),
                         "\(path) types a section label in capitals; use sentence case")
        }
    }

    func test_userFacingTextSaysServerNotBox() throws {
        let box = try NSRegularExpression(pattern: #"(?:Text|FSPrimaryButton|FSSecondaryButton|FSDangerButton|\.navigationTitle|toasts\.\w+|\.failed)\("[^"]*\b[Bb]ox(?:es)?\b[^"]*""#)
        for (path, text) in try uiSources() where !path.contains("/Gym/") {
            for line in text.split(separator: "\n") where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
                let s = String(line)
                if s.contains("“I have a recipe” box") { continue }
                XCTAssertNil(box.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
                             "\(path): \(s.trimmingCharacters(in: .whitespaces))")
            }
        }
    }

    func test_segmentedControlAndAdaptiveStackBuild() {
        _ = FSSegmentedControl(
            segments: [.init(value: 1, title: "One", identifier: "a"), .init(value: 2, title: "Two", identifier: "b")],
            selection: 1, onSelect: { _ in })
        _ = FSAdaptiveStack { Text("x") }
        _ = FSPressStyle()
        _ = FSRowPressStyle()
    }
}
