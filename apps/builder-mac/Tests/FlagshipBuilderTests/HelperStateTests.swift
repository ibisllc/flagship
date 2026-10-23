import XCTest
@testable import FlagshipBuilderCore

/// SEC-MAC-002: the root helper keeps opaque ids it issued, stages images from a descriptor into its own
/// folder, and answers only the user that asked.
final class HelperStateTests: XCTestCase {
    private var dir: URL!
    private var state: HelperState!
    private var clock = Date(timeIntervalSince1970: 1_800_000_000)
    private let me = getuid()

    override func setUpWithError() throws {
        dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("helper-state-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        state = HelperState(stagingDir: dir.appendingPathComponent("stage").path, ttl: 600, maxStaged: 2, now: { self.clock })
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func file(_ name: String = "a.iso", bytes: Int = 8192, fill: UInt8 = 7) throws -> FileHandle {
        let url = dir.appendingPathComponent(name)
        try Data(repeating: fill, count: bytes).write(to: url)
        return try FileHandle(forReadingFrom: url)
    }

    private func facts(_ id: String = "disk9") -> HelperPolicy.DiskFacts {
        .init(id: id, totalSize: 16_000_000_000, mediaName: "USB", busProtocol: "USB", uuid: "U", registryEntryID: 42)
    }

    func testStagesACopyWithItsDigestAndAnOpaqueId() throws {
        let s = try state.stage(from: try file(), clientUID: me)
        XCTAssertEqual(s.id.count, 32)
        XCTAssertTrue(s.id.allSatisfy { $0.isHexDigit })
        XCTAssertEqual(s.size, 8192)
        // SHA-256 of 8192 bytes of 0x07.
        XCTAssertEqual(s.sha256.count, 64)
        XCTAssertTrue(s.path.hasPrefix(dir.appendingPathComponent("stage").path))
        XCTAssertFalse(s.path.contains("a.iso"), "the staged name never carries the client's")
        var st = stat()
        XCTAssertEqual(stat(s.path, &st), 0)
        XCTAssertEqual(st.st_mode & 0o777, 0o600)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: s.path)), Data(repeating: 7, count: 8192))
    }

    func testTheStagedCopyDoesNotFollowLaterChangesToTheClientsFile() throws {
        let url = dir.appendingPathComponent("swap.iso")
        try Data(repeating: 1, count: 4096).write(to: url)
        let s = try state.stage(from: try FileHandle(forReadingFrom: url), clientUID: me)
        try Data(repeating: 9, count: 4096).write(to: url)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: s.path)), Data(repeating: 1, count: 4096))
    }

    func testRefusesWhatIsNotAPlainFileOrIsAnUnreasonableSize() throws {
        XCTAssertThrowsError(try state.stage(from: try file("tiny.iso", bytes: 10), clientUID: me)) {
            XCTAssertEqual($0 as? HelperState.Refusal, .badSize)
        }
        let dfd = open(dir.path, O_RDONLY)
        XCTAssertGreaterThanOrEqual(dfd, 0)
        XCTAssertThrowsError(try state.stage(from: FileHandle(fileDescriptor: dfd, closeOnDealloc: true), clientUID: me)) {
            XCTAssertEqual($0 as? HelperState.Refusal, .notAFile)
        }
        let fifo = dir.appendingPathComponent("fifo").path
        XCTAssertEqual(mkfifo(fifo, 0o600), 0)
        let fd = open(fifo, O_RDONLY | O_NONBLOCK)
        XCTAssertGreaterThanOrEqual(fd, 0)
        XCTAssertThrowsError(try state.stage(from: FileHandle(fileDescriptor: fd, closeOnDealloc: true), clientUID: me)) {
            XCTAssertEqual($0 as? HelperState.Refusal, .notAFile)
        }
    }

    func testAnImageIsForTheUserWhoStagedItAndForOneWrite() throws {
        let s = try state.stage(from: try file(), clientUID: me)
        XCTAssertThrowsError(try state.staged(id: s.id, clientUID: me &+ 1)) { XCTAssertEqual($0 as? HelperState.Refusal, .unknownImage) }
        XCTAssertThrowsError(try state.staged(id: "00000000000000000000000000000000", clientUID: me))
        XCTAssertNoThrow(try state.staged(id: s.id, clientUID: me))
        state.finish(imageID: s.id)
        XCTAssertThrowsError(try state.staged(id: s.id, clientUID: me))
        XCTAssertFalse(FileManager.default.fileExists(atPath: s.path), "the staged bytes go with the write")
    }

    func testAnImageExpiresAndItsFileIsRemoved() throws {
        let s = try state.stage(from: try file(), clientUID: me)
        clock.addTimeInterval(601)
        XCTAssertThrowsError(try state.staged(id: s.id, clientUID: me))
        XCTAssertFalse(FileManager.default.fileExists(atPath: s.path))
    }

    func testOnlyAFewImagesWaitAtOnce() throws {
        _ = try state.stage(from: try file("a"), clientUID: me)
        _ = try state.stage(from: try file("b"), clientUID: me)
        XCTAssertThrowsError(try state.stage(from: try file("c"), clientUID: me)) { XCTAssertEqual($0 as? HelperState.Refusal, .tooManyStaged) }
        // Another user's own allowance is separate.
        XCTAssertNoThrow(try state.stage(from: try file("d"), clientUID: me &+ 1))
    }

    func testADiskIsRegisteredForOneUserAndExpires() throws {
        let m = state.register(facts: facts(), clientUID: me)
        XCTAssertEqual(m.id.count, 32)
        XCTAssertEqual(try state.media(id: m.id, clientUID: me).facts, facts())
        XCTAssertThrowsError(try state.media(id: m.id, clientUID: me &+ 1)) { XCTAssertEqual($0 as? HelperState.Refusal, .unknownMedia) }
        clock.addTimeInterval(601)
        XCTAssertThrowsError(try state.media(id: m.id, clientUID: me))
    }

    func testProgressIsReadFromWhereTheCallerLeftOffAndOnlyByTheOwner() throws {
        let s = try state.stage(from: try file(), clientUID: me)
        state.append("FLAGSHIP_PHASE:write", imageID: s.id)
        state.append("FLAGSHIP_PROGRESS:0.5000", imageID: s.id)
        var r = state.read(imageID: s.id, clientUID: me, from: 0)
        XCTAssertEqual(r.lines, ["FLAGSHIP_PHASE:write", "FLAGSHIP_PROGRESS:0.5000"])
        state.append("FLAGSHIP_PROGRESS:1.0000", imageID: s.id)
        r = state.read(imageID: s.id, clientUID: me, from: r.next)
        XCTAssertEqual(r.lines, ["FLAGSHIP_PROGRESS:1.0000"])
        XCTAssertEqual(state.read(imageID: s.id, clientUID: me &+ 1, from: 0).lines, [])
        XCTAssertEqual(state.read(imageID: "nope", clientUID: me, from: 0).lines, [])
    }

    func testIdsAreDifferentEveryTime() throws {
        XCTAssertNotEqual(HelperState.newID(), HelperState.newID())
    }
}
