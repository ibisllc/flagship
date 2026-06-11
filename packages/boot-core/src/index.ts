/**
 * @flagship/boot-core — the runtime-agnostic boot-operations logic.
 *
 * The `/api/boot/*` contract (box-sealed auto-unlock lease release + the
 * phone-gated approval relay) is a pure router over storage + a directory
 * + a notify pipe, exactly the way `@flagship/control-plane` is pure over
 * storage. It is consumed TWICE:
 *
 *   - by `apps/com` (the reference deployment) — mounted on the identity
 *     plane itself, host-dispatched for boot.flagshipserver.com, backed by
 *     `flagship-state`, with the directory + notify resolved IN-PROCESS
 *     (no cross-worker bridge, no shared secret).
 *   - by `apps/boot` (the optional cloneable target) — a standalone worker
 *     pointed at a SEPARATE identity plane over HTTP, with the directory
 *     read + the owner push delivered through the notify pipe.
 *
 * The router never sees plaintext keys (invariant I1) — leases/responses
 * are ciphertext + public-signed artifacts. Every route is identity-gated
 * by WHO SIGNED IT (gate.ts), not the verb.
 */

export { routeBoot, type BootRouteDeps, type BootResponse } from "./routes.js";
export {
  gate,
  signBootRequest,
  encodeAuthHeader,
  b64urlEncode,
  b64urlDecode,
  AUTH_HEADER,
  DEFAULT_MAX_AGE_MS,
  type GateDeps,
  type GateEnvelope,
  type GateResult,
  type GateRole,
} from "./gate.js";
export {
  HttpDirectoryClient,
  usernameFromServerDomain,
  type DirectoryClient,
  type HttpDirectoryClientOpts,
} from "./directory.js";
export {
  HttpNotifyPipe,
  NoopNotifyPipe,
  type NotifyPipe,
  type HttpNotifyPipeOpts,
} from "./notify.js";
export {
  D1NonceStore,
  InMemoryNonceStore,
  type NonceStore,
} from "./nonceStore.js";
export { hexToBytes, bytesToHex, equalHex, equalToken } from "./hex.js";
