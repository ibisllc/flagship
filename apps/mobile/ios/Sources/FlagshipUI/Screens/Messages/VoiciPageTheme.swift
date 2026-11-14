import SwiftUI

/// The voi.ci page's colours (apps/voici-site/src/style.css), so the Social tab shows the page as visitors see it.
/// `classic` and `sea` follow the light/dark setting like the site; `ink` is always dark.
struct VoiciPageTheme {
    let canvas: Color
    let surface: Color
    let ink: Color
    let inkSoft: Color
    let muted: Color
    let rule: Color
    let ruleStrong: Color
    let fill: Color
    let onFill: Color
    let link: Color
    let graphic: Color
    let fillSoft: Color
    let err: Color
    /// The scheme the page itself is drawn in (ink is dark even on a light phone).
    let scheme: ColorScheme

    static let ids = ["classic", "ink", "sea"]

    static func label(_ id: String) -> String {
        switch id {
        case "ink": return String(localized: "Ink")
        case "sea": return String(localized: "Sea")
        default: return String(localized: "Classic")
        }
    }

    static func of(_ id: String, _ scheme: ColorScheme) -> VoiciPageTheme {
        let h = FSColors.hex
        switch (id, scheme) {
        case ("ink", _):
            return .init(canvas: h(0x0a0a09), surface: h(0x171612), ink: h(0xece7d6), inkSoft: h(0xc8c2b0), muted: h(0xa39d8f),
                         rule: h(0x26241d), ruleStrong: h(0x3a372f), fill: h(0xece7d6), onFill: h(0x0a0a09), link: h(0x2dd4bf),
                         graphic: h(0x2dd4bf), fillSoft: h(0xece7d6).opacity(0.08), err: h(0xf87171), scheme: .dark)
        case ("sea", .dark):
            return .init(canvas: h(0x061015), surface: h(0x0f2028), ink: h(0xe2eef2), inkSoft: h(0xc3d3d9), muted: h(0x8fa6ae),
                         rule: h(0x1a2e36), ruleStrong: h(0x2a434d), fill: h(0x38bdf8), onFill: h(0x06141a), link: h(0x7dd3fc),
                         graphic: h(0x38bdf8), fillSoft: h(0x38bdf8).opacity(0.13), err: h(0xf87171), scheme: .dark)
        case ("sea", _):
            return .init(canvas: h(0xf3f6f7), surface: h(0xffffff), ink: h(0x0e1a1f), inkSoft: h(0x23343b), muted: h(0x4c5f67),
                         rule: h(0xdce5e8), ruleStrong: h(0xb9c8ce), fill: h(0x38bdf8), onFill: h(0x06141a), link: h(0x0369a1),
                         graphic: h(0x0ea5e9), fillSoft: h(0x0ea5e9).opacity(0.12), err: h(0xb91c1c), scheme: .light)
        case (_, .dark):
            return .init(canvas: h(0x0a0a09), surface: h(0x161512), ink: h(0xece7d6), inkSoft: h(0xc8c2b0), muted: h(0xa39d8f),
                         rule: h(0x25231c), ruleStrong: h(0x3a372f), fill: h(0x14b8a6), onFill: h(0x0a0a09), link: h(0x2dd4bf),
                         graphic: h(0x2dd4bf), fillSoft: h(0x2dd4bf).opacity(0.13), err: h(0xf87171), scheme: .dark)
        default:
            return .init(canvas: h(0xf7f6f2), surface: h(0xffffff), ink: h(0x14140f), inkSoft: h(0x2a2924), muted: h(0x555149),
                         rule: h(0xe5e3dc), ruleStrong: h(0xc8c5bb), fill: h(0x14b8a6), onFill: h(0x0a0a09), link: h(0x0f766e),
                         graphic: h(0x14b8a6), fillSoft: h(0x14b8a6).opacity(0.12), err: h(0xb91c1c), scheme: .light)
        }
    }
}
