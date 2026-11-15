#if DEBUG
import Foundation

/// The mock box's restore into a running server: a stage opens a fixed backup whose preview has one
/// app of each kind, a plan runs at once, and every replace leaves an undo point.
extension MockScreensClient {
    public static func restoreMergeDemoApps() -> [RestoreMergeApp] {
        let g = RestoreMergeApp.Guards(guardCode: "tree:" + String(repeating: "a", count: 64), guardSchema: String(repeating: "b", count: 64), guardGen: 0)
        return [
            RestoreMergeApp(archivedServiceId: "demo--notes", name: "notes", targetServiceId: "demo--notes", verdict: "same", code: "backup-older", schema: "backup-older",
                            backup: .init(version: "1.2.0", bytes: 4_000_000, hasDatabase: true, hasFiles: true), box: .init(version: "1.4.0", bytes: 6_000_000, installedAt: 1_790_000_000_000),
                            allowed: ["keep", "replace", "replace-data", "copy"], disallowed: ["install": "already-on-server", "skip": "already-on-server"],
                            recommended: "keep", copyServiceId: "demo--notes-restored", guards: g),
            RestoreMergeApp(archivedServiceId: "demo--todo", name: "todo", targetServiceId: "demo--todo", verdict: "new", code: "unknown", schema: nil,
                            backup: .init(version: "1.0.0", bytes: 1_000_000, hasDatabase: true, hasFiles: false), box: nil,
                            allowed: ["install", "skip", "copy"], disallowed: ["keep": "not-on-server", "replace": "not-on-server", "replace-data": "not-on-server"],
                            recommended: "install", copyServiceId: "demo--todo-restored", guards: nil),
            RestoreMergeApp(archivedServiceId: "demo--chess", name: "chess", targetServiceId: "demo--chess", verdict: "runs-elsewhere", code: "unknown", schema: nil,
                            backup: .init(version: "2.0.0", bytes: 2_000_000), box: nil, alsoOn: ["home2"], addressMoves: true,
                            allowed: ["install", "skip", "copy"], disallowed: ["keep": "not-on-server"], recommended: "skip", copyServiceId: "demo--chess-restored", guards: nil),
            RestoreMergeApp(archivedServiceId: "sam--blog", name: "blog", targetServiceId: "demo--blog", verdict: "clash", code: "diverged", schema: "diverged",
                            backup: .init(version: "0.3.0", bytes: 500_000), box: .init(version: "1.0.0", bytes: 800_000, installedAt: 1_790_000_000_000),
                            allowed: ["keep", "copy"], disallowed: ["replace": "different-app", "replace-data": "different-app"],
                            recommended: "copy", copyServiceId: "demo--blog-restored", guards: nil),
        ]
    }

    public func restoreMergeStatus() async throws -> RestoreMergeView {
        try await tick()
        return restoreMergeState
    }

    public func restoreMergeStage(_ req: RestoreMergeSigned<RestoreMergeStageOrder>) async throws -> RestoreMergeStarted {
        try await tick()
        restoreMergeStages.append(req)
        let id = "0123456789abcdef0123456789abcdef"
        let ready = req.order.source == "saved"
        restoreMergeState = RestoreMergeView(
            stage: RestoreMergeStage(restoreId: id, archiveId: req.order.archiveId, source: req.order.source, bytes: req.order.bytes,
                                     received: ready ? req.order.bytes : 0, state: ready ? "ready" : "receiving"),
            preview: nil, run: restoreMergeState.run, undo: restoreMergeState.undo)
        return RestoreMergeStarted(restoreId: id, received: ready ? req.order.bytes : 0)
    }

    public func restoreMergeChunk(offset: Int64, data: Data) async throws {
        try await tick()
        guard let s = restoreMergeState.stage else { throw Self.refusal(409, "This server isn't waiting for backup data.", code: "not-receiving") }
        let received = offset + Int64(data.count)
        restoreMergeState = RestoreMergeView(
            stage: RestoreMergeStage(restoreId: s.restoreId, archiveId: s.archiveId, source: s.source, bytes: s.bytes, received: received, state: received >= s.bytes ? "ready" : "receiving"),
            preview: nil, run: restoreMergeState.run, undo: restoreMergeState.undo)
    }

    public func restoreMergeCommit(keyHex: String) async throws {
        try await tick()
        guard let s = restoreMergeState.stage, s.state == "ready" else { throw Self.refusal(409, "Send the whole backup file first.", code: "not-ready") }
        restoreMergeCommits.append(keyHex)
        restoreMergeState = RestoreMergeView(
            stage: RestoreMergeStage(restoreId: s.restoreId, archiveId: s.archiveId, source: s.source, bytes: s.bytes, received: s.bytes, state: "previewed"),
            preview: RestoreMergePreview(restoreId: s.restoreId, backup: .init(createdAt: 1_793_700_000_000, sourceServer: "home.demo.flagship.services"), apps: restoreMergeApps),
            run: nil, undo: restoreMergeState.undo)
    }

    public func restoreMergePlan(_ req: RestoreMergeSigned<RestoreMergePlanOrder>) async throws {
        try await tick()
        if let refusal = restoreMergeNextRefusal {
            restoreMergeNextRefusal = nil
            throw Self.refusal(409, refusal.sentence, code: refusal.code)
        }
        restoreMergePlans.append(req)
        let lines = req.lines ?? []
        let apps = lines.map { l -> RestoreMergeRun.App in
            let p = restoreMergeApps.first { $0.archivedServiceId == l.archivedServiceId }
            let step = l.action == "keep" ? "kept" : l.action == "skip" ? "skipped" : "done"
            return .init(archivedServiceId: l.archivedServiceId, action: l.action, targetServiceId: l.targetServiceId ?? p?.targetServiceId ?? l.archivedServiceId, step: step)
        }
        let now: Int64 = 1_794_000_000_000
        let undo = lines.filter { $0.action == "replace" || $0.action == "replace-data" }.map { l in
            RestoreMergeUndoPoint(serviceId: restoreMergeApps.first { $0.archivedServiceId == l.archivedServiceId }?.targetServiceId ?? l.archivedServiceId,
                                  name: restoreMergeApps.first { $0.archivedServiceId == l.archivedServiceId }?.name ?? l.archivedServiceId,
                                  restoreId: req.order.restoreId, keptAt: now, expiresAt: now + 7 * 86_400_000)
        }
        restoreMergeState = RestoreMergeView(stage: nil, preview: nil, run: .init(restoreId: req.order.restoreId, state: "done", apps: apps), undo: restoreMergeState.undo + undo)
    }

    public func restoreMergeCancel() async throws {
        try await tick()
        restoreMergeState = RestoreMergeView(stage: nil, preview: nil, run: restoreMergeState.run, undo: restoreMergeState.undo)
    }

    public func restoreMergeUndo(_ req: RestoreMergeSigned<RestoreMergeUndoOrder>) async throws {
        try await tick()
        guard restoreMergeState.undo.contains(where: { $0.serviceId == req.order.serviceId && $0.restoreId == req.order.restoreId }) else {
            throw Self.refusal(404, "There is no earlier copy of that app to put back.", code: "no-undo")
        }
        restoreMergeUndos.append(req)
        restoreMergeState = RestoreMergeView(stage: restoreMergeState.stage, preview: restoreMergeState.preview, run: restoreMergeState.run,
                                             undo: restoreMergeState.undo.filter { !($0.serviceId == req.order.serviceId && $0.restoreId == req.order.restoreId) })
    }

    public func savedBackupFile(archiveId: String) async throws -> Data {
        try await tick()
        guard savedBackupsList.contains(where: { $0.archiveId == archiveId }) else { throw Self.refusal(404, "That backup isn't saved on this server.", code: "no-saved-backup") }
        return restoreMergeSavedFiles[archiveId] ?? Data("{}".utf8)
    }
}
#endif
