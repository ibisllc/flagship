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

    enum Mode: String, CaseIterable, Identifiable {
        case open, membersOnly
        var id: String { rawValue }
        var label: String { self == .open ? "Open to all" : "Members only" }
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
            confirmRemove?.isGroup == true ? "Revoke \(confirmRemove?.name ?? "this group")?" : "Remove \(confirmRemove?.name ?? "this person")?",
            isPresented: Binding(get: { confirmRemove != nil }, set: { if !$0 { confirmRemove = nil } }),
            titleVisibility: .visible
        ) {
            Button(confirmRemove?.isGroup == true ? "Revoke" : "Remove", role: .destructive) {
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
        return n == 1 ? "Only this 1 person will be able to open it." : "Only these \(n) people will be able to open it."
    }

    private func removeMessage(_ p: ServiceAccessViewModel.Person?) -> String {
        let membersOnly = mode == .membersOnly
        if p?.isGroup == true {
            return membersOnly
                ? "Everyone who joined through this link loses access, unless they were also invited another way."
                : "Everyone who joined through this link loses their rank and can still visit as anyone can."
        }
        return membersOnly
            ? "They're signed out and kept out. You can invite them again later."
            : "They lose their rank and can still visit as anyone can. You can invite them again later."
    }

    // MARK: header

    private func headerCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(serviceLabel)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(c.text)
                Text("id: \(serviceRef)")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                    .textSelection(.enabled)
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
                Text(vm?.busyMode == true || applyingMode ? "Saving…"
                     : mode == .membersOnly ? "Only members and you can open it. Anyone else is asked to sign in."
                     : "Anyone can open it. Members who sign in get their rank.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                    .accessibilityIdentifier("service-access-mode-status")
            }
        }
    }

    // MARK: account members

    @ViewBuilder
    private func accountMembersSection(c: FSColors) -> some View {
        let rows = vm?.members?.account ?? []
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("ACCOUNT MEMBERS (\(rows.count))")
                    .font(FS.font.caption())
                    .fontWeight(.semibold)
                    .foregroundColor(c.textMuted)
                    .accessibilityIdentifier("service-access-account-members-title")
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
                        .font(.system(size: 14)).foregroundColor(c.textMuted))
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
                        Image(systemName: "crown.fill").font(.system(size: 12)).foregroundColor(Self.crownGold)
                    }
                    Text(current.label).font(.system(size: 14, weight: .semibold))
                } else {
                    Text("Refused").font(.system(size: 14, weight: .semibold))
                }
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .semibold))
            }
            .foregroundColor(current == nil ? c.danger : c.primary)
            .padding(.horizontal, FS.space.s3)
            .frame(minHeight: 32)
            .background(c.surfaceSunken)
            .clipShape(Capsule())
        }
        .disabled(busy)
        .accessibilityIdentifier("service-access-account-rank-\(a.id)")
        .accessibilityLabel("Rank: \(current?.label ?? "Refused")")
    }

    private func refusedLabel(id: String, c: FSColors) -> some View {
        Text("Refused")
            .font(.system(size: 14, weight: .semibold))
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
            Text("MEMBERS (\(people.count))")
                .font(FS.font.caption())
                .fontWeight(.semibold)
                .foregroundColor(c.textMuted)
                .accessibilityIdentifier("service-access-members-title")
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
                    Text(vm?.canInvite == true ? "No members yet. Add a person or a group." : "No members yet.")
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
                    Text(kind == .group ? "Add a group" : "Add a person")
                        .font(.system(size: 16, weight: .semibold))
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
                    label: kind == .group ? "Group name (only you + your servers see it)" : "Name (only you + your servers see it)",
                    placeholder: kind == .group ? "Chess club" : "Alex")
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
                    .tint(c.primary)
                    .accessibilityIdentifier("service-access-approve-toggle")
                }
                FSPrimaryButton(vm?.busyAdd == true ? "Creating…" : "Create invite link", block: true, large: true) {
                    Task { await add(kind) }
                }
                .disabled(vm?.busyAdd == true || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("service-access-create-invite")
                if let note = vm?.roleNotice {
                    Text(note).font(FS.font.caption()).foregroundColor(c.danger)
                }
                if let link = vm?.lastInviteLink {
                    InviteShareCard(title: "Shareable link", subtitle: shareSubtitle, link: link, idPrefix: "service-access-share")
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
                    Image(systemName: "crown.fill").font(.system(size: 12)).foregroundColor(Color(red: 0.79, green: 0.64, blue: 0.15))
                }
                Text(selection.label).font(.system(size: 14, weight: .semibold))
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .semibold))
            }
            .foregroundColor(c.primary)
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
                Image(systemName: "crown.fill").font(.system(size: 12)).foregroundColor(Color(red: 0.79, green: 0.64, blue: 0.15))
            }
            Text(role.label).font(.system(size: 14, weight: .semibold))
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
            FSField(value: $groupMaxText, label: "How many people can use it? (0 = no limit)", placeholder: "10")
                .keyboardType(.numberPad)
                .accessibilityIdentifier("service-access-group-max")
            Toggle(isOn: $groupExpires) {
                Text("Expire this link in 7 days").foregroundColor(c.text)
            }
            .tint(c.primary)
            .accessibilityIdentifier("service-access-group-expires")
        }
    }

    @ViewBuilder
    private func photoRow(c: FSColors) -> some View {
        HStack(spacing: FS.space.s3) {
            PhotosPicker(selection: $photoItem, matching: .images) {
                Label(photoDataUri == nil ? "Add photo (optional)" : "Change photo", systemImage: "photo")
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("service-access-photo-picker")
            if photoDataUri != nil {
                Button {
                    photoDataUri = nil
                    photoItem = nil
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundColor(c.textMuted)
                }
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
            return "They'll accept, then send a reply back to you — open it to approve them."
        case .some(.group):
            return "Anyone with this link (up to the limit) joins. Share it carefully."
        default:
            return "Send it over a private channel. It locks to the first account that opens it."
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
                                    .font(.system(size: 13, weight: .semibold))
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
                    .accessibilityLabel(p.isGroup ? "Revoke \(p.name)" : "Remove \(p.name)")
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
            return cap == 0 ? "\(used) joined" : "\(used) of \(cap) joined"
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
                .overlay(Image(systemName: "person.3.fill").font(.system(size: 14)).foregroundColor(c.textMuted))
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
        let m = vm ?? ServiceAccessViewModel(
            client: client,
            serverDomain: serverDomain,
            serviceRef: serviceRef,
            username: username,
            authorAidKeys: keys?.authorAidKeys,
            screens: screens,
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
                toasts.success(want == .membersOnly ? "Now members only." : "Now open to all.")
            }
        }
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
            toasts.success(kind == .group ? "Group invite created." : "Invite for \(trimmed) created.")
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
            toasts.success("\(p.name) is now \(role.label).")
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
                ? "\(name) is refused in this app."
                : "\(name) is now \(AppMemberRole(rawValue: rank.rawValue)?.label ?? rank.rawValue).")
        } else if case .failed(let msg) = vm.phase {
            toasts.error(msg)
        }
    }

    @MainActor
    private func remove(_ p: ServiceAccessViewModel.Person) async {
        guard let vm else { return }
        await vm.remove(inviteId: p.inviteId)
        if case .failed(let msg) = vm.phase { toasts.error(msg) } else { toasts.success(p.isGroup ? "Group revoked." : "Removed.") }
    }

    @MainActor
    private func loadPhoto(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            // Cap at ~256 KB encoded so the sealed bundle stays small (.com stores it).
            if data.count > 256 * 1024 {
                toasts.error("Photo is too large (max 256 KB). Pick a smaller image.")
                photoItem = nil
                return
            }
            photoDataUri = "data:image/jpeg;base64,\(data.base64EncodedString())"
        } catch {
            toasts.error("Couldn't read that image.")
        }
    }

    private func imageFromDataUri(_ s: String) -> UIImage? {
        guard let comma = s.range(of: ",") else { return nil }
        let b64 = String(s[comma.upperBound...])
        guard let data = Data(base64Encoded: b64) else { return nil }
        return UIImage(data: data)
    }
}
