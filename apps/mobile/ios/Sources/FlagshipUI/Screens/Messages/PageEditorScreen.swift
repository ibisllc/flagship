import SwiftUI
import PhotosUI
import FlagshipAPI
import FlagshipCore

/// The voi.ci page editor (docs/voici-and-messages.md §11.2). Every change is a draft op, grayed "Not published yet",
/// until the one bottom bar's Publish on an admin device signs a new index (elsewhere: "Waiting for an admin device to
/// publish"). The Public switch sits on top, with the warning that the page can be linked to the owner's apps; making
/// the page public goes through the same one-time warning as the Messages header (PagePublicFlow).
struct PageEditorScreen: View {
    var onPreview: () -> Void
    private let store = MessagesStore.shared
    @State private var displayName = ""
    @State private var bio = ""
    @State private var theme = "classic"
    @State private var links: [VoiciProfileLink] = []
    @State private var avatar: String?
    @State private var avatarBytes: [UInt8]?
    @State private var photo: PhotosPickerItem?
    @State private var loaded = false
    @State private var profileNote: String?
    @State private var addingLink = false
    @State private var newPost = ""
    @State private var posting = false
    @State private var editing: VoiciPost?
    @State private var copied = false
    @State private var flow = PagePublicFlow()
    @FocusState private var focusedField: Field?

    private enum Field { case name, bio }

    var body: some View {
        Form {
            Section {
                PagePublicToggle(flow: flow)
                if !store.isAdmin {
                    Text("Only an admin device can publish your page.").font(.footnote).foregroundStyle(.secondary)
                }
            } footer: {
                Label {
                    Text("Anyone can see this page. It shares your username with your apps and servers, so people can connect them.")
                } icon: {
                    Image(systemName: "eye").foregroundStyle(.orange)
                }
                .accessibilityIdentifier("page-warning")
            }
            profileSection
            linksSection
            Section("Theme") {
                Picker("Theme", selection: $theme) {
                    Text("Classic").tag("classic")
                    Text("Ink").tag("ink")
                    Text("Sea").tag("sea")
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("page-theme")
            }
            Section {
                Toggle("Accept messages", isOn: Binding(get: { store.acceptsMessages }, set: { on in Task { await store.setAcceptsMessages(on) } }))
                    .accessibilityIdentifier("page-accept-messages")
            } footer: {
                Text("People with a Flagship account can write to you. They appear as visitors, not by name.")
            }
            postsSection
            publishSection
        }
        .navigationTitle(Text("Your page"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Preview", action: onPreview).accessibilityIdentifier("page-preview")
            }
        }
        .onAppear { loadFields() }
        // Every change is a draft: the fields become one when they lose focus, and on leaving the editor.
        .onDisappear { Task { await commitProfile() } }
        .onChange(of: focusedField) { old, _ in if old != nil { Task { await commitProfile() } } }
        .onChange(of: theme) { _, _ in Task { await commitProfile() } }
        .onChange(of: links) { _, _ in Task { await commitProfile() } }
        .onChange(of: avatar) { _, _ in Task { await commitProfile() } }
        .onChange(of: store.preview.profile) { _, _ in if focusedField == nil, !profileChanged { reloadFields() } }
        .onChange(of: photo) { _, item in Task { await pick(item) } }
        .safeAreaInset(edge: .bottom, spacing: 0) { publishBar }
        .pagePublicFlow(flow)
        .sheet(isPresented: $addingLink) {
            AddLinkSheet(existing: links) { links.append($0) }
        }
        .sheet(item: $editing) { post in
            EditPostSheet(post: post) { text in Task { await store.editPost(VoiciPost(id: post.id, createdAt: post.createdAt, editedAt: nil, text: text, links: post.links)) } }
        }
    }

    /// Changes waiting to be published, counted the way the header counts them (a field still being typed in is one).
    private var unpublished: Int { store.pendingCount + (profileChanged && !store.profileUnpublished ? 1 : 0) }

    /// One bar for the whole editor: "<N> changes not published · Publish" (on another device: waiting for an admin).
    @ViewBuilder
    private var publishBar: some View {
        let n = unpublished
        if n > 0 || store.isPublishing {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(String(localized: "\(n) changes not published"))
                        .font(.subheadline.weight(.semibold))
                        .accessibilityIdentifier("page-pending-count")
                    if !store.isAdmin {
                        Text("Waiting for an admin device to publish")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("page-waiting-admin")
                    }
                }
                Spacer(minLength: 8)
                if store.isAdmin {
                    Button {
                        Task {
                            if await commitProfile() { flow.publishAll() }
                        }
                    } label: {
                        if store.isPublishing { ProgressView() } else { Text("Publish").fontWeight(.semibold) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(store.isPublishing)
                    .accessibilityIdentifier("page-publish")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity)
            .background(.bar)
            .overlay(alignment: .top) { Divider() }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("page-publish-bar")
        }
    }

    // MARK: profile

    private var profileSection: some View {
        Section("Profile") {
            HStack(spacing: 16) {
                AvatarView(sha: avatar, bytes: avatarBytes, size: 64)
                VStack(alignment: .leading, spacing: 6) {
                    PhotosPicker(selection: $photo, matching: .images) { Text(avatar == nil ? String(localized: "Add photo") : String(localized: "Change photo")) }
                        .accessibilityIdentifier("page-photo")
                    if avatar != nil {
                        Button("Remove photo", role: .destructive) { avatar = nil; avatarBytes = nil }
                    }
                }
            }
            TextField("Display name", text: $displayName)
                .focused($focusedField, equals: .name)
                .submitLabel(.done)
                .accessibilityIdentifier("page-display-name")
            VStack(alignment: .trailing, spacing: 2) {
                TextField("Bio", text: $bio, axis: .vertical)
                    .lineLimit(2...5)
                    .focused($focusedField, equals: .bio)
                    .accessibilityIdentifier("page-bio")
                Text(verbatim: "\(bio.unicodeScalars.count)/280").font(.caption2).foregroundStyle(bio.unicodeScalars.count > 280 ? .red : .secondary)
            }
            if let profileNote { Text(verbatim: profileNote).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("page-profile-note") }
            if store.profileUnpublished || profileChanged { pendingNote }
        }
    }

    private var linksSection: some View {
        Section {
            ForEach(Array(links.enumerated()), id: \.offset) { _, l in
                HStack {
                    Image(systemName: l.url.hasPrefix("mailto:") ? "envelope" : "link").foregroundStyle(.secondary).frame(width: 22)
                    VStack(alignment: .leading) {
                        Text(verbatim: l.label)
                        Text(verbatim: VoiciText.voiciUrlHost(l.url) ?? l.url).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let site = l.site, let label = VoiciText.linkSites.first(where: { $0.id == site })?.label {
                        Text(verbatim: site == "email" ? String(localized: "Email") : label).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .onMove { links.move(fromOffsets: $0, toOffset: $1) }
            .onDelete { links.remove(atOffsets: $0) }
            if links.count < VoiciPage.profileMaxLinks {
                Button { addingLink = true } label: { Label("Add link", systemImage: "plus") }
                    .accessibilityIdentifier("page-add-link")
            }
        } header: {
            HStack { Text("Links"); Spacer(); if links.count > 1 { EditButton().font(.caption) } }
        }
    }

    private var currentProfile: VoiciProfile {
        VoiciProfile(displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping,
                     bio: bio.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping,
                     avatar: avatar, theme: theme, links: links)
    }

    private var profileChanged: Bool { loaded && currentProfile != store.preview.profile }

    private func loadFields() {
        guard !loaded else { return }
        reloadFields()
        loaded = true
    }

    /// The header (or another device) changed the profile while no field here was being edited.
    private func reloadFields() {
        let p = store.preview.profile
        displayName = p.displayName
        bio = p.bio
        theme = p.theme
        links = p.links
        avatar = p.avatar
    }

    private func pick(_ item: PhotosPickerItem?) async {
        guard let item, let data = try? await item.loadTransferable(type: Data.self) else { return }
        guard let jpeg = VoiciImageEncoder.encode(data, shape: .avatar) else {
            profileNote = String(localized: "That photo couldn't be made small enough. Try another.")
            return
        }
        avatarBytes = jpeg
        avatar = CanonicalJson.sha256Hex(jpeg)
        profileNote = nil
    }

    /// Records the fields as one profile draft (it replaces this device's earlier one). False when a field is refused.
    @discardableResult
    private func commitProfile() async -> Bool {
        guard profileChanged else { return true }
        let p = currentProfile
        if let r = VoiciText.checkVoiciText(.displayName, p.displayName) {
            profileNote = r == .tooShort ? String(localized: "Add a display name.") : MessagesStore.textSentence(r)
            return false
        }
        if let r = VoiciText.checkVoiciText(.bio, p.bio) {
            profileNote = MessagesStore.textSentence(r)
            return false
        }
        profileNote = nil
        await store.setProfile(p, avatar: avatar == store.preview.profile.avatar ? nil : avatarBytes)
        return true
    }

    // MARK: posts

    private var postsSection: some View {
        Section("Posts") {
            VStack(alignment: .trailing, spacing: 6) {
                TextField("Write a post", text: $newPost, axis: .vertical)
                    .lineLimit(2...8)
                    .accessibilityIdentifier("page-new-post")
                    .onChange(of: newPost) { _, v in if v.count > 2_000 { newPost = String(v.prefix(2_000)) } }
                HStack {
                    Text(verbatim: "\(newPost.count)/2000").font(.caption2).foregroundStyle(.secondary)
                    Spacer()
                    Button(posting ? String(localized: "Adding…") : String(localized: "Add post")) { Task { await addPost() } }
                        .disabled(posting || newPost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("page-add-post")
                }
            }
            let unpublished = store.unpublishedPostIds
            ForEach(store.preview.chunks.flatMap { $0 }.reversed(), id: \.id) { post in
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: post.text).lineLimit(6)
                    ForEach(post.links, id: \.url) { l in
                        if let card = l.card {
                            Label { Text(verbatim: card.title).font(.caption) } icon: { Image(systemName: "rectangle.on.rectangle") }
                                .foregroundStyle(.secondary)
                        }
                    }
                    if unpublished.contains(post.id) { pendingNote }
                }
                .opacity(unpublished.contains(post.id) ? 0.55 : 1)
                .accessibilityIdentifier(unpublished.contains(post.id) ? "page-post-pending" : "page-post")
                .swipeActions {
                    Button(role: .destructive) { Task { await store.deletePost(post.id) } } label: { Label("Delete", systemImage: "trash") }
                    Button { editing = post } label: { Label("Edit", systemImage: "pencil") }
                }
                .contextMenu {
                    Button { editing = post } label: { Label("Edit", systemImage: "pencil") }
                    if post.links.contains(where: { $0.card != nil }) {
                        Button {
                            var p = post
                            p.links = p.links.map { VoiciPostLink(url: $0.url, card: nil) }
                            Task { await store.editPost(p) }
                        } label: { Label("Remove link cards", systemImage: "rectangle.slash") }
                    }
                    Button(role: .destructive) { Task { await store.deletePost(post.id) } } label: { Label("Delete", systemImage: "trash") }
                }
            }
        }
    }

    private var pendingNote: some View {
        Text(store.isAdmin ? String(localized: "Not published yet") : String(localized: "Waiting for an admin device to publish"))
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("page-pending-note")
    }

    private func addPost() async {
        let text = newPost.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
        if let r = VoiciText.checkVoiciText(.postText, text) {
            profileNote = MessagesStore.textSentence(r)
            return
        }
        posting = true
        defer { posting = false }
        var postLinks: [VoiciPostLink] = []
        var images: [String: [UInt8]] = [:]
        for m in VoiciText.findVoiciLinks(text).prefix(VoiciPage.postMaxLinks) where VoiciText.checkVoiciLinkUrl(m.url) == nil {
            let fetched = await VoiciLinkCards.fetch(m.url)
            if let img = fetched?.image, let sha = fetched?.card.image { images[sha] = img }
            postLinks.append(VoiciPostLink(url: m.url, card: fetched?.card))
        }
        await store.addPost(text: text, links: postLinks, images: images)
        newPost = ""
    }

    // MARK: publish

    /// Publishing is the bottom bar; this keeps the last refusal, and the link while the page is public.
    @ViewBuilder
    private var publishSection: some View {
        if store.publishError != nil || store.isPublic {
            Section {
                if let e = store.publishError { Text(verbatim: e).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("page-publish-error") }
                if store.isPublic {
                    Button(copied ? String(localized: "Copied") : String(localized: "Copy link")) {
                        UIPasteboard.general.string = store.pageURL
                        copied = true
                    }
                    ShareLink(item: URL(string: store.pageURL)!) { Text("Share") }
                }
            } footer: {
                if store.isPublic { Text(verbatim: store.pageURL) }
            }
        }
    }
}

struct AvatarView: View {
    let sha: String?
    var bytes: [UInt8]?
    let size: CGFloat

    var body: some View {
        Group {
            if let b = bytes ?? sha.flatMap(VoiciImageStore.load), let img = UIImage(data: Data(b)) {
                Image(uiImage: img).resizable().scaledToFill()
            } else {
                Image(systemName: "person.crop.circle.fill").resizable().foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }
}

struct AddLinkSheet: View {
    let existing: [VoiciProfileLink]
    let onAdd: (VoiciProfileLink) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var url = ""
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField("Label", text: $label).accessibilityIdentifier("link-label")
                TextField("https://", text: $url)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("link-url")
                if let host = VoiciText.voiciUrlHost(url) {
                    Text(verbatim: host).font(.caption).foregroundStyle(.secondary)
                }
                if let problem { Text(verbatim: problem).font(.footnote).foregroundStyle(.red) }
            }
            .navigationTitle(Text("Add link"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Add") { add() }.accessibilityIdentifier("link-add") }
            }
        }
    }

    private func add() {
        let l = label.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
        let u = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if VoiciText.checkVoiciText(.linkLabel, l) != nil { problem = String(localized: "Give the link a short label (40 characters at most)."); return }
        let mailto = u.hasPrefix("mailto:")
        if mailto && existing.contains(where: { $0.url.hasPrefix("mailto:") }) { problem = String(localized: "A page can have one email link."); return }
        if VoiciText.checkVoiciLinkUrl(u, allowMailto: true) != nil { problem = String(localized: "Use a full https:// address."); return }
        onAdd(VoiciProfileLink(url: u, label: l, site: mailto ? nil : VoiciText.voiciLinkSite(u)))
        dismiss()
    }
}

struct EditPostSheet: View {
    let post: VoiciPost
    let onSave: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""

    var body: some View {
        NavigationStack {
            Form {
                TextField("Post", text: $text, axis: .vertical).lineLimit(3...12)
            }
            .navigationTitle(Text("Edit post"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let t = text.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
                        guard VoiciText.checkVoiciText(.postText, t) == nil else { return }
                        onSave(t)
                        dismiss()
                    }
                }
            }
            .onAppear { text = post.text }
        }
    }
}

/// The one-time "Page and message rules" (§9.7): before the first publish and the first sign-in approval.
enum VoiciRules {
    static let key = "flagship.voici.rulesAccepted"
    static var accepted: Bool { UserDefaults.standard.bool(forKey: key) }
    static func accept() { UserDefaults.standard.set(true, forKey: key) }
}

struct VoiciRulesSheet: View {
    var onAccept: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Your page and your messages must not contain illegal content, harassment, threats, spam, or content that pretends to be someone else.")
                    Text("Anyone can report a page or a message. Flagship can remove a page and stop an account from sending messages.")
                    Text("Messages are private. If someone reports your message, Flagship can see which account sent it.")
                    Text("The full rules are in the terms at flagshipserver.com/terms.")
                        .foregroundStyle(.secondary)
                }
                .padding()
            }
            .navigationTitle(Text("Page and message rules"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("I agree") {
                        VoiciRules.accept()
                        dismiss()
                        onAccept()
                    }
                    .accessibilityIdentifier("rules-agree")
                }
            }
        }
    }
}
