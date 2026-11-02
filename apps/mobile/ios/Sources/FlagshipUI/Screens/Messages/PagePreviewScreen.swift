import SwiftUI
import FlagshipAPI
import FlagshipCore

/// The page as voi.ci will show it (docs/voici-and-messages.md §2.1, §11.2), with the same rules: text as text,
/// each link's host under its label, at most the "Send me a message" button while messages are accepted, posts newest
/// first. Changes not yet published are grayed with "Not published yet"; voi.ci never shows them.
struct PagePreviewScreen: View {
    private let store = MessagesStore.shared

    var body: some View {
        let page = store.preview
        let unpublished = store.unpublishedPostIds
        ScrollView {
            VStack(spacing: 16) {
                VStack(spacing: 8) {
                    AvatarView(sha: page.profile.avatar, size: 96)
                    Text(verbatim: page.profile.displayName).font(.title2.weight(.semibold)).multilineTextAlignment(.center)
                    if !page.profile.bio.isEmpty {
                        Text(verbatim: page.profile.bio).font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    if store.profileUnpublished { Text("Not published yet").font(.caption).foregroundStyle(.secondary) }
                }
                .opacity(store.profileUnpublished ? 0.6 : 1)
                VStack(spacing: 8) {
                    ForEach(Array(page.profile.links.enumerated()), id: \.offset) { _, l in
                        VStack(spacing: 2) {
                            Text(verbatim: l.label).font(.body.weight(.medium))
                            Text(verbatim: VoiciText.voiciUrlHost(l.url) ?? l.url.replacingOccurrences(of: "mailto:", with: "")).font(.caption).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
                if page.acceptsMessages == 1 {
                    Text("Send me a message")
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .foregroundStyle(.white)
                        .accessibilityIdentifier("preview-send-message")
                }
                ForEach(page.chunks.flatMap { $0 }.reversed(), id: \.id) { post in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(Date(timeIntervalSince1970: TimeInterval(post.createdAt) / 1000), format: .dateTime.day().month().year())
                            .font(.caption).foregroundStyle(.secondary)
                        Text(verbatim: post.text)
                        ForEach(post.links, id: \.url) { l in
                            if let card = l.card {
                                HStack(alignment: .top, spacing: 10) {
                                    if let sha = card.image, let b = VoiciImageStore.load(sha), let img = UIImage(data: Data(b)) {
                                        Image(uiImage: img).resizable().scaledToFill().frame(width: 72, height: 54).clipped()
                                            .clipShape(RoundedRectangle(cornerRadius: 6))
                                    }
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(verbatim: card.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                                        if !card.description.isEmpty { Text(verbatim: card.description).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                                        Text(verbatim: card.site.isEmpty ? (VoiciText.voiciUrlHost(l.url) ?? "") : card.site).font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                                .padding(8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                        }
                        if unpublished.contains(post.id) { Text("Not published yet").font(.caption).foregroundStyle(.secondary) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .opacity(unpublished.contains(post.id) ? 0.55 : 1)
                    Divider()
                }
            }
            .padding()
        }
        .navigationTitle(Text(verbatim: "voi.ci/\(store.username)"))
        .navigationBarTitleDisplayMode(.inline)
    }
}
