import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Settings → Messages (docs/voici-and-messages.md §11.3): the websites this account is signed in to as a visitor (sign
/// one out: its browser key is refused from then on), rotating the page's inbox key, and the rules.
struct MessagesSettingsScreen: View {
    @Environment(AppState.self) private var app
    @Environment(\.voiciComClient) private var client
    private let store = MessagesStore.shared
    @State private var confirmRotate = false
    @State private var showRules = false
    @State private var signingOut: String?

    var body: some View {
        Form {
            Section {
                if store.state.signedInSites.isEmpty {
                    Text("None. When you sign in to message someone on voi.ci, the website shows here.")
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("messages-settings-no-sites")
                }
                ForEach(store.state.signedInSites, id: \.delegatePub) { site in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: VoiciSignInBook.title(pageId: site.pageId))
                            Text(Date(timeIntervalSince1970: TimeInterval(site.at) / 1000), format: .dateTime.day().month().year())
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button(signingOut == site.delegatePub ? String(localized: "Signing out…") : String(localized: "Sign out")) {
                            signingOut = site.delegatePub
                            Task {
                                await store.signOut(site: site)
                                signingOut = nil
                            }
                        }
                        .disabled(signingOut != nil)
                        .accessibilityIdentifier("messages-settings-sign-out")
                    }
                }
            } header: {
                Text("Websites you're signed in to")
            }
            if store.isAdmin, store.index != nil {
                Section {
                    Button("Rotate inbox key") { confirmRotate = true }
                        .accessibilityIdentifier("messages-settings-rotate")
                } footer: {
                    Text("New messages are sealed to a new key. This device keeps reading the old ones.")
                }
            }
            Section {
                Button("Page and message rules") { showRules = true }
            }
            if let e = store.lastError ?? store.publishError {
                Section { Text(verbatim: e).font(.footnote).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle(Text("Messages"))
        .task {
            if let client { store.configure(client: client, username: app.currentUser, deviceId: app.activeProfile?.deviceId, isDemo: app.isDemoAccount) }
            await store.refresh()
        }
        .confirmationDialog("Rotate your inbox key?", isPresented: $confirmRotate, titleVisibility: .visible) {
            Button("Rotate") { Task { await store.rotateInbox() } }
        } message: {
            Text("Your page is published again with the new key.")
        }
        .sheet(isPresented: $showRules) { VoiciRulesSheet {} }
    }
}

/// What this device remembers about the pages it signed in to (the state blob keeps only the page id).
enum VoiciSignInBook {
    static let key = "flagship.voici.signInNames"

    static let usernamesKey = "flagship.voici.signInUsernames"

    static func remember(pageId: String, username: String, displayName: String) {
        var all = UserDefaults.standard.dictionary(forKey: key) as? [String: String] ?? [:]
        all[pageId] = "\(displayName) · voi.ci/\(username)"
        UserDefaults.standard.set(all, forKey: key)
        var names = UserDefaults.standard.dictionary(forKey: usernamesKey) as? [String: String] ?? [:]
        names[pageId] = username.lowercased()
        UserDefaults.standard.set(names, forKey: usernamesKey)
    }

    static func username(pageId: String) -> String? {
        (UserDefaults.standard.dictionary(forKey: usernamesKey) as? [String: String])?[pageId]
    }

    /// The attestation this device got for its pseudonym on a page (kept by the sign-in approval).
    static func attestationKey(_ pageId: String) -> String { "flagship.messages.attestation.\(pageId)" }

    static let delegationsKey = "flagship.voici.signInDelegations"

    /// The delegation this device signed, kept so it can sign that browser out later (`.com` needs it with the revoke).
    static func keep(delegation: JSONValue, signature: String) {
        guard let pub = delegation["delegatePub"]?.string, let text = try? CanonicalJson.canonicalJson(["delegation": delegation, "sig": .string(signature)]) else { return }
        var all = UserDefaults.standard.dictionary(forKey: delegationsKey) as? [String: String] ?? [:]
        all[pub] = text
        UserDefaults.standard.set(all, forKey: delegationsKey)
    }

    static func delegation(_ delegatePub: String) -> (delegation: JSONValue, signature: String)? {
        guard let text = (UserDefaults.standard.dictionary(forKey: delegationsKey) as? [String: String])?[delegatePub],
              let v = JSONValue.parse(text), let d = v["delegation"], let s = v["sig"]?.string else { return nil }
        return (d, s)
    }

    static func title(pageId: String) -> String {
        (UserDefaults.standard.dictionary(forKey: key) as? [String: String])?[pageId] ?? String(localized: "A voi.ci page")
    }
}
