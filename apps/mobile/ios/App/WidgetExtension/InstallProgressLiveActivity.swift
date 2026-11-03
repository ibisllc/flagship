import ActivityKit
import WidgetKit
import SwiftUI

/// Live Activity widget surfacing the create-server install pipeline.
///
/// Renders three contexts:
///   1. Lock Screen / Notification Center — full vertical step list
///   2. Dynamic Island compact — leading icon + trailing percent
///   3. Dynamic Island expanded — header + ProgressView + active step
///   4. Dynamic Island minimal — just the active-step icon
///
/// Activity lifecycle is driven by the app via
/// InstallProgressLiveActivityCenter:
///   start(serial:podName:) → request()
///   advance(step:)         → update()
///   complete(fqdn:)        → update(.ready) then end(dismissalPolicy:)
///   fail(reason:)          → update(.failed) then end(dismissalPolicy:)
struct InstallProgressLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: InstallProgressAttributes.self) { ctx in
            LockScreenView(attributes: ctx.attributes, state: ctx.state)
                .widgetURL(Self.tapURL(ctx.attributes, ctx.state))
                .activityBackgroundTint(Color(.systemBackground))
                .activitySystemActionForegroundColor(Color.accentColor)
        } dynamicIsland: { ctx in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: ctx.state.currentStep.systemImageName)
                        .imageScale(.large)
                        .foregroundStyle(.tint)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text("\(Int(ctx.state.fractionalProgress * 100))%")
                        .font(.headline.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(ctx.attributes.podName)
                        .font(.headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        ProgressView(value: ctx.state.fractionalProgress)
                            .tint(.accentColor)
                        Text(ctx.state.currentStep.label)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            } compactLeading: {
                Image(systemName: ctx.state.currentStep.systemImageName)
                    .foregroundStyle(.tint)
            } compactTrailing: {
                Text("\(Int(ctx.state.fractionalProgress * 100))%")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            } minimal: {
                Image(systemName: ctx.state.currentStep.systemImageName)
                    .foregroundStyle(.tint)
            }
            // Every region opens the install this activity tracks.
            .widgetURL(Self.tapURL(ctx.attributes, ctx.state))
        }
    }

    /// The tracked install's page (pending, or the server once live), named
    /// by the install key the activity was started with.
    static func tapURL(_ attributes: InstallProgressAttributes, _ state: InstallProgressAttributes.ContentState) -> URL {
        PodStatusSnapshot.read().installProgressURL(key: attributes.serial, serverFqdn: state.serverFqdn)
    }
}

private struct LockScreenView: View {
    let attributes: InstallProgressAttributes
    let state: InstallProgressAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: "server.rack")
                    .imageScale(.large)
                    .foregroundStyle(.tint)
                VStack(alignment: .leading) {
                    Text(attributes.podName).font(.headline)
                    Text(state.serverFqdn ?? String(localized: "Provisioning \(attributes.serial.prefix(8))…"))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text("\(Int(state.fractionalProgress * 100))%")
                    .font(.title3.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            ProgressView(value: state.fractionalProgress)
                .tint(.accentColor)

            if state.currentStep == .error, let reason = state.failureReason {
                Label(reason, systemImage: InstallProgressAttributes.Step.error.systemImageName)
                    .font(.footnote)
                    .foregroundStyle(.red)
            } else {
                Label(state.currentStep.label, systemImage: state.currentStep.systemImageName)
                    .font(.footnote)
                    .foregroundStyle(state.currentStep == .live ? .green : .secondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}
