import SwiftUI
import PhotosUI
import FlagshipAPI
import FlagshipCore

/// Admin "Who can open this" screen for per-service access gating
/// (docs/service-access-gating.md). Mirrors the webapp `views/service-access.js`:
///   - an open ⇄ restricted toggle (reads the TRUE mode from the box; sets it
///     with an owner-IRK envelope),
///   - when restricted, an allow-list manager: add a person (name + optional
///     photo → mint a capability invite via `.com` → copyable/shareable
///     `https://<server>.<user>/invite#<secret>` link), the people list
///     (decrypted bundle name/photo, bound vs invite-sent), remove (revoke).
///
/// Self-contained: reads the box+`.com` access client from the environment.
public struct ServiceAccessScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.serviceAccessClient) private var client
    @Environment(ToastCenter.self) private var toasts

    private let serverDomain: String
    private let serviceRef: String
    private let serviceLabel: String
    private let username: String

    @State private var vm: ServiceAccessViewModel?
    @State private var restrictedToggle = false
    @State private var name = ""
    @State private var photoItem: PhotosPickerItem?
    @State private var photoDataUri: String?
    @State private var confirmRemove: ServiceAccessViewModel.Person?

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
                toggleCard(c: c)
                if restrictedToggle {
                    addPersonCard(c: c)
                    peopleSection(c: c)
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Who can open this")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .confirmationDialog(
            "Remove \(confirmRemove?.name ?? "this person")?",
            isPresented: Binding(get: { confirmRemove != nil }, set: { if !$0 { confirmRemove = nil } }),
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                if let p = confirmRemove { Task { await remove(p) } }
                confirmRemove = nil
            }
            Button("Cancel", role: .cancel) { confirmRemove = nil }
        } message: {
            Text("They'll lose access the next time they try to open it. You can re-add them later with a new link.")
        }
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

    // MARK: toggle

    @ViewBuilder
    private func toggleCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("**Open** — anyone with the link can open it. **Restricted** — only people you add below.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                Toggle(isOn: Binding(
                    get: { restrictedToggle },
                    set: { want in onToggle(want) }
                )) {
                    Text("Restrict to an allow-list").foregroundColor(c.text)
                }
                .tint(c.primary)
                .disabled(vm?.busyMode ?? false)
                .accessibilityIdentifier("service-access-restrict-toggle")
                statusLine(c: c)
            }
        }
    }

    @ViewBuilder
    private func statusLine(c: FSColors) -> some View {
        switch vm?.phase {
        case .none, .loading:
            Text("Loading…").font(FS.font.caption()).foregroundColor(c.textMuted)
        case .failed(let msg):
            Text(msg).font(FS.font.caption()).foregroundColor(c.danger)
        default:
            Text(restrictedToggle ? "Restricted — \(allowCountLabel)" : "Open to anyone with the link")
                .font(FS.font.caption())
                .foregroundColor(c.textMuted)
                .accessibilityIdentifier("service-access-mode-status")
        }
    }

    private var allowCountLabel: String {
        let n = vm?.allowCount ?? 0
        return n == 1 ? "1 person added" : "\(n) people added"
    }

    // MARK: add person

    @ViewBuilder
    private func addPersonCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("Add a person")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(c.text)
                Text("Names & photos stay encrypted to your account — flagshipserver.com stores only ciphertext and never sees them. The link is a bearer capability: send it over a private channel. It locks to the first account that opens it.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
                FSField(value: $name, label: "Name (only you + your servers see it)", placeholder: "Alex")
                    .accessibilityIdentifier("service-access-name-field")
                photoRow(c: c)
                FSPrimaryButton(vm?.busyAdd == true ? "Creating…" : "Create invite link", block: true, large: true) {
                    Task { await addPerson() }
                }
                .disabled(vm?.busyAdd == true || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("service-access-create-invite")
                if let link = vm?.lastInviteLink {
                    resultBlock(c: c, link: link)
                }
            }
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

    @ViewBuilder
    private func resultBlock(c: FSColors, link: String) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text("Shareable link")
                .font(FS.font.caption())
                .foregroundColor(c.text)
            Text(link)
                .font(FS.font.mono())
                .foregroundColor(c.text)
                .textSelection(.enabled)
                .padding(.vertical, FS.space.s2)
                .padding(.horizontal, FS.space.s3)
                .background(c.surfaceSunken)
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
                .accessibilityIdentifier("service-access-share-url")
            HStack(spacing: FS.space.s3) {
                if let url = URL(string: link) {
                    ShareLink(item: url) {
                        Label("Share…", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("service-access-share-sheet")
                }
                Button {
                    UIPasteboard.general.string = link
                    toasts.success("Link copied.")
                } label: {
                    Label("Copy link", systemImage: "doc.on.doc")
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("service-access-copy-btn")
            }
        }
    }

    // MARK: people list

    @ViewBuilder
    private func peopleSection(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("People with access")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(c.text)
            if (vm?.people ?? []).isEmpty {
                FSCard {
                    Text("No one added yet. Create an invite link above.")
                        .font(FS.font.body())
                        .foregroundColor(c.textMuted)
                }
            } else {
                ForEach(vm?.people ?? []) { person in
                    personRow(person, c: c)
                }
            }
        }
    }

    private func personRow(_ p: ServiceAccessViewModel.Person, c: FSColors) -> some View {
        FSCard {
            HStack(spacing: FS.space.s3) {
                avatar(p, c: c)
                VStack(alignment: .leading, spacing: 2) {
                    Text(p.name).font(FS.font.body()).foregroundColor(c.text)
                    Text(p.bound ? "active" : "invite sent — not opened yet")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                }
                Spacer()
                Button("Remove", role: .destructive) { confirmRemove = p }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("service-access-remove-\(p.inviteId)")
            }
        }
    }

    @ViewBuilder
    private func avatar(_ p: ServiceAccessViewModel.Person, c: FSColors) -> some View {
        if let photo = p.photo, let img = imageFromDataUri(photo) {
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
        let m = vm ?? ServiceAccessViewModel(
            client: client,
            serverDomain: serverDomain,
            serviceRef: serviceRef,
            username: username
        )
        vm = m
        await m.load()
        restrictedToggle = m.restricted
        if case .failed(let msg) = m.phase { toasts.error(msg) }
    }

    @MainActor
    private func onToggle(_ want: Bool) {
        // Optimistic flip so the section reveals/hides immediately; the VM
        // re-reads + reverts on failure.
        restrictedToggle = want
        guard let vm else { return }
        Task {
            await vm.setMode(restricted: want)
            restrictedToggle = vm.restricted
            if case .failed(let msg) = vm.phase {
                toasts.error(msg)
            } else {
                toasts.success(want ? "Now restricted to your allow-list." : "Now open to anyone with the link.")
            }
        }
    }

    @MainActor
    private func addPerson() async {
        guard let vm else { return }
        let link = await vm.addPerson(name: name, photo: photoDataUri)
        if link != nil {
            toasts.success("Invite for \(name.trimmingCharacters(in: .whitespacesAndNewlines)) created.")
            name = ""
            photoDataUri = nil
            photoItem = nil
        } else if case .failed(let msg) = vm.phase {
            toasts.error(msg)
        }
    }

    @MainActor
    private func remove(_ p: ServiceAccessViewModel.Person) async {
        guard let vm else { return }
        await vm.remove(inviteId: p.inviteId)
        if case .failed(let msg) = vm.phase { toasts.error(msg) } else { toasts.success("Removed.") }
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
