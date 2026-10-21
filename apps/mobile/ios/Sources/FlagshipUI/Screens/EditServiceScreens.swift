import SwiftUI
import FlagshipAPI

/// "Edit this service": change an installed service's code, either by
/// describing the change to the AI chat or from the owner's own IDE. Either
/// way the new version replaces the running one in place (same address, same
/// data). Mirrors the webapp `views/edit-service.js`.
public struct EditServiceScreen: View {
    @Environment(\.colorScheme) private var scheme
    let name: String
    var onAI: () -> Void
    var onIDE: () -> Void

    public init(name: String, onAI: @escaping () -> Void, onIDE: @escaping () -> Void) {
        self.name = name
        self.onAI = onAI
        self.onIDE = onIDE
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    Spacer().frame(height: FS.space.s4)
                    option(c: c, icon: "sparkles", title: String(localized: "Describe the change"),
                           subtitle: String(localized: "Tell the AI what to change. It starts from the current code."),
                           id: "edit-service-ai", action: onAI)
                    option(c: c, icon: "laptopcomputer", title: String(localized: "Use your IDE"),
                           subtitle: String(localized: "Connect Cursor, Cline or another editor and change it with your own AI."),
                           id: "edit-service-ide", action: onIDE)
                    Text("The new version replaces the one running now. Its address, data and the people who can open it stay the same.")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, FS.space.s2)
                    Spacer().frame(height: FS.space.s8)
                }
                .padding(.horizontal, FS.space.s6)
                .fsReadingColumn()
            }
        }
        .navigationTitle("Edit \(name)")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func option(c: FSColors, icon: String, title: String, subtitle: String,
                        id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            FSCard {
                HStack(spacing: FS.space.s3) {
                    Image(systemName: icon).font(FS.font.scaled(20)).foregroundColor(c.accent).frame(width: 28)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(FS.font.scaled(16, weight: .semibold)).foregroundColor(c.text)
                        Text(subtitle).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }
}

/// What should change, for the AI chat. Starting runs the same build session
/// screen as a new service; deploying from it replaces this one.
public struct EditDescribeScreen: View {
    @Environment(\.colorScheme) private var scheme
    let name: String
    /// Starts the session; returns why the box refused, if it did.
    var onStart: (String) async -> EditStartRefusal?
    var onOpenSessions: () -> Void
    var onUseIDE: () -> Void
    @State private var prompt = ""
    @State private var starting = false
    @State private var refusal: EditStartRefusal?
    @FocusState private var focused: Bool

    public init(name: String,
                onStart: @escaping (String) async -> EditStartRefusal?,
                onOpenSessions: @escaping () -> Void,
                onUseIDE: @escaping () -> Void) {
        self.name = name
        self.onStart = onStart
        self.onOpenSessions = onOpenSessions
        self.onUseIDE = onUseIDE
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s4) {
                    Spacer().frame(height: FS.space.s4)
                    Text("What should change?").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    TextEditor(text: $prompt)
                        .focused($focused)
                        .font(FS.font.body())
                        .padding(10)
                        .frame(height: 180)
                        .background(c.surfaceSunken)
                        .overlay(RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous).stroke(c.border, lineWidth: 1))
                        .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous))
                        .accessibilityIdentifier("edit-describe-prompt")
                    Text("For example: \"Add a due date to each item and sort by it.\"")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    FSPrimaryButton(starting ? String(localized: "Starting…") : String(localized: "Start"),
                                    enabled: !starting && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                                    block: true, large: true) {
                        focused = false
                        starting = true
                        Task {
                            refusal = await onStart(prompt)
                            starting = false
                        }
                    }
                    .accessibilityIdentifier("edit-describe-start")
                    Spacer().frame(height: FS.space.s8)
                }
                .padding(.horizontal, FS.space.s6)
                .fsReadingColumn()
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .navigationTitle("Edit \(name)")
        .navigationBarTitleDisplayMode(.inline)
        .alert(refusal?.title ?? "", isPresented: Binding(get: { refusal != nil }, set: { if !$0 { refusal = nil } }),
               presenting: refusal) { r in
            switch r {
            case .sessionOpen:
                Button("Open build sessions") { onOpenSessions() }
                Button("OK", role: .cancel) {}
            case .tooBig:
                Button("Use your IDE") { onUseIDE() }
                Button("OK", role: .cancel) {}
            case .other:
                Button("OK", role: .cancel) {}
            }
        } message: { r in
            Text(r.message(name: name))
        }
    }
}

/// Why the box wouldn't start an edit session.
public enum EditStartRefusal: Equatable, Sendable {
    /// Another session is already changing this service.
    case sessionOpen
    /// Too much code for the AI chat; the IDE route can take it.
    case tooBig(String)
    case other(String)

    var title: String {
        switch self {
        case .sessionOpen: return "Already being changed"
        case .tooBig: return "Too big for the AI chat"
        case .other: return "Couldn't start"
        }
    }

    func message(name: String) -> String {
        switch self {
        case .sessionOpen:
            return String(localized: "A build session is already changing \(name). Open it from Build sessions, or discard it there to start over.")
        case .tooBig(let m), .other(let m):
            return m
        }
    }

    /// Read the box's refusal of `vibeCodeStart`.
    public static func from(_ error: Error) -> EditStartRefusal {
        if VibeCodeNameCheck.conflict(in: error)?.kind == "session" { return .sessionOpen }
        if case let ScreensClientError.http(status, body) = error {
            struct Body: Decodable { let error: String? }
            let msg = (try? JSONDecoder().decode(Body.self, from: Data(body.utf8)))?.error
            if status == 413 { return .tooBig(msg ?? String(localized: "This service is too big to change in the AI chat. Use your IDE instead.")) }
            if let msg { return .other(msg) }
        }
        return .other(ScreensClientError.userFacing(error))
    }
}
