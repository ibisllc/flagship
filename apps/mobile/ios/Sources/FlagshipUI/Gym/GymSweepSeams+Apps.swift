#if DEBUG
import Foundation
import FlagshipAPI
import FlagshipCore

extension GymSweepSeams {
    /// A per-server mock the gym answers one server with instead of the
    /// shared one (keyed by the server's first label, e.g. "office").
    nonisolated(unsafe) static var podClients: [String: MockScreensClient] = [:]

    /// The client the smoke launch's per-server factory hands out for `fqdn`,
    /// when a seam gave that server its own mock.
    public nonisolated static func podClient(forFqdn fqdn: String) -> (any ScreensClient)? {
        guard let label = fqdn.lowercased().split(separator: ".").first else { return nil }
        return podClients[String(label)]
    }

    /// Apps seams for GymSweepAppTests.
    static func apps(_ args: [String], _ app: AppState, _ mocks: GymMocks) {
        podClients = [:]
        let screens = mocks.screens
        // An older box: no access lists, so the app page shows the v1
        // internet card (Allow a declared host, Stop access).
        if args.contains("-smoke-legacy-egress") {
            screens.mockAccess["bright-maple--plants"] = nil
            screens.mockAccess["bright-maple--wiki"] = nil
        }
        // Plants suggests an access list for review.
        if args.contains("-smoke-access-draft") {
            screens.mockAccessDrafts["bright-maple--plants"] = AppAccessDraft(
                list: "allow api.open-meteo.com\n" + AppAccessList.defaultList,
                hosts: [AppAccessDraftHost(host: "api.open-meteo.com", why: "Weather for watering reminders")],
                createdAt: 1_760_000_000_000)
        }
        // Office and Music run their own boxes without Plants, so "Runs on"
        // can tick them and Home holds its only copy.
        if args.contains("-smoke-office-lacks-plants") {
            for context in ["office", "music"] {
                let box = MockScreensClient()
                box.podContext = context
                box.simulatedLatency = screens.simulatedLatency
                box.hiddenApps = ["bright-maple--plants"]
                podClients[context] = box
            }
        }
        // Plants can be edited here, came from a shared adaptation and has a
        // headless-browser tab running.
        if args.contains("-smoke-app-extras") {
            screens.mockEditableApps.insert("bright-maple--plants")
            screens.mockAdaptedFrom["bright-maple--plants"] = "github.com/example/plants"
            screens.mockBrowserTabIds["bright-maple--plants"] = ["t1"]
        }
        // The box refuses an edit: another session is changing the app, or
        // it is too big for the AI chat.
        switch value(args, "-smoke-edit-refusal") {
        case "session":
            let body = #"{"ok":false,"kind":"session","name":"plants","sessionId":"vc-open01"}"#
            screens.vibeCodeStartError = ScreensClientError.http(status: 409, message: body)
        case "toobig":
            screens.vibeCodeStartError = ScreensClientError.http(
                status: 413, message: #"{"error":"Plants is too big to change in the AI chat. Use your IDE instead."}"#)
        default:
            break
        }
        // New invites show in the members list (the mock .com lists them).
        if args.contains("-smoke-invites-listed") {
            mocks.access.listsCreatedInvites = true
        }
    }
}
#endif
