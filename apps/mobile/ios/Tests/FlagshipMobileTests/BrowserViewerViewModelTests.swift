import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

@MainActor
final class BrowserViewerViewModelTests: XCTestCase {

    // MARK: - Wire-shape parity (mirrors apps/web/public/webapp/views/browser-viewer.js)

    func test_browserInput_mouseDown_encodesToWebappShape() throws {
        let input = BrowserInput.mouseDown(x: 42, y: 17, button: "left")
        let dict = input.wireDictionary()
        XCTAssertEqual(dict["kind"] as? String, "input")
        let inner = try XCTUnwrap(dict["input"] as? [String: Any])
        XCTAssertEqual(inner["kind"] as? String, "mouseDown")
        XCTAssertEqual(inner["x"] as? Int, 42)
        XCTAssertEqual(inner["y"] as? Int, 17)
        XCTAssertEqual(inner["button"] as? String, "left")
    }

    func test_browserInput_mouseUp_encodesToWebappShape() throws {
        let dict = BrowserInput.mouseUp(x: 1, y: 2, button: "left").wireDictionary()
        let inner = try XCTUnwrap(dict["input"] as? [String: Any])
        XCTAssertEqual(inner["kind"] as? String, "mouseUp")
        XCTAssertEqual(inner["x"] as? Int, 1)
        XCTAssertEqual(inner["y"] as? Int, 2)
        XCTAssertEqual(inner["button"] as? String, "left")
    }

    func test_browserInput_mouseMove_omitsButtonField() throws {
        let dict = BrowserInput.mouseMove(x: 3, y: 4).wireDictionary()
        let inner = try XCTUnwrap(dict["input"] as? [String: Any])
        XCTAssertEqual(inner["kind"] as? String, "mouseMove")
        XCTAssertEqual(inner["x"] as? Int, 3)
        XCTAssertEqual(inner["y"] as? Int, 4)
        XCTAssertNil(inner["button"])
    }

    func test_browserInput_scroll_carriesDeltas() throws {
        let dict = BrowserInput.scroll(x: 5, y: 6, deltaX: 12.5, deltaY: -33.0).wireDictionary()
        let inner = try XCTUnwrap(dict["input"] as? [String: Any])
        XCTAssertEqual(inner["kind"] as? String, "scroll")
        XCTAssertEqual(inner["deltaX"] as? Double, 12.5)
        XCTAssertEqual(inner["deltaY"] as? Double, -33.0)
    }

    func test_browserInput_key_carriesEventTypeKeyAndCode() throws {
        let dict = BrowserInput.key(eventType: "keyDown", key: "a", code: "KeyA").wireDictionary()
        let inner = try XCTUnwrap(dict["input"] as? [String: Any])
        XCTAssertEqual(inner["kind"] as? String, "key")
        XCTAssertEqual(inner["eventType"] as? String, "keyDown")
        XCTAssertEqual(inner["key"] as? String, "a")
        XCTAssertEqual(inner["code"] as? String, "KeyA")
    }

    func test_browserInput_jsonEncodes_andDecodesBackThroughJSONSerialization() throws {
        let data = try BrowserInput.mouseDown(x: 10, y: 20, button: "left").encode()
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["kind"] as? String, "input")
        let inner = try XCTUnwrap(obj["input"] as? [String: Any])
        XCTAssertEqual(inner["kind"] as? String, "mouseDown")
    }

    // MARK: - BrowserFrame decoding

    func test_browserFrame_decodesFrameMessage() {
        let json = #"{"kind":"frame","dataBase64":"aGVsbG8="}"#.data(using: .utf8)!
        let f = BrowserFrame.decode(json)
        guard case .frame(let s) = f else { return XCTFail("expected .frame, got \(String(describing: f))") }
        XCTAssertEqual(s, "aGVsbG8=")
    }

    func test_browserFrame_decodesErrorMessage() {
        let json = #"{"kind":"error","message":"nav blocked by DomainGate"}"#.data(using: .utf8)!
        let f = BrowserFrame.decode(json)
        guard case .error(let m) = f else { return XCTFail("expected .error, got \(String(describing: f))") }
        XCTAssertEqual(m, "nav blocked by DomainGate")
    }

    func test_browserFrame_unknownKind_returnsNil() {
        let json = #"{"kind":"pong"}"#.data(using: .utf8)!
        XCTAssertNil(BrowserFrame.decode(json))
    }

    // MARK: - Coordinate transform

    func test_coordTransform_mapsViewportToImageNaturalPixels() {
        let (x, y) = BrowserViewerViewModel.toImageCoords(
            touchX: 50, touchY: 100,
            viewportWidth: 100, viewportHeight: 200,
            imageWidth: 1000, imageHeight: 2000
        )
        XCTAssertEqual(x, 500)
        XCTAssertEqual(y, 1000)
    }

    func test_coordTransform_zeroImageDims_fallsBackToViewport() {
        let (x, y) = BrowserViewerViewModel.toImageCoords(
            touchX: 25, touchY: 75,
            viewportWidth: 100, viewportHeight: 200,
            imageWidth: 0, imageHeight: 0
        )
        // With imageW=0 we fall back to viewportW → identity.
        XCTAssertEqual(x, 25)
        XCTAssertEqual(y, 75)
    }

    // MARK: - VM behavior

    func test_vm_applyErrorFrame_setsFailedStatusAndMessage() async {
        let mock = MockScreensClient()
        mock.simulatedLatency = 0
        let vm = BrowserViewerViewModel(tabId: "tab-x", client: mock)
        vm.apply(.error(message: "broken"))
        XCTAssertEqual(vm.errorMessage, "broken")
        if case .failed(let m) = vm.status {
            XCTAssertEqual(m, "broken")
        } else {
            XCTFail("expected .failed status, got \(vm.status)")
        }
    }

    func test_vm_applyFrame_setsStreamingStatus() async {
        let mock = MockScreensClient()
        mock.simulatedLatency = 0
        let vm = BrowserViewerViewModel(tabId: "tab-y", client: mock)
        // 1×1 transparent PNG base64 — UIImage(data:) decodes this and
        // populates `frame` + flips status to .streaming.
        let onePxPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
        vm.apply(.frame(dataBase64: onePxPng))
        if case .streaming = vm.status { /* ok */ }
        else { XCTFail("expected .streaming after frame, got \(vm.status)") }
        XCTAssertNotNil(vm.frame)
    }

    // MARK: - Key-event diff (P8 keyboard UI)

    func test_keyEvents_singleCharAppended_emitsKeyDownThenKeyUp() {
        let evs = BrowserViewerViewModel.keyEvents(from: "ab", to: "abc")
        XCTAssertEqual(evs.count, 2)
        XCTAssertEqual(evs[0].eventType, "keyDown")
        XCTAssertEqual(evs[0].key, "c")
        XCTAssertEqual(evs[0].code, "KeyC")
        XCTAssertEqual(evs[1].eventType, "keyUp")
        XCTAssertEqual(evs[1].key, "c")
        XCTAssertEqual(evs[1].code, "KeyC")
    }

    func test_keyEvents_multipleCharsAppended_emitsPairPerChar() {
        let evs = BrowserViewerViewModel.keyEvents(from: "", to: "Hi 1")
        XCTAssertEqual(evs.count, 8)
        XCTAssertEqual(evs.map(\.eventType), ["keyDown", "keyUp", "keyDown", "keyUp", "keyDown", "keyUp", "keyDown", "keyUp"])
        XCTAssertEqual(evs.map(\.key), ["H", "H", "i", "i", " ", " ", "1", "1"])
        XCTAssertEqual(evs.map(\.code), ["KeyH", "KeyH", "KeyI", "KeyI", "Space", "Space", "Digit1", "Digit1"])
    }

    func test_keyEvents_singleCharRemoved_emitsBackspacePair() {
        let evs = BrowserViewerViewModel.keyEvents(from: "abc", to: "ab")
        XCTAssertEqual(evs.count, 2)
        XCTAssertEqual(evs[0].eventType, "keyDown")
        XCTAssertEqual(evs[0].key, "Backspace")
        XCTAssertEqual(evs[0].code, "Backspace")
        XCTAssertEqual(evs[1].eventType, "keyUp")
        XCTAssertEqual(evs[1].key, "Backspace")
    }

    func test_keyEvents_unchanged_emitsNothing() {
        XCTAssertTrue(BrowserViewerViewModel.keyEvents(from: "hello", to: "hello").isEmpty)
    }

    func test_keyEvents_replacement_deletesOldThenInsertsNew() {
        let evs = BrowserViewerViewModel.keyEvents(from: "ab", to: "cd")
        XCTAssertEqual(evs.count, 8)
        XCTAssertEqual(evs.prefix(4).map(\.key), ["Backspace", "Backspace", "Backspace", "Backspace"])
        XCTAssertEqual(evs.suffix(4).map(\.key), ["c", "c", "d", "d"])
    }

    func test_vm_sendKey_routesThroughBrowserInputKeyShape() async {
        let mock = MockScreensClient()
        mock.simulatedLatency = 0
        let vm = BrowserViewerViewModel(tabId: "tab-k", client: mock)
        vm.start()
        await vm.sendKey(eventType: "keyDown", key: "a", code: "KeyA")
        await vm.sendKey(eventType: "keyUp", key: "a", code: "KeyA")
        let stream = mock.lastBrowserStream as? MockBrowserStream
        XCTAssertNotNil(stream)
        XCTAssertEqual(stream?.sent.count, 2)
        XCTAssertEqual(stream?.sent[0], .key(eventType: "keyDown", key: "a", code: "KeyA"))
        XCTAssertEqual(stream?.sent[1], .key(eventType: "keyUp", key: "a", code: "KeyA"))
        vm.stop()
    }

    // MARK: - Stream lifecycle through MockScreensClient

    func test_browserTabStream_recordsTabIdAndCanSendInputs() async {
        let mock = MockScreensClient()
        let stream = mock.browserTabStream(tabId: "tab-42")
        XCTAssertEqual(mock.browserStreamsOpened, ["tab-42"])
        await stream.send(.mouseDown(x: 10, y: 20, button: "left"))
        await stream.send(.mouseUp(x: 10, y: 20, button: "left"))
        if let m = stream as? MockBrowserStream {
            XCTAssertEqual(m.sent.count, 2)
            XCTAssertEqual(m.sent.first, .mouseDown(x: 10, y: 20, button: "left"))
        } else {
            XCTFail("expected MockBrowserStream")
        }
        stream.close()
    }
}
