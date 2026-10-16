import SwiftUI
import FlagshipAPI

/// Gym-only: an invisible element whose accessibility label lists what the
/// mock clients saw (GymProbe), for UI tests to read as `gym-probe`.
public struct GymProbeView: View {
    private let probe = GymProbe.shared

    public init() {}

    public var body: some View {
        Text(probe.label)
            .font(.system(size: 1))
            .frame(width: 1, height: 1)
            .clipped()
            .opacity(0.011)
            .allowsHitTesting(false)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(probe.label)
            .accessibilityIdentifier("gym-probe")
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
