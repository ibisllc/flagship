import SwiftUI
import UIKit
import FlagshipAPI
import FlagshipCore

// Share this server (docs/share-a-server.md §8). Owner: the "Shared with"
// and "Activity" cards on a server's page and the Share sheet. The second
// account: the accept screen, Home's "Shared with me" and the shared
// server's page, which shows only what the share's level allows.

private func sectionHeader(_ title: String, c: FSColors) -> some View {
    Text(title)
        .font(.system(size: 12, weight: .semibold))
        .tracking(1)
        .foregroundColor(c.textMuted)
}

private func relative(_ ms: Int64) -> String {
    Date(timeIntervalSince1970: TimeInterval(ms) / 1000).formatted(.relative(presentation: .named))
}

// MARK: - Owner: "Shared with" + "Activity"

/// Self-contained like the other server-page cards: it finds the pod and the
/// box token itself, so the server page only places it.
struct ShareServerCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.sessionStore) private var sessionStore
    @Environment(AppState.self) private var app
    @Environment(ToastCenter.self) private var toasts

    let serverDomain: String

    @State private var model: ShareServerCardModel?
    @State private var sharing = false
    @State private var removing: OwnerShareRow?

    private var pod: PodInfo? { app.pods.first { $0.fqdn.lowercased() == serverDomain.lowercased() } }
    /// Grants, revokes and offers take the admin root: other devices see the
    /// card read-only instead of sending orders `.com` and the box refuse.
    private var canShare: Bool { AdminOrderGate.allows(app) }

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s6) {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                sectionHeader(ServerShareCopy.sectionTitle, c: c)
                FSCard { content(c) }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("share-server-card")
            if let model, case .loaded(let entries) = model.activity, !entries.isEmpty {
                activityCard(entries, c: c)
            }
        }
        .background(ServerShareDemo.route == "owner" ? DemoScrollIntoView() : nil)
        .task { await start() }
        .sheet(isPresented: $sharing) {
            if let model { ShareServerSheet(model: model, startOnLink: ServerShareDemo.route == "sheet") }
        }
        .confirmationDialog(
            removing.map { "Remove \($0.label)?" } ?? "",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            titleVisibility: .visible,
            presenting: removing
        ) { row in
            Button("Remove", role: .destructive) { Task { await model?.end(row) } }
        } message: { row in
            Text("\(row.label) loses access to this server at once.")
        }
    }

    private func start() async {
        #if DEBUG
        if model == nil, ServerShareDemo.route == "owner-refused" {
            // The gym: a real Confirm against ShareAcceptMockWorld's `.com` and
            // box, for an acceptance an older app sent with no admin proof.
            let fqdn = serverDomain.lowercased()
            let world = ShareAcceptMockWorld(shareId: String(repeating: "c3", count: 16), secret: Data(repeating: 0x5e, count: 32),
                                             serverDomain: fqdn,
                                             accountAdminPub: Data(repeating: 0, count: 32))
            if let household = GymSeams.accountRootSeed.flatMap({ ServiceInvite.deriveHouseholdKey(umkSeed: $0) }) {
                try? world.seedOldAcceptance(householdKey: household, label: "Riley")
            }
            model = ShareServerCardModel(
                serverDomain: fqdn,
                serverName: pod?.name ?? ServerShareNames.serverLabel(fromDomain: fqdn),
                stkPubHex: pod?.identityPubKeyHex ?? "",
                flow: ServerShareOwnerFlow(client: ServerShareServices.mockClient(world), username: app.currentUser ?? "bright-maple",
                                           keys: ServerShareServices.ownerKeys(),
                                           apexOrigin: { "https://flagshipserver.com" }),
                ownerToken: { "gym-owner-token" },
                keysUnlocked: { true }
            )
        }
        #endif
        if model == nil {
            let store = sessionStore
            let fqdn = serverDomain.lowercased()
            let demo = ServerShareDemo.isOn && !ServerShareDemo.flowsOn
            let gym = ServerShareDemo.flowsOn
            let stk = pod?.identityPubKeyHex ?? ""
            model = ShareServerCardModel(
                serverDomain: fqdn,
                serverName: pod?.name ?? ServerShareNames.serverLabel(fromDomain: fqdn),
                stkPubHex: stk.isEmpty && gym ? GymShareTransport.stkPubHex : stk,
                flow: demo ? nil : app.currentUser.map {
                    ServerShareOwnerFlow(client: ServerShareServices.client, username: $0, keys: ServerShareServices.ownerKeys())
                },
                ownerToken: {
                    let t = await store.sessionToken(forPodId: PodInfo.podId(forFqdn: fqdn))
                    if gym, t?.isEmpty ?? true { return "gym-owner" }
                    return (t?.isEmpty ?? true) ? nil : t
                },
                demo: demo
            )
        }
        await model?.load()
        await model?.loadActivity()
        if ServerShareDemo.route == "sheet", !sharing {
            try? await Task.sleep(for: .seconds(1.5))
            sharing = true
        }
    }

    @ViewBuilder
    private func content(_ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            if let model {
                switch model.state {
                case .idle, .loading:
                    ProgressView().frame(maxWidth: .infinity)
                case .failed(let msg):
                    Text(msg).font(FS.font.bodySm()).foregroundColor(c.danger)
                        .fixedSize(horizontal: false, vertical: true)
                case .loaded(let snap):
                    if snap.rows.isEmpty {
                        Text(ServerShareCopy.nobodyYet).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ForEach(snap.rows) { row in
                        rowView(row, model: model, c: c)
                        Divider()
                    }
                    if !snap.invitationsRead {
                        FSGhostButton(ServerShareCopy.showInvitations, block: true) {
                            Task { await model.load(allowAuth: true) }
                        }
                        .accessibilityIdentifier("share-show-invitations")
                    }
                }
                if let n = model.notice {
                    Text(n).font(FS.font.bodySm()).foregroundColor(c.warning).fixedSize(horizontal: false, vertical: true)
                }
                if let e = model.errorMessage {
                    Text(e).font(FS.font.bodySm()).foregroundColor(c.danger).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("share-error")
                }
                if canShare {
                    FSPrimaryButton(ServerShareCopy.shareButton, enabled: model.busy == nil, block: true) { sharing = true }
                        .accessibilityIdentifier("share-server-open")
                } else {
                    Text(AdminOrderGate.share).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("share-admin-only")
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
    }

    @ViewBuilder
    private func rowView(_ row: OwnerShareRow, model: ShareServerCardModel, c: FSColors) -> some View {
        let busy = model.busy == row.shareId
        VStack(alignment: .leading, spacing: FS.space.s2) {
            HStack(spacing: FS.space.s2) {
                FSMonogram(name: row.label, size: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.label).font(.system(size: 16, weight: .semibold)).foregroundColor(c.text)
                    if row.status == .active, let seen = row.lastSeenAt {
                        Text("Last here \(relative(seen))").font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                }
                Spacer()
                if busy { ProgressView() } else {
                    FSPill(ServerShareCopy.levelName(row.level), kind: row.status == .active ? .online : .pending)
                }
            }
            switch row.status {
            case .active where !canShare:
                Text(ServerShareCopy.levelLine(row.level)).font(FS.font.caption()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            case .active:
                activeControls(row, model: model, busy: busy, c: c)
            case .awaitingConfirm(let sas):
                Text(ServerShareCopy.awaitingConfirm(row.label)).font(FS.font.bodySm()).foregroundColor(c.text)
                    .fixedSize(horizontal: false, vertical: true)
                Text(sas).font(.system(size: 30, weight: .semibold, design: .monospaced)).foregroundColor(c.text)
                    .accessibilityIdentifier("share-sas-\(row.shareId)")
                Text("Only confirm if it matches. A different code means someone else opened the link.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
                if canShare {
                    HStack(spacing: FS.space.s2) {
                        FSPrimaryButton("Confirm with Face ID", enabled: model.busy == nil) { Task { await model.confirm(row) } }
                            .accessibilityIdentifier("share-confirm-\(row.shareId)")
                        FSGhostButton("Cancel") { Task { await model.end(row) } }
                            .disabled(model.busy != nil)
                    }
                }
            case .offered(let link, let expiresAt):
                Text(ServerShareCopy.offered(row.label)).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                Text("The link expires \(relative(expiresAt)).").font(FS.font.caption()).foregroundColor(c.textMuted)
                HStack(spacing: FS.space.s2) {
                    FSSecondaryButton("Copy link") {
                        UIPasteboard.general.string = link
                        toasts.success("Link copied.")
                    }
                    if canShare {
                        FSGhostButton("Cancel") { Task { await model.end(row) } }
                            .disabled(model.busy != nil)
                    }
                }
            case .acceptanceInvalid:
                Text(ServerShareCopy.acceptanceInvalid).font(FS.font.bodySm()).foregroundColor(c.danger)
                    .fixedSize(horizontal: false, vertical: true)
                if canShare {
                    FSGhostButton("Cancel") { Task { await model.end(row) } }.disabled(model.busy != nil)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("share-row-\(row.shareId)")
    }

    @ViewBuilder
    private func activeControls(_ row: OwnerShareRow, model: ShareServerCardModel, busy: Bool, c: FSColors) -> some View {
        Picker("Access", selection: Binding(
            get: { row.level },
            set: { level in Task { await model.change(row, level: level) } }
        )) {
            ForEach(ServerShareLevel.allCases, id: \.self) { Text(ServerShareCopy.levelName($0)).tag($0) }
        }
        .pickerStyle(.segmented)
        .disabled(model.busy != nil)
        .accessibilityIdentifier("share-level-\(row.shareId)")
        Text(ServerShareCopy.levelLine(row.level)).font(FS.font.caption()).foregroundColor(c.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        optIn(ServerShareCopy.unlockTitle, ServerShareCopy.unlockLine, warning: ServerShareCopy.unlockHouseKey, isOn: Binding(
            get: { row.unlockAtBoot },
            set: { on in Task { await model.change(row, unlockAtBoot: on) } }
        ), c: c)
        .disabled(model.busy != nil)
        .accessibilityIdentifier("share-unlock-\(row.shareId)")
        if row.needsStartupKey {
            HStack(spacing: FS.space.s2) {
                Text(ServerShareCopy.startupKeyMissing).font(FS.font.caption()).foregroundColor(c.warning)
                Spacer()
                FSGhostButton("Set up") { Task { await model.sendStartupKey(row) } }.disabled(model.busy != nil)
                    .accessibilityIdentifier("share-startup-setup-\(row.shareId)")
            }
        }
        optIn(ServerShareCopy.dataTitle, ServerShareCopy.dataLine, isOn: Binding(
            get: { row.seeAppData },
            set: { on in Task { await model.change(row, seeAppData: on) } }
        ), c: c)
        .disabled(model.busy != nil)
        .accessibilityIdentifier("share-data-\(row.shareId)")
        FSGhostButton("Remove \(row.label)") { removing = row }
            .disabled(model.busy != nil)
            .accessibilityIdentifier("share-remove-\(row.shareId)")
    }

    private func activityCard(_ entries: [ShareActivityEntry], c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            sectionHeader("ACTIVITY", c: c)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    ForEach(entries.prefix(12)) { e in
                        HStack(alignment: .firstTextBaseline) {
                            Text(ServerShareCopy.activityLine(e)).font(FS.font.bodySm()).foregroundColor(c.text)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: FS.space.s2)
                            Text(relative(e.ts)).font(FS.font.caption()).foregroundColor(c.textMuted)
                        }
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("share-activity-card")
    }
}

private func optIn(_ title: String, _ line: String, warning: String? = nil, isOn: Binding<Bool>, c: FSColors) -> some View {
    Toggle(isOn: isOn) {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
            Text(line).font(FS.font.caption()).foregroundColor(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            if let warning {
                Text(warning).font(FS.font.caption()).foregroundColor(c.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
    .tint(c.primary)
}

// MARK: - Owner: the Share sheet

struct ShareServerSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @Environment(ToastCenter.self) private var toasts
    @Bindable var model: ShareServerCardModel
    var startOnLink = false

    @State private var draft = ShareDraft()
    @State private var created: CreatedShare?

    var body: some View {
        let c = FSColors.scheme(scheme)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s6) {
                    if let created { linkStep(created, c: c) } else { form(c) }
                }
                .padding(.horizontal, FS.space.s6)
                .padding(.vertical, FS.space.s4)
                .fsReadingColumn()
            }
            .background(c.bg.ignoresSafeArea())
            .navigationTitle(ServerShareCopy.shareButton)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(created == nil ? "Cancel" : "Done") { dismiss() }
                }
            }
        }
        .task {
            if startOnLink, created == nil {
                draft.label = "Alex"
                created = await model.create(draft)
            }
        }
    }

    private var labelOk: Bool { ServerShare.normalizeShareLabel(draft.label) != nil }

    @ViewBuilder
    private func form(_ c: FSColors) -> some View {
        Text("Give another person access to \(model.serverName). They use their own Flagship account; you can change or remove their access at any time.")
            .font(FS.font.bodySm()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
        FSField(value: $draft.label, label: "Who is it for?", placeholder: "Sam",
                helper: "Only you and this server see this name.")
            .accessibilityIdentifier("share-label")
        VStack(alignment: .leading, spacing: FS.space.s2) {
            sectionHeader("WHAT THEY CAN DO", c: c)
            ForEach(ServerShareLevel.allCases, id: \.self) { level in
                Button { draft.level = level } label: {
                    HStack(alignment: .top, spacing: FS.space.s3) {
                        Image(systemName: draft.level == level ? "largecircle.fill.circle" : "circle")
                            .foregroundColor(draft.level == level ? c.primary : c.textMuted)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ServerShareCopy.levelName(level)).font(FS.font.body().weight(.semibold)).foregroundColor(c.text)
                            Text(ServerShareCopy.levelLine(level)).font(FS.font.caption()).foregroundColor(c.textMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer()
                    }
                    .padding(FS.space.s3)
                    .background(c.surface)
                    .overlay(RoundedRectangle(cornerRadius: FS.radius.md)
                        .stroke(draft.level == level ? c.primary : c.border, lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("share-level-\(level.rawValue)")
            }
        }
        VStack(alignment: .leading, spacing: FS.space.s3) {
            sectionHeader("ALSO LET THEM", c: c)
            optIn(ServerShareCopy.unlockTitle, ServerShareCopy.unlockLine, warning: ServerShareCopy.unlockHouseKey,
                  isOn: $draft.unlockAtBoot, c: c)
                .accessibilityIdentifier("share-draft-unlock")
            optIn(ServerShareCopy.dataTitle, ServerShareCopy.dataLine, isOn: $draft.seeAppData, c: c)
                .accessibilityIdentifier("share-draft-data")
        }
        if let e = model.errorMessage {
            Text(e).font(FS.font.bodySm()).foregroundColor(c.danger).fixedSize(horizontal: false, vertical: true)
        }
        FSPrimaryButton(model.busy == "create" ? "Creating…" : "Create link", enabled: labelOk && model.busy == nil,
                        block: true, large: true) {
            Task { created = await model.create(draft) }
        }
        .accessibilityIdentifier("share-create")
    }

    @ViewBuilder
    private func linkStep(_ created: CreatedShare, c: FSColors) -> some View {
        let name = ServerShare.normalizeShareLabel(draft.label) ?? "them"
        Text("Send this link to \(name)").font(FS.font.h3()).foregroundColor(c.text)
        Text("It works once and expires in 7 days. When \(name) opens it, their phone shows a 6-digit code. You'll check it here before they get access.")
            .font(FS.font.bodySm()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
        HStack {
            Spacer()
            PairingQRView(text: created.link, size: 200).accessibilityIdentifier("share-qr")
            Spacer()
        }
        Text(created.link)
            .font(FS.font.mono()).foregroundColor(c.text)
            .lineLimit(3).truncationMode(.middle)
            .textSelection(.enabled)
            .padding(.vertical, FS.space.s2).padding(.horizontal, FS.space.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(c.surfaceSunken)
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
            .accessibilityIdentifier("share-link")
        HStack(spacing: FS.space.s3) {
            if let url = URL(string: created.link) {
                ShareLink(item: url) { Label("Share…", systemImage: "square.and.arrow.up") }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("share-sheet")
            }
            Button {
                UIPasteboard.general.string = created.link
                toasts.success("Link copied.")
            } label: { Label("Copy link", systemImage: "doc.on.doc") }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("share-copy-link")
        }
        Text("Anyone with the link can ask to join, so send it only to \(name).")
            .font(FS.font.caption()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - Home: "Shared with me"

/// Servers other accounts shared with this one. Absent when there are none:
/// accepting a share starts from "Add a server" (docs/share-a-server.md §8).
struct SharedWithMeSection: View {
    @Environment(\.colorScheme) private var scheme
    let rows: [SharedServerRow]
    var onOpen: (String) -> Void = { _ in }

    var body: some View {
        let c = FSColors.scheme(scheme)
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                HStack {
                    sectionHeader("SHARED WITH ME", c: c)
                    Spacer()
                    Text("\(rows.count)").font(.system(size: 12, weight: .semibold)).foregroundColor(c.textMuted)
                }
                LazyVStack(spacing: FS.space.s3) {
                    ForEach(rows) { row in
                        Button { onOpen(row.shareId) } label: {
                            FSListRow(leading: .icon("person.2.fill", color: c.primary), title: row.name,
                                      subtitle: "Shared by \(row.owner)",
                                      below: {
                                          if row.waitingForOwner {
                                              FSPill("Waiting for the owner", kind: .pending)
                                          } else if let level = row.level {
                                              FSPill(ServerShareCopy.levelName(level), kind: .online)
                                          }
                                      },
                                      trailing: { Image(systemName: "chevron.right").foregroundColor(c.textMuted) })
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("home-shared-\(row.shareId)")
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("home-shared-with-me")
            .background(ServerShareDemo.route == "home" ? DemoScrollIntoView() : nil)
        }
    }
}

// MARK: - The second account: accept a link

struct ShareAcceptScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(AppState.self) private var app
    let shareId: String?
    let secretHex: String?
    var onOpenServer: (String) -> Void = { _ in }

    @State private var model: ShareAcceptModel?
    @State private var pasted = ""
    @State private var scanning = false
    @State private var badPaste = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                if let model { phaseView(model, c: c) } else { ProgressView().frame(maxWidth: .infinity) }
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.vertical, FS.space.s4)
            .fsReadingColumn()
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Shared server")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                #if DEBUG
                if ServerShareDemo.route == "accept-admin" {
                    // The gym: a real accept against ShareAcceptMockWorld's `.com` and box.
                    let world = ShareAcceptMockWorld.gym()
                    let flow = ServerShareMemberFlow(
                        client: ServerShareServices.mockClient(world), umkSeed: ServerShareServices.umkSeed,
                        admin: ServerShareServices.acceptAdminKeys(username: app.currentUser ?? "bright-maple",
                                                                   isDemoAccount: app.isDemoAccount))
                    model = ShareAcceptModel(store: SharedWithMeStore(flow: flow), flow: flow)
                    await model?.open(shareId: world.shareId, secretHex: HexUtil.encode(world.secret))
                    return
                }
                #endif
                let store = SharedWithMeStore.shared
                let demo = ServerShareDemo.isOn && !ServerShareDemo.flowsOn
                model = ShareAcceptModel(store: store,
                                         flow: ServerShareDemo.isOn ? store.flow : ServerShareServices.acceptFlow(username: app.currentUser,
                                                                                                                 isDemoAccount: app.isDemoAccount),
                                         demo: demo)
                if let shareId, let secretHex {
                    await model?.open(shareId: shareId, secretHex: secretHex)
                }
                #if DEBUG
                if shareId == nil || secretHex == nil, ServerShareDemo.route == "accept" {
                    await model?.open(shareId: ServerShareDemo.invitation.shareId, secretHex: ServerShareDemo.secretHex)
                }
                #endif
            }
        }
        .sheet(isPresented: $scanning) {
            NavigationStack {
                QRScannerView(
                    onScan: { text in
                        scanning = false
                        Task { _ = await model?.open(text: text) }
                    },
                    validate: { ServerShare.parseShareLink($0) != nil }
                )
                .ignoresSafeArea()
                .navigationTitle("Scan the share code")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { scanning = false } } }
            }
        }
    }

    @ViewBuilder
    private func phaseView(_ model: ShareAcceptModel, c: FSColors) -> some View {
        switch model.phase {
        case .entry:
            Text("Open a shared server").font(FS.font.h3()).foregroundColor(c.text)
            Text("Paste the link someone sent you, or scan the code on their phone.")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
            FSField(value: $pasted, label: "Link", placeholder: "https://flagshipserver.com/share#…",
                    error: badPaste ? "That isn't a share link." : nil)
                .accessibilityIdentifier("share-accept-paste")
            FSPrimaryButton("Open", enabled: !pasted.isEmpty, block: true) {
                Task { badPaste = !(await model.open(text: pasted)) }
            }
            .accessibilityIdentifier("share-accept-open")
            FSSecondaryButton("Scan a code", block: true) { scanning = true }
                .accessibilityIdentifier("share-accept-scan")
        case .opening:
            ProgressView("Opening the link…").frame(maxWidth: .infinity)
        case .invitation(let inv), .accepting(let inv):
            invitation(inv, accepting: model.phase == .accepting(inv), model: model, c: c)
        case .code(let accepted, let owner):
            codeView(accepted, owner: owner, c: c)
                .task { await model.waitForConfirmation() }
        case .done(let entry):
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    Label("You're in", systemImage: "checkmark.seal.fill")
                        .font(FS.font.h4()).foregroundColor(c.success)
                    Text("\(entry.ownerName) confirmed. \(entry.displayName) is now under Shared with me on Home.")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
                    FSPrimaryButton("Open \(entry.displayName)", block: true) { onOpenServer(entry.shareId) }
                        .accessibilityIdentifier("share-accept-done-open")
                }
            }
        case .failed(let msg):
            ErrorCard(message: msg)
        }
    }

    private func invitation(_ inv: ShareInvitation, accepting: Bool, model: ShareAcceptModel, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            Text("\(inv.ownerName) shared a server with you").font(FS.font.h3()).foregroundColor(c.text)
                .fixedSize(horizontal: false, vertical: true)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    HStack {
                        Text(inv.offer.serverName.isEmpty ? ServerShareNames.serverLabel(fromDomain: inv.offer.serverDomain) : inv.offer.serverName)
                            .font(.system(size: 17, weight: .semibold)).foregroundColor(c.text)
                        Spacer()
                        FSPill(ServerShareCopy.levelName(inv.offer.level), kind: .online)
                    }
                    Text(inv.offer.serverDomain).font(FS.font.mono()).foregroundColor(c.textMuted)
                        .lineLimit(1).truncationMode(.middle)
                    Text(ServerShareCopy.levelLine(inv.offer.level)).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    if inv.offer.unlockAtBoot {
                        Label("You can approve its start-ups.", systemImage: "power").font(FS.font.bodySm()).foregroundColor(c.text)
                    }
                    if inv.offer.seeAppData {
                        Label("You can see its apps' data.", systemImage: "tablecells").font(FS.font.bodySm()).foregroundColor(c.text)
                    }
                }
            }
            Text("\(inv.ownerName) won't learn your account name. They see only the name they gave you.")
                .font(FS.font.caption()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
            if model.canAccept {
                FSPrimaryButton(accepting ? "Accepting…" : "Accept", enabled: !accepting, block: true, large: true) {
                    Task { await model.accept() }
                }
                .accessibilityIdentifier("share-accept")
            } else {
                Text(ServerShareFlowError.notAdminDeviceMessage)
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("share-accept-admin-only")
            }
        }
    }

    private func codeView(_ accepted: AcceptedShare, owner: String, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            Text("Read this code to \(owner)").font(FS.font.h3()).foregroundColor(c.text)
            FSCard {
                HStack {
                    Spacer()
                    Text(accepted.sas)
                        .font(.system(size: 44, weight: .semibold, design: .monospaced))
                        .foregroundColor(c.text)
                        .accessibilityIdentifier("share-accept-sas")
                    Spacer()
                }
                .padding(.vertical, FS.space.s4)
            }
            Text("\(owner) checks that their phone shows the same code before giving you access. If it doesn't match, they won't confirm.")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: FS.space.s2) {
                ProgressView()
                Text("Waiting for \(owner) to confirm…").font(FS.font.bodySm()).foregroundColor(c.textMuted)
            }
        }
    }
}

// MARK: - The second account: the shared server's page

struct SharedServerScreen: View {
    @Environment(\.colorScheme) private var scheme
    let shareId: String
    var onOpenApp: (String) -> Void = { _ in }
    var onLeft: () -> Void = {}

    @State private var model: SharedServerModel?
    @State private var confirmLeave = false
    @State private var confirmUpdate: ReleaseEntry?

    private var store: SharedWithMeStore { SharedWithMeStore.shared }

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                if let model { content(model, c: c) } else { ServerCardSkeleton() }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
            .fsReadingColumn()
            .containerRelativeFrame(.horizontal)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle(model?.entry?.displayName ?? "Shared server")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await model?.load()
            await model?.refreshStartups()
        }
        .task {
            if model == nil { model = SharedServerModel(shareId: shareId, store: store) }
            await model?.load()
            model?.metrics?.startPolling(every: 15)
            while !Task.isCancelled {
                await model?.refreshStartups()
                try? await Task.sleep(for: .seconds(10))
            }
        }
        .onDisappear { model?.metrics?.stopPolling() }
        .confirmationDialog("Leave this server?", isPresented: $confirmLeave, titleVisibility: .visible) {
            Button("Leave", role: .destructive) {
                Task { if await model?.leave() == true { onLeft() } }
            }
        } message: {
            Text("You lose access at once. The owner would have to share it with you again.")
        }
        .confirmationDialog(
            confirmUpdate.map { ServerShareCopy.updateButton($0) } ?? "",
            isPresented: Binding(get: { confirmUpdate != nil }, set: { if !$0 { confirmUpdate = nil } }),
            titleVisibility: .visible,
            presenting: confirmUpdate
        ) { release in
            Button("Update") { Task { await model?.update(to: release) } }
        } message: { _ in
            Text(ServerShareCopy.updateConfirm(model?.entry?.displayName ?? "The server"))
        }
    }

    @ViewBuilder
    private func content(_ model: SharedServerModel, c: FSColors) -> some View {
        if model.ended {
            ErrorCard(message: ServerShareFlowError.shareEnded.errorDescription ?? "")
        } else if let entry = model.entry {
            header(entry, model: model, c: c)
            ForEach(model.startups) { s in startupCard(s, entry: entry, model: model, c: c) }
            if let n = model.notice {
                Text(n).font(FS.font.bodySm()).foregroundColor(c.success).fixedSize(horizontal: false, vertical: true)
            }
            if let e = model.errorMessage {
                Text(e).font(FS.font.bodySm()).foregroundColor(c.danger).fixedSize(horizontal: false, vertical: true)
            }
            switch model.detail {
            case .idle, .loading:
                ServerCardSkeleton()
            case .failed(let msg):
                FSCard {
                    Text(msg).font(FS.font.bodySm()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
                }
            case .loaded(let d):
                status(d, c: c)
                if model.canUpdate { updateSection(d, model: model, c: c) }
                if let metrics = model.metrics { MonitoringPane(health: nil, metrics: metrics.state, cert: nil) }
                appsSection(model, c: c)
            }
            if model.session?.unlockAtBoot == true { startupNotices(model, c: c) }
            whatYouCanDo(model, c: c)
            VStack(alignment: .leading, spacing: FS.space.s3) {
                sectionHeader("LEAVE", c: c)
                FSDangerButton("Leave this server", block: true) { confirmLeave = true }
                    .accessibilityIdentifier("shared-leave")
            }
        }
    }

    private func header(_ entry: SharedServerEntry, model: SharedServerModel, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack {
                    Text(entry.displayName).font(.system(size: 20, weight: .semibold)).foregroundColor(c.text)
                    Spacer()
                    if let level = model.level { FSPill(ServerShareCopy.levelName(level), kind: .online) }
                }
                Text("Shared by \(entry.ownerName)").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                Text(entry.serverDomain).font(FS.font.mono()).foregroundColor(c.textMuted)
                    .lineLimit(1).truncationMode(.middle)
            }
        }
    }

    private func startupCard(_ s: VerifiedShareStartup, entry: SharedServerEntry, model: SharedServerModel, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            sectionHeader("START-UP", c: c)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("\(entry.displayName) is starting. Unlock it?")
                        .font(.system(size: 17, weight: .semibold)).foregroundColor(c.text)
                    Text("It's waiting for its disk key. Unlock it only if you expected it to restart.")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
                    FSPrimaryButton(model.approving ? "Unlocking…" : "Unlock with Face ID", enabled: !model.approving,
                                    block: true, large: true) {
                        Task { await model.approve(s) }
                    }
                    .accessibilityIdentifier("shared-approve-startup")
                    FSGhostButton("Not now", block: true) { model.dismiss(s) }
                        .accessibilityIdentifier("shared-startup-not-now")
                }
            }
        }
    }

    private func status(_ d: ServerDetailResponse, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            sectionHeader("STATUS", c: c)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    HStack {
                        FSPill("Online", kind: .online)
                        Spacer()
                        Text("Version \(d.daemonVersion)").font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                    Text("Running since \(relative(d.startedAt))").font(FS.font.bodySm()).foregroundColor(c.text)
                    if let notAfter = d.certNotAfter {
                        Text("Certificate renews before \(Date(timeIntervalSince1970: TimeInterval(notAfter) / 1000).formatted(date: .abbreviated, time: .omitted))")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                }
            }
        }
    }

    private func updateSection(_ d: ServerDetailResponse, model: SharedServerModel, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            sectionHeader("UPDATE", c: c)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("Version \(d.currentCommit.map { String($0.prefix(8)) } ?? "unknown")")
                        .font(FS.font.bodySm()).foregroundColor(c.text)
                    if let latest = model.latestRelease {
                        Label("New release available: \(latest.tag)", systemImage: "arrow.up.circle.fill")
                            .font(FS.font.bodySm()).foregroundColor(c.text)
                        FSPrimaryButton(model.updating ? "Sending…" : ServerShareCopy.updateButton(latest),
                                        enabled: !model.updating && d.currentCommit != nil && model.updateNotice == nil,
                                        block: true) {
                            confirmUpdate = latest
                        }
                        .accessibilityIdentifier("shared-update")
                    } else {
                        Text("This server is on the latest release.").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                    if let n = model.updateNotice {
                        Text(n).font(FS.font.bodySm()).foregroundColor(c.success).fixedSize(horizontal: false, vertical: true)
                    }
                    if let e = model.updateError {
                        Text(e).font(FS.font.bodySm()).foregroundColor(c.danger).fixedSize(horizontal: false, vertical: true)
                    }
                    if let last = d.lastUpdate?.summary {
                        Text(last).font(FS.font.caption()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("shared-update-card")
    }

    private func startupNotices(_ model: SharedServerModel, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            sectionHeader("START-UP NOTICES", c: c)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    optIn(ServerShareCopy.notifyTitle, ServerShareCopy.notifyNote, isOn: Binding(
                        get: { model.notifyOn },
                        set: { on in Task { await model.setNotify(on) } }
                    ), c: c)
                    .disabled(model.notifyBusy)
                    .accessibilityIdentifier("shared-startup-notify")
                    if let e = model.notifyError {
                        Text(e).font(FS.font.bodySm()).foregroundColor(c.danger).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func appsSection(_ model: SharedServerModel, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            sectionHeader("APPS", c: c)
            switch model.apps {
            case .loaded(let apps) where apps.isEmpty:
                Text("No apps on this server yet.").font(FS.font.bodySm()).foregroundColor(c.textMuted)
            case .loaded(let apps):
                if model.level == .view {
                    Text(ShareCoInviteCopy.viewOnly).font(FS.font.caption()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("co-invite-view-only")
                }
                VStack(spacing: FS.space.s2) {
                    ForEach(apps, id: \.serviceId) { app in
                        Button { onOpenApp(app.serviceId) } label: {
                            FSListRow(leading: .icon("app.dashed", color: app.status == "running" ? c.success : c.textMuted),
                                      title: app.slug.capitalized, subtitle: app.summary ?? app.url,
                                      below: {
                                          if app.isMembersOnly {
                                              Text(ServerShareCopy.membersOnlyHint).font(FS.font.caption()).foregroundColor(c.textMuted)
                                                  .fixedSize(horizontal: false, vertical: true)
                                          }
                                      },
                                      trailing: { Image(systemName: "chevron.right").foregroundColor(c.textMuted) })
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("shared-app-\(app.serviceId)")
                    }
                }
            default:
                ServerCardSkeleton()
            }
        }
    }

    private func whatYouCanDo(_ model: SharedServerModel, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            sectionHeader("WHAT YOU CAN DO", c: c)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text(ServerShareCopy.levelLine(model.level ?? .view)).font(FS.font.bodySm()).foregroundColor(c.text)
                        .fixedSize(horizontal: false, vertical: true)
                    if model.session?.seeAppData == true {
                        Label("You can see app data. Open an app to read its database.", systemImage: "tablecells")
                            .font(FS.font.bodySm()).foregroundColor(c.text)
                    }
                    if model.session?.unlockAtBoot == true {
                        Label("You can approve this server's start-ups. Keep this page open when it restarts.", systemImage: "power")
                            .font(FS.font.bodySm()).foregroundColor(c.text)
                    }
                    Text("The owner can change this or remove you at any time.")
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                }
            }
        }
    }
}

// MARK: - The second account: one app on a shared server

struct SharedAppScreen: View {
    private struct DbTable: Hashable { let store: String; let table: String }
    private struct DbQuery: Hashable { let store: String }

    @Environment(\.colorScheme) private var scheme
    let shareId: String
    let serviceId: String

    @State private var server: SharedServerModel?
    @State private var detail: LoadingState<AppSummary> = .idle
    @State private var access: AppAccessController?
    @State private var invites: CoInviteController?
    @State private var database: AppDatabaseController?
    @State private var showDatabase = false
    @State private var table: DbTable?
    @State private var query: DbQuery?

    private var appName: String { ServicesTab.slug(of: serviceId).capitalized }

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                switch detail {
                case .idle, .loading: ServerCardSkeleton()
                case .failed(let msg): ErrorCard(message: msg)
                case .loaded(let app):
                    FSCard {
                        VStack(alignment: .leading, spacing: FS.space.s2) {
                            HStack {
                                Text(appName).font(.system(size: 20, weight: .semibold)).foregroundColor(c.text)
                                Spacer()
                                FSPill(app.status == "running" ? "Running" : app.status.capitalized,
                                       kind: app.status == "running" ? .online : .idle)
                            }
                            if let s = app.summary { Text(s).font(FS.font.bodySm()).foregroundColor(c.textMuted) }
                            if app.isMembersOnly {
                                Label(ServerShareCopy.membersOnlyHint, systemImage: "lock")
                                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .accessibilityIdentifier("shared-app-members-only")
                            }
                            if let url = URL(string: app.url) {
                                Link(destination: url) { Label("Open \(appName)", systemImage: "safari") }
                                    .font(FS.font.bodySm())
                            }
                        }
                    }
                    if let access { InternetAccessSection(controller: access) }
                    if let invites { CoInviteSection(controller: invites) }
                    if let database {
                        FSSecondaryButton("Database", block: true) { showDatabase = true }
                            .accessibilityIdentifier("shared-app-database")
                            .navigationDestination(isPresented: $showDatabase) {
                                AppDatabaseScreen(controller: database, appName: appName,
                                                  onOpenTable: { table = DbTable(store: $0, table: $1) },
                                                  onRunSql: { query = DbQuery(store: $0) })
                                    .task { await database.load() }
                                    .navigationDestination(item: $table) { t in tableScreen(t) }
                                    .navigationDestination(item: $query) { q in queryScreen(q) }
                            }
                    }
                }
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.vertical, FS.space.s4)
            .fsReadingColumn()
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle(appName)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    @State private var client: (any ScreensClient)?

    private func load() async {
        let store = SharedWithMeStore.shared
        if server == nil { server = SharedServerModel(shareId: shareId, store: store) }
        guard let server, let entry = server.entry else { return }
        do {
            let c = try await store.screensClient(for: shareId)
            client = c
            let session = store.item(shareId)?.session
            let app = try await c.appDetail(serviceId: serviceId).app
            detail = .loaded(app)
            if session?.level == .manage, access == nil {
                let a = AppAccessController(serviceId: serviceId, appName: appName, client: c,
                                            serverDomain: entry.serverDomain, signer: server.memberSigner)
                access = a
                await a.load()
            }
            if session?.level == .manage, invites == nil {
                invites = CoInviteController(store: store, shareId: shareId, serviceRef: serviceId, appName: appName)
            }
            if session?.seeAppData == true, database == nil {
                database = AppDatabaseController(serviceId: serviceId, client: c)
            }
        } catch {
            detail = .failed(ServerShareCopy.message(for: error))
        }
    }

    @ViewBuilder
    private func tableScreen(_ t: DbTable) -> some View {
        if let client {
            let ctrl = AppDbTableController(serviceId: serviceId, store: t.store, table: t.table, client: client)
            AppDbTableScreen(controller: ctrl).task { await ctrl.load() }
        }
    }

    @ViewBuilder
    private func queryScreen(_ q: DbQuery) -> some View {
        if let client, let server, let entry = server.entry {
            AppDbQueryScreen(controller: AppDbQueryController(
                serviceId: serviceId, store: q.store, appName: appName, client: client,
                serverDomain: entry.serverDomain, signer: server.memberSigner))
        }
    }
}

// MARK: - Demo

/// Smoke-mode only: scrolls the nearest scroll view so this view is on
/// screen, for screenshots of cards low on a page.
private struct DemoScrollIntoView: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView { Probe() }
    func updateUIView(_ uiView: UIView, context: Context) {}

    private final class Probe: UIView {
        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self else { return }
                var v: UIView? = superview
                while let cur = v, !(cur is UIScrollView) { v = cur.superview }
                guard let scroll = v as? UIScrollView else { return }
                let r = convert(bounds, to: scroll)
                let y = min(max(0, r.minY - 80), max(0, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom))
                scroll.setContentOffset(CGPoint(x: 0, y: y - scroll.adjustedContentInset.top), animated: false)
            }
        }
    }
}
