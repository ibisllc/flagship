import SwiftUI
import Flagship
import FlagshipCore

/// Settings → Organizations: create one, open one. Kept to a list and one button.
public struct OrgListScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: OrgViewModel
    @State private var creating = false
    @State private var name = ""

    public init(vm: OrgViewModel) { self.vm = vm }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        List {
            Section {
                Text("An organization lets several people run servers together. No one person can delete everything, and every change is signed by the people who approved it.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
            }
            if !vm.seats.isEmpty {
                Section("Your organizations") {
                    ForEach(vm.seats) { s in
                        NavigationLink(s.orgName) { OrgDetailScreen(vm: vm, seat: s) }
                            .accessibilityIdentifier("org-row-\(s.orgName)")
                    }
                }
            }
            Section {
                Button("Create an organization") { creating = true }
                    .accessibilityIdentifier("org-create")
            }
            if let m = vm.message { Section { Text(m).font(FS.font.bodySm()).foregroundColor(c.text) } }
        }
        .navigationTitle("Organizations")
        .onAppear { vm.reloadSeats() }
        .alert("Name your organization", isPresented: $creating) {
            TextField("Name", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Create") { Task { if await vm.create(name: name) { name = "" } } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This becomes the organization's address, like home.name.flagship.services. You start as its only admin; invite others next.")
        }
    }
}

/// One organization: approvals waiting, admins, invite, and Restore my access when frozen.
public struct OrgDetailScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: OrgViewModel
    let seat: OrgSeatKeys.Seat
    @State private var freezeTarget: String?
    @State private var inviting = false

    public init(vm: OrgViewModel, seat: OrgSeatKeys.Seat) { self.vm = vm; self.seat = seat }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        List {
            switch vm.phase {
            case .idle, .loading:
                Section { ProgressView().frame(maxWidth: .infinity) }
            case .failed(let m):
                Section { Text(m).font(FS.font.bodySm()).foregroundColor(c.danger) }
            case .loaded:
                if let f = vm.myFreeze(seat) { frozenSection(f, c: c) }
                joinsSection(c: c)
                rotationsSection(c: c)
                approvalsSection(c: c)
                if seat.memberOnly != true { OrgDirectorySections(vm: vm, seat: seat) }
                adminsSection(c: c)
                Section {
                    Button("Invite a person") { inviting = true }.accessibilityIdentifier("org-invite")
                }
            }
            if let m = vm.message { Section { Text(m).font(FS.font.bodySm()).foregroundColor(c.text) } }
        }
        .navigationTitle(seat.orgName)
        .task { await vm.load(seat) }
        .refreshable { await vm.load(seat) }
        .sheet(isPresented: $inviting, onDismiss: { vm.clearInvite() }) {
            NavigationStack { OrgInviteSheet(vm: vm, seat: seat) }
        }
        .confirmationDialog("Freeze this admin for 72 hours?", isPresented: Binding(get: { freezeTarget != nil }, set: { if !$0 { freezeTarget = nil } }), titleVisibility: .visible) {
            Button("Freeze for 72 hours", role: .destructive) {
                if let t = freezeTarget { Task { await vm.freeze(seat, target: t) } }
                freezeTarget = nil
            }
        } message: {
            Text("They can't approve anything until it ends or the bylaws' signers lift it. You can freeze one admin once a week. Removing an admin takes more people.")
        }
    }

    @ViewBuilder
    private func frozenSection(_ f: OrgVerifiedFreeze, c: FSColors) -> some View {
        Section {
            Text("Your access is frozen until \(Date(timeIntervalSince1970: TimeInterval(f.untilMs) / 1000).formatted(date: .abbreviated, time: .shortened)).")
                .font(FS.font.body()).foregroundColor(c.danger)
            if let who = vm.restoreApprovers(seat) {
                Text("To lift it sooner, \(who.needed) of these must approve: \(who.seats.map { label($0) }.joined(separator: ", ")).")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
            }
            Button("Restore my access") { Task { await vm.restoreMyAccess(seat) } }
                .disabled(vm.busy)
                .accessibilityIdentifier("org-restore")
        }
    }

    /// People who accepted: compare the 6-digit code they read out, then admit them.
    @ViewBuilder
    private func joinsSection(c: FSColors) -> some View {
        if !vm.pendingJoins.isEmpty && seat.memberOnly != true {
            Section("Waiting to join") {
                ForEach(vm.pendingJoins) { j in
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        Text(label(j.seatId)).font(FS.font.body()).foregroundColor(c.text)
                        if let code = j.sas {
                            Text("Their code should read \(String(code.prefix(3))) \(String(code.suffix(3)))").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        }
                        Button("Codes match: admit") { Task { await vm.admit(seat, j) } }
                            .disabled(vm.busy || vm.myFreeze(seat) != nil)
                            .accessibilityIdentifier("org-admit-\(j.seatId.prefix(8))")
                    }
                }
            }
        }
    }

    /// People who left: rotate the keys they could open so they read nothing new.
    @ViewBuilder
    private func rotationsSection(c: FSColors) -> some View {
        if !vm.rotations.isEmpty && seat.memberOnly != true {
            Section("Keys to rotate") {
                ForEach(vm.rotations) { r in
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        Text("\(label(r.seatId)) left. Rotate the keys they could open so they can't read anything new.")
                            .font(FS.font.body()).foregroundColor(c.text)
                        ForEach(Array(r.keys.enumerated()), id: \.offset) { _, k in
                            Text(OrgCopy.key(k)).font(FS.font.caption()).foregroundColor(c.textMuted)
                        }
                        if r.keys.contains(where: { $0.kind == .diskKey }) {
                            Text("A disk key changes when its server is re-keyed, which isn't available yet.")
                                .font(FS.font.caption()).foregroundColor(c.textMuted)
                        }
                        if !vm.rotatable(r).isEmpty {
                            Button("Rotate keys") { Task { await vm.rotate(seat, r) } }
                                .disabled(vm.busy || vm.myFreeze(seat) != nil)
                                .accessibilityIdentifier("org-rotate-\(r.seatId.prefix(8))")
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func approvalsSection(c: FSColors) -> some View {
        let list = vm.snapshot?.ceremonies ?? []
        Section("Waiting for approval") {
            if list.isEmpty {
                Text("Nothing to approve.").font(FS.font.bodySm()).foregroundColor(c.textMuted)
            }
            ForEach(list) { cer in
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text(OrgCopy.purpose(cer.purpose)).font(FS.font.body()).foregroundColor(c.text)
                    Text("Approved by \(cer.approvals.count)").font(FS.font.caption()).foregroundColor(c.textMuted)
                    if vm.hasApproved(seat, cer) {
                        Text("You approved this.").font(FS.font.caption()).foregroundColor(c.textMuted)
                    } else {
                        Button("Approve") { Task { await vm.approve(seat, cer) } }
                            .disabled(vm.busy || vm.myFreeze(seat) != nil)
                            .accessibilityIdentifier("org-approve-\(cer.sha256.prefix(8))")
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func adminsSection(c: FSColors) -> some View {
        Section("People who can approve") {
            ForEach(vm.admins(seat)) { a in
                HStack {
                    VStack(alignment: .leading) {
                        Text(label(a.seatId)).font(FS.font.body()).foregroundColor(c.text)
                        Text(OrgCopy.kind(a.kind, founder: a.isFounder)).font(FS.font.caption()).foregroundColor(c.textMuted)
                        if let u = a.frozenUntil {
                            Text("Frozen until \(Date(timeIntervalSince1970: TimeInterval(u) / 1000).formatted(date: .abbreviated, time: .shortened))")
                                .font(FS.font.caption()).foregroundColor(c.danger)
                        }
                    }
                    Spacer()
                    if !a.isMe && a.kind == .admin && a.frozenUntil == nil && vm.myFreeze(seat) == nil {
                        Button("Freeze") { freezeTarget = a.seatId }.font(FS.font.caption())
                    }
                }
            }
        }
    }

    private func label(_ seatId: String) -> String { vm.name(seat, seatId) }
}

/// Invite: the pseudonym comes first, then the role; only then is the QR and link made.
struct OrgInviteSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @Bindable var vm: OrgViewModel
    let seat: OrgSeatKeys.Seat
    @State private var pseudonym = ""
    @State private var role: OrgViewModel.InviteRole = .member
    @State private var target = ""

    var body: some View {
        let c = FSColors.scheme(scheme)
        Form {
            if let link = vm.inviteLink {
                Section {
                    PairingQRView(text: link).frame(maxWidth: .infinity)
                    ShareLink(item: link) { Label("Share the link", systemImage: "square.and.arrow.up") }
                    Text("They open it on their phone and you both check the same 6-digit code before you approve.")
                        .font(FS.font.caption()).foregroundColor(c.textMuted)
                }
            } else {
                Section {
                    TextField("Name the organization will know them by", text: $pseudonym)
                        .accessibilityIdentifier("org-invite-pseudonym")
                } header: { Text("Who is this?") } footer: {
                    Text("Required. The organization sees only this name, never their own account.")
                }
                Section("What can they do?") {
                    Picker("Role", selection: $role) {
                        Text("Member").tag(OrgViewModel.InviteRole.member)
                        Text("Admin of one server").tag(OrgViewModel.InviteRole.serverAdmin)
                        Text("Admin of one app").tag(OrgViewModel.InviteRole.appAdmin)
                    }
                    .pickerStyle(.inline).labelsHidden()
                    if role == .serverAdmin { TextField("Server address", text: $target).textInputAutocapitalization(.never) }
                    if role == .appAdmin { TextField("App id", text: $target).textInputAutocapitalization(.never) }
                }
                Section {
                    Button("Make the invitation") { Task { await vm.invite(seat, pseudonym: pseudonym, role: role, target: target) } }
                        .disabled(pseudonym.trimmingCharacters(in: .whitespaces).isEmpty || vm.busy || (role != .member && target.isEmpty))
                        .accessibilityIdentifier("org-invite-make")
                }
            }
            if let m = vm.message { Section { Text(m).font(FS.font.bodySm()).foregroundColor(c.text) } }
        }
        .navigationTitle("Invite a person")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
    }
}

enum OrgCopy {
    static func purpose(_ tag: String) -> String {
        switch tag {
        case OrgAuthority.tagOverturn: return String(localized: "Lift a freeze")
        case OrgAuthority.tagAuthority: return String(localized: "Change who are admins or the rules")
        case OrgAuthority.tagSeatGrant: return String(localized: "Give a person a seat or a role")
        case OrgAuthority.tagDelayedChange: return String(localized: "Remove an admin after notice")
        case "flagship/servers-self-delete/v1": return String(localized: "Delete a server")
        case "flagship/server-update/v1": return String(localized: "Update a server")
        default: return String(localized: "Approve an organization change")
        }
    }

    static func key(_ k: OrgPendingRotation.Key) -> String {
        switch k.kind {
        case .cgk: return String(localized: "Server-to-server key")
        case .directoryKey: return String(localized: "Directory key")
        case .archiveKeys: return String(localized: "Backup keys of \(k.scope)")
        case .diskKey: return String(localized: "Disk key of \(k.scope)")
        }
    }

    static func kind(_ k: OrgAdminKind, founder: Bool) -> String {
        if founder { return String(localized: "Founder and admin") }
        switch k {
        case .admin: return String(localized: "Admin")
        case .board: return String(localized: "Board member: lifts freezes")
        case .recovery: return String(localized: "Recovery key")
        }
    }
}

/// The admin console's Directory (docs/org-directory.md §6): people with their names, proposals from the
/// company directory with Approve, and the connectors with "Add a SCIM connector" (URL and token once).
struct OrgDirectorySections: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: OrgViewModel
    let seat: OrgSeatKeys.Seat
    @State private var pickingServer = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        if !vm.proposals.isEmpty {
            Section("From your company directory") {
                ForEach(vm.proposals) { p in
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        Text(p.entry.pseudonym).font(FS.font.body()).foregroundColor(c.text)
                        if !p.entry.email.isEmpty { Text(p.entry.email).font(FS.font.caption()).foregroundColor(c.textMuted) }
                        Text(OrgDirectoryCopy.proposal(p.kind)).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        HStack {
                            Button("Approve") { Task { await vm.approveProposal(seat, p) } }
                                .disabled(vm.busy || vm.myFreeze(seat) != nil)
                                .accessibilityIdentifier("org-proposal-approve-\(p.id.prefix(8))")
                            Spacer()
                            Button("Decline", role: .destructive) { Task { await vm.declineProposal(seat, p) } }
                                .disabled(vm.busy)
                                .accessibilityIdentifier("org-proposal-decline-\(p.id.prefix(8))")
                        }
                    }
                }
            }
        }
        if !vm.people.isEmpty {
            Section("People") {
                ForEach(vm.people.values.sorted { $0.pseudonym < $1.pseudonym }, id: \.seatId) { e in
                    VStack(alignment: .leading) {
                        Text(e.pseudonym).font(FS.font.body()).foregroundColor(c.text)
                        if !e.email.isEmpty || !e.groups.isEmpty {
                            Text(([e.email] + e.groups).filter { !$0.isEmpty }.joined(separator: " · ")).font(FS.font.caption()).foregroundColor(c.textMuted)
                        }
                    }
                }
            }
        }
        Section {
            ForEach(vm.connectors, id: \.connectorId) { k in
                VStack(alignment: .leading) {
                    Text(OrgDirectoryCopy.kind(k.kind)).font(FS.font.body()).foregroundColor(c.text)
                    Text("\(k.serverDomain) · \(OrgDirectoryCopy.status(k.status))").font(FS.font.caption()).foregroundColor(c.textMuted)
                }
            }
            if let n = vm.newConnector {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("Give these to your identity provider. The token is shown only now.").font(FS.font.bodySm()).foregroundColor(c.text)
                    Text(n.url).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    Text(n.token).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        .accessibilityIdentifier("org-connector-token")
                    Button("Done") { vm.clearNewConnector() }
                }
            } else {
                Button("Add a SCIM connector") { pickingServer = true }
                    .disabled(vm.busy || vm.servers.isEmpty)
                    .accessibilityIdentifier("org-connector-add")
            }
        } header: { Text("Directory connectors") } footer: {
            Text("Microsoft Entra ID, Okta and others send people to your own server. Nothing changes until an admin approves it here.")
        }
        .confirmationDialog("Which server runs the connector?", isPresented: $pickingServer, titleVisibility: .visible) {
            ForEach(vm.servers, id: \.self) { d in Button(d) { Task { await vm.addScimConnector(seat, serverDomain: d) } } }
        }
    }
}

enum OrgDirectoryCopy {
    static func proposal(_ kind: String) -> String {
        switch kind {
        case "invite": return String(localized: "Proposed: invite to the organization")
        case "offboard": return String(localized: "Proposed: remove from the organization")
        case "role-change": return String(localized: "Proposed: change their role")
        default: return String(localized: "Proposed: update their details")
        }
    }
    static func kind(_ k: String) -> String {
        switch k {
        case "scim": return String(localized: "SCIM connector")
        case "ldap": return String(localized: "LDAP connector")
        default: return String(localized: "Custom connector")
        }
    }
    static func status(_ s: String) -> String {
        switch s {
        case "active": return String(localized: "Active")
        case "paused": return String(localized: "Paused")
        default: return String(localized: "Retired")
        }
    }
}
