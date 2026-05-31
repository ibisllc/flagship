import Foundation

// P8 — browser-viewer wire format.
//
// MIRRORS apps/web/public/webapp/views/browser-viewer.js byte-for-byte.
// The daemon's WS path is `/api/screens/browser-tabs/:tabId/stream`
// (P1.11); the session token rides the URL query param `sessionToken`
// because URLSessionWebSocketTask + OkHttp can't add a custom header
// before the upgrade handshake on every platform.

public enum BrowserFrame: Equatable, Sendable {
    case frame(dataBase64: String)
    case error(message: String)

    private enum CodingKeys: String, CodingKey {
        case kind, dataBase64, message
    }

    public static func decode(_ json: Data) -> BrowserFrame? {
        guard let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else { return nil }
        let kind = obj["kind"] as? String
        switch kind {
        case "frame":
            guard let s = obj["dataBase64"] as? String else { return nil }
            return .frame(dataBase64: s)
        case "error":
            let msg = (obj["message"] as? String) ?? "stream error"
            return .error(message: msg)
        default:
            return nil
        }
    }
}

public enum BrowserInput: Equatable, Sendable {
    case mouseDown(x: Int, y: Int, button: String)
    case mouseUp(x: Int, y: Int, button: String)
    case mouseMove(x: Int, y: Int)
    case scroll(x: Int, y: Int, deltaX: Double, deltaY: Double)
    case key(eventType: String, key: String, code: String)

    public func wireDictionary() -> [String: Any] {
        let inputPayload: [String: Any]
        switch self {
        case .mouseDown(let x, let y, let button):
            inputPayload = ["kind": "mouseDown", "x": x, "y": y, "button": button]
        case .mouseUp(let x, let y, let button):
            inputPayload = ["kind": "mouseUp", "x": x, "y": y, "button": button]
        case .mouseMove(let x, let y):
            inputPayload = ["kind": "mouseMove", "x": x, "y": y]
        case .scroll(let x, let y, let dx, let dy):
            inputPayload = ["kind": "scroll", "x": x, "y": y, "deltaX": dx, "deltaY": dy]
        case .key(let evt, let key, let code):
            inputPayload = ["kind": "key", "eventType": evt, "key": key, "code": code]
        }
        return ["kind": "input", "input": inputPayload]
    }

    public func encode() throws -> Data {
        try JSONSerialization.data(withJSONObject: wireDictionary(), options: [.sortedKeys])
    }
}
