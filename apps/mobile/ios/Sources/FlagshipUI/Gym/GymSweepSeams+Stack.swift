#if DEBUG
import Foundation
import Flagship
import FlagshipAPI
import FlagshipCore

extension GymSweepSeams {
    /// The server page's Container stack card: `-smoke-stack` gives the mock box the classic stack
    /// with a plan that fits; `-smoke-stack-blocked` one without room for the move. Without either the
    /// mock box has no stack screen, as an older box, and the page shows no card.
    static func stack(_ args: [String], _ app: AppState, _ mocks: GymMocks) {
        let m = mocks.screens.stackMock
        m.status = nil
        if args.contains("-smoke-stack") { m.status = MockStack.classic() }
        if args.contains("-smoke-stack-blocked") { m.status = MockStack.classic(blocked: true) }
    }
}
#endif
