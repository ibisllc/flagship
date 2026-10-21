import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Home → Add/Restore server → Restore from backup: where is the backup?
/// A file, other servers, or the copies this phone keeps. One short line
/// under each source; the flows behind them are the existing ones.
struct RestoreSourceScreen: View {
    @Environment(\.colorScheme) private var scheme
    let onFile: () -> Void
    let onPeers: () -> Void
    let onPhone: () -> Void

    static let fileLine = String(localized: "A .flagship backup file you saved or were sent.")
    static let peersLine = String(localized: "Pieces other Flagship servers keep of a lost server's backup.")
    static let phoneLine = String(localized: "The newest backups this phone keeps for your servers.")

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("Where is the backup?")
                    .font(FS.font.h3()).foregroundColor(c.text)
                    .accessibilityAddTraits(.isHeader)
                source(String(localized: "From a file"), Self.fileLine, "doc", id: "restore-source-file", action: onFile)
                source(String(localized: "From other servers"), Self.peersLine, "server.rack", id: "restore-source-peers", action: onPeers)
                source(String(localized: "From this phone"), Self.phoneLine, "iphone", id: "restore-source-phone", action: onPhone)
            }
            .padding(FS.space.s4)
            .fsReadingColumn()
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Restore from backup")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func source(_ title: String, _ line: String, _ icon: String, id: String, action: @escaping () -> Void) -> some View {
        let c = FSColors.scheme(scheme)
        return Button(action: action) {
            FSListRow(leading: .icon(icon, color: c.accent), title: title, subtitle: line) {
                Image(systemName: "chevron.right").foregroundColor(c.textMuted)
            }
        }
        .buttonStyle(FSPressStyle())
        .accessibilityIdentifier(id)
    }
}

/// The copies this phone keeps (the "On my phone" backup policy), by server
/// and date; tapping one imports it like a picked file.
struct PhoneBackupsScreen: View {
    @Environment(\.colorScheme) private var scheme
    let store: PhoneBackupStore
    let onPick: (URL) -> Void

    init(store: PhoneBackupStore = .shared, onPick: @escaping (URL) -> Void) {
        self.store = store
        self.onPick = onPick
    }

    struct Entry: Identifiable {
        let server: String
        let copy: PhoneBackupStore.Copy
        let url: URL
        var id: String { server + "/" + copy.archiveId }
    }

    static func entries(in store: PhoneBackupStore) -> [Entry] {
        store.servers.flatMap { s in
            store.copies(s.fqdn).map { Entry(server: s.fqdn, copy: $0, url: store.url(of: $0, server: s.fqdn)) }
        }.sorted { $0.copy.createdAt > $1.copy.createdAt }
    }

    static func serverName(_ fqdn: String) -> String { fqdn.split(separator: ".").first.map(String.init) ?? fqdn }

    static let emptyLine = String(localized: "This phone keeps no backups yet. When a server's backups go to \"On my phone\", its newest one is kept here.")

    var body: some View {
        let c = FSColors.scheme(scheme)
        let items = Self.entries(in: store)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                if items.isEmpty {
                    FSCard {
                        Text(Self.emptyLine).font(FS.font.body()).foregroundColor(c.textMuted)
                            .accessibilityIdentifier("restore-phone-empty")
                    }
                } else {
                    Text("Pick a backup to restore. It opens from this phone; nothing is sent until you choose where it goes.")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    ForEach(items) { e in
                        Button { onPick(e.url) } label: {
                            FSListRow(
                                leading: .icon("externaldrive", color: c.accent),
                                title: Self.serverName(e.server),
                                subtitle: Self.when(e.copy.createdAt) + " · " + ServerArchive.formatBytes(e.copy.bytes)
                            ) {
                                Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                            }
                        }
                        .buttonStyle(FSPressStyle())
                        .accessibilityIdentifier("restore-phone-copy-\(Self.serverName(e.server))")
                    }
                }
            }
            .padding(FS.space.s4)
            .fsReadingColumn()
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("From this phone")
        .navigationBarTitleDisplayMode(.inline)
    }

    static func when(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(date: .abbreviated, time: .shortened)
    }
}
