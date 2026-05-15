import SwiftUI
import FlagshipCore

/// Compact menu/picker for switching the active pod context. Shown in
/// per-pod-scoped surfaces (Apps, Activity, ServerDetail-driven views)
/// when the user owns more than one pod. Tap → menu of pods with the
/// leader marked.
///
/// V8 — Apps-tab variant. When `allLabel` is set, the menu prepends an
/// "All <thing>" entry that maps to `currentPodId == nil`, and tapping
/// it fires `onPickAll`. Used on the Apps page where the switcher
/// doubles as a filter: "All servers" = show every app the user owns
/// regardless of which pod it runs on. Other call sites pass nil and
/// keep the original single-select behavior.
public struct PodSwitcher: View {
    @Environment(\.colorScheme) private var scheme
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
        Menu {
            if let allLabel, let onPickAll {
                Button {
                    onPickAll()
                } label: {
                    HStack {
                        Text(allLabel)
                        Spacer()
                        if currentPodId == nil {
                            Image(systemName: "checkmark")
                        }
                    }
                }
                Divider()
            }
            ForEach(pods) { pod in
                Button {
                    onPick(pod)
                } label: {
                    HStack {
                        Text(pod.name)
                        if pod.podId == leaderPodId {
                            Image(systemName: "crown.fill")
                        }
                        Spacer()
                        if pod.podId == currentPodId {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "server.rack")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(c.textMuted)
                Text(currentName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(c.text)
                if currentPodId == leaderPodId && currentPodId != nil {
                    Image(systemName: "crown.fill")
                        .font(.system(size: 10))
                        .foregroundColor(c.primary)
                }
                Image(systemName: "chevron.down")
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
    }

    private var currentName: String {
        if currentPodId == nil, let allLabel { return allLabel }
        return pods.first(where: { $0.podId == currentPodId })?.name ?? "—"
    }
}
