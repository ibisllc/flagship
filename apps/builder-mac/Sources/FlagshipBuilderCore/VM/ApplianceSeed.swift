import CryptoKit
import Foundation

public enum ApplianceSeed {
    public static let magic = "FLSHSD01"
    public static let headerBytes = 80
    public static let sizeBytes = 8 * 1024 * 1024

    private struct Payload: Codable {
        let version: Int
        let recipeBase64: String
        let bootstrapBase64: String
        let recipeSha256: String
    }

    public static func encode(recipe: Data, bootstrap: String) throws -> Data {
        let payload = Payload(
            version: 1,
            recipeBase64: recipe.base64EncodedString(),
            bootstrapBase64: Data(bootstrap.utf8).base64EncodedString(),
            recipeSha256: sha256(recipe))
        let body = try JSONEncoder().encode(payload)
        guard body.count <= sizeBytes - headerBytes else {
            throw EncodingError.invalidValue(body.count, .init(
                codingPath: [], debugDescription: "Appliance seed payload is too large."))
        }
        let header = Data("\(magic)\(String(format: "%08x", body.count))\(sha256(body))".utf8)
        precondition(header.count == headerBytes)
        var result = Data(count: sizeBytes)
        result.replaceSubrange(0..<header.count, with: header)
        result.replaceSubrange(headerBytes..<(headerBytes + body.count), with: body)
        return result
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
