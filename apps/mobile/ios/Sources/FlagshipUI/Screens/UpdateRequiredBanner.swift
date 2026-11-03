import SwiftUI
import FlagshipAPI

/// "This server needs an update" (owner decision 2026-11-02): the box runs a
/// release from before the one `.com` needs (`/pods` `updateRequired`, a 0.2
/// box under 0.3). Its certificate can't renew, so it goes dark when the one
/// it holds runs out. The update itself is the page's "Software update" card,
/// which the page moves right under this banner.
struct UpdateRequiredBanner: View {
    @Environment(\.colorScheme) private var scheme
    let view: UpdateRequiredWire

    /// The line under the title: when the certificate runs out, if `.com` knows.
    static func detail(_ view: UpdateRequiredWire, locale: Locale = .current) -> String {
        guard let ms = view.certificateExpiresAt, ms > 0 else {
            return String(localized: "Its certificate can't be renewed until it is updated.")
        }
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
            .formatted(Date.FormatStyle(date: .long, time: .omitted).locale(locale))
        return String(localized: "Its certificate can't be renewed and runs out on \(date). Update it before then.")
    }

    var body: some View {
        let c = FSColors.scheme(scheme)
        HStack(alignment: .top, spacing: FS.space.s2) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(c.warning)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: FS.space.s1) {
                Text("This server needs an update to keep working with Flagship 0.3")
                    .font(FS.font.bodySm().weight(.semibold))
                    .foregroundColor(c.text)
                    .fixedSize(horizontal: false, vertical: true)
                Text(Self.detail(view))
                    .font(FS.font.bodySm())
                    .foregroundColor(c.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sd-update-required-detail")
            }
            Spacer(minLength: 0)
        }
        .padding(FS.space.s3)
        .background(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous).fill(c.warningWash))
        .overlay(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous).stroke(c.warning.opacity(0.5), lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("sd-update-required")
    }
}
