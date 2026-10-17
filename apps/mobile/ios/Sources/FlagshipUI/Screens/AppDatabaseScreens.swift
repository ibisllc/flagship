import SwiftUI
import FlagshipAPI
import FlagshipCore

// The owner's Database section (docs/app-apis.md §6): tables, rows (100 at
// a time), Export CSV and Run SQL. Owner only: a restricted profile never
// gets here (the app page hides the entry) and the box 403s companions.

private func appLabel(_ serviceId: String) -> String {
    ServicesTab.slug(of: serviceId).capitalized
}

// MARK: - Containers

struct AppDatabaseContainer: View {
    let serviceId: String
    @Binding var path: [AppsRoute]
    @Environment(\.screensClient) private var client
    @State private var controller: AppDatabaseController?

    var body: some View {
        Group {
            if let controller {
                AppDatabaseScreen(controller: controller, appName: appLabel(serviceId),
                                  onOpenTable: { store, table in
                                      path.append(.appDatabaseTable(serviceId: serviceId, store: store, table: table))
                                  },
                                  onRunSql: { store in
                                      path.append(.appDatabaseQuery(serviceId: serviceId, store: store))
                                  })
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            if controller == nil { controller = AppDatabaseController(serviceId: serviceId, client: client) }
            await controller?.load()
        }
    }
}

struct AppDbTableContainer: View {
    let serviceId: String
    let store: String
    let table: String
    @Environment(\.screensClient) private var client
    @State private var controller: AppDbTableController?

    var body: some View {
        Group {
            if let controller {
                AppDbTableScreen(controller: controller)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            if controller == nil {
                controller = AppDbTableController(serviceId: serviceId, store: store, table: table, client: client)
                await controller?.load()
            }
        }
    }
}

struct AppDbQueryContainer: View {
    let serviceId: String
    let store: String
    @Environment(\.screensClient) private var client
    @Environment(\.screensServerFqdn) private var bound
    @Environment(AppState.self) private var app
    @State private var controller: AppDbQueryController?

    var body: some View {
        Group {
            if let controller {
                AppDbQueryScreen(controller: controller)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            // The order names the box the client talks to; the session pod
            // is the fallback, never the leader.
            if controller == nil {
                controller = AppDbQueryController(serviceId: serviceId, store: store, appName: appLabel(serviceId),
                                                  client: client,
                                                  serverDomain: bound ?? app.sessionPod?.fqdn ?? app.currentPod?.fqdn,
                                                  canWrite: AdminOrderGate.allows(app))
            }
        }
    }
}

// MARK: - Tables

struct AppDatabaseScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var controller: AppDatabaseController
    let appName: String
    let onOpenTable: (_ store: String, _ table: String) -> Void
    let onRunSql: (_ store: String) -> Void

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Text(AppDbCopy.intro)
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                if controller.isHidden {
                    ErrorCard(message: "This server doesn't offer this app's database.")
                } else {
                    switch controller.state {
                    case .idle, .loading:
                        ProgressView().frame(maxWidth: .infinity)
                    case .failed(let msg):
                        ErrorCard(message: msg)
                    case .loaded(let stores):
                        ForEach(stores) { store in storeSection(store, c: c) }
                    }
                }
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.vertical, FS.space.s4)
            .fsReadingColumn()
        }
        .refreshable { await controller.load() }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("\(appName) · \(AppDbCopy.screenTitle)")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func storeSection(_ store: AppDbStore, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(AppDbCopy.storeTitle(store.store).uppercased())
                .font(FS.font.scaled(13, weight: .semibold)).foregroundColor(c.textMuted)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    if store.tables.isEmpty {
                        Text(AppDbCopy.noTables).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                    ForEach(store.tables) { t in
                        Button { onOpenTable(store.store, t.name) } label: {
                            HStack(spacing: FS.space.s3) {
                                Image(systemName: t.isView ? "eye" : "tablecells").foregroundColor(c.accent)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(t.name).font(FS.font.mono()).foregroundColor(c.text)
                                        .lineLimit(1).truncationMode(.middle)
                                    Text(AppDbCopy.tableDetail(t)).font(FS.font.caption()).foregroundColor(c.textMuted)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").foregroundColor(c.textMuted)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("database-table-\(t.name)")
                        Divider()
                    }
                    FSSecondaryButton(AppDbCopy.runSql, block: true) { onRunSql(store.store) }
                        .accessibilityIdentifier("database-run-sql")
                }
            }
        }
    }
}

// MARK: - Rows grid

/// Columns (name + type) over rows, scrolling sideways when wide. Each
/// column is as wide as its longest value, within limits.
struct AppDbGrid: View {
    @Environment(\.colorScheme) private var scheme
    let columns: [AppDbColumn]
    let rows: [[AppDbValue]]

    private static let charWidth: CGFloat = 8.4
    private static let minWidth: CGFloat = 72
    private static let maxWidth: CGFloat = 260

    private var widths: [CGFloat] {
        columns.indices.map { i in
            var longest = max(columns[i].name.count, columns[i].type.count)
            for row in rows.prefix(200) where i < row.count {
                longest = max(longest, min(row[i].display.count, 40))
            }
            return min(Self.maxWidth, max(Self.minWidth, CGFloat(longest) * Self.charWidth + 16))
        }
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        let w = widths
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 0) {
                    ForEach(columns.indices, id: \.self) { i in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(columns[i].name).font(FS.font.mono().weight(.semibold)).foregroundColor(c.text)
                            Text(columns[i].type).font(FS.font.scaled(11, design: .monospaced)).foregroundColor(c.textMuted)
                        }
                        .lineLimit(1)
                        .frame(width: w[i], alignment: .leading)
                        .padding(.vertical, 6)
                    }
                }
                .padding(.horizontal, FS.space.s2)
                .background(c.surface)
                Divider()
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(rows.indices, id: \.self) { r in
                        HStack(spacing: 0) {
                            ForEach(columns.indices, id: \.self) { i in
                                let v: AppDbValue = i < rows[r].count ? rows[r][i] : .null
                                Text(v.display)
                                    .font(FS.font.mono())
                                    .foregroundColor(v.isNull ? c.textMuted : c.text)
                                    .italic(v.isNull)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                    .frame(width: w[i], alignment: .leading)
                                    .padding(.vertical, 6)
                            }
                        }
                        .padding(.horizontal, FS.space.s2)
                        .textSelection(.enabled)
                        Divider()
                    }
                }
            }
        }
        .accessibilityIdentifier("database-grid")
    }
}

// MARK: - One table

struct AppDbTableScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var controller: AppDbTableController

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                switch controller.state {
                case .idle, .loading:
                    ProgressView().frame(maxWidth: .infinity).padding(.top, FS.space.s6)
                case .failed(let msg):
                    ErrorCard(message: msg)
                    FSSecondaryButton("Try again", block: true) { Task { await controller.load() } }
                case .loaded(let page):
                    Text(controller.pageLabel)
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                        .accessibilityIdentifier("database-page-label")
                    if page.columns.isEmpty {
                        Text(AppDbCopy.noTables).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    } else {
                        AppDbGrid(columns: page.columns, rows: page.rows)
                            .overlay(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous).stroke(c.border, lineWidth: 1))
                    }
                    HStack(spacing: FS.space.s2) {
                        FSSecondaryButton("Previous") { Task { await controller.previous() } }
                            .disabled(!controller.hasPrevious)
                            .accessibilityIdentifier("database-page-previous")
                        Spacer()
                        FSSecondaryButton("Next") { Task { await controller.next() } }
                            .disabled(!controller.hasNext)
                            .accessibilityIdentifier("database-page-next")
                    }
                }
                if let err = controller.exportError {
                    Text(err).font(FS.font.bodySm()).foregroundColor(c.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, FS.space.s4)
            .padding(.vertical, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle(controller.table)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await controller.exportCsv() }
                } label: {
                    if controller.isExporting { ProgressView() } else { Label(AppDbCopy.exportCsv, systemImage: "square.and.arrow.up") }
                }
                .disabled(controller.isExporting)
                .accessibilityIdentifier("database-export-csv")
            }
        }
        .sheet(item: $controller.exportedFile, onDismiss: { controller.finishExport() }) { url in
            ShareSheet(items: [url])
        }
    }
}

// MARK: - Run SQL

struct AppDbQueryScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var controller: AppDbQueryController
    /// Rows shown on the phone; the box returns at most 1000.
    private static let shownRows = 200

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                ZStack(alignment: .topLeading) {
                    if controller.sql.isEmpty {
                        Text(AppDbCopy.sqlPlaceholder)
                            .font(FS.font.mono()).foregroundColor(c.textMuted)
                            .padding(.horizontal, FS.space.s2 + 5).padding(.vertical, FS.space.s2 + 8)
                            .allowsHitTesting(false)
                    }
                    TextEditor(text: $controller.sql)
                        .font(FS.font.mono())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 140)
                        .padding(FS.space.s2)
                        .accessibilityIdentifier("database-sql-editor")
                }
                .background(c.surface)
                .overlay(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous).stroke(c.border, lineWidth: 1))

                FSPrimaryButton(controller.phase == .running ? "Running…" : AppDbCopy.run,
                                enabled: controller.canRun, block: true) {
                    Task { await controller.run() }
                }
                .accessibilityIdentifier("database-run")

                phaseView(c: c)
            }
            .padding(.horizontal, FS.space.s4)
            .padding(.vertical, FS.space.s4)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(c.bg.ignoresSafeArea())
        .navigationTitle(controller.store == "default" ? AppDbCopy.runSql : "\(AppDbCopy.runSql) · \(controller.store)")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func phaseView(c: FSColors) -> some View {
        switch controller.phase {
        case .idle, .running:
            EmptyView()
        case .needsConfirm, .signing:
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    HStack(alignment: .top, spacing: FS.space.s2) {
                        Image(systemName: "faceid").foregroundColor(c.warning)
                        Text(AppDbCopy.confirmWrite)
                            .font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("database-confirm-write")
                    }
                    let signing = controller.phase == .signing
                    FSPrimaryButton(signing ? "Confirming…" : AppDbCopy.confirmButton, enabled: !signing, block: true) {
                        Task { await controller.confirmWrite() }
                    }
                    .accessibilityIdentifier("database-confirm-run")
                    FSGhostButton("Cancel", block: true) { controller.cancelConfirm() }
                        .disabled(signing)
                }
            }
        case .failed(let msg):
            Text(msg).font(FS.font.bodySm()).foregroundColor(c.danger)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityIdentifier("database-query-error")
        case .done(let r):
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text(AppDbCopy.resultSummary(r))
                    .font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
                    .accessibilityIdentifier("database-query-summary")
                if !r.columns.isEmpty {
                    AppDbGrid(columns: r.columns, rows: Array(r.rows.prefix(Self.shownRows)))
                        .overlay(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous).stroke(c.border, lineWidth: 1))
                }
                if r.truncated || r.rows.count > Self.shownRows {
                    Text(r.truncated ? AppDbCopy.truncated
                         : "Showing the first \(Self.shownRows) of \(r.rows.count) rows.")
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("database-query-truncated")
                }
            }
        }
    }
}
