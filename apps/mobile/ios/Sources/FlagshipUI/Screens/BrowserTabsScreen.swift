import SwiftUI
import FlagshipAPI

/// P8 — lists the daemon's open Chromium tabs for a given serviceId and
/// lets the user pick one to stream. Mirrors webapp's `renderTabs()` in
/// views/browser-viewer.js.
public struct BrowserTabsScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: BrowserTabsViewModel
    let onPick: (BrowserTab) -> Void

    public init(vm: BrowserTabsViewModel, onPick: @escaping (BrowserTab) -> Void) {
        self.vm = vm
        self.onPick = onPick
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Open tabs")
                    .font(.system(size: 28, weight: .medium))
                    .foregroundColor(c.text)
                Text("Pick a tab to stream. Touches are forwarded to the headless browser.")
                    .font(.system(size: 14))
                    .foregroundColor(c.textMuted)
                switch vm.state {
                case .idle, .loading:
                    ServerCardSkeleton()
                case .failed(let msg):
                    ErrorCard(message: msg)
                case .loaded(let tabs):
                    if tabs.isEmpty {
                        FSCard {
                            Text("No tabs open for this service.")
                                .foregroundColor(c.textMuted)
                        }
                    } else {
                        VStack(spacing: FS.space.s3) {
                            ForEach(tabs, id: \.tabId) { tab in
                                Button(action: { onPick(tab) }) {
                                    tabRow(tab: tab, c: c)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Tabs")
        .navigationBarTitleDisplayMode(.inline)
        .task { if case .idle = vm.state { await vm.load() } }
        .refreshable { await vm.load() }
    }

    private func tabRow(tab: BrowserTab, c: FSColors) -> some View {
        FSCard {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(tab.title ?? tab.tabId)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(c.text)
                    if let url = tab.currentUrl {
                        Text(url)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundColor(c.textMuted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer()
                Image(systemName: "play.circle.fill").foregroundColor(c.primary)
            }
        }
    }
}
