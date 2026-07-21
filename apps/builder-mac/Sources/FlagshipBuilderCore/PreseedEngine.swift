import Foundation
import JavaScriptCore

/// Runs the SINGLE canonical preseed / user-data generator
/// (`packages/flagship-builder/engine/preseed-engine.js`) via JavaScriptCore,
/// the system framework — no third-party dependency. This REPLACES the former
/// ~2,200-line Swift re-implementation in UserData.swift: a second copy of a
/// security-critical, signed-bootstrap path that could drift from the canonical
/// TypeScript. The bundle is pure ECMAScript (no Node/Buffer/btoa/TextEncoder),
/// so a bare JSContext runs it unchanged; PreseedEngineTests proves the output
/// is byte-identical to Node against the shared golden vectors.
///
/// The recipe JSON has ALREADY been signature-verified natively
/// (`RecipeLoader`) — the engine does NOT re-verify. burnOpts carry the
/// burn-time-only inputs (disk-encryption override, Wi-Fi, git ref, repo, boot
/// host). bootUnlockMode + the debug user are recipe-driven (read from the
/// signed blob / the unsigned `debugGrant` sibling inside the engine), not
/// burnOpts.
public final class PreseedEngine {

    /// Burn-time inputs the engine layers on top of the signed recipe. Mirrors
    /// the engine's `burnOptsJson` schema
    /// (`{encryptRoot?, wifiSSID?, wifiPassword?, installerGitRef?,
    /// flagshipRepoUrl?, bootHost?}`). Keys are emitted verbatim — note the
    /// engine reads `wifiSSID` (capital SSID) and `flagshipRepoUrl`.
    public struct BurnOptions: Sendable {
        public var encryptRoot: Bool?
        public var wifiSSID: String?
        public var wifiPassword: String?
        public var installerGitRef: String?
        public var flagshipRepoUrl: String?
        public var bootHost: String?

        public init(encryptRoot: Bool? = nil,
                    wifiSSID: String? = nil,
                    wifiPassword: String? = nil,
                    installerGitRef: String? = nil,
                    flagshipRepoUrl: String? = nil,
                    bootHost: String? = nil) {
            self.encryptRoot = encryptRoot
            self.wifiSSID = wifiSSID
            self.wifiPassword = wifiPassword
            self.installerGitRef = installerGitRef
            self.flagshipRepoUrl = flagshipRepoUrl
            self.bootHost = bootHost
        }

        /// JSON the engine's `parseBurn` consumes. Only set keys are emitted,
        /// matching the engine's `burn.<k> ? {…} : {}` truthiness merge (an
        /// empty/blank Wi-Fi SSID or git ref is dropped so the engine falls back
        /// to its defaults / the signed blob).
        func json() -> String {
            var o: [String: Any] = [:]
            if let v = encryptRoot { o["encryptRoot"] = v }
            if let v = wifiSSID, !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                o["wifiSSID"] = v
            }
            if let v = wifiPassword, !v.isEmpty { o["wifiPassword"] = v }
            if let v = installerGitRef, !v.isEmpty { o["installerGitRef"] = v }
            if let v = flagshipRepoUrl, !v.isEmpty { o["flagshipRepoUrl"] = v }
            if let v = bootHost, !v.isEmpty { o["bootHost"] = v }
            guard let data = try? JSONSerialization.data(withJSONObject: o),
                  let s = String(data: data, encoding: .utf8) else { return "{}" }
            return s
        }
    }

    public enum EngineError: LocalizedError {
        case bundleMissing
        case evaluationFailed(String)
        case globalMissing
        case threw(String)
        case nonStringResult

        public var errorDescription: String? {
            switch self {
            case .bundleMissing:
                return "preseed-engine.js resource not found in the bundle."
            case .evaluationFailed(let m):
                return "Failed to evaluate the preseed engine: \(m)"
            case .globalMissing:
                return "FlagshipPreseed global not installed by the preseed engine."
            case .threw(let m):
                return "The preseed engine threw: \(m)"
            case .nonStringResult:
                return "The preseed engine returned a non-string result."
            }
        }
    }

    /// Process-wide engine over the shipped resource bundle.
    public static let shared: PreseedEngine = {
        do { return try PreseedEngine() }
        catch {
            // Construction only fails if the resource is missing / the bundle
            // doesn't evaluate — a build/packaging error, not a runtime one. Fail
            // loud at first use rather than returning a silently-broken engine.
            fatalError("PreseedEngine.shared could not initialize: \(error)")
        }
    }()

    private let context: JSContext
    private var lastException: String?

    /// Load the canonical bundle source. Defaults to the SPM resource
    /// (`Bundle.module`); tests may inject the source directly.
    public convenience init() throws {
        try self.init(bundleSource: PreseedEngine.loadBundledSource())
    }

    public init(bundleSource: String) throws {
        guard let ctx = JSContext() else {
            throw EngineError.evaluationFailed("could not create JSContext")
        }
        self.context = ctx
        ctx.exceptionHandler = { [weak self] _, exc in
            self?.lastException = exc?.toString() ?? "unknown JS exception"
        }
        lastException = nil
        ctx.evaluateScript(bundleSource)
        if let exc = lastException {
            throw EngineError.evaluationFailed(exc)
        }
        // The bundle installs `globalThis.FlagshipPreseed`.
        guard let global = ctx.objectForKeyedSubscript("FlagshipPreseed"),
              !global.isUndefined, !global.isNull else {
            throw EngineError.globalMissing
        }
    }

    /// The canonical bundle source shipped as an SPM resource.
    public static func loadBundledSource() throws -> String {
        let url = Bundle.main.url(forResource: "preseed-engine", withExtension: "js")
            ?? Bundle.module.url(forResource: "preseed-engine", withExtension: "js")
        guard let url else {
            throw EngineError.bundleMissing
        }
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// Debian d-i preseed.cfg for the (already-verified) recipe + burn options.
    public func buildPreseed(recipeJSON: Data, burnOpts: BurnOptions = .init()) throws -> String {
        try invoke("buildPreseedFromRecipe", recipeJSON: recipeJSON, burnOptsJson: burnOpts.json())
    }

    /// Ubuntu autoinstall user-data for the (already-verified) recipe + options.
    public func buildUserData(recipeJSON: Data, burnOpts: BurnOptions = .init()) throws -> String {
        try invoke("buildUserDataFromRecipe", recipeJSON: recipeJSON, burnOptsJson: burnOpts.json())
    }

    /// The canonical per-owner specialization script for a generalized VM
    /// appliance. The guest runs it with FLAGSHIP_APPLIANCE_PREINSTALLED=1.
    public func buildApplianceBootstrap(recipeJSON: Data,
                                        burnOpts: BurnOptions = .init()) throws -> String {
        try invoke("buildBootstrapFromRecipe", recipeJSON: recipeJSON, burnOptsJson: burnOpts.json())
    }

    /// Raw invocation with a pre-built `burnOpts` JSON string — the exact wire
    /// shape the canonical generator + Node golden vectors use. Used by the
    /// byte-identity test to isolate JSC fidelity from the BurnOptions struct.
    func buildPreseedRaw(recipeJSON: Data, burnOptsJson: String) throws -> String {
        try invoke("buildPreseedFromRecipe", recipeJSON: recipeJSON, burnOptsJson: burnOptsJson)
    }

    func buildUserDataRaw(recipeJSON: Data, burnOptsJson: String) throws -> String {
        try invoke("buildUserDataFromRecipe", recipeJSON: recipeJSON, burnOptsJson: burnOptsJson)
    }

    private func invoke(_ method: String, recipeJSON: Data, burnOptsJson: String) throws -> String {
        let recipeStr = String(data: recipeJSON, encoding: .utf8) ?? ""
        guard let fp = context.objectForKeyedSubscript("FlagshipPreseed"),
              !fp.isUndefined,
              let fn = fp.objectForKeyedSubscript(method),
              !fn.isUndefined else {
            throw EngineError.globalMissing
        }
        lastException = nil
        let result = fn.call(withArguments: [recipeStr, burnOptsJson])
        if let exc = lastException {
            throw EngineError.threw(exc)
        }
        guard let result, result.isString, let s = result.toString() else {
            throw EngineError.nonStringResult
        }
        return s
    }
}
