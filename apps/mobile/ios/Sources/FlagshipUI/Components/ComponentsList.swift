import SwiftUI

/// WhatsApp-inspired list/settings/chip primitives, built entirely on FS
/// tokens (`/docs/design-system.md`). These compose the three hero screens
/// (Home / Apps / Settings) into a single calm, grouped-card language:
///
/// - FSChipRow / FSChip          — horizontal scrollable filter pills
/// - FSSearchField               — rounded search field (magnifier + clear)
/// - FSProfileCard               — account hero (monogram + tier + chevron)
/// - FSAnnouncementCard          — dismissible teal-tinted nudge card
/// - FSSettingsGroup / FSSettingsRow — grouped rounded settings sections
/// - FSListRow                   — clean list row (status icon + title + meta)
///
/// All are presentation-only: they take data + callbacks and never reach for
/// app state. Selected = teal-filled; everything else lives on the warm-
/// neutral axis with one accent hue per surface.

// MARK: - Chips

/// A single filter pill. Selected → teal-filled with on-accent text;
/// unselected → subtle surface with a hairline border. Tap selects.
public struct FSChip: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let selected: Bool
    /// Optional leading count badge ("3") shown muted when unselected.
    let count: Int?
    let action: () -> Void

    public init(_ label: String, selected: Bool, count: Int? = nil, action: @escaping () -> Void) {
        self.label = label
        self.selected = selected
        self.count = count
        self.action = action
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        Button(action: action) {
            HStack(spacing: 6) {
                Text(label)
                    .font(.system(size: 14, weight: .semibold))
                if let count {
                    Text("\(count)")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(selected ? .white.opacity(0.9) : c.textMuted)
                }
            }
            .foregroundColor(selected ? .white : c.text)
            .padding(.horizontal, FS.space.s4)
            .frame(height: 34)
            .background(selected ? c.primary : c.surface)
            .overlay(
                Capsule().stroke(selected ? Color.clear : c.border, lineWidth: 1)
            )
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .animation(.easeOut(duration: 0.2), value: selected)
    }
}

/// A horizontal, scrollable row of `FSChip` filter pills. Generic over a
/// `Hashable` value so callers can drive it with an enum. `selection` is a
/// binding; tapping a chip sets it.
public struct FSChipRow<Value: Hashable>: View {
    public struct Item: Identifiable {
        public let value: Value
        public let label: String
        public let count: Int?
        public var id: AnyHashable { AnyHashable(value) }
        public init(value: Value, label: String, count: Int? = nil) {
            self.value = value
            self.label = label
            self.count = count
        }
    }

    let items: [Item]
    @Binding var selection: Value

    public init(items: [Item], selection: Binding<Value>) {
        self.items = items
        self._selection = selection
    }

    public var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: FS.space.s2) {
                ForEach(items) { item in
                    FSChip(item.label, selected: item.value == selection, count: item.count) {
                        selection = item.value
                    }
                    .accessibilityIdentifier("fs-chip-\(item.label.lowercased())")
                }
            }
            .padding(.horizontal, 1) // keep the first/last chip's border crisp
            .padding(.vertical, 2)
        }
    }
}

// MARK: - Search

/// A rounded search field: magnifier glyph + placeholder + a clear ("x")
/// button that appears once there's text. Use on screens where the native
/// `.searchable` large-title collapse doesn't fit (or where the screen
/// isn't a NavigationStack); prefer native `.searchable` otherwise.
public struct FSSearchField: View {
    @Environment(\.colorScheme) private var scheme
    @Binding var text: String
    var placeholder: String = "Search"

    public init(text: Binding<String>, placeholder: String = "Search") {
        self._text = text
        self.placeholder = placeholder
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        HStack(spacing: FS.space.s2) {
            Image(systemName: "magnifyingglass")
                .foregroundColor(c.textMuted)
                .font(.system(size: 15, weight: .medium))
            TextField(placeholder, text: $text)
                .font(FS.font.body())
                .foregroundColor(c.text)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            if !text.isEmpty {
                Button { text = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(c.textMuted)
                        .font(.system(size: 15))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 40)
        .background(c.surfaceSunken)
        .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
        .accessibilityIdentifier("fs-search-field")
    }
}

// MARK: - Monogram

/// A circular teal monogram avatar — the initials of a name on a soft-teal
/// fill. Used by FSProfileCard and any row that wants an account/person
/// glyph instead of a status icon.
public struct FSMonogram: View {
    @Environment(\.colorScheme) private var scheme
    let name: String
    var size: CGFloat = 52

    public init(name: String, size: CGFloat = 52) {
        self.name = name
        self.size = size
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        Circle()
            .fill(c.softTint())
            .frame(width: size, height: size)
            .overlay(
                Text(fsInitials(name))
                    .font(.system(size: size * 0.40, weight: .semibold))
                    .foregroundColor(c.primary)
            )
    }
}

// MARK: - Profile hero

/// A prominent account hero card: a teal monogram, the username (bold), a
/// subtitle (tier / status), and a trailing chevron. Tappable.
public struct FSProfileCard: View {
    @Environment(\.colorScheme) private var scheme
    let name: String
    let subtitle: String
    var action: () -> Void = {}

    public init(name: String, subtitle: String, action: @escaping () -> Void = {}) {
        self.name = name
        self.subtitle = subtitle
        self.action = action
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        Button(action: action) {
            HStack(spacing: FS.space.s4) {
                FSMonogram(name: name)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name.isEmpty ? "Your account" : name)
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundColor(c.text)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text(subtitle)
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: FS.space.s2)
                Image(systemName: "chevron.right").foregroundColor(c.textMuted)
            }
            .padding(FS.space.s4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(c.surface)
            .overlay(
                RoundedRectangle(cornerRadius: FS.radius.lg).stroke(c.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.lg))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("fs-profile-card")
    }
}

// MARK: - Announcement

/// A dismissible, teal-tinted rounded card: a leading icon, a title, a body,
/// an optional CTA button, and an "x" to dismiss. Replaces a stack of
/// home nudges/banners with one clean card — when several nudges are active
/// the caller shows the single highest-priority one. The `tint` lets a
/// danger-class announcement (account reset) reuse the same shape in red.
public struct FSAnnouncementCard: View {
    @Environment(\.colorScheme) private var scheme
    let icon: String
    let title: String
    let message: String
    let ctaLabel: String?
    let onCta: () -> Void
    let onDismiss: (() -> Void)?
    /// Accent for the icon + CTA + tinted fill. Pass `nil` to use the brand
    /// primary (teal); pass a semantic color for danger/warning variants.
    var tint: Color?

    public init(
        icon: String,
        title: String,
        message: String,
        ctaLabel: String? = nil,
        tint: Color? = nil,
        onCta: @escaping () -> Void = {},
        onDismiss: (() -> Void)? = nil
    ) {
        self.icon = icon
        self.title = title
        self.message = message
        self.ctaLabel = ctaLabel
        self.tint = tint
        self.onCta = onCta
        self.onDismiss = onDismiss
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        let accent = tint ?? c.primary
        VStack(alignment: .leading, spacing: FS.space.s3) {
            HStack(alignment: .top, spacing: FS.space.s3) {
                ZStack {
                    RoundedRectangle(cornerRadius: FS.radius.sm).fill(accent.opacity(0.16))
                    Image(systemName: icon)
                        .foregroundColor(accent)
                        .font(.system(size: 17, weight: .semibold))
                }
                .frame(width: 36, height: 36)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(c.text)
                    Text(message)
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                if let onDismiss {
                    Button(action: onDismiss) {
                        Image(systemName: "xmark")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(c.textMuted)
                            .padding(6)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss")
                    .accessibilityIdentifier("fs-announcement-dismiss")
                }
            }
            if let ctaLabel {
                Button(action: onCta) {
                    Text(ctaLabel)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 20)
                        .frame(height: 40)
                        .background(accent)
                        .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("fs-announcement-cta")
            }
        }
        .padding(FS.space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(accent.opacity(0.06))
        .overlay(
            RoundedRectangle(cornerRadius: FS.radius.lg).stroke(accent.opacity(0.22), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: FS.radius.lg))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fs-announcement-card")
    }
}

// MARK: - Settings group + row

/// A grouped, rounded settings section (WhatsApp look): an optional small-
/// caps header label, then the rows stitched into one rounded card with
/// hairline separators between them, inset to clear the leading icon.
///
/// Pass an array of `FSSettingsRow` via `rows:` to get automatic per-row
/// dividers; that's the common case. A generic-content initializer also
/// exists for one-off custom content (no auto-dividers).
public struct FSSettingsGroup<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    let header: String?
    @ViewBuilder let content: () -> Content

    public init(_ header: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.header = header
        self.content = content
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s2) {
            if let header {
                Text(header)
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(1)
                    .foregroundColor(c.textMuted)
                    .padding(.leading, FS.space.s1)
            }
            VStack(spacing: 0) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(c.surface)
            .overlay(
                RoundedRectangle(cornerRadius: FS.radius.lg).stroke(c.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.lg))
        }
    }
}

public extension FSSettingsGroup where Content == _FSRowStack {
    /// Build a group from an array of rows, interleaving an inset hairline
    /// divider between each. The leading inset (60pt) clears the icon square
    /// so the dividers align under the text, matching the iOS Settings look.
    init(_ header: String? = nil, rows: [FSSettingsRow]) {
        self.header = header
        self.content = { _FSRowStack(rows: rows) }
    }
}

/// Internal: stacks settings rows with an inset divider between each.
public struct _FSRowStack: View {
    @Environment(\.colorScheme) private var scheme
    let rows: [FSSettingsRow]
    public var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { idx, row in
                row
                if idx < rows.count - 1 {
                    Rectangle()
                        .fill(c.border)
                        .frame(height: 1)
                        .padding(.leading, 60)
                }
            }
        }
    }
}

/// One settings row: a leading icon inside a soft-tinted rounded square, a
/// label, an optional trailing value or numeric badge, and a chevron. Full-
/// width tappable. The whole row sits inside an `FSSettingsGroup`.
public struct FSSettingsRow: View {
    @Environment(\.colorScheme) private var scheme
    let icon: String
    /// Tint of the leading icon square. Defaults to the brand teal; pass a
    /// semantic color (success/danger) for status-bearing rows.
    var iconTint: Color?
    let title: String
    var subtitle: String?
    var value: String?
    var badge: Int?
    /// When false the chevron is hidden (a row that toggles in place / is a
    /// value display, not a drill-down).
    var showsChevron: Bool
    let action: () -> Void

    public init(
        icon: String,
        iconTint: Color? = nil,
        title: String,
        subtitle: String? = nil,
        value: String? = nil,
        badge: Int? = nil,
        showsChevron: Bool = true,
        action: @escaping () -> Void = {}
    ) {
        self.icon = icon
        self.iconTint = iconTint
        self.title = title
        self.subtitle = subtitle
        self.value = value
        self.badge = badge
        self.showsChevron = showsChevron
        self.action = action
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        let tint = iconTint ?? c.primary
        Button(action: action) {
            HStack(spacing: FS.space.s3) {
                ZStack {
                    RoundedRectangle(cornerRadius: FS.radius.sm).fill(tint.opacity(0.14))
                    Image(systemName: icon)
                        .foregroundColor(tint)
                        .font(.system(size: 15, weight: .semibold))
                }
                .frame(width: 30, height: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.system(size: 16))
                        .foregroundColor(c.text)
                        .lineLimit(1)
                    if let subtitle {
                        Text(subtitle)
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: FS.space.s2)
                if let value {
                    Text(value)
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if let badge, badge > 0 {
                    Text("\(badge)")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(c.danger)
                        .clipShape(Capsule())
                }
                if showsChevron {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(c.textMuted.opacity(0.7))
                }
            }
            .padding(.horizontal, FS.space.s4)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Clean list row

/// A clean, full-width tappable list row: a leading status-tinted rounded-
/// square icon (or a monogram), a bold title, a muted subtitle, and trailing
/// metadata (a timestamp string, an `FSPill` status, or a small badge). Used
/// for servers (Home) and apps (Services).
public struct FSListRow<Trailing: View>: View {
    @Environment(\.colorScheme) private var scheme
    let leading: Leading
    let title: String
    var subtitle: String?
    /// Optional second muted line below the subtitle (e.g. a canonical URL).
    var detail: String?
    @ViewBuilder let trailing: () -> Trailing

    public enum Leading {
        /// SF Symbol on a soft tint of `color`.
        case icon(String, color: Color)
        /// A monogram derived from the given name.
        case monogram(String)
    }

    public init(
        leading: Leading,
        title: String,
        subtitle: String? = nil,
        detail: String? = nil,
        @ViewBuilder trailing: @escaping () -> Trailing
    ) {
        self.leading = leading
        self.title = title
        self.subtitle = subtitle
        self.detail = detail
        self.trailing = trailing
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        HStack(alignment: .center, spacing: FS.space.s3) {
            leadingView(c: c)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(c.text)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundColor(c.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: FS.space.s2)
            trailing()
        }
        .padding(FS.space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(c.surface)
        .overlay(
            RoundedRectangle(cornerRadius: FS.radius.md).stroke(c.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func leadingView(c: FSColors) -> some View {
        switch leading {
        case .icon(let symbol, let color):
            ZStack {
                RoundedRectangle(cornerRadius: FS.radius.sm).fill(color.opacity(0.14))
                Image(systemName: symbol)
                    .foregroundColor(color)
                    .font(.system(size: 17, weight: .semibold))
            }
            .frame(width: 42, height: 42)
        case .monogram(let name):
            FSMonogram(name: name, size: 42)
        }
    }
}

public extension FSListRow where Trailing == EmptyView {
    /// Convenience for a row with no trailing accessory (a plain chevron is
    /// added by the caller if wanted).
    init(leading: Leading, title: String, subtitle: String? = nil, detail: String? = nil) {
        self.init(leading: leading, title: title, subtitle: subtitle, detail: detail) {
            EmptyView()
        }
    }
}

