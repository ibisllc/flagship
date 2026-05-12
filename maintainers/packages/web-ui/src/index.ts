/**
 * @maintainers/web-ui — public surface.
 *
 * Two ways to use this package:
 *
 *   import { mountApp, staticAdapter } from "@maintainers/web-ui";
 *
 *   mountApp(document.body, {
 *     adapter: staticAdapter(),     // Model B: pure client
 *   });
 *
 * Or, with a server-side commit endpoint:
 *
 *   import { mountApp, serverAdapter } from "@maintainers/web-ui";
 *
 *   mountApp(document.body, {
 *     adapter: serverAdapter({ baseUrl: "/api/maintainers" }),  // Model A
 *   });
 *
 * Lower-level helpers (envelope assembly, WebAuthn glue, ZIP writer)
 * are exported here too for adopters who want to integrate piecewise.
 */

export * from "./app.js";
export * from "./adapter.js";
export * from "./state.js";
export * from "./styles.js";
export * from "./webauthn.js";
export * from "./repo-provider.js";
export * from "./parse-folder.js";
export * from "./envelopes.js";
export * from "./zip.js";
export * from "./cbor.js";
