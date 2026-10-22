import SwiftUI
import PhotosUI
import FlagshipAPI
import FlagshipCore

/// "Access control" screen (docs/service-access-gating.md, "Open mode +
/// members" and "Account members, ranks and who may change them"). Mirrors
/// the webapp `views/service-access.js`:
///   - a two-way Open to all | Members only toggle (reads the TRUE mode from
///     the box; an admin sets it with a signed order; rolls back on failure),
///   - Account members: this account's devices (names decrypted on the
///     phone) and the accounts co-managing the server, each with its rank;
///     on an admin device a rank menu and Refuse per row,
///   - on a Pro account, "Separate list on each server" (admin devices) and,
///     while it is on, a server picker that re-targets the whole screen,
///   - in both modes, Members (n): people and groups with a rank each
///     (a signed `flagship/app-rank/v1` order), + Add person / + Add group
///     (the rank chosen at creation), remove (withdraw), and who invited
///     each one ("Invited by <device>").
///
/// Only an admin device (it holds the admin root) gives a rank above Member,
/// changes ranks, the mode or revokes anyone; another device that is Manager
/// or Master in the app invites at Member and may withdraw only its own
/// invites; below that it sees why it can't invite.
///
/// Self-contained: reads the box+`.com` access client from the environment.
public struct ServiceAccessScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.serviceAccessClient) private var client
    @Environment(\.screensClient) private var screens
    @Environment(\.serviceAccessKeys) private var keys
    @Environment(\.flagshipServerClient) private var server
    @Environment(\.podScreensClients) private var podClients
    @Environment(AppState.self) private var app
    @Environment(ToastCenter.self) private var toasts

    private let serverDomain: String
    private let serviceRef: String
    private let serviceLabel: String
    private let username: String

    @State private var vm: ServiceAccessViewModel?
    /// The mode picked but not yet confirmed / saved; nil shows the box's.
    @State private var pendingMode: Mode?
    @State private var applyingMode = false
    @State private var confirmMembersOnly = false
    @State private var adding: AddKind?
    @State private var name = ""
    @State private var newRole: AppMemberRole = .member
    @State private var approveFirst = false
    @State private var photoItem: PhotosPickerItem?
    @State private var photoDataUri: String?
    @State private var confirmRemove: ServiceAccessViewModel.Person?
    @State private var groupMaxText = "10"
    @State private var groupExpires = true
    /// The list-scope switch's pick awaiting its confirm; nil: none.
    @State private var confirmScope: Bool?

    enum Mode: String, CaseIterable, Identifiable {
        case open, membersOnly
        var id: String { rawValue }
        var label: String { self == .open ? String(localized: "Open to all") : String(localized: "Members only") }
    }

    enum AddKind { case person, group }

    public init(serverDomain: String, serviceRef: String, serviceLabel: String, username: String) {
        self.serverDomain = serverDomain
        self.serviceRef = serviceRef
        self.serviceLabel = serviceLabel
        self.username = username
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                headerCard(c: c)
                modeCard(c: c)
                scopeCard(c: c)
                accountMembersSection(c: c)
                membersSection(c: c)
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
            .fsReadingColumn()
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Access control")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .confirmationDialog(
            "Members only?",
            isPresented: $confirmMembersOnly,
            titleVisibility: .visible
        ) {
            Button("Members only") { applyMode(.membersOnly) }
            Button("Cancel", role: .cancel) { pendingMode = nil }
        } message: {
            Text(membersOnlyMessage)
        }
        .onChange(of: confirmMembersOnly) { _, shown in
            // Dismissed without choosing: the toggle goes back.
            if !shown && !applyingMode { pendingMode = nil }
        }
        .confirmationDialog(
            confirmScope == true ? ServiceAccessViewModel.scopeOnTitle : ServiceAccessViewModel.scopeOffTitle,
            isPresented: Binding(get: { confirmScope != nil }, set: { if !$0 { confirmScope = nil } }),
            titleVisibility: .visible
        ) {
            Button(confirmScope == true ? "Separate lists" : "One list") {
                if let want = confirmScope { Task { await applyScope(want) } }
                confirmScope = nil
            }
            .accessibilityIdentifier("service-access-list-scope-confirm")
            Button("Cancel", role: .cancel) { confirmScope = nil }
        } message: {
            Text(confirmScope == true ? ServiceAccessViewModel.scopeOnConfirm : (vm?.scopeOffConfirmText ?? ""))
        }
        .confirmationDialog(
            confirmRemove?.isGroup == true ? String(localized: "Revoke \(confirmRemove?.name ?? "this group")?") : "Remove \(confirmRemove?.name ?? "this person")?",
            isPresented: Binding(get: { confirmRemove != nil }, set: { if !$0 { confirmRemove = nil } }),
            titleVisibility: .visible
        ) {
            Button(confirmRemove?.isGroup == true ? String(localized: "Revoke") : "Remove", role: .destructive) {
                if let p = confirmRemove { Task { await remove(p) } }
                confirmRemove = nil
            }
            Button("Cancel", role: .cancel) { confirmRemove = nil }
        } message: {
            Text(removeMessage(confirmRemove))
        }
    }

    /// What the toggle shows: the pick in flight, else the box's mode.
    private var mode: Mode { pendingMode ?? ((vm?.restricted ?? false) ? .membersOnly : .open) }

    private var membersOnlyMessage: String {
        let n = vm?.memberPeopleCount ?? 0
        return n == 1 ? String(localized: "Only this 1 person will be able to open it.") : String(localized: "Only these \(n) people will be able to open it.")
    }

    private func removeMessage(_ p: ServiceAccessViewModel.Person?) -> String {
        let membersOnly = mode == .membersOnly
        if p?.isGroup == true {
            return membersOnly
                ? String(localized: "Everyone who joined through this link loses access, unless they were also invited another way.")
                : String(localized: "Everyone who joined through this link loses their rank and can still visit as anyone can.")
        }
        return membersOnly
            ? String(localized: "They're signed out and kept out. You can invite them again later.")
            : String(localized: "They lose their rank and can still visit as anyone can. You can invite them again later.")
    }

    // MARK: header

    private func headerCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(serviceLabel)
                    .font(FS.font.scaled(17, weight: .semibold))
                    .foregroundColor(c.text)
                Text("Who can open this app, and what they can do.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
            }
        }
    }

    // MARK: mode

    @ViewBuilder
    private func modeCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Picker("Who can open it", selection: Binding(
                    get: { mode },
                    set: { want in onPickMode(want) }
                )) {
                    ForEach(Mode.allCases) { m in Text(m.label).tag(m) }
                }
                .pickerStyle(.segmented)
                .disabled(vm == nil || vm?.canChangeMode == false || vm?.busyMode == true || applyingMode)
                .accessibilityIdentifier("service-access-restrict-toggle")
                statusLine(c: c)
                if vm?.canChangeMode == false {
                    Text(ServiceAccessViewModel.modeAdminOnly)
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                        .accessibilityIdentifier("service-access-mode-admin-only")
                }
            }
        }
    }

    @ViewBuilder
    private func statusLine(c: FSColors) -> some View {
        HStack(spacing: FS.space.s2) {
            if vm?.busyMode == true || applyingMode { ProgressView().controlSize(.small) }
            switch vm?.phase {
            case .none, .loading:
                Text("Loading…").font(FS.font.caption()).foregroundColor(c.textMuted)
            case .failed(let msg):
                Text(msg).font(FS.font.caption()).foregroundColor(c.danger)
                    .accessibilityIdentifier("service-access-mode-status")
            default:
                Text(vm?.busyMode == true || applyingMode ? String(localized: "Saving…")
                     : mode == .membersOnly ? String(localized: "Only members and you can open it. Anyone else is asked to sign in.")
                     : "Anyone can open it. Members who sign in get their rank.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                    .accessibilityIdentifier("service-access-mode-status")
            }
        }
    }

    // MARK: separate list on each server (Pro)

    @ViewBuilder
    private func scopeCard(c: FSColors) -> some View {
        if let vm, vm.showsScopeToggle || vm.scopeReadOnlyNote != nil {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    if vm.showsScopeToggle {
                        Toggle(isOn: Binding(get: { vm.scopeOn }, set: { want in onPickScope(want) })) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(ServiceAccessViewModel.scopeTitle).foregroundColor(c.text)
                                Text(ServiceAccessViewModel.scopeNote)
                                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                            }
                        }
                        .tint(c.primary)
                        .disabled(!vm.canToggleScope)
                        .accessibilityIdentifier("service-access-list-scope-toggle")
                        if let pro = vm.scopeProNote {
                            Text(pro).font(FS.font.caption()).foregroundColor(c.textMuted)
                                .accessibilityIdentifier("service-access-list-scope-pro")
                        }
                    } else if let note = vm.scopeReadOnlyNote {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ServiceAccessViewModel.scopeTitle).foregroundColor(c.text)
                            Text(note).font(FS.font.caption()).foregroundColor(c.textMuted)
                                .accessibilityIdentifier("service-access-list-scope-readonly")
                        }
                    }
                    if let pending = vm.scopePendingNote {
                        Text(pending).font(FS.font.caption()).foregroundColor(c.warning)
                            .accessibilityIdentifier("service-access-list-scope-pending")
                    }
                    if vm.showsServerPicker { serverPicker(vm) }
                }
            }
        }
    }

    /// Which server's list the whole screen shows and edits.
    @ViewBuilder
    private func serverPicker(_ vm: ServiceAccessViewModel) -> some View {
        let servers = vm.pickerServers
        let picker = Picker("Server", selection: Binding(
            get: { vm.shownServerKey },
            set: { f in Task { await showServer(f) } }
        )) {
            ForEach(servers, id: \.self) { f in Text(vm.serverName(f)).tag(f) }
        }
        .accessibilityIdentifier("service-access-server-picker")
        if servers.count <= 3 {
            picker.pickerStyle(.segmented)
        } else {
            HStack {
                Text("Server").foregroundColor(FSColors.scheme(scheme).text)
                Spacer()
                picker.pickerStyle(.menu)
            }
        }
    }

    // MARK: account members

    @ViewBuilder
    private func accountMembersSection(c: FSColors) -> some View {
        let rows = vm?.members?.account ?? []
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                FSSectionLabel(String(localized: "Account members (\(rows.count))"), id: "service-access-account-members-title")
                ForEach(rows) { row in accountRow(row, c: c) }
            }
        }
    }

    private func accountRow(_ a: AppAccountMember, c: FSColors) -> some View {
        FSCard {
            HStack(spacing: FS.space.s3) {
                Circle()
                    .fill(c.surfaceSunken)
                    .frame(width: 36, height: 36)
                    .overlay(Image(systemName: a.isDevice ? "iphone" : "person.2.fill")
                        .font(FS.font.scaled(14)).foregroundColor(c.textMuted))
                VStack(alignment: .leading, spacing: 2) {
                    Text(vm?.accountName(a) ?? "")
                        .font(FS.font.body()).foregroundColor(c.text).lineLimit(1)
                        .accessibilityIdentifier("service-access-account-name-\(a.id)")
                    Text(vm?.accountDetail(a) ?? "")
                        .font(FS.font.caption()).foregroundColor(c.textMuted).lineLimit(1)
                        .accessibilityIdentifier("service-access-account-detail-\(a.id)")
                }
                Spacer(minLength: FS.space.s2)
                if vm?.canChangeRanks == true, a.rankTarget != nil {
                    accountRankMenu(a, c: c)
                } else if let role = a.role {
                    rankLabel(role, id: "service-access-account-rank-\(a.id)")
                } else {
                    refusedLabel(id: "service-access-account-rank-\(a.id)", c: c)
                }
            }
        }
    }

    /// Member, Manager, Master, then Refuse; picking a rank on a refused row
    /// lets it back in.
    private func accountRankMenu(_ a: AppAccountMember, c: FSColors) -> some View {
        let busy = vm?.busyAccount.contains(a.id) == true
        let current = a.role
        return Menu {
            ForEach(AppMemberRole.allCases) { r in
                Button { Task { await pickAccountRank(AppRankValue(r), for: a) } } label: {
                    Text(r.label)
                    if let d = vm?.members?.description(of: r) { Text(d) }
                    if r == current { Image(systemName: "checkmark") }
                    else if r.crowned { Image(systemName: "crown.fill") }
                }
            }
            Divider()
            Button(role: .destructive) { Task { await pickAccountRank(.refused, for: a) } } label: {
                Text("Refuse")
                Text("Kept out of this app until an admin gives a rank again")
                if a.refused { Image(systemName: "checkmark") }
            }
            .accessibilityIdentifier("service-access-account-refuse-\(a.id)")
        } label: {
            HStack(spacing: 4) {
                if busy { ProgressView().controlSize(.mini) }
                if let current {
                    if current.crowned {
                        Image(systemName: "crown.fill").font(FS.font.scaled(12)).foregroundColor(Self.crownGold)
                    }
                    Text(current.label).font(FS.font.scaled(14, weight: .semibold))
                } else {
                    Text("Refused").font(FS.font.scaled(14, weight: .semibold))
                }
                Image(systemName: "chevron.up.chevron.down").font(FS.font.scaled(11, weight: .semibold))
            }
            .foregroundColor(current == nil ? c.danger : c.primary)
            .padding(.horizontal, FS.space.s3)
            .frame(minHeight: 32)
            .background(c.surfaceSunken)
            .clipShape(Capsule())
        }
        .disabled(busy)
        .accessibilityIdentifier("service-access-account-rank-\(a.id)")
        .accessibilityLabel("Rank: \(current?.label ?? String(localized: "Refused"))")
    }

    private func refusedLabel(id: String, c: FSColors) -> some View {
        Text("Refused")
            .font(FS.font.scaled(14, weight: .semibold))
            .foregroundColor(c.danger)
            .padding(.horizontal, FS.space.s3)
            .frame(minHeight: 32)
            .background(c.surfaceSunken)
            .clipShape(Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Rank: Refused")
            .accessibilityIdentifier(id)
    }

    private static let crownGold = Color(red: 0.79, green: 0.64, blue: 0.15)

    // MARK: members

    @ViewBuilder
    private func membersSection(c: FSColors) -> some View {
        let people = vm?.people ?? []
        VStack(alignment: .leading, spacing: FS.space.s3) {
            FSSectionLabel(String(localized: "Members (\(people.count))"), id: "service-access-members-title")
            if vm?.canInvite == true {
                HStack(spacing: FS.space.s3) {
                    FSSecondaryButton("+ Add person", block: true) { openAdd(.person) }
                        .accessibilityIdentifier("service-access-add-person")
                    FSSecondaryButton("+ Add group", block: true) { openAdd(.group) }
                        .accessibilityIdentifier("service-access-add-group")
                }
            } else if let why = vm?.inviteBlockedReason {
                Text(why)
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                    .accessibilityIdentifier("service-access-invite-why")
            }
            if let adding, vm?.canInvite == true { addCard(adding, c: c) }
            if people.isEmpty {
                FSCard {
                    Text(vm?.canInvite == true ? String(localized: "No members yet. Add a person or a group.") : "No members yet.")
                        .font(FS.font.body())
                        .foregroundColor(c.textMuted)
                }
            } else {
                ForEach(people) { person in personRow(person, c: c) }
            }
        }
    }

    @ViewBuilder
    private func addCard(_ kind: AddKind, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                HStack {
                    Text(kind == .group ? String(localized: "Add a group") : "Add a person")
                        .font(FS.font.scaled(16, weight: .semibold))
                        .foregroundColor(c.text)
                    Spacer()
                    Button { adding = nil; vm?.clearLink() } label: {
                        Image(systemName: "xmark.circle.fill").foregroundColor(c.textMuted)
                    }
                    .accessibilityLabel("Close")
                }
                Text("Names & photos stay encrypted to your account — flagshipserver.com stores only ciphertext. Send the link over a private channel.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                FSField(
                    value: $name,
                    label: kind == .group ? String(localized: "Group name (only you + your servers see it)") : String(localized: "Name (only you + your servers see it)"),
                    placeholder: kind == .group ? String(localized: "Chess club") : String(localized: "Alex"))
                    .accessibilityIdentifier("service-access-name-field")
                HStack {
                    Text("Rank").foregroundColor(c.text)
                    Spacer()
                    if vm?.isAdminDevice == false {
                        rankLabel(.member, id: "service-access-new-role")
                    } else {
                        rolePicker(selection: newRole, id: "service-access-new-role") { newRole = $0 }
                    }
                }
                if vm?.isAdminDevice == false {
                    Text(ServiceAccessViewModel.memberOnlyReason)
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                        .accessibilityIdentifier("service-access-member-only-reason")
                } else if let desc = vm?.members?.description(of: newRole) {
                    Text(desc).font(FS.font.caption()).foregroundColor(c.textMuted)
                }
                if kind == .group {
                    Text("Everyone who joins through the link gets this rank.")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                    groupFields(c: c)
                } else {
                    photoRow(c: c)
                    Toggle(isOn: $approveFirst) {
                        Text("I approve them before they get in").foregroundColor(c.text)
                    }
                    .tint(c.accent)
                    .accessibilityIdentifier("service-access-approve-toggle")
                }
                FSPrimaryButton(vm?.busyAdd == true ? String(localized: "Creating…") : String(localized: "Create invite link"), block: true, large: true) {
                    Task { await add(kind) }
                }
                .disabled(vm?.busyAdd == true || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("service-access-create-invite")
                if let note = vm?.roleNotice {
                    Text(note).font(FS.font.caption()).foregroundColor(c.danger)
                }
                if let link = vm?.lastInviteLink {
                    InviteShareCard(title: String(localized: "Shareable link"), subtitle: shareSubtitle, link: link, idPrefix: "service-access-share")
                }
            }
        }
    }

    /// A rank menu (the display names come from `AppMemberRole.label` only);
    /// each item carries the app's one line for that rank, Master its crown.
    private func rolePicker(selection: AppMemberRole, id: String, busy: Bool = false,
                            onPick: @escaping (AppMemberRole) -> Void) -> some View {
        let c = FSColors.scheme(scheme)
        return Menu {
            ForEach(AppMemberRole.allCases) { r in
                // A menu item reads title, subtitle and image from its label.
                Button { onPick(r) } label: {
                    Text(r.label)
                    if let d = vm?.members?.description(of: r) { Text(d) }
                    if r == selection { Image(systemName: "checkmark") }
                    else if r.crowned { Image(systemName: "crown.fill") }
                }
            }
        } label: {
            HStack(spacing: 4) {
                if busy { ProgressView().controlSize(.mini) }
                if selection.crowned {
                    Image(systemName: "crown.fill").font(FS.font.scaled(12)).foregroundColor(Color(red: 0.79, green: 0.64, blue: 0.15))
                }
                Text(selection.label).font(FS.font.scaled(14, weight: .semibold))
                Image(systemName: "chevron.up.chevron.down").font(FS.font.scaled(11, weight: .semibold))
            }
            .foregroundColor(c.accent)
            .padding(.horizontal, FS.space.s3)
            .frame(minHeight: 32)
            .background(c.surfaceSunken)
            .clipShape(Capsule())
        }
        .disabled(busy)
        .accessibilityIdentifier(id)
        .accessibilityLabel("Rank: \(selection.label)")
    }

    /// A rank shown read-only (a non-admin device can't change it).
    private func rankLabel(_ role: AppMemberRole, id: String) -> some View {
        let c = FSColors.scheme(scheme)
        return HStack(spacing: 4) {
            if role.crowned {
                Image(systemName: "crown.fill").font(FS.font.scaled(12)).foregroundColor(Color(red: 0.79, green: 0.64, blue: 0.15))
            }
            Text(role.label).font(FS.font.scaled(14, weight: .semibold))
        }
        .foregroundColor(c.textMuted)
        .padding(.horizontal, FS.space.s3)
        .frame(minHeight: 32)
        .background(c.surfaceSunken)
        .clipShape(Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Rank: \(role.label)")
        .accessibilityIdentifier(id)
    }

    @ViewBuilder
    private func groupFields(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            FSField(value: $groupMaxText, label: String(localized: "How many people can use it? (0 = no limit)"), placeholder: "10")
                .keyboardType(.numberPad)
                .accessibilityIdentifier("service-access-group-max")
            Toggle(isOn: $groupExpires) {
                Text("Expire this link in 7 days").foregroundColor(c.text)
            }
            .tint(c.accent)
            .accessibilityIdentifier("service-access-group-expires")
        }
    }

    @ViewBuilder
    private func photoRow(c: FSColors) -> some View {
        HStack(spacing: FS.space.s3) {
            PhotosPicker(selection: $photoItem, matching: .images) {
                Label(photoDataUri == nil ? String(localized: "Add photo (optional)") : "Change photo", systemImage: "photo")
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("service-access-photo-picker")
            if photoDataUri != nil {
                Button {
                    photoDataUri = nil
                    photoItem = nil
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundColor(c.textMuted)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Remove photo")
            }
        }
        .onChange(of: photoItem) { _, item in
            Task { await loadPhoto(item) }
        }
    }

    /// Guidance shown under the freshly-created link.
    private var shareSubtitle: String {
        switch vm?.lastInviteTier {
        case .some(.personalManual):
            return String(localized: "They'll accept, then send a reply back to you — open it to approve them.")
        case .some(.group):
            return String(localized: "Anyone with this link (up to the limit) joins. Share it carefully.")
        default:
            return String(localized: "Send it over a private channel. It locks to the first account that opens it.")
        }
    }

    private func personRow(_ p: ServiceAccessViewModel.Person, c: FSColors) -> some View {
        FSCard {
            HStack(spacing: FS.space.s3) {
                avatar(p, c: c)
                VStack(alignment: .leading, spacing: 2) {
                    Text(p.name).font(FS.font.body()).foregroundColor(c.text).lineLimit(1)
                    Text(statusLine(p))
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                        .accessibilityIdentifier("service-access-status-\(p.inviteId)")
                    if let also = vm?.alsoIn(for: p), !also.isEmpty {
                        Text(also).font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                    if let by = vm?.invitedBy(for: p) {
                        HStack(spacing: FS.space.s2) {
                            Text(by)
                                .font(FS.font.caption())
                                .foregroundColor(c.textMuted)
                                .lineLimit(1)
                                .accessibilityIdentifier("service-access-invited-by-\(p.inviteId)")
                            if vm?.isAdminDevice == true {
                                Button("Revoke") { confirmRemove = p }
                                    .font(FS.font.scaled(13, weight: .semibold))
                                    .foregroundColor(c.danger)
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Revoke \(p.name)")
                                    .accessibilityIdentifier("service-access-revoke-\(p.inviteId)")
                            }
                        }
                    }
                }
                Spacer(minLength: FS.space.s2)
                if let role = vm?.role(for: p) {
                    if vm?.canChangeRanks == true {
                        rolePicker(selection: role, id: "service-access-role-\(p.inviteId)",
                                   busy: vm?.busyRoles.contains(p.inviteId) == true) { r in
                            Task { await pickRole(r, for: p) }
                        }
                    } else {
                        rankLabel(role, id: "service-access-role-\(p.inviteId)")
                    }
                }
                if showsRemoveIcon(p) {
                    Button { confirmRemove = p } label: {
                        Image(systemName: p.isGroup ? "xmark.circle" : "person.crop.circle.badge.minus")
                            .foregroundColor(c.danger)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(p.isGroup ? String(localized: "Revoke \(p.name)") : "Remove \(p.name)")
                    .accessibilityIdentifier("service-access-remove-\(p.inviteId)")
                }
            }
        }
    }

    /// An admin row with an "Invited by" line carries its Revoke there.
    private func showsRemoveIcon(_ p: ServiceAccessViewModel.Person) -> Bool {
        guard let vm, vm.canRemove(p) else { return false }
        return !(vm.isAdminDevice && vm.invitedBy(for: p) != nil)
    }

    /// A group shows "k of N joined" (N = cap, 0 = no limit); an approve-first
    /// invite waits for the owner; a personal invite shows bound/pending.
    private func statusLine(_ p: ServiceAccessViewModel.Person) -> String {
        if p.isGroup {
            let used = p.groupBoundAIDs.count
            let cap = p.groupMax ?? 0
            return cap == 0 ? String(localized: "\(used) joined") : String(localized: "\(used) of \(cap) joined")
        }
        if p.manual && !p.bound { return "you approve · not yet in" }
        return p.bound ? "active" : "invite sent — not opened yet"
    }

    @ViewBuilder
    private func avatar(_ p: ServiceAccessViewModel.Person, c: FSColors) -> some View {
        if p.isGroup {
            Circle()
                .fill(c.surfaceSunken)
                .frame(width: 36, height: 36)
                .overlay(Image(systemName: "person.3.fill").font(FS.font.scaled(14)).foregroundColor(c.textMuted))
        } else if let photo = p.photo, let img = imageFromDataUri(photo) {
            Image(uiImage: img)
                .resizable()
                .scaledToFill()
                .frame(width: 36, height: 36)
                .clipShape(Circle())
        } else {
            Circle()
                .fill(c.surfaceSunken)
                .frame(width: 36, height: 36)
                .overlay(
                    Text(String(p.name.first.map(String.init)?.uppercased() ?? "?"))
                        .font(FS.font.caption())
                        .foregroundColor(c.text)
                )
        }
    }

    // MARK: actions

    @MainActor
    private func reload() async {
        let deviceId = keys?.deviceId ?? app.activeProfile?.deviceId
        let fixtureNames = keys?.deviceNames
        let account = username
        let directory = server
        let pods = podClients
        let m = vm ?? ServiceAccessViewModel(
            client: client,
            serverDomain: serverDomain,
            serviceRef: serviceRef,
            username: username,
            authorAidKeys: keys?.authorAidKeys,
            screens: screens,
            podScreens: { fqdn in await pods.client(forFqdn: fqdn) },
            serverNames: Dictionary(app.pods.map { ($0.fqdn.lowercased(), AppPlacementCopy.serverName($0)) },
                                    uniquingKeysWith: { a, _ in a }),
            isAdminDevice: keys?.isAdminDevice ?? AdminOrderGate.allows(app),
            adminSigner: keys?.adminSigner,
            deviceId: deviceId,
            deviceSigner: keys?.deviceSigner,
            ownDeviceKey: keys?.ownDeviceKey,
            deviceNames: {
                if let fixtureNames { return fixtureNames }
                return await AccountDeviceNames.load(username: account, deviceId: deviceId, server: directory)
            }
        )
        vm = m
        await m.load()
        if case .failed(let msg) = m.phase { toasts.error(msg) }
    }

    @MainActor
    private func onPickMode(_ want: Mode) {
        guard want != mode, vm?.busyMode != true, !applyingMode else { return }
        pendingMode = want
        if want == .membersOnly {
            confirmMembersOnly = true
        } else {
            applyMode(.open)
        }
    }

    /// Sign + post the mode; the toggle rolls back if the box refuses.
    @MainActor
    private func applyMode(_ want: Mode) {
        guard let vm else { return }
        pendingMode = want
        applyingMode = true
        Task {
            await vm.setMode(restricted: want == .membersOnly)
            // The box's answer wins: a refused change rolls the toggle back.
            pendingMode = nil
            applyingMode = false
            if case .failed(let msg) = vm.phase {
                toasts.error(msg)
            } else {
                toasts.success(want == .membersOnly ? String(localized: "Now members only.") : String(localized: "Now open to all."))
            }
        }
    }

    @MainActor
    private func onPickScope(_ want: Bool) {
        guard let vm, want != vm.scopeOn, vm.canToggleScope else { return }
        confirmScope = want
    }

    @MainActor
    private func applyScope(_ want: Bool) async {
        guard let vm else { return }
        if await vm.setSeparateLists(want) {
            toasts.success(want ? "Each server now keeps its own list." : "Every server now uses one list.")
        } else if vm.scopeNeedsPro {
            return
        } else if case .failed(let msg) = vm.phase {
            toasts.error(msg)
        }
    }

    @MainActor
    private func showServer(_ fqdn: String) async {
        guard let vm else { return }
        adding = nil
        pendingMode = nil
        await vm.showServer(fqdn)
        if case .failed(let msg) = vm.phase { toasts.error(msg) }
    }

    @MainActor
    private func openAdd(_ kind: AddKind) {
        adding = kind
        vm?.clearLink()
        name = ""
        approveFirst = false
        photoDataUri = nil
        photoItem = nil
        newRole = vm?.isAdminDevice == false ? .member : AppMemberRole(wire: vm?.members?.defaultRole) ?? .member
    }

    @MainActor
    private func add(_ kind: AddKind) async {
        guard let vm else { return }
        let tier: ServiceAccessViewModel.InviteTier
        switch kind {
        case .group:
            let maxN = max(0, Int(groupMaxText.trimmingCharacters(in: .whitespaces)) ?? 0)
            let expiresAt: Int64? = groupExpires
                ? Int64(Date().addingTimeInterval(7 * 24 * 60 * 60).timeIntervalSince1970 * 1000)
                : nil
            tier = .group(maxRedemptions: maxN, expiresAt: expiresAt)
        case .person:
            tier = approveFirst ? .personalManual : .personalAuto
        }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let link = await vm.addPerson(name: trimmed, photo: kind == .group ? nil : photoDataUri, tier: tier, role: newRole)
        if link != nil {
            toasts.success(kind == .group ? String(localized: "Group invite created.") : String(localized: "Invite for \(trimmed) created."))
            name = ""
            photoDataUri = nil
            photoItem = nil
        } else if case .failed(let msg) = vm.phase {
            toasts.error(msg)
        }
    }

    @MainActor
    private func pickRole(_ role: AppMemberRole, for p: ServiceAccessViewModel.Person) async {
        guard let vm, role != vm.role(for: p) else { return }
        if await vm.setRole(role, for: p) {
            toasts.success(String(localized: "\(p.name) is now \(role.label)."))
        } else if case .failed(let msg) = vm.phase {
            toasts.error(msg)
        }
    }

    @MainActor
    private func pickAccountRank(_ rank: AppRankValue, for a: AppAccountMember) async {
        guard let vm else { return }
        let unchanged = rank == .refused ? a.refused : (!a.refused && a.rank == rank.rawValue)
        guard !unchanged else { return }
        let name = vm.accountName(a)
        if await vm.setAccountRank(rank, for: a) {
            toasts.success(rank == .refused
                ? String(localized: "\(name) is refused in this app.")
                : String(localized: "\(name) is now \(AppMemberRole(rawValue: rank.rawValue)?.label ?? rank.rawValue)."))
        } else if case .failed(let msg) = vm.phase {
            toasts.error(msg)
        }
    }

    @MainActor
    private func remove(_ p: ServiceAccessViewModel.Person) async {
        guard let vm else { return }
        await vm.remove(inviteId: p.inviteId)
        if case .failed(let msg) = vm.phase { toasts.error(msg) } else { toasts.success(p.isGroup ? "Group revoked." : String(localized: "Removed.")) }
    }

    @MainActor
    private func loadPhoto(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            // Cap at ~256 KB encoded so the sealed bundle stays small (.com stores it).
            if data.count > 256 * 1024 {
                toasts.error(String(localized: "Photo is too large (max 256 KB). Pick a smaller image."))
                photoItem = nil
                return
            }
            photoDataUri = "data:image/jpeg;base64,\(data.base64EncodedString())"
        } catch {
            toasts.error(String(localized: "Couldn't read that image."))
        }
    }

    private func imageFromDataUri(_ s: String) -> UIImage? {
        guard let comma = s.range(of: ",") else { return nil }
        let b64 = String(s[comma.upperBound...])
        guard let data = Data(base64Encoded: b64) else { return nil }
        return UIImage(data: data)
    }
}
