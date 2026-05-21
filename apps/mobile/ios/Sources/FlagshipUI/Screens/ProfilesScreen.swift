import SwiftUI
import FlagshipCore

/// W3 — list of clouds (profiles) this phone is a member of. Tapping
/// a row switches the active profile; the rest of the UI re-renders
/// against the new cloud's session state. Empty list renders a
/// "no profiles yet" affordance pointing back at onboarding.
///
/// Phase F demo case is one profile per phone, so the typical user
/// sees a single row. Multi-profile is the v2 capability that lets
/// corporate / family setups co-exist.
public struct ProfilesScreen: View {
    @Environment(\.colorScheme) private var scheme

    public let profiles: [Profile]
    public let activeCloudName: String?
    public let onSelect: (String) -> Void
    public let onSetUpNew: () -> Void

    public init(
        profiles: [Profile],
        activeCloudName: String?,
        onSelect: @escaping (String) -> Void,
        onSetUpNew: @escaping () -> Void = {}
    ) {
        self.profiles = profiles
        self.activeCloudName = activeCloudName
        self.onSelect = onSelect
        self.onSetUpNew = onSetUpNew
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Text("Your clouds").font(FS.font.h2()).foregroundColor(c.text)
                Text("One phone, multiple clouds. Each profile is a separate cloud (personal, family, work) with its own root key.")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)

                if profiles.isEmpty {
                    FSCard(padding: FS.space.s6) {
                        VStack(alignment: .leading, spacing: FS.space.s3) {
                            Text("No profiles yet").font(FS.font.h3()).foregroundColor(c.text)
                            Text("Set one up to bind this phone to a cloud.")
                                .font(FS.font.body())
                                .foregroundColor(c.textMuted)
                            FSPrimaryButton("Set one up", action: onSetUpNew)
                        }
                    }
                } else {
                    VStack(spacing: FS.space.s3) {
                        ForEach(profiles, id: \.cloudName) { p in
                            row(p, c: c)
                        }
                    }
                }
            }
            .padding(FS.space.s6)
        }
        .navigationTitle("Profiles")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ profile: Profile, c: FSColors) -> some View {
        let isActive = profile.cloudName == activeCloudName
        return Button(action: { onSelect(profile.cloudName) }) {
            HStack(alignment: .center, spacing: FS.space.s3) {
                VStack(alignment: .leading, spacing: FS.space.s1) {
                    Text(profile.cloudName)
                        .font(FS.font.body())
                        .foregroundColor(c.text)
                    if let label = profile.deviceLabel {
                        Text("Device: \(label)")
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
                    }
                }
                Spacer()
                if isActive {
                    Text("ACTIVE")
                        .font(FS.font.caption())
                        .foregroundColor(c.primary)
                }
            }
            .padding(FS.space.s4)
            .background(c.surface)
            .cornerRadius(12)
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(isActive ? c.primary : c.border, lineWidth: isActive ? 2 : 1)
            )
        }
        .buttonStyle(.plain)
    }
}
