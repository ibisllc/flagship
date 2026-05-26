import Foundation
import UIKit
import Observation
import FlagshipAPI

/// P8 — drives the BrowserViewerScreen.
///
/// Subscribes to the WS frame stream (`ScreensClient.browserTabStream`),
/// decodes each `frame` into a `UIImage`, and forwards user gestures
/// back as `BrowserInput` events. Mirrors the webapp viewer at
/// `apps/web/public/webapp/views/browser-viewer.js`.
@MainActor
@Observable
public final class BrowserViewerViewModel {
    public enum Status: Sendable, Equatable {
        case idle
        case connecting
        case streaming
        case closed
        case failed(String)
    }

    public let tabId: String
    public private(set) var status: Status = .idle
    public private(set) var errorMessage: String?

    /// Latest decoded JPEG dimensions, in pixels. Used by the view to
    /// translate touch coords back to the image's natural space before
    /// shipping each pointer event.
    public private(set) var frameWidth: Int = 0
    public private(set) var frameHeight: Int = 0

    public private(set) var frame: UIImage?

    private let client: any ScreensClient
    private var stream: (any BrowserStream)?
    private var consumer: Task<Void, Never>?

    public init(tabId: String, client: any ScreensClient) {
        self.tabId = tabId
        self.client = client
    }

    public func start() {
        guard stream == nil else { return }
        status = .connecting
        let s = client.browserTabStream(tabId: tabId)
        stream = s
        consumer = Task { [weak self] in
            for await frame in s.incoming {
                if Task.isCancelled { break }
                self?.apply(frame)
            }
            self?.status = .closed
        }
    }

    public func stop() {
        consumer?.cancel()
        consumer = nil
        stream?.close()
        stream = nil
    }

    // Cleanup is the explicit `stop()` call (wired to onDisappear). The
    // VM is @MainActor; touching the actor-isolated consumer from a
    // non-isolated deinit is rejected under Swift 6 strict concurrency.

    /// Decode a single server-pushed frame. Public so the test suite can
    /// drive the VM directly without spinning up a real WS.
    public func apply(_ frame: BrowserFrame) {
        switch frame {
        case .frame(let dataBase64):
            guard let data = Data(base64Encoded: dataBase64),
                  let img = UIImage(data: data) else { return }
            self.frame = img
            self.frameWidth = Int(img.size.width * img.scale)
            self.frameHeight = Int(img.size.height * img.scale)
            self.status = .streaming
        case .error(let message):
            self.errorMessage = message
            self.status = .failed(message)
        }
    }

    /// Convert a touch-coords pair (in the rendered viewport's pixel
    /// space) to the frame's natural pixel space, mirroring the webapp's
    /// `toImgCoords` helper.
    public static func toImageCoords(
        touchX: CGFloat, touchY: CGFloat,
        viewportWidth: CGFloat, viewportHeight: CGFloat,
        imageWidth: Int, imageHeight: Int
    ) -> (Int, Int) {
        let imgW = imageWidth > 0 ? CGFloat(imageWidth) : viewportWidth
        let imgH = imageHeight > 0 ? CGFloat(imageHeight) : viewportHeight
        let vw = viewportWidth == 0 ? 1 : viewportWidth
        let vh = viewportHeight == 0 ? 1 : viewportHeight
        let x = (touchX / vw) * imgW
        let y = (touchY / vh) * imgH
        return (Int(x.rounded()), Int(y.rounded()))
    }

    public func sendMouseDown(x: Int, y: Int) async {
        await stream?.send(.mouseDown(x: x, y: y, button: "left"))
    }

    public func sendMouseUp(x: Int, y: Int) async {
        await stream?.send(.mouseUp(x: x, y: y, button: "left"))
    }

    public func sendMouseMove(x: Int, y: Int) async {
        await stream?.send(.mouseMove(x: x, y: y))
    }

    public func sendScroll(x: Int, y: Int, deltaX: Double, deltaY: Double) async {
        await stream?.send(.scroll(x: x, y: y, deltaX: deltaX, deltaY: deltaY))
    }

    public func sendKey(eventType: String, key: String, code: String) async {
        await stream?.send(.key(eventType: eventType, key: key, code: code))
    }
}
