import SwiftUI
import PhotosUI
import FlagshipAPI
import FlagshipCore

/// The voi.ci page editor (docs/voici-and-messages.md §11.2). Every change is a draft op: grayed "Not published yet"
/// until an admin device signs a new index (on a non-admin device: "Waiting for an admin device to publish"). The
/// warning that the page can be linked to the owner's apps sits above the profile and again before the first publish.
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
    @State private var confirmFirstPublish = false
    @State private var showRules = false
    @State private var afterRules = false
    @State private var copied = false

    var body: some View {
        Form {
            Section {
                Label {
                    Text("Anyone can see this page. It shares your username with your apps and servers, so people can connect them.")
                        .font(.subheadline)
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
                Button("Save profile") { Task { await saveProfile() } }
                    .disabled(!profileChanged)
                    .accessibilityIdentifier("page-save-profile")
                if let profileNote { Text(verbatim: profileNote).font(.footnote).foregroundStyle(.red) }
                if store.profileUnpublished { pendingNote }
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
        .onChange(of: photo) { _, item in Task { await pick(item) } }
        .sheet(isPresented: $addingLink) {
            AddLinkSheet(existing: links) { links.append($0) }
        }
        .sheet(item: $editing) { post in
            EditPostSheet(post: post) { text in Task { await store.editPost(VoiciPost(id: post.id, createdAt: post.createdAt, editedAt: nil, text: text, links: post.links)) } }
        }
        .sheet(isPresented: $showRules, onDismiss: {
            if afterRules {
                afterRules = false
                confirmFirstPublish = true
            }
        }) {
            VoiciRulesSheet { afterRules = true }
        }
        .alert("Publish your page?", isPresented: $confirmFirstPublish) {
            Button("Cancel", role: .cancel) {}
            Button("Publish") { Task { await publish() } }
        } message: {
            Text("Anyone can see this page. It shares your username with your apps and servers, so people can connect them.")
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
                .accessibilityIdentifier("page-display-name")
            VStack(alignment: .trailing, spacing: 2) {
                TextField("Bio", text: $bio, axis: .vertical)
                    .lineLimit(2...5)
                    .accessibilityIdentifier("page-bio")
                Text(verbatim: "\(bio.unicodeScalars.count)/280").font(.caption2).foregroundStyle(bio.unicodeScalars.count > 280 ? .red : .secondary)
            }
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
        let p = store.preview.profile
        displayName = p.displayName
        bio = p.bio
        theme = p.theme
        links = p.links
        avatar = p.avatar
        loaded = true
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

    private func saveProfile() async {
        let p = currentProfile
        if let r = VoiciText.checkVoiciText(.displayName, p.displayName) {
            profileNote = r == .tooShort ? String(localized: "Add a display name.") : MessagesStore.textSentence(r)
            return
        }
        if let r = VoiciText.checkVoiciText(.bio, p.bio) {
            profileNote = MessagesStore.textSentence(r)
            return
        }
        profileNote = nil
        await store.setProfile(p, avatar: avatar == store.preview.profile.avatar ? nil : avatarBytes)
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

    private var publishSection: some View {
        Section {
            if store.isAdmin {
                Button {
                    if store.index == nil {
                        if VoiciRules.accepted { confirmFirstPublish = true } else { showRules = true }
                    } else {
                        Task { await publish() }
                    }
                } label: {
                    HStack { Text(store.isPublishing ? String(localized: "Publishing…") : String(localized: "Publish")); Spacer() }
                }
                .disabled(store.isPublishing || (store.index != nil && store.pendingCount == 0))
                .accessibilityIdentifier("page-publish")
            } else if store.pendingCount > 0 {
                Text("Waiting for an admin device to publish").foregroundStyle(.secondary)
            }
            if let e = store.publishError { Text(verbatim: e).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("page-publish-error") }
            if store.index != nil {
                Button(copied ? String(localized: "Copied") : String(localized: "Copy link")) {
                    UIPasteboard.general.string = store.pageURL
                    copied = true
                }
                ShareLink(item: URL(string: store.pageURL)!) { Text("Share") }
            }
        } footer: {
            if store.index != nil { Text(verbatim: store.pageURL) }
        }
    }

    private func publish() async {
        VoiciRules.accept()
        if profileChanged { await saveProfile() }
        await store.publishNow()
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
