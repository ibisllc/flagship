import SwiftUI

/// SwiftUI primitives mirroring the Compose `Components.kt` set.
///
/// - FSPrimaryButton / FSSecondaryButton / FSGhostButton / FSDangerButton
/// - FSCard
/// - FSField
/// - FSPill (FSPillKind)
/// - FSStack helpers via `VStack(spacing: FS.space.s4)`

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
                .font(.system(size: large ? 16 : 14, weight: .semibold))
                .frame(maxWidth: block ? .infinity : nil)
                .frame(minHeight: large ? 48 : 44)
                .padding(.horizontal, large ? FS.space.s6 : FS.space.s5)
                .background(c.primary.opacity(enabled ? 1 : 0.4))
                .foregroundColor(.white)
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
        }
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
                .font(.system(size: large ? 16 : 14, weight: .semibold))
                .frame(maxWidth: block ? .infinity : nil)
                .frame(minHeight: large ? 48 : 44)
                .padding(.horizontal, large ? FS.space.s6 : FS.space.s5)
                .background(c.surface)
                .foregroundColor(c.text)
                .overlay(
                    RoundedRectangle(cornerRadius: FS.radius.md)
                        .stroke(c.border, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
        }
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
                .font(.system(size: large ? 16 : 14, weight: .semibold))
                .frame(maxWidth: block ? .infinity : nil)
                .frame(minHeight: large ? 48 : 44)
                .padding(.horizontal, large ? FS.space.s6 : FS.space.s5)
                .foregroundColor(c.text)
        }
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
                .font(.system(size: large ? 16 : 14, weight: .semibold))
                .frame(maxWidth: block ? .infinity : nil)
                .frame(minHeight: large ? 48 : 44)
                .padding(.horizontal, large ? FS.space.s6 : FS.space.s5)
                .foregroundColor(fg)
                .overlay(
                    RoundedRectangle(cornerRadius: FS.radius.md)
                        .stroke(fg, lineWidth: 1)
                )
        }
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
                RoundedRectangle(cornerRadius: FS.radius.md)
                    .stroke(c.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
    }
}

public struct FSField: View {
    @Environment(\.colorScheme) private var scheme
    @Binding var value: String
    let label: String
    var placeholder: String = ""
    var helper: String? = nil
    var error: String? = nil
    var secure: Bool = false
    var keyboard: UIKeyboardType = .default

    public init(value: Binding<String>, label: String, placeholder: String = "", helper: String? = nil, error: String? = nil, secure: Bool = false, keyboard: UIKeyboardType = .default) {
        self._value = value
        self.label = label
        self.placeholder = placeholder
        self.helper = helper
        self.error = error
        self.secure = secure
        self.keyboard = keyboard
    }
    public var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text(label).font(FS.font.caption()).foregroundColor(c.text)
            Group {
                if secure {
                    SecureField(placeholder, text: $value)
                } else {
                    TextField(placeholder, text: $value)
                        .keyboardType(keyboard)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
            }
            .font(FS.font.body())
            .padding(.horizontal, 14)
            .frame(height: 40)
            .background(c.surfaceSunken)
            .overlay(
                RoundedRectangle(cornerRadius: FS.radius.sm)
                    .stroke(error != nil ? c.danger : c.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))

            if let sub = error ?? helper {
                Text(sub)
                    .font(FS.font.bodySm())
                    .foregroundColor(error != nil ? c.danger : c.textMuted)
            }
        }
    }
}

public enum FSPillKind { case online, renewing, offline, provisioning, pending, idle }

public struct FSPill: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let kind: FSPillKind
    public init(_ label: String, kind: FSPillKind) { self.label = label; self.kind = kind }
    public var body: some View {
        let c = FSColors.scheme(scheme)
        let (fg, bg) = colors(c, kind)
        HStack(spacing: 6) {
            Circle().fill(fg).frame(width: 6, height: 6)
            Text(label).font(FS.font.caption()).foregroundColor(fg)
        }
        .padding(.horizontal, 10).padding(.vertical, 2)
        .frame(minHeight: 22)
        .background(bg)
        .clipShape(Capsule())
    }
    private func colors(_ c: FSColors, _ k: FSPillKind) -> (Color, Color) {
        switch k {
        case .online:       return (c.success, c.success.opacity(0.12))
        case .renewing:     return (c.warning, c.warning.opacity(0.12))
        case .offline:      return (c.danger, c.danger.opacity(0.12))
        case .provisioning: return (c.primary, c.primary.opacity(0.12))
        case .pending:      return (c.warning, c.warning.opacity(0.12))
        case .idle:         return (c.textMuted, c.surfaceSunken)
        }
    }
}
