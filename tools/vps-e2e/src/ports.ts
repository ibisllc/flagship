/**
 * Injected ports — every real-world side effect (provisioning a cloud
 * VPS, the signed HTTP calls to `.com`, TLS-cert introspection of the
 * live `.services` padlock, optional SSH into the booted node, wall
 * clock, sleeping) sits behind one of these interfaces so the pure
 * orchestration core (`runE2E.ts`) is unit-testable with deterministic
 * fakes and the vitest gate NEVER provisions a real VPS, never spends
 * money, and never touches the network.
 *
 * The concrete real-I/O implementations live under `providers/` and at
 * the CLI edge (`cli.ts`); they are authored + typechecked here but
 * NOT executed by the test suite — a real run needs a provider token
 * and accepts cloud cost.
 */

import type { Keypair } from "@flagship/protocol";

/** Outcome status for a single named stage of the chain. */
export type StageStatus = "pass" | "fail" | "known-gated" | "skipped";

/** One stage's typed, ordered result. */
export interface StageResult {
  name: string;
  status: StageStatus;
  /** Human-readable one-liner: what was asserted / what happened. */
  detail: string;
  /**
   * Present on `known-gated` stages: the precise reason this pillar is
   * not yet wired in prod, pointing at the file that must change. A
   * gated stage that "fails" its assertion is EXPECTED and does NOT
   * fail the overall run.
   */
  gatedReason?: string;
}

/** The full ordered report `runE2E` always returns (never throws). */
export interface E2EReport {
  /** True iff no NON-gated stage is `fail`. Gated fails don't count. */
  ok: boolean;
  /** Stages in execution order. */
  stages: StageResult[];
  /** The derived `<server>.<user>.flagship.services` FQDN, once known. */
  serverFqdn?: string;
  /** The provider instance id, once provisioned (for the operator). */
  instanceId?: string;
  /** Wall-clock start/end (from the injected clock). */
  startedAt: number;
  finishedAt: number;
}

/** A provisioned VPS the provider handed back. */
export interface VpsInstance {
  /** Provider-opaque instance id (used for awaitBoot / destroy). */
  id: string;
  /** Public IPv4 of the booted node. */
  ip: string;
}

/** Parameters for a single provision request. */
export interface ProvisionRequest {
  /** Path or URL to the ALREADY-personalized Flagship ISO (an INPUT). */
  iso: string;
  /** Provider region/datacenter slug. */
  region: string;
  /** Provider instance-size/plan slug. */
  size: string;
  /**
   * A stable label so a human can find + manually nuke the box if
   * teardown ever fails. Derived from the username/server.
   */
  label: string;
}

/**
 * The real-I/O cloud adapter. The pure core only ever calls these
 * three methods; it performs NO network/process itself. An adapter
 * MUST `provision` a node booted from the supplied custom ISO,
 * `awaitBoot` until it is reachable, and `destroy` it idempotently
 * (teardown is always attempted by the core, even mid-chain failure).
 */
export interface VpsProvider {
  /** Human name for the report header (e.g. "hetzner"). */
  readonly name: string;
  provision(req: ProvisionRequest): Promise<VpsInstance>;
  /** Resolve once the instance has finished its first boot. */
  awaitBoot(id: string): Promise<void>;
  /** Idempotent: a no-op if the id is unknown / already gone. */
  destroy(id: string): Promise<void>;
}

/** A single TLS peer certificate, as the introspecting client saw it. */
export interface TlsCertInfo {
  /** Issuer organization / common name (e.g. "Let's Encrypt"). */
  issuer: string;
  /** Subject Alternative Names presented. */
  subjectAltNames: string[];
  validFrom: number;
  validTo: number;
}

/** Result of an injected HTTP call, with optional TLS introspection. */
export interface HttpResponse {
  status: number;
  /** Decoded body text (callers JSON.parse as needed). */
  body: string;
  /**
   * Present only when the request was HTTPS and the client captured
   * the peer cert — used by the green-padlock assertion.
   */
  tls?: TlsCertInfo;
}

/**
 * Injected HTTP port. The real implementation (CLI edge) uses
 * `node:https` so it can expose the peer cert; the test fake returns
 * scripted responses. The core never imports `node:http(s)` itself.
 */
export interface HttpClient {
  get(url: string): Promise<HttpResponse>;
  post(url: string, jsonBody: unknown): Promise<HttpResponse>;
}

/** Optional SSH port — used only for richer in-node assertions. */
export interface SshClient {
  /** Run a command on the booted node; resolve with combined output. */
  exec(host: string, command: string): Promise<{ code: number; out: string }>;
}

/** Injected wall clock (ms). */
export type Clock = () => number;

/** Injected sleep so polling loops are deterministic in tests. */
export type Sleep = (ms: number) => Promise<void>;

/** Injected structured logger. */
export interface Logger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

/**
 * Identity/signing helper, reusing `@flagship/protocol` for the IRK
 * keypair + Ed25519. Injected so the test suite can pin a
 * deterministic key and the core stays free of crypto-source choices.
 */
export interface IdentityHelper {
  /** The user's IRK keypair (Ed25519). */
  readonly irk: Keypair;
  /** Phone-delegated keypair (signs nothing the IRK can't, here). */
  readonly delegated: Keypair;
  /** Routing-Control-Key keypair for this subdomain. */
  readonly rck: Keypair;
  /** Sign canonical bytes with the IRK private key. */
  signWithIrk(msg: Uint8Array): Uint8Array;
}

/** Everything `runE2E` needs; ALL side effects live here. */
export interface E2EDeps {
  provider: VpsProvider;
  http: HttpClient;
  ssh?: SshClient;
  clock: Clock;
  sleep: Sleep;
  logger: Logger;
  identity: IdentityHelper;
}

/** The immutable inputs of one run. */
export interface E2EPlan {
  /** Base URL of the identity/state control plane (`.com`). */
  comBase: string;
  /** Base URL of the stateless data plane (`.services`). */
  servicesBase: string;
  /** Path or URL to the personalized ISO — an INPUT, not built here. */
  iso: string;
  /** Desired username label (RFC-1035). */
  username: string;
  /** Desired server label (RFC-1035). */
  serverName: string;
  /** Provider region slug. */
  region: string;
  /** Provider size slug. */
  size: string;
  /** Poll budget for the install→register→unlock waits. */
  pollIntervalMs: number;
  pollMaxAttempts: number;
  /** When true, leave the VPS running (skip destroy) for debugging. */
  keep?: boolean;
}
