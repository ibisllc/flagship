import Foundation
import Observation
import UIKit
import UniformTypeIdentifiers
import FlagshipAPI

/// What a build chat accepts as attachments, and the limits. MIRRORS the box's
/// `packages/server-daemon/src/llm/vibeCodeAttachments.ts` and the webapp.
public enum ChatAttachmentRules {
    public static let maxPerMessage = 6

    public enum Kind: String, Sendable, CaseIterable {
        case image, text, data, document

        public var maxBytes: Int {
            switch self {
            case .image: return 4 * 1024 * 1024
            case .text: return 256 * 1024
            case .data: return 2 * 1024 * 1024
            case .document: return 10 * 1024 * 1024
            }
        }

        var limitText: String {
            maxBytes >= 1024 * 1024 ? String(localized: "\(maxBytes / (1024 * 1024)) MB") : String(localized: "\(maxBytes / 1024) KB")
        }

        var noun: String {
            switch self {
            case .image: return "images"
            case .text: return "text files"
            case .data: return "CSV and JSON files"
            case .document: return "PDFs"
            }
        }

        public var symbol: String {
            switch self {
            case .image: return "photo"
            case .text: return "doc.text"
            case .data: return "tablecells"
            case .document: return "doc.richtext"
            }
        }
    }

    static let imageTypes: [String: String] = [
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
    ]

    static let textExtensions: Set<String> = [
        "txt", "md", "markdown", "rst", "log", "tsv",
        "swift", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "kts",
        "c", "h", "cc", "cpp", "hpp", "cs", "php", "lua", "dart", "scala", "sh", "bash", "zsh",
        "html", "htm", "css", "scss", "sass", "less", "vue", "svelte", "sql", "graphql", "gql",
        "yaml", "yml", "toml", "ini", "cfg", "conf", "xml", "svg", "properties", "gradle", "prisma",
    ]

    static let textNames: Set<String> = ["dockerfile", "makefile", "procfile", "readme", "license"]

    /// The kind a file name maps to, nil when it can't be attached.
    public static func kind(forFileName name: String) -> Kind? {
        let ext = (name as NSString).pathExtension.lowercased()
        if imageTypes[ext] != nil { return .image }
        if ext == "csv" || ext == "json" { return .data }
        if ext == "pdf" { return .document }
        if textExtensions.contains(ext) { return .text }
        if ext.isEmpty, textNames.contains(name.lowercased()) { return .text }
        return nil
    }

    public enum Refusal: Error, Equatable, Sendable {
        case tooMany
        case tooBig(name: String, kind: Kind)
        case unsupported(name: String)
        case notText(name: String)
        case unreadable(name: String)

        public var message: String {
            switch self {
            case .tooMany:
                return String(localized: "You can attach up to \(maxPerMessage) files to a message.")
            case .tooBig(let name, let kind):
                return String(localized: "\(name) is over the \(kind.limitText) limit for \(kind.noun).")
            case .unsupported(let name):
                return String(localized: "\(name) can't be attached. Attach an image, a text file, a CSV or JSON file, or a PDF.")
            case .notText(let name):
                return String(localized: "\(name) isn't plain text.")
            case .unreadable(let name):
                return String(localized: "Couldn't read \(name).")
            }
        }
    }

    /// The image type from the file's first bytes (png, jpeg, gif, webp).
    static func sniffImage(_ d: Data) -> String? {
        let b = [UInt8](d.prefix(12))
        if b.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
        if b.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if b.starts(with: [0x47, 0x49, 0x46, 0x38]) { return "image/gif" }
        if b.count >= 12, b.starts(with: [0x52, 0x49, 0x46, 0x46]), Array(b[8..<12]) == [0x57, 0x45, 0x42, 0x50] {
            return "image/webp"
        }
        return nil
    }

    /// A file the owner picked → its attachment, or why not.
    public static func attachment(name: String, data: Data) -> Result<VibeCodeAttachment, Refusal> {
        guard let kind = kind(forFileName: name) else { return .failure(.unsupported(name: name)) }
        guard data.count <= kind.maxBytes else { return .failure(.tooBig(name: name, kind: kind)) }
        switch kind {
        case .image:
            guard let type = sniffImage(data) else { return .failure(.unsupported(name: name)) }
            return .success(.image(name: name, mediaType: type, data: data))
        case .document:
            guard data.starts(with: Array("%PDF".utf8)) else { return .failure(.unsupported(name: name)) }
            return .success(.document(name: name, data: data))
        case .text, .data:
            guard let text = String(data: data, encoding: .utf8) else { return .failure(.notText(name: name)) }
            if kind == .text { return .success(.text(name: name, text: text)) }
            let ext = (name as NSString).pathExtension.lowercased()
            return .success(.data(name: name, mediaType: ext == "csv" ? "text/csv" : "application/json", text: text))
        }
    }

    /// A photo from the library. Kept as is when it's a png/jpeg/gif/webp
    /// under the limit; otherwise (HEIC, a large photo) re-encoded as JPEG,
    /// at most 2048 px on the long side.
    public static func photo(data: Data, index: Int) -> Result<VibeCodeAttachment, Refusal> {
        if let type = sniffImage(data), data.count <= Kind.image.maxBytes {
            let ext = type == "image/jpeg" ? "jpg" : String(type.dropFirst("image/".count))
            return .success(.image(name: String(localized: "photo-\(index).\(ext)"), mediaType: type, data: data))
        }
        let name = "photo-\(index).jpg"
        guard let img = UIImage(data: data) else { return .failure(.unreadable(name: name)) }
        let longSide = max(img.size.width, img.size.height)
        let scale = longSide > 2048 ? 2048 / longSide : 1
        let size = CGSize(width: (img.size.width * scale).rounded(), height: (img.size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            img.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let jpeg = resized.jpegData(compressionQuality: 0.82) else { return .failure(.unreadable(name: name)) }
        guard jpeg.count <= Kind.image.maxBytes else { return .failure(.tooBig(name: name, kind: .image)) }
        return .success(.image(name: name, mediaType: "image/jpeg", data: jpeg))
    }

    /// The kind of an attachment already on the wire.
    public static func kind(of a: VibeCodeAttachment) -> Kind {
        Kind(rawValue: a.kind) ?? .text
    }

    /// The document picker's types.
    public static let pickerTypes: [UTType] = [.image, .plainText, .text, .sourceCode, .commaSeparatedText, .json, .pdf, .data]
}

/// The notice by the attach control.
public enum ChatAttachmentCopy {
    public static let notice = String(localized: "The AI will see what you attach.")
    public static let sampleData = String(localized: "Sample data goes only to the private test copy.")
    public static let attach = String(localized: "Attach")
    public static let photo = String(localized: "Photo")
    public static let file = String(localized: "File")
}

/// The files staged for the next message.
@MainActor
@Observable
public final class ChatAttachmentStager {
    public struct Staged: Identifiable, Equatable {
        public let id = UUID()
        public let attachment: VibeCodeAttachment
        public var name: String { attachment.name ?? "file" }
        public var kind: ChatAttachmentRules.Kind { ChatAttachmentRules.kind(of: attachment) }
    }

    public private(set) var staged: [Staged] = []
    public private(set) var error: String?

    public init(staged: [VibeCodeAttachment] = []) {
        self.staged = staged.map { Staged(attachment: $0) }
    }

    public var isEmpty: Bool { staged.isEmpty }
    public var hasImage: Bool { staged.contains { $0.kind == .image } }
    public var hasData: Bool { staged.contains { $0.kind == .data } }
    public var wire: [VibeCodeAttachment] { staged.map(\.attachment) }

    /// Stage one result; a refusal shows inline and nothing is attached.
    public func add(_ r: Result<VibeCodeAttachment, ChatAttachmentRules.Refusal>) {
        switch r {
        case .success(let a):
            guard staged.count < ChatAttachmentRules.maxPerMessage else {
                error = ChatAttachmentRules.Refusal.tooMany.message
                return
            }
            staged.append(Staged(attachment: a))
            error = nil
        case .failure(let refusal):
            error = refusal.message
        }
    }

    public func addFiles(_ urls: [URL]) {
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let name = url.lastPathComponent
            if let kind = ChatAttachmentRules.kind(forFileName: name),
               let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, size > kind.maxBytes {
                add(.failure(.tooBig(name: name, kind: kind)))
                continue
            }
            guard let data = try? Data(contentsOf: url) else {
                add(.failure(.unreadable(name: name)))
                continue
            }
            add(ChatAttachmentRules.attachment(name: name, data: data))
        }
    }

    public func addPhoto(_ data: Data) {
        add(ChatAttachmentRules.photo(data: data, index: staged.filter { $0.kind == .image }.count + 1))
    }

    public func fail(_ message: String) { error = message }

    public func remove(_ id: UUID) {
        staged.removeAll { $0.id == id }
        error = nil
    }

    public func clear() {
        staged = []
        error = nil
    }
}
