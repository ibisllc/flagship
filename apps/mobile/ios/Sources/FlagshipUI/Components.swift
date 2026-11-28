import SwiftUI

/// SwiftUI primitives mirroring the Compose `Components.kt` set.
///
/// - FSPrimaryButton / FSSecondaryButton / FSGhostButton / FSDangerButton
/// - FSCard
/// - FSField
/// - FSPill (FSPillKind)
/// - FSStack helpers via `VStack(spacing: FS.space.s4)`

/// Press feedback for every Flagship button: a small, springy settle and a
/// dim, instead of the bare default highlight.
public struct FSPressStyle: ButtonStyle {
    var cornerRadius: CGFloat
    public init(cornerRadius: CGFloat = FS.radius.md) { self.cornerRadius = cornerRadius }
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.82 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
            .fsFocusRing(cornerRadius: cornerRadius)
    }
}

/// The hardware-keyboard focus indicator, the same on every surface (and the
/// web): a 2pt brand-teal ring with a 2pt ink (cream in dark) ring just inside
/// it, so the focus shows on teal fills, on paper and on dark.
public struct FSFocusRing: ViewModifier {
    @Environment(\.isFocused) private var isFocused
    @Environment(\.colorScheme) private var scheme
    var cornerRadius: CGFloat
    public func body(content: Content) -> some View {
        let c = FSColors.scheme(scheme)
        content
            .focusEffectDisabled()
            .overlay {
                if isFocused {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(c.accent, lineWidth: 2)
                        .overlay(
                            RoundedRectangle(cornerRadius: max(cornerRadius - 2, 0), style: .continuous)
                                .strokeBorder(c.text, lineWidth: 2)
                                .padding(2)
                        )
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
    }
}

public extension View {
    func fsFocusRing(cornerRadius: CGFloat = FS.radius.md) -> some View {
        modifier(FSFocusRing(cornerRadius: cornerRadius))
    }
}

public struct FSPrimaryButton: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let action: () -> Void
    var enabled: Bool = true
    var block: Bool = false
    var large: Bool = false

    public init(_ label: String, enabled: Bool = true, block: Bool = false, large: Bool = false, action: @escaping () -> Void) {
        self.label = label
        self.action = action
        self.enabled = enabled
        self.block = block
        self.large = large
    }
    public var body: some View {
        let c = FSColors.scheme(scheme)
        Button(action: action) {
            Text(label)
                .font(FS.font.scaled(large ? 17 : 16, weight: .semibold))
                .multilineTextAlignment(.center)
                .padding(.vertical, FS.space.s2)
                .frame(maxWidth: block ? .infinity : nil)
                .frame(minHeight: large ? 52 : 44)
                .padding(.horizontal, large ? FS.space.s6 : FS.space.s5)
                .background(c.primaryFill.opacity(enabled ? 1 : 0.4))
                .foregroundColor(c.onPrimary)
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
        }
        .buttonStyle(FSPressStyle())
        .disabled(!enabled)
        .animation(.easeOut(duration: 0.2), value: enabled)
    }
}

public struct FSSecondaryButton: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let action: () -> Void
    var block: Bool = false
    var large: Bool = false
    public init(_ label: String, block: Bool = false, large: Bool = false, action: @escaping () -> Void) {
        self.label = label; self.action = action; self.block = block; self.large = large
    }
    public var body: some View {
        let c = FSColors.scheme(scheme)
        Button(action: action) {
            Text(label)
                .font(FS.font.scaled(large ? 17 : 16, weight: .semibold))
                .multilineTextAlignment(.center)
                .padding(.vertical, FS.space.s2)
                .frame(maxWidth: block ? .infinity : nil)
                .frame(minHeight: large ? 52 : 44)
                .padding(.horizontal, large ? FS.space.s6 : FS.space.s5)
                .background(c.surface)
                .foregroundColor(c.text)
                .overlay(
                    RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous)
                        .stroke(c.border, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
        }
        .buttonStyle(FSPressStyle())
    }
}

public struct FSGhostButton: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let action: () -> Void
    var block: Bool = false
    var large: Bool = false
    public init(_ label: String, block: Bool = false, large: Bool = false, action: @escaping () -> Void) {
        self.label = label; self.action = action; self.block = block; self.large = large
    }
    public var body: some View {
        let c = FSColors.scheme(scheme)
        Button(action: action) {
            Text(label)
                .font(FS.font.scaled(large ? 17 : 16, weight: .semibold))
                .multilineTextAlignment(.center)
                .padding(.vertical, FS.space.s2)
                .frame(maxWidth: block ? .infinity : nil)
                .frame(minHeight: large ? 52 : 44)
                .padding(.horizontal, large ? FS.space.s6 : FS.space.s5)
                .foregroundColor(c.text)
        }
        .buttonStyle(FSPressStyle())
    }
}

public struct FSDangerButton: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let action: () -> Void
    /// Greys the button (muted foreground + border) while leaving it
    /// TAPPABLE — used for a recovery-gated action so a tap can surface a
    /// "set up recovery first" toast instead of running the destructive
    /// path. Distinct from a true `.disabled` (which would swallow taps).
    var muted: Bool = false
    var block: Bool = false
    var large: Bool = false
    public init(_ label: String, muted: Bool = false, block: Bool = false, large: Bool = false, action: @escaping () -> Void) {
        self.label = label; self.action = action; self.muted = muted; self.block = block; self.large = large
    }
    public var body: some View {
        let c = FSColors.scheme(scheme)
        let fg = muted ? c.textMuted : c.danger
        Button(action: action) {
            Text(label)
                .font(FS.font.scaled(large ? 17 : 16, weight: .semibold))
                .multilineTextAlignment(.center)
                .padding(.vertical, FS.space.s2)
                .frame(maxWidth: block ? .infinity : nil)
                .frame(minHeight: large ? 52 : 44)
                .padding(.horizontal, large ? FS.space.s6 : FS.space.s5)
                .foregroundColor(fg)
                .background(muted ? c.surfaceSunken : c.danger.opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
        }
        .buttonStyle(FSPressStyle())
    }
}

public struct FSCard<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    var padding: CGFloat = FS.space.s4
    @ViewBuilder var content: () -> Content
    public init(padding: CGFloat = FS.space.s4, @ViewBuilder content: @escaping () -> Content) {
        self.padding = padding; self.content = content
    }
    public var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) { content() }
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(c.surface)
            .overlay(
                RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous)
                    .stroke(c.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
    }
}

/// An account's public address, `voi.ci/<name>`: the prefix muted, the name in the text colour, always left to right.
/// When both don't fit on one line (large text, a narrow phone) the prefix sits above the name instead of truncating it.
public struct FSAccountAddress: View {
    @Environment(\.colorScheme) private var scheme
    let name: String
    var nameIdentifier: String

    public init(name: String, nameIdentifier: String = "account-address-name") {
        self.name = name
        self.nameIdentifier = nameIdentifier
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        // The gap is spacing, not a space: VoiceOver and anything copied read one address, voi.ci/<name>.
        let prefix = Text(verbatim: VoiciAddress.prefix).font(FS.font.h2()).foregroundStyle(c.textMuted)
            .accessibilityHidden(true)
        let handle = Text(verbatim: name).font(FS.font.h1()).foregroundColor(c.text)
            .accessibilityLabel(Text(verbatim: VoiciAddress.prefix + name))
            .accessibilityIdentifier(nameIdentifier)
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: FS.space.s2) { prefix; handle }
                .fixedSize(horizontal: true, vertical: false)
            VStack(spacing: FS.space.s1) {
                prefix
                handle.multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }
        }
        .environment(\.layoutDirection, .leftToRight)
    }
}

/// The account's public address on voi.ci. The prefix is a domain, never translated.
public enum VoiciAddress {
    public static let prefix = "voi.ci/"

    /// What the owner typed or pasted, without a leading `https://voi.ci/` (scheme optional, any case).
    public static func stripPrefix(_ typed: String) -> String {
        var rest = Substring(typed.drop(while: { $0.isWhitespace }))
        for scheme in ["https://", "http://"] where rest.lowercased().hasPrefix(scheme) {
            let after = rest.dropFirst(scheme.count)
            if after.lowercased().hasPrefix(prefix) { rest = after }
        }
        if rest.lowercased().hasPrefix(prefix) { return String(rest.dropFirst(prefix.count)) }
        return typed
    }
}

public struct FSField: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.layoutDirection) private var direction
    @Binding var value: String
    let label: String
    var placeholder: String = ""
    var helper: String? = nil
    var error: String? = nil
    var secure: Bool = false
    var keyboard: UIKeyboardType = .default
    /// Fixed text before the input (a URL prefix): shown, never edited, never part of the value.
    var prefix: String? = nil
    @FocusState private var ownFocus: Bool
    /// The screen's own focus state for the field (to close the keyboard on submit), or the field's.
    private var externalFocus: FocusState<Bool>.Binding?
    private var focus: FocusState<Bool>.Binding { externalFocus ?? $ownFocus }
    private var focused: Bool { focus.wrappedValue }

    public init(value: Binding<String>, label: String, placeholder: String = "", helper: String? = nil, error: String? = nil, secure: Bool = false, keyboard: UIKeyboardType = .default, prefix: String? = nil,
                focus: FocusState<Bool>.Binding? = nil) {
        self._value = value
        self.label = label
        self.placeholder = placeholder
        self.helper = helper
        self.error = error
        self.secure = secure
        self.keyboard = keyboard
        self.prefix = prefix
        self.externalFocus = focus
    }
    public var body: some View {
        let c = FSColors.scheme(scheme)
        // At accessibility sizes the prefix moves above the box, so the typed name keeps the whole width.
        let prefixAbove = prefix != nil && typeSize.isAccessibilitySize
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text(label).font(FS.font.scaled(13, weight: .medium)).foregroundColor(c.text)
            if prefixAbove, let prefix {
                Text(verbatim: prefix).font(.system(.body)).foregroundStyle(c.textMuted)
                    .environment(\.layoutDirection, .leftToRight)
                    .accessibilityHidden(true)
            }
            HStack(spacing: prefix != nil && !prefixAbove ? FS.space.s2 : 0) {
                if !prefixAbove, let prefix {
                    Text(verbatim: prefix).foregroundStyle(c.textMuted)
                        .fixedSize()
                        .accessibilityHidden(true)
                }
                if secure {
                    SecureField(placeholder, text: $value)
                        .focused(focus)
                } else {
                    TextField(placeholder, text: $value)
                        .keyboardType(keyboard)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .foregroundStyle(c.text)
                        .fontWeight(prefix != nil ? .medium : nil)
                        .focused(focus)
                }
            }
            .environment(\.layoutDirection, prefix != nil ? .leftToRight : direction)
            .font(.system(.body))
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(c.surfaceSunken)
            .overlay(
                RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous)
                    .stroke(error != nil ? c.danger : c.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous))
            .overlay {
                if focused {
                    RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous)
                        .strokeBorder(c.accent, lineWidth: 2)
                        .overlay(
                            RoundedRectangle(cornerRadius: FS.radius.sm - 2, style: .continuous)
                                .strokeBorder(c.text, lineWidth: 2).padding(2)
                        )
                        .allowsHitTesting(false)
                }
            }

            if let sub = error ?? helper {
                // Never cut short: a long sentence or a large text size takes the lines it needs.
                Text(sub)
                    .font(FS.font.bodySm())
                    .foregroundColor(error != nil ? c.danger : c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// One look for every text input: sunken fill, 8pt continuous corners, 44pt
/// minimum, and the shared focus ring while it has the keyboard.
public struct FSInputBox: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @FocusState private var focused: Bool
    public func body(content: Content) -> some View {
        let c = FSColors.scheme(scheme)
        let shape = RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous)
        content
            .focused($focused)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .background(c.surfaceSunken, in: shape)
            .overlay(shape.stroke(c.border, lineWidth: 1))
            .overlay {
                if focused {
                    shape.strokeBorder(c.accent, lineWidth: 2)
                        .overlay(RoundedRectangle(cornerRadius: FS.radius.sm - 2, style: .continuous)
                            .strokeBorder(c.text, lineWidth: 2).padding(2))
                        .allowsHitTesting(false)
                }
            }
    }
}

public extension View {
    func fsInputBox() -> some View { modifier(FSInputBox()) }
}

public enum FSPillKind { case online, renewing, offline, provisioning, pending, idle }

public struct FSPill: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let kind: FSPillKind
    /// An SF Symbol after the label, in gray (the services list's "2" and
    /// Home's server icon).
    let trailingIcon: String?
    public init(_ label: String, kind: FSPillKind, trailingIcon: String? = nil) {
        self.label = label; self.kind = kind; self.trailingIcon = trailingIcon
    }
    public var body: some View {
        let c = FSColors.scheme(scheme)
        let (fg, bg) = colors(c, kind)
        HStack(spacing: 6) {
            Circle().fill(kind == .provisioning ? c.accent : fg).frame(width: 6, height: 6)
            HStack(spacing: 3) {
                Text(label).font(FS.font.caption()).foregroundColor(kind == .provisioning ? c.text : fg)
                if let trailingIcon {
                    Image(systemName: trailingIcon)
                        .font(FS.font.scaled(10, weight: .semibold))
                        .foregroundColor(c.textMuted)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 3)
        .frame(minHeight: 24)
        .background(bg)
        .clipShape(Capsule())
    }
    private func colors(_ c: FSColors, _ k: FSPillKind) -> (Color, Color) {
        switch k {
        case .online:       return (c.success, c.successWash)
        case .renewing:     return (c.warning, c.warningWash)
        case .offline:      return (c.danger, c.dangerWash)
        case .provisioning: return (c.primary, c.primary.opacity(0.10))
        case .pending:      return (c.warning, c.warningWash)
        case .idle:         return (c.textMuted, c.surfaceSunken)
        }
    }
}
