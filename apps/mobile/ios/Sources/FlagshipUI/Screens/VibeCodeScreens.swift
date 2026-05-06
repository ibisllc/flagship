import SwiftUI

/// D.6.1 — VibeCodeProviderPickScreen.
public struct VibeCodeProviderPickScreen: View {
    var promoUsed: Int = 12
    var promoCap: Int = 50
    var onPickPromo: () -> Void = {}
    var onPickBYOK: () -> Void = {}
    public init(
        promoUsed: Int = 12,
        promoCap: Int = 50,
        onPickPromo: @escaping () -> Void = {},
        onPickBYOK: @escaping () -> Void = {}
    ) {
        self.promoUsed = promoUsed
        self.promoCap = promoCap
        self.onPickPromo = onPickPromo
        self.onPickBYOK = onPickBYOK
    }
    public var body: some View {
        FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s6) {
                    Spacer().frame(height: FS.space.s12)
                    Text("How would you like to build it?").font(FS.font.h2())
                    FSColorReader { c in
                        Text("Pick the AI that writes the code. You can change this any time.")
                            .font(FS.font.body())
                            .foregroundColor(c.textMuted)
                    }

                    FSCard(padding: FS.space.s6) {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: FS.space.s2) {
                                Text("Use Flagship's credits").font(FS.font.h3())
                                FSColorReader { c in
                                    Text("50 free calls a day · 200 lifetime · we cover the API bill.")
                                        .font(.system(size: 14)).foregroundColor(c.textMuted)
                                }
                            }
                            Spacer()
                            PromoBadge(used: promoUsed, cap: promoCap)
                        }
                        FSColorReader { c in
                            Text("Honest note: your prompts go directly to Anthropic, not through us.")
                                .font(.system(size: 13)).foregroundColor(c.textMuted)
                        }
                        FSPrimaryButton("Use the promo →", block: true, action: onPickPromo)
                    }

                    FSCard(padding: FS.space.s6) {
                        Text("Bring your own key").font(FS.font.h3())
                        FSColorReader { c in
                            Text("Anthropic, OpenAI, or Google. No daily limits. Your key, your bill, your choice of model.")
                                .font(.system(size: 14)).foregroundColor(c.textMuted)
                        }
                        FSSecondaryButton("Set up a key", block: true, action: onPickBYOK)
                    }
                    Spacer().frame(height: FS.space.s8)
                }
                .padding(.horizontal, FS.space.s6)
            }
        }
    }
}

private struct PromoBadge: View {
    @Environment(\.colorScheme) private var scheme
    let used: Int
    let cap: Int
    var body: some View {
        let c = FSColors.scheme(scheme)
        Text("\(used) / \(cap) today")
            .font(.system(size: 13, weight: .medium))
            .foregroundColor(c.primary)
            .padding(.horizontal, 12).padding(.vertical, 4)
            .background(c.primary.opacity(0.12))
            .clipShape(Capsule())
    }
}

/// D.6.3 — VibeCodeDescribeScreen.
public struct VibeCodeDescribeScreen: View {
    @State private var prompt: String = "A little site to track which of my houseplants I've watered, with a photo per plant. Send me a push when one's been thirsty 5+ days."
    @State private var name: String = "plants"
    var onBuild: (String) -> Void = { _ in }
    public init(onBuild: @escaping (String) -> Void = { _ in }) { self.onBuild = onBuild }

    public var body: some View {
        FSScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: FS.space.s6) {
                    Spacer().frame(height: FS.space.s12)
                    Text("New app").font(FS.font.h2())
                    FSColorReader { c in
                        Text("Describe what you want. Your Flagship will build it and run it at \(name).harry.flagship.services.")
                            .font(FS.font.body()).foregroundColor(c.textMuted)
                    }

                    // Textarea
                    PromptArea(prompt: $prompt)

                    // Examples
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: FS.space.s2) {
                            ForEach(["Habit tracker", "Family wishlist", "Recipe jar", "Sleep journal"], id: \.self) { ex in
                                ExampleChip(text: ex)
                            }
                        }
                    }

                    FSCard {
                        LabeledRow(label: "Name", value: name)
                        LabeledRow(label: "Visible to", value: "Just me")
                        LabeledRow(label: "AI", value: "Claude (Flagship credits)")
                    }

                    FSCard {
                        FSColorReader { c in
                            Text("It'll ask for these:").font(FS.font.caption()).foregroundColor(c.textMuted)
                            Text("· Postgres (a 'plants' table)\n· Object store (photos)\n· Push notifications")
                                .font(.system(size: 14))
                                .foregroundColor(c.text)
                        }
                    }

                    FSPrimaryButton("Build it", block: true, large: true, action: { onBuild(prompt) })
                    FSColorReader { c in
                        Text("about 90 seconds")
                            .font(.system(size: 13))
                            .foregroundColor(c.textMuted)
                    }
                    Spacer().frame(height: FS.space.s8)
                }
                .padding(.horizontal, FS.space.s6)
            }
        }
    }
}

private struct PromptArea: View {
    @Environment(\.colorScheme) private var scheme
    @Binding var prompt: String
    var body: some View {
        let c = FSColors.scheme(scheme)
        ZStack(alignment: .bottomTrailing) {
            TextEditor(text: $prompt)
                .font(FS.font.body())
                .padding(10)
                .frame(height: 180)
                .background(c.surfaceSunken)
                .overlay(
                    RoundedRectangle(cornerRadius: FS.radius.sm)
                        .stroke(c.border, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
            Text("\(prompt.count)")
                .font(FS.font.mono())
                .foregroundColor(c.textMuted)
                .padding(8)
        }
    }
}

private struct ExampleChip: View {
    @Environment(\.colorScheme) private var scheme
    let text: String
    var body: some View {
        let c = FSColors.scheme(scheme)
        Text(text)
            .font(FS.font.caption())
            .foregroundColor(c.textMuted)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(c.surfaceSunken)
            .overlay(
                RoundedRectangle(cornerRadius: FS.radius.pill).stroke(c.border, lineWidth: 1)
            )
            .clipShape(Capsule())
    }
}

private struct LabeledRow: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let value: String
    var body: some View {
        let c = FSColors.scheme(scheme)
        HStack {
            Text(label).font(FS.font.bodySm()).foregroundColor(c.textMuted)
            Spacer()
            Text(value).font(.system(size: 14, weight: .medium)).foregroundColor(c.text)
        }
        .padding(.vertical, FS.space.s2)
    }
}

/// D.6.4 — VibeCodeGeneratingScreen.
public struct VibeCodeGeneratingScreen: View {
    public init() {}
    public var body: some View {
        FSScreen {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Spacer().frame(height: FS.space.s12)
                Text("Building plants…").font(FS.font.h2())
                FSColorReader { c in
                    Text("Streaming live. You can interrupt with a follow-up at any time.")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                }

                FSCard(padding: FS.space.s4) {
                    StreamPreview()
                }

                Spacer()

                HStack(spacing: FS.space.s2) {
                    FSGhostButton("Interrupt", action: {})
                    FSSecondaryButton("Save & continue later", block: true, action: {})
                }
                Spacer().frame(height: FS.space.s8)
            }
            .padding(.horizontal, FS.space.s6)
        }
    }
}

private struct StreamPreview: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text("Sketching the schema. One table for plants, one for waterings.")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
            Text("── flagship.app.json ──")
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundColor(c.primary)
                .padding(.top, FS.space.s2)
            Text("{\n  \"schema_version\": 1,\n  \"name\": \"plants\",\n  ...\n}")
                .font(.system(size: 12, design: .monospaced))
                .foregroundColor(c.text)
            Text("── Dockerfile ──")
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundColor(c.primary)
                .padding(.top, FS.space.s2)
            Text("FROM node:20-alpine\nWORKDIR /app\n...")
                .font(.system(size: 12, design: .monospaced))
                .foregroundColor(c.text)
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
