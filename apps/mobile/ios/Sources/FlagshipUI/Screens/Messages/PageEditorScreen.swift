import SwiftUI
import PhotosUI
import FlagshipAPI
import FlagshipCore

/// The page's profile fields while they are edited (docs/social-tab.md). Every change is a draft op until Publish on an
/// admin device signs a new index; one model so the page itself, the Page options sheet (theme) and the publish bar
/// count and commit the same fields.
@MainActor
@Observable
final class PageDraft {
    var displayName = ""
    var bio = ""
    var theme = "classic"
    var links: [VoiciProfileLink] = []
    var avatar: String?
    var avatarBytes: [UInt8]?
    var note: String?
    /// The field open for editing (kept here, not in the view, so it survives the page view being rebuilt).
    var editing: PageEditorView.Field?
    private(set) var loaded = false
    private let store: MessagesStore

    init(store: MessagesStore = .shared) { self.store = store }

    var current: VoiciProfile {
        VoiciProfile(displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping,
                     bio: bio.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping,
                     avatar: avatar, theme: theme, links: links)
    }

    /// The fields as last loaded from the store: anything else is an edit made here.
    private var baseline: VoiciProfile?

    /// The person changed a field here since it was last loaded.
    var edited: Bool { current != baseline }

    var changed: Bool { loaded && edited && current != store.preview.profile }

    /// Changes waiting to be published, counted the way the store counts them (a field still being edited is one).
    var unpublished: Int { store.pendingCount + (changed && !store.profileUnpublished ? 1 : 0) }

    func load() {
        guard !loaded else { return }
        reload()
        loaded = true
    }

    /// Another device (or a publish) changed the profile while nothing here was being edited.
    func reload() {
        let p = store.preview.profile
        displayName = p.displayName
        bio = p.bio
        theme = p.theme
        links = p.links
        avatar = p.avatar
        avatarBytes = nil
        baseline = current
    }

    /// The store's profile moved (the first read, a publish, another device): take it unless an edit here is pending.
    func storeChanged() {
        if !changed { reload() }
    }

    func pick(_ item: PhotosPickerItem?) async {
        guard let item, let data = try? await item.loadTransferable(type: Data.self) else { return }
        guard let jpeg = VoiciImageEncoder.encode(data, shape: .avatar) else {
            note = String(localized: "That photo couldn't be made small enough. Try another.")
            return
        }
        avatarBytes = jpeg
        avatar = CanonicalJson.sha256Hex(jpeg)
        note = nil
        await commit()
    }

    /// Records the fields as one profile draft (it replaces this device's earlier one). False when a field is refused.
    @discardableResult
    func commit() async -> Bool {
        guard changed else { return true }
        let p = current
        if let r = VoiciText.checkVoiciText(.displayName, p.displayName) {
            note = r == .tooShort ? String(localized: "Add a display name.") : MessagesStore.textSentence(r)
            return false
        }
        if let r = VoiciText.checkVoiciText(.bio, p.bio) {
            note = MessagesStore.textSentence(r)
            return false
        }
        note = nil
        await store.setProfile(p, avatar: avatar == store.preview.profile.avatar ? nil : avatarBytes)
        return true
    }
}

/// The Social tab's Profile: the page drawn as voi.ci draws it, in its theme, minus voi.ci's footer (docs/social-tab.md).
/// The photo, display name and bio read as live text with a pencil each and become editable only after the tap; links
/// and posts sit as on the page with Edit links and New post. Changes are drafts, grayed "Not published yet".
struct PageEditorView: View {
    @Bindable var draft: PageDraft
    private let store = MessagesStore.shared
    @Environment(\.colorScheme) private var scheme
    @State private var photo: PhotosPickerItem?
    @State private var choosingPhoto = false
    @State private var photoMenu = false
    @State private var editingLinks = false
    @State private var composing = false
    @State private var editingPost: VoiciPost?
    @FocusState private var focused: Field?
    @ScaledMetric(relativeTo: .title) private var avatarSide: CGFloat = 96

    enum Field { case name, bio }

    var body: some View {
        let t = VoiciPageTheme.of(draft.theme, scheme)
        VStack(spacing: 0) {
            head(t)
            posts(t)
        }
        .background(t.canvas)
        .foregroundStyle(t.ink)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(t.rule, lineWidth: 1))
        .environment(\.colorScheme, t.scheme)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("social-profile")
        .onAppear { draft.load() }
        .onChange(of: store.preview.profile) { _, _ in if draft.editing == nil { draft.storeChanged() } }
        .onChange(of: photo) { _, item in
            Task {
                await draft.pick(item)
                photo = nil
            }
        }
        .photosPicker(isPresented: $choosingPhoto, selection: $photo, matching: .images)
        .confirmationDialog(Text("Photo"), isPresented: $photoMenu) {
            Button(draft.avatar == nil ? String(localized: "Add photo") : String(localized: "Change photo")) { choosingPhoto = true }
                .accessibilityIdentifier("page-photo")
            if draft.avatar != nil {
                Button("Remove photo", role: .destructive) {
                    draft.avatar = nil
                    draft.avatarBytes = nil
                    Task { await draft.commit() }
                }
            }
        }
        .sheet(isPresented: $editingLinks, onDismiss: { Task { await draft.commit() } }) {
            EditLinksSheet(links: $draft.links)
        }
        .sheet(isPresented: $composing) { NewPostSheet() }
        .sheet(item: $editingPost) { post in
            EditPostSheet(post: post) { text in Task { await store.editPost(VoiciPost(id: post.id, createdAt: post.createdAt, editedAt: nil, text: text, links: post.links)) } }
        }
    }

    // MARK: head

    private func head(_ t: VoiciPageTheme) -> some View {
        VStack(spacing: 12) {
            ZStack(alignment: .bottomTrailing) {
                AvatarView(sha: draft.avatar, bytes: draft.avatarBytes, size: avatarSide)
                    .padding(4)
                    .background(Circle().fill(t.surface))
                    .overlay(Circle().strokeBorder(t.rule, lineWidth: 1))
                Button { photoMenu = true } label: {
                    PencilBadge(t: t, filled: true)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(draft.avatar == nil ? String(localized: "Add photo") : String(localized: "Change photo")))
                .accessibilityIdentifier("page-edit-photo")
            }
            .padding(.top, 8)
            nameRow(t)
            bioRow(t)
            if let n = draft.note {
                Text(verbatim: n).font(.footnote).foregroundStyle(t.err).multilineTextAlignment(.center)
                    .accessibilityIdentifier("page-profile-note")
            }
            if store.profileUnpublished || (draft.changed && draft.editing == nil) { pendingNote(t) }
            linksBlock(t)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 20)
        .padding(.top, 24)
        .padding(.bottom, 20)
    }

    @ViewBuilder
    private func nameRow(_ t: VoiciPageTheme) -> some View {
        if draft.editing == .name {
            VStack(alignment: .leading, spacing: 6) {
                Text("Display name").font(.caption).foregroundStyle(t.muted)
                HStack(spacing: 8) {
                    TextField(text: $draft.displayName, prompt: Text(verbatim: store.username)) { Text("Display name") }
                        .font(.title3.weight(.semibold))
                        .textContentType(.name)
                        .submitLabel(.done)
                        .focused($focused, equals: .name)
                        .onSubmit { finish() }
                        .onAppear { focused = .name }
                        .padding(.horizontal, 10)
                        .frame(minHeight: 44)
                        .background(RoundedRectangle(cornerRadius: 10).fill(t.surface))
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(t.link, lineWidth: 1.5))
                        .accessibilityIdentifier("page-display-name")
                    doneButton(t)
                }
            }
        } else {
            HStack(spacing: 2) {
                Text(verbatim: draft.displayName.isEmpty ? store.username : draft.displayName)
                    .font(.title.weight(.medium))
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("page-name-text")
                pencil(t, label: String(localized: "Edit display name"), id: "page-edit-name") { begin(.name) }
            }
        }
    }

    @ViewBuilder
    private func bioRow(_ t: VoiciPageTheme) -> some View {
        if draft.editing == .bio {
            VStack(alignment: .leading, spacing: 6) {
                Text("Bio").font(.caption).foregroundStyle(t.muted)
                TextField("Bio", text: $draft.bio, axis: .vertical)
                    .lineLimit(2...6)
                    .focused($focused, equals: .bio)
                    .onAppear { focused = .bio }
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 10).fill(t.surface))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(t.link, lineWidth: 1.5))
                    .accessibilityIdentifier("page-bio")
                HStack {
                    Text(verbatim: "\(draft.bio.unicodeScalars.count)/280").font(.caption2)
                        .foregroundStyle(draft.bio.unicodeScalars.count > 280 ? t.err : t.muted)
                    Spacer()
                    doneButton(t)
                }
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                if draft.bio.isEmpty {
                    Text("Add a short bio").foregroundStyle(t.muted)
                } else {
                    Text(verbatim: draft.bio).foregroundStyle(t.inkSoft).multilineTextAlignment(.center)
                        .accessibilityIdentifier("page-bio-text")
                }
                pencil(t, label: String(localized: "Edit bio"), id: "page-edit-bio") { begin(.bio) }
            }
            .frame(maxWidth: 420)
        }
    }

    private func doneButton(_ t: VoiciPageTheme) -> some View {
        Button { finish() } label: {
            Text("Done").fontWeight(.semibold).padding(.horizontal, 14).frame(minHeight: 44)
                .background(RoundedRectangle(cornerRadius: 10).fill(t.fill))
                .foregroundStyle(t.onFill)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("page-edit-done")
    }

    /// One field is edited at a time: while one is open the other pencils step aside (their 44-point targets would
    /// otherwise overlap the open field).
    @ViewBuilder
    private func pencil(_ t: VoiciPageTheme, label: String, id: String, action: @escaping () -> Void) -> some View {
        if draft.editing == nil {
            pencilButton(t, label: label, id: id, action: action)
        }
    }

    private func pencilButton(_ t: VoiciPageTheme, label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "pencil").font(.subheadline.weight(.semibold)).foregroundStyle(t.muted)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
        .accessibilityIdentifier(id)
    }

    private func begin(_ f: Field) {
        Task {
            if draft.editing != nil, !(await draft.commit()) { return }
            draft.editing = f
        }
    }

    private func finish() {
        Task {
            if await draft.commit() {
                draft.editing = nil
                focused = nil
            }
        }
    }

    // MARK: links

    private func linksBlock(_ t: VoiciPageTheme) -> some View {
        VStack(spacing: 10) {
            ForEach(Array(draft.links.enumerated()), id: \.offset) { _, l in
                HStack(spacing: 14) {
                    Image(systemName: l.url.hasPrefix("mailto:") ? "envelope" : "link")
                        .font(.subheadline)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(t.canvas))
                        .overlay(Circle().strokeBorder(t.rule, lineWidth: 1))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(verbatim: l.label).fontWeight(.medium).lineLimit(1)
                        Text(verbatim: VoiciText.voiciUrlHost(l.url) ?? l.url.replacingOccurrences(of: "mailto:", with: ""))
                            .font(.caption.monospaced()).foregroundStyle(t.muted).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "arrow.up.right").font(.footnote).foregroundStyle(t.muted).accessibilityHidden(true)
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 64)
                .background(RoundedRectangle(cornerRadius: 6).fill(t.surface))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(t.rule, lineWidth: 1))
                .accessibilityElement(children: .combine)
            }
            Button { editingLinks = true } label: {
                Label(draft.links.isEmpty ? String(localized: "Add link") : String(localized: "Edit links"), systemImage: "pencil")
                    .font(.footnote)
                    .foregroundStyle(t.muted)
                    .frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("page-edit-links")
        }
        .padding(.top, draft.links.isEmpty ? 0 : 14)
    }

    // MARK: posts

    private func posts(_ t: VoiciPageTheme) -> some View {
        let unpublished = store.unpublishedPostIds
        let all = Array(store.preview.chunks.flatMap { $0 }.reversed())
        return VStack(spacing: 0) {
            HStack {
                Text("Posts").textCase(.uppercase).font(.caption.monospaced().weight(.medium)).tracking(1.5).foregroundStyle(t.muted)
                Spacer()
                Button { composing = true } label: {
                    Label("New post", systemImage: "plus")
                        .font(.footnote.weight(.semibold))
                        .padding(.horizontal, 12)
                        .frame(minHeight: 36)
                        .background(Capsule().fill(t.fill))
                        .foregroundStyle(t.onFill)
                }
                .buttonStyle(.plain)
                .frame(minHeight: 44)
                .accessibilityIdentifier("page-new-post-open")
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 6)
            if all.isEmpty {
                Text("No posts yet.")
                    .font(.subheadline).foregroundStyle(t.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 18).padding(.vertical, 16)
                    .overlay(alignment: .top) { t.rule.frame(height: 1) }
            }
            ForEach(all, id: \.id) { post in
                postRow(post, t, pending: unpublished.contains(post.id))
            }
        }
        .padding(.bottom, 6)
        .overlay(alignment: .top) { t.rule.frame(height: 1) }
    }

    private func postRow(_ post: VoiciPost, _ t: VoiciPageTheme, pending: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(Date(timeIntervalSince1970: TimeInterval(post.createdAt) / 1000), format: .dateTime.day().month().year())
                    .font(.caption.monospaced()).foregroundStyle(t.muted)
                if pending {
                    Text(store.isAdmin ? String(localized: "Not published yet") : String(localized: "Waiting for an admin device to publish"))
                        .font(.caption2).foregroundStyle(t.muted)
                        .accessibilityIdentifier("page-pending-note")
                }
                Spacer()
                Menu {
                    Button { editingPost = post } label: { Label("Edit", systemImage: "pencil") }
                    if post.links.contains(where: { $0.card != nil }) {
                        Button {
                            var p = post
                            p.links = p.links.map { VoiciPostLink(url: $0.url, card: nil) }
                            Task { await store.editPost(p) }
                        } label: { Label("Remove link cards", systemImage: "rectangle.slash") }
                    }
                    Button(role: .destructive) { Task { await store.deletePost(post.id) } } label: { Label("Delete", systemImage: "trash") }
                } label: {
                    Image(systemName: "ellipsis").foregroundStyle(t.muted).frame(width: 44, height: 32).contentShape(Rectangle())
                }
                .accessibilityLabel(Text("Post options"))
                .accessibilityIdentifier("page-post-menu")
            }
            Text(verbatim: post.text).font(.callout).fixedSize(horizontal: false, vertical: true)
            ForEach(post.links, id: \.url) { l in
                if let card = l.card { linkCard(card, url: l.url, t) }
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { t.rule.frame(height: 1) }
        .opacity(pending ? 0.55 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(pending ? "page-post-pending" : "page-post")
    }

    private func linkCard(_ card: VoiciCard, url: String, _ t: VoiciPageTheme) -> some View {
        HStack(alignment: .top, spacing: 10) {
            if let sha = card.image, let b = VoiciImageStore.load(sha), let img = UIImage(data: Data(b)) {
                Image(uiImage: img).resizable().scaledToFill().frame(width: 72, height: 54).clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 4))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: card.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                if !card.description.isEmpty { Text(verbatim: card.description).font(.caption).foregroundStyle(t.muted).lineLimit(2) }
                Text(verbatim: card.site.isEmpty ? (VoiciText.voiciUrlHost(url) ?? "") : card.site).font(.caption2.monospaced()).foregroundStyle(t.muted)
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(t.surface))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(t.rule, lineWidth: 1))
    }

    private func pendingNote(_ t: VoiciPageTheme) -> some View {
        Text(store.isAdmin ? String(localized: "Not published yet") : String(localized: "Waiting for an admin device to publish"))
            .font(.caption)
            .foregroundStyle(t.muted)
            .accessibilityIdentifier("page-pending-note")
    }
}

/// The round pencil on the photo.
private struct PencilBadge: View {
    let t: VoiciPageTheme
    var filled = false

    var body: some View {
        Image(systemName: "pencil")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(t.ink)
            .frame(width: 32, height: 32)
            .background(Circle().fill(t.surface))
            .overlay(Circle().strokeBorder(t.ruleStrong, lineWidth: 1))
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
            .offset(x: 8, y: 6)
    }
}

/// The page's links: reorder, delete, add (at most VoiciPage.profileMaxLinks). Committed as a draft when it closes.
struct EditLinksSheet: View {
    @Binding var links: [VoiciProfileLink]
    @Environment(\.dismiss) private var dismiss
    @State private var adding = false

    var body: some View {
        NavigationStack {
            Form {
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
                        Button { adding = true } label: { Label("Add link", systemImage: "plus") }
                            .accessibilityIdentifier("page-add-link")
                    }
                }
            }
            .navigationTitle(Text("Links"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if links.count > 1 { ToolbarItem(placement: .topBarLeading) { EditButton() } }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("page-links-done") }
            }
            .sheet(isPresented: $adding) {
                AddLinkSheet(existing: links) { links.append($0) }
            }
        }
    }
}

/// Write a post: a draft, grayed on the page until it is published. Link cards are fetched here, as before.
struct NewPostSheet: View {
    private let store = MessagesStore.shared
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var posting = false
    @State private var problem: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Write a post", text: $text, axis: .vertical)
                        .lineLimit(4...12)
                        .focused($focused)
                        .accessibilityIdentifier("page-new-post")
                        .onChange(of: text) { _, v in if v.count > 2_000 { text = String(v.prefix(2_000)) } }
                } footer: {
                    HStack {
                        if let problem { Text(verbatim: problem).foregroundStyle(.red) }
                        Spacer()
                        Text(verbatim: "\(text.count)/2000")
                    }
                }
            }
            .navigationTitle(Text("New post"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(posting ? String(localized: "Adding…") : String(localized: "Add post")) { Task { await add() } }
                        .disabled(posting || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("page-add-post")
                }
            }
            .onAppear { focused = true }
        }
    }

    private func add() async {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
        if let r = VoiciText.checkVoiciText(.postText, t) {
            problem = MessagesStore.textSentence(r)
            return
        }
        posting = true
        defer { posting = false }
        var postLinks: [VoiciPostLink] = []
        var images: [String: [UInt8]] = [:]
        for m in VoiciText.findVoiciLinks(t).prefix(VoiciPage.postMaxLinks) where VoiciText.checkVoiciLinkUrl(m.url) == nil {
            let fetched = await VoiciLinkCards.fetch(m.url)
            if let img = fetched?.image, let sha = fetched?.card.image { images[sha] = img }
            postLinks.append(VoiciPostLink(url: m.url, card: fetched?.card))
        }
        await store.addPost(text: t, links: postLinks, images: images)
        dismiss()
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
                    Text("Your page and your messages must not contain illegal content, harassment, threats, nudity or sexual content, graphic real-world violence, spam, or content that pretends to be someone else.")
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
