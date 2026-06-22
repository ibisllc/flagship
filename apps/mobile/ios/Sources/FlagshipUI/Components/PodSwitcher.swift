import SwiftUI
import FlagshipCore

/// Compact dropdown for switching / filtering the active pod context. Shown in
/// per-pod-scoped surfaces (Apps, Activity, ServerDetail-driven views) when the
/// user owns more than one pod. Tap → a panel of pods with the leader marked by
/// a small flag; the currently-selected row carries a teal background.
///
/// V8 — Apps-tab variant. When `allLabel` is set, the panel prepends an
/// "All <thing>" entry that maps to `currentPodId == nil`, and tapping it fires
/// `onPickAll`. Used where the switcher doubles as a filter: "All servers" =
/// every app the user owns regardless of which pod it runs on.
///
/// This is a CUSTOM in-hierarchy dropdown rather than a system `Menu` on
/// purpose: a system menu presents in its own UIKit window that floats ABOVE
/// the app's view tree — including the biometric lock overlay — so an open menu
/// leaked server names over the Face-ID cover. Rendering the panel as an
/// overlay inside the normal view hierarchy means `RootShell`'s lock screen
/// (zIndex 10) covers it, and `scenePhase` closes it on background for good
/// measure. It also lets us paint the teal selection background + the flag,
/// which a system menu can't.
///
/// NOTE (maintainer): the panel is an overlay anchored to the trigger. The
/// trigger currently lives in a navigation-bar `ToolbarItem` at both call
/// sites; if the panel is visually clipped by the nav bar on device, move the
/// `PodSwitcher` out of `.toolbar` into the inline content area (one-line move
/// at the call site) — the component itself needs no change.
public struct PodSwitcher: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var open = false

    let pods: [PodInfo]
    let currentPodId: String?
    let leaderPodId: String?
    let onPick: (PodInfo) -> Void
    let allLabel: String?
    let onPickAll: (() -> Void)?

    public init(
        pods: [PodInfo],
        currentPodId: String?,
        leaderPodId: String?,
        onPick: @escaping (PodInfo) -> Void,
        allLabel: String? = nil,
        onPickAll: (() -> Void)? = nil
    ) {
        self.pods = pods
        self.currentPodId = currentPodId
        self.leaderPodId = leaderPodId
        self.onPick = onPick
        self.allLabel = allLabel
        self.onPickAll = onPickAll
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        trigger(c)
            // Presented as a POPOVER — NOT a nav-bar-clipped in-hierarchy overlay
            // (which rendered into nothing when the trigger sits in a ToolbarItem)
            // and NOT a system `Menu` (which floats in its own window over the
            // biometric-lock cover). A popover anchors to the trigger even inside
            // a navigation-bar ToolbarItem, so the switcher keeps its place
            // top-right ABOVE the large title while the panel actually appears.
            // `.presentationCompactAdaptation(.popover)` keeps it a downward
            // popover on iPhone instead of a half-sheet. We still force it closed
            // on background (scenePhase) so an open list of server names can't
            // linger over the lock cover.
            .popover(isPresented: $open, arrowEdge: .top) {
                panel(c)
                    .presentationCompactAdaptation(.popover)
            }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { open = false }
            }
    }

    private func trigger(_ c: FSColors) -> some View {
        Button {
            open.toggle()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "server.rack")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(c.textMuted)
                Text(currentName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(c.text)
                if currentPodId == leaderPodId && currentPodId != nil {
                    LeaderFlag(size: 12, tint: c.primary)
                }
                Image(systemName: open ? "chevron.up" : "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(c.textMuted)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(c.surface)
            .overlay(
                RoundedRectangle(cornerRadius: FS.radius.pill)
                    .stroke(c.border, lineWidth: 1)
            )
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("pod-switcher")
    }

    private func panel(_ c: FSColors) -> some View {
        VStack(spacing: 0) {
            if let allLabel, let onPickAll {
                row(label: allLabel, isLeader: false, isSelected: currentPodId == nil, c: c) {
                    onPickAll()
                    open = false
                }
                Divider().background(c.border)
            }
            ForEach(Array(pods.enumerated()), id: \.element.id) { idx, pod in
                row(
                    label: pod.name,
                    isLeader: pod.podId == leaderPodId,
                    isSelected: pod.podId == currentPodId,
                    c: c
                ) {
                    onPick(pod)
                    open = false
                }
                if idx < pods.count - 1 {
                    Divider().background(c.border.opacity(0.5))
                }
            }
        }
        .frame(width: 230, alignment: .leading)
        .background(c.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(c.border, lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.18), radius: 12, x: 0, y: 6)
        .accessibilityIdentifier("pod-switcher-menu")
    }

    private func row(
        label: String,
        isLeader: Bool,
        isSelected: Bool,
        c: FSColors,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(label)
                    .font(.system(size: 14, weight: isSelected ? .semibold : .regular))
                    .foregroundColor(c.text)
                if isLeader {
                    LeaderFlag(size: 13, tint: c.primary)
                }
                Spacer(minLength: 8)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            // Selection is shown ONLY by the teal background (no checkmark) so
            // it never reads as the leader marker.
            .background(isSelected ? c.primary.opacity(0.16) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var currentName: String {
        if currentPodId == nil, let allLabel { return allLabel }
        return pods.first(where: { $0.podId == currentPodId })?.name ?? "—"
    }
}
