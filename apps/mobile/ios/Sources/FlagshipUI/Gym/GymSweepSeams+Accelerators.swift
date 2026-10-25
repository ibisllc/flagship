#if DEBUG
import Foundation
import Flagship
import FlagshipAPI
import FlagshipCore

extension GymSweepSeams {
    /// The server page's GPU card: `-smoke-accelerators` gives the mock box an RTX 4090 that Plants
    /// holds, a free A2000, a Radeon set aside after a fault, and Wiki waiting for a GPU.
    /// `-smoke-accelerators-paused` also pauses new GPU work; `-smoke-gpu-approvals` adds apps asking for
    /// a GPU and one already approved. Without either the mock box has no GPU
    /// screen, as an older box, and the page shows no card.
    static func accelerators(_ args: [String], _ app: AppState, _ mocks: GymMocks) {
        let m = mocks.screens.acceleratorsMock
        m.view = nil
        if args.contains("-smoke-accelerators") {
            let v = MockAccelerators.fixture()
            m.view = args.contains("-smoke-accelerators-paused")
                ? AcceleratorsView(available: v.available, reason: v.reason, admissionPaused: "maintenance",
                                   catalog: v.catalog, devices: v.devices, queue: v.queue)
                : v
        }
        // Render and Train ask to use a GPU; Photos may already (flagship/gpu-approval/v1).
        if args.contains("-smoke-gpu-approvals") {
            let a = MockAccelerators.approvalsFixture()
            m.view = (m.view ?? MockAccelerators.fixture()).with(pendingApprovals: a.pending, approvals: a.granted)
        }
        if args.contains("-smoke-accelerators-none") {
            m.view = AcceleratorsView(available: false, reason: "no-gpu-service", devices: [])
        }
    }
}
#endif
