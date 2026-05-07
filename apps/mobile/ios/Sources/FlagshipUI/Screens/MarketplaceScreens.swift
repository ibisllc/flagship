import SwiftUI

/// Marketplace list + detail screens (N5).
///
/// MarketplaceListScreen — paged list of public apps; tap a card to
/// open MarketplaceDetailScreen.
/// MarketplaceDetailScreen — the install destination. The user picks
/// a pod to install on; the phone signs the install order and ships
/// it to .com `/api/marketplace/<creator>/<slug>/install`.

public struct MarketplaceListScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var listings: [ListingSummary] = []
    @State private var query: String = ""
    var onOpen: (String, String) -> Void = { _, _ in }

    public init(
        listings: [ListingSummary] = [],
        onOpen: @escaping (String, String) -> Void = { _, _ in }
    ) {
        self._listings = State(initialValue: listings)
        self.onOpen = onOpen
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("Marketplace")
                        .font(.system(size: 32, weight: .medium))
                        .foregroundColor(c.text)
                    Text("Apps your neighbours built. One tap to install on any of your boxes.")
                        .font(.system(size: 17))
                        .foregroundColor(c.textMuted)
                }
                .padding(.top, FS.space.s10)

                FSField(value: $query, label: "", placeholder: "Search apps")

                VStack(spacing: FS.space.s3) {
                    ForEach(listings.filter { $0.matches(query) }) { l in
                        Button(action: { onOpen(l.creator, l.slug) }) {
                            ListingRowView(l: l)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
    }
}

private struct ListingRowView: View {
    @Environment(\.colorScheme) private var scheme
    let l: ListingSummary
    var body: some View {
        let c = FSColors.scheme(scheme)
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(l.name)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(c.text)
                Text(l.tagline)
                    .font(.system(size: 14))
                    .foregroundColor(c.textMuted)
                HStack(spacing: FS.space.s2) {
                    FSPill(l.category, kind: .idle)
                    if l.installCount > 0 {
                        FSPill("\(l.installCount) installs", kind: .online)
                    }
                    if let grade = l.scanGrade {
                        FSPill("Scan: \(grade)", kind: .provisioning)
                    }
                }
            }
        }
    }
}

public struct MarketplaceDetailScreen: View {
    @Environment(\.colorScheme) private var scheme
    let listing: ListingDetail
    let pods: [PodSummary]
    @State private var selectedPodId: String? = nil
    var onInstall: (String) -> Void = { _ in }
    var onViewSource: () -> Void = { }

    public init(
        listing: ListingDetail,
        pods: [PodSummary],
        onInstall: @escaping (String) -> Void = { _ in },
        onViewSource: @escaping () -> Void = { }
    ) {
        self.listing = listing
        self.pods = pods
        self.onInstall = onInstall
        self.onViewSource = onViewSource
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text(listing.name)
                        .font(.system(size: 32, weight: .medium))
                        .foregroundColor(c.text)
                    Text("by \(listing.creator)")
                        .font(.system(size: 17))
                        .foregroundColor(c.textMuted)
                }
                .padding(.top, FS.space.s10)

                FSCard {
                    Text(listing.description)
                        .font(.system(size: 15))
                        .foregroundColor(c.text)
                }

                VStack(alignment: .leading, spacing: FS.space.s3) {
                    Text("INSTALL ON")
                        .font(.system(size: 12, weight: .semibold))
                        .tracking(1)
                        .foregroundColor(c.textMuted)
                    VStack(spacing: FS.space.s2) {
                        ForEach(pods) { pod in
                            Button(action: { selectedPodId = pod.podId }) {
                                FSCard {
                                    HStack {
                                        VStack(alignment: .leading, spacing: FS.space.s1) {
                                            Text(pod.label)
                                                .font(.system(size: 16, weight: .semibold))
                                                .foregroundColor(c.text)
                                            Text(pod.fqdn)
                                                .font(.system(size: 13))
                                                .foregroundColor(c.textMuted)
                                        }
                                        Spacer()
                                        if selectedPodId == pod.podId {
                                            FSPill("Selected", kind: .online)
                                        }
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                FSPrimaryButton("Install", enabled: selectedPodId != nil, block: true) {
                    if let pod = selectedPodId { onInstall(pod) }
                }
                FSGhostButton("View source", block: true, action: onViewSource)
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
    }
}

public struct ListingSummary: Identifiable {
    public let id: String
    public let creator: String
    public let slug: String
    public let name: String
    public let tagline: String
    public let category: String
    public let installCount: Int
    public let scanGrade: String?
    public init(
        creator: String,
        slug: String,
        name: String,
        tagline: String,
        category: String,
        installCount: Int,
        scanGrade: String? = nil
    ) {
        self.id = "\(creator)/\(slug)"
        self.creator = creator
        self.slug = slug
        self.name = name
        self.tagline = tagline
        self.category = category
        self.installCount = installCount
        self.scanGrade = scanGrade
    }
    public func matches(_ q: String) -> Bool {
        if q.isEmpty { return true }
        let lower = q.lowercased()
        return name.lowercased().contains(lower) ||
            tagline.lowercased().contains(lower) ||
            category.lowercased().contains(lower)
    }
}

public struct ListingDetail {
    public let name: String
    public let creator: String
    public let slug: String
    public let description: String
    public init(name: String, creator: String, slug: String, description: String) {
        self.name = name
        self.creator = creator
        self.slug = slug
        self.description = description
    }
}
