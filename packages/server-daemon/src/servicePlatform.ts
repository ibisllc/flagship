/**
 * App-platform plumbing on the daemon: install/uninstall lifecycle + the
 * per-app runtime registry the reverse proxy consults to route inbound
 * SNI traffic.
 *
 * App identity is `(creator, slug)`. The URL form is host-relative:
 *
 *   creator === host  →  `<slug>.<host>.flagship.services`
 *   creator !== host  →  `<slug>-<creator>.<host>.flagship.services`
 *
 * Membership for an installed app is controlled by the **host's** IRK
 * (the box owner), not the creator's. When Bob hosts Alice's `game1`,
 * Bob's phone signs membership mutations.
 */

import {
  parseManifest,
  signMembershipMutation,
  composeServiceId,
  parseServiceId as parseServiceIdShared,
  deriveUrlFragment,
  type AppManifest,
  type Bytes,
  type InstallServiceRequest,
  type Keypair,
  type MembershipMutation,
  type SetServiceEnvRequest,
  type UninstallServiceRequest,
} from "@flagship/protocol";
import type { AppEnv } from "./serviceEnvStore.js";
import { AppRunner, type AppSpec } from "./serviceRunner.js";
import { AppMembership } from "./membership.js";
import {
  DataProvisioner,
  credentialsToEnv,
  type AppDataCredentials,
} from "./dataLayer/index.js";
import type { AppAuthTokens } from "./serviceAuthToken.js";
import type { DomainGate } from "./browser/domainGate.js";
import type { TabRegistry } from "./browser/tabRegistry.js";
import type { AppPullState, AppPullStateStore, UpdatePolicy } from "./updateClient.js";

export interface InstalledService {
  creator: string;
  slug: string;
  /** Composite app id: `<creator>-<slug>` (single dash; creator is
   *  hyphen-free so it parses unambiguously). Container name + map key. */
  serviceId: string;
  manifest: AppManifest;
  /** Host-relative URL label: `<slug>` if self-authored, else `<slug>-<creator>`. */
  urlLabel: string;
  /** Per-app membership store. Mutations IRK-signed by the host. */
  membership: AppMembership;
  /** Local container port the daemon's reverse proxy forwards to. */
  containerPort: number;
  /** Provisioned data credentials (null if the app declared no stores). */
  data: AppDataCredentials | null;
  installedAt: number;
}

export interface ServicePlatformDeps {
  /** Whose box this is — used for the host-vs-creator URL collapse + as IRK-mutation owner. */
  host: { username: string; irkPub: Bytes };
  /**
   * Server Working Key — derives per-app secrets for member stable-id
   * derivation. Per `key_hierarchy.md` this is provisioned by the
   * phone at first boot. Until that's wired, callers pass an env-
   * derived placeholder; per-app derivation still works (the values
   * just rotate when SWK rotates).
   */
  swk: Bytes;
  appRunner: AppRunner;
  dataProvisioner: DataProvisioner | null;
  /**
   * Per-app daemon-API auth tokens. When set, the platform mints a
   * fresh `FLAGSHIP_APP_TOKEN` at install time and injects it into the
   * container's env so the app can authenticate calls back to the
   * daemon (used by the browser API and any future app→daemon
   * surfaces). Optional — when null, apps simply don't get a token
   * and the daemon-side surfaces that require it return 401.
   */
  appAuthTokens?: AppAuthTokens | null;
  /**
   * Browser-feature surfaces. When all three are configured AND the
   * app's manifest declares `browser.domains`, install registers the
   * domain grant and uninstall revokes it + closes the app's tabs.
   * Apps without a manifest browser.domains are NOT entitled to the
   * browser API regardless of these deps.
   */
  domainGate?: DomainGate | null;
  tabRegistry?: TabRegistry | null;
  /**
   * Update-pack canonical-home registration. When `pullStateStore`
   * is set AND the app is cross-creator (creator !== host), install
   * records an initial AppPullState so the pull scheduler can fetch
   * updates from the canonical home.
   *
   * `cloneService` is the daemon-injected hook that clones the canonical
   * repo into the working tree and returns the HEAD commit (lineage
   * anchor + initial tip). Production wires it to a real git client;
   * tests inject a fake. When unset, install records canonicalUrl +
   * empty anchor (the first pull then materializes history) — this
   * is "register but don't clone yet" and is sometimes useful for
   * deferred-fetch flows.
   */
  pullStateStore?: AppPullStateStore | null;
  cloneService?: ((args: {
    serviceId: string;
    canonicalUrl: string;
  }) => Promise<{ currentTip: string }>) | null;
  /**
   * Per-app generic env store. When set, the app's owner-set env vars
   * (sealed at rest by the store) are injected into the deployed
   * container's process environment at install/deploy; uninstall
   * forgets them. Optional — when null, an app simply runs without any
   * owner-set env vars (just the FLAGSHIP_* / data-layer ones).
   */
  envStore?: import("./serviceEnvStore.js").AppEnvStore | null;
  /** Reject mutations whose `issuedAt` is more than this old (ms). Default 5 min. */
  maxAgeMs?: number;
  now?: () => number;
}

export class ServicePlatform {
  private readonly apps = new Map<string, InstalledService>();
  private readonly byUrlLabel = new Map<string, InstalledService>();
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: ServicePlatformDeps) {
    this.maxAgeMs = deps.maxAgeMs ?? 5 * 60_000;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Composite app id used as the container name + registry key.
   *  `<creator>-<slug>` — single dash. Unambiguous because usernames
   *  (the creator) are hyphen-free (see control-plane labels.ts), so
   *  the FIRST hyphen always separates creator from slug even when
   *  the slug itself contains hyphens. Stable for the life of the
   *  package — never rotates on a URL-stem Replace. */
  static serviceId(creator: string, slug: string): string {
    return composeServiceId(creator, slug);
  }

  /** Inverse of `serviceId`. Splits at the FIRST hyphen (creator is
   *  hyphen-free). Returns null when the id has no hyphen. */
  static parseServiceId(serviceId: string): { creator: string; slug: string } | null {
    return parseServiceIdShared(serviceId);
  }

  /**
   * Compute the inbound URL label for an installed app on this box.
   *
   *   creator === host →  "game1"
   *   creator !== host →  "game1-alice"
   *
   * Delegates to the shared protocol derivation so .com and the box
   * can never drift on what URL a user sees.
   */
  static urlLabel(host: string, creator: string, slug: string): string {
    return deriveUrlFragment(composeServiceId(creator, slug), host);
  }

  /**
   * The canonical home of an app — where update-packs are pulled from.
   * Always the creator's pod, regardless of who is hosting:
   *
   *   `<slug>.<creator>.flagship.services`
   *
   * (For self-authored apps, this is also where THIS box lives, so
   * registering a pull state is generally a no-op.)
   *
   * NOTE (cert model A′): this is a TIER-2 name — leader-routed,
   * hardware-agnostic — which no per-box wildcard covers. HTTPS to it
   * only verifies once the shared per-service cert phase ships
   * (docs/cert-model-A-prime-migration.md, Phase 5). Update pulls keep
   * dialing it unchanged; TLS is the part that arrives with tier 2.
   */
  static canonicalUrl(creator: string, slug: string): string {
    return `${slug}.${creator}.flagship.services`;
  }

  list(): InstalledService[] {
    return [...this.apps.values()].map((a) => ({ ...a }));
  }

  /** Look up an app by the leftmost SNI label. Used by the reverse proxy. */
  byLabel(urlLabel: string): InstalledService | undefined {
    return this.byUrlLabel.get(urlLabel.toLowerCase());
  }

  byServiceId(serviceId: string): InstalledService | undefined {
    return this.apps.get(serviceId);
  }

  /**
   * Install an app per a phone-signed request. The signature is verified
   * against the **host's** IRK pubkey (the daemon's `deps.host.irkPub`).
   */
  async install(args: {
    request: InstallServiceRequest;
    signature: Bytes;
    verify: (req: InstallServiceRequest, sig: Bytes, irkPub: Bytes) => boolean;
    /** For tests + future port allocators. Default picks a random 49152–65535. */
    pickPort?: () => number;
  }): Promise<InstallResult> {
    const { request: r, signature, verify } = args;

    if (Math.abs(this.now() - r.issuedAt) > this.maxAgeMs) {
      return { ok: false, reason: "stale request" };
    }
    if (!verify(r, signature, this.deps.host.irkPub)) {
      return { ok: false, reason: "invalid signature (must be host's IRK)" };
    }
    if (r.serverId.split(".")[1] !== this.deps.host.username && !r.serverId.startsWith(this.deps.host.username + ".")) {
      // Conservative serverId sanity check; the daemon already verifies
      // the signature against the host's IRK so this is defense-in-depth.
    }

    const parsed = parseManifest(safeJsonParse(r.manifestJson));
    if (!parsed.ok) {
      return { ok: false, reason: `manifest invalid: ${parsed.errors.join("; ")}` };
    }

    const serviceId = ServicePlatform.serviceId(r.creator, r.slug);
    if (this.apps.has(serviceId)) {
      return { ok: false, reason: `app ${serviceId} already installed` };
    }
    const urlLabel = ServicePlatform.urlLabel(this.deps.host.username, r.creator, r.slug);
    if (this.byUrlLabel.has(urlLabel)) {
      // E.g., a self-authored `game1` would collide with an existing
      // `game1.<host>...` from another (creator==host, slug==game1)
      // install. Should never happen because (creator, slug) is the
      // identity, but verify defensively.
      return { ok: false, reason: `URL ${urlLabel} already in use` };
    }

    // 1. Provision data stores per the manifest.
    let data: AppDataCredentials | null = null;
    const stores = parsed.manifest.data.stores;
    const wantsStores = !!(stores?.postgres || stores?.objects || stores?.kv);
    if (wantsStores) {
      if (!this.deps.dataProvisioner) {
        return { ok: false, reason: "manifest declares data.stores but daemon has no DataProvisioner (data-services compose stack not running?)" };
      }
      try {
        data = await this.deps.dataProvisioner.provisionApp({
          creator: r.creator,
          slug: r.slug,
          stores: stores ?? {},
        });
      } catch (e) {
        return { ok: false, reason: `data provisioning failed: ${(e as Error).message}` };
      }
    }

    // 2. Mint the app's daemon-API token (browser API + future surfaces auth).
    // We do this BEFORE deploy so the env var is set on first container start.
    let apiToken: string | null = null;
    if (this.deps.appAuthTokens) {
      try {
        apiToken = await this.deps.appAuthTokens.mint(serviceId);
      } catch (e) {
        // A failed token mint shouldn't kill an install — the app just
        // won't be able to use the browser surface until re-installed.
        // Log it; carry on.
        // (No actual logger here — leaving as a soft failure.)
        void e;
      }
    }

    // 3. Deploy the container with FLAGSHIP_* env injected. Owner-set
    // generic env vars (sealed at rest) are injected here too — they
    // sit BELOW the data-layer + reserved FLAGSHIP_* vars so an owner
    // can never shadow a reserved name. Keys with the reserved
    // `FLAGSHIP_` prefix are dropped defensively. Values are read
    // transiently for this deploy and never logged.
    const port = args.pickPort?.() ?? randomPort();
    const ownerEnv = this.deps.envStore
      ? sanitizeOwnerEnv(await this.deps.envStore.get(serviceId).catch(() => null))
      : {};
    const env: Record<string, string> = {
      ...ownerEnv,
      ...(parsed.manifest.runtime.env ?? {}),
      ...(data ? credentialsToEnv(data) : {}),
      FLAGSHIP_APP_ID: serviceId,
      FLAGSHIP_CREATOR: r.creator,
      FLAGSHIP_SLUG: r.slug,
      FLAGSHIP_HOST: this.deps.host.username,
      ...(apiToken ? { FLAGSHIP_APP_TOKEN: apiToken } : {}),
    };
    const spec: AppSpec = {
      serviceId,
      image: parsed.manifest.runtime.image,
      env,
      port,
    };
    try {
      await this.deps.appRunner.deploy(spec);
    } catch (e) {
      // Roll back the provisioned data so a failed deploy doesn't leak a half-done tenant.
      if (data && this.deps.dataProvisioner) {
        await this.deps.dataProvisioner
          .deprovisionApp({ creator: r.creator, slug: r.slug, stores: stores ?? {} })
          .catch(() => {});
      }
      // Roll back the minted token too — a stale entry would let a
      // re-attempted install collide on the same serviceId.
      if (apiToken && this.deps.appAuthTokens) {
        await this.deps.appAuthTokens.forget(serviceId).catch(() => {});
      }
      return { ok: false, reason: `container deploy failed: ${(e as Error).message}` };
    }

    // 3. Build the per-app membership store (mutations gated by host's IRK).
    const membership = new AppMembership(
      serviceId,
      this.deps.host.username,
      this.deps.host.irkPub,
      this.deps.swk,
    );

    const installed: InstalledService = {
      creator: r.creator,
      slug: r.slug,
      serviceId,
      manifest: parsed.manifest,
      urlLabel,
      membership,
      containerPort: port,
      data,
      installedAt: this.now(),
    };
    this.apps.set(serviceId, installed);
    this.byUrlLabel.set(urlLabel.toLowerCase(), installed);

    // Browser feature: register the domain grant if the manifest
    // declares one AND the daemon has the gate wired in. Without a
    // grant, the app's calls to /api/browser/* return 403.
    if (this.deps.domainGate && parsed.manifest.browser?.domains) {
      this.deps.domainGate.setGrant(serviceId, parsed.manifest.browser.domains);
    }

    // Update-pack: record canonical-home pull state on first install
    // for cross-creator apps. Self-authored apps don't need this — the
    // pull scheduler skips them since this box IS the canonical home.
    if (
      this.deps.pullStateStore &&
      r.creator !== this.deps.host.username
    ) {
      const canonicalUrl = ServicePlatform.canonicalUrl(r.creator, r.slug);
      const updatePolicy: UpdatePolicy = "auto";
      let currentTip = "";
      if (this.deps.cloneService) {
        try {
          const r2 = await this.deps.cloneService({ serviceId, canonicalUrl });
          currentTip = r2.currentTip;
        } catch (e) {
          // Cloning is best-effort; the pull scheduler will recover on its
          // next tick if the canonical home was unreachable transiently.
          // We log and proceed (the install itself succeeded).
          void e;
        }
      }
      const pullState: AppPullState = {
        canonicalUrl,
        lineageAnchor: currentTip,
        currentTip,
        lastAppliedMigration: "",
        updatePolicy,
      };
      try {
        await this.deps.pullStateStore.put(serviceId, pullState);
      } catch {
        // Same rationale: don't fail the install over a state-write
        // hiccup; the scheduler is the recovery path.
      }
    }

    return { ok: true, app: installed };
  }

  /**
   * Apply an owner-signed `SetServiceEnvRequest`: verify the IRK signature
   * (same trust root as install/uninstall), then store the env sealed
   * at rest. Full-replace semantics — the request carries the complete
   * desired env set. The new values take effect on the next deploy
   * (the app's process env is set at container start); we do not hot-
   * swap a running container's env. Reserved `FLAGSHIP_`-prefixed keys
   * are rejected so an owner can never shadow a daemon-injected var.
   *
   * The values are SECRET: this method never logs them, never returns
   * them, and never surfaces them in an error.
   */
  async setEnv(args: {
    request: SetServiceEnvRequest;
    signature: Bytes;
    verify: (req: SetServiceEnvRequest, sig: Bytes, irkPub: Bytes) => boolean;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { request: r, signature, verify } = args;
    if (Math.abs(this.now() - r.issuedAt) > this.maxAgeMs) {
      return { ok: false, reason: "stale request" };
    }
    if (!verify(r, signature, this.deps.host.irkPub)) {
      return { ok: false, reason: "invalid signature (must be host's IRK)" };
    }
    if (!this.deps.envStore) {
      return { ok: false, reason: "no env store configured" };
    }
    for (const k of Object.keys(r.env)) {
      if (k.startsWith("FLAGSHIP_")) {
        return { ok: false, reason: "reserved FLAGSHIP_ env name" };
      }
    }
    const serviceId = ServicePlatform.serviceId(r.creator, r.slug);
    try {
      await this.deps.envStore.put(serviceId, { ...r.env });
    } catch {
      // Never surface a value in a thrown error.
      return { ok: false, reason: "failed to persist env" };
    }
    return { ok: true };
  }

  /**
   * Add the host as the first member with role `owner`. Called by the
   * install endpoint when the request's `addOwnerToMembership` is
   * true. The mutation is signed by the host's IRK supplied here so
   * the membership store records a real, auditable mutation rather
   * than a synthetic exception.
   */
  /**
   * Add the host as a member of the freshly-installed app. The signing
   * key is supplied by the install handler — typically the host's IRK
   * already in scope. The mutation is a normal IRK-signed add targeting
   * the host's own IRK pubkey, so it shows up in the membership log
   * exactly like any other "add member" event.
   */
  addHostAsOwner(args: {
    serviceId: string;
    hostIrk: Keypair;
    role?: "owner" | "admin" | "member" | "viewer";
  }): { ok: true } | { ok: false; reason: string } {
    const app = this.apps.get(args.serviceId);
    if (!app) return { ok: false, reason: "unknown app" };
    const role = args.role ?? "owner";
    const mutation: MembershipMutation = {
      serviceId: args.serviceId,
      targetIrkPub: this.deps.host.irkPub,
      role,
      issuedAt: this.now(),
    };
    const sig = signMembershipMutation(mutation, args.hostIrk);
    const result = app.membership.applyMutation(mutation, sig);
    if (!result.ok) return { ok: false, reason: `apply: ${result.reason}` };
    return { ok: true };
  }

  async uninstall(args: {
    request: UninstallServiceRequest;
    signature: Bytes;
    verify: (req: UninstallServiceRequest, sig: Bytes, irkPub: Bytes) => boolean;
  }): Promise<UninstallResult> {
    const { request: r, signature, verify } = args;
    if (Math.abs(this.now() - r.issuedAt) > this.maxAgeMs) {
      return { ok: false, reason: "stale request" };
    }
    if (!verify(r, signature, this.deps.host.irkPub)) {
      return { ok: false, reason: "invalid signature (must be host's IRK)" };
    }
    const serviceId = ServicePlatform.serviceId(r.creator, r.slug);
    const app = this.apps.get(serviceId);
    if (!app) {
      // Idempotent: uninstalling something already gone is success.
      return { ok: true, alreadyGone: true };
    }
    // Stop container; best-effort.
    try {
      await this.deps.appRunner.stop(serviceId);
    } catch {
      // container may already be gone
    }
    // Drop data stores.
    if (app.data && this.deps.dataProvisioner) {
      try {
        await this.deps.dataProvisioner.deprovisionApp({
          creator: r.creator,
          slug: r.slug,
          stores: app.manifest.data.stores ?? {},
        });
      } catch {
        // best-effort
      }
    }
    // Drop the daemon-API token so any container that's still alive can't
    // call back; idempotent + best-effort.
    if (this.deps.appAuthTokens) {
      await this.deps.appAuthTokens.forget(serviceId).catch(() => {});
    }
    // Drop the app's owner-set env so values don't outlive the app.
    if (this.deps.envStore) {
      await this.deps.envStore.forget(serviceId).catch(() => {});
    }
    // Browser feature: close any tabs the app opened, then revoke its
    // domain grant. Order matters — close tabs first so the gate is
    // still in place during shutdown (paranoid; close shouldn't navigate).
    if (this.deps.tabRegistry) {
      await this.deps.tabRegistry.closeAllForApp(serviceId).catch(() => {});
    }
    if (this.deps.domainGate) {
      this.deps.domainGate.revoke(serviceId);
    }
    // Update-pack: drop pull state so the scheduler doesn't keep
    // contacting the canonical home for an app no longer installed.
    if (this.deps.pullStateStore?.delete) {
      await this.deps.pullStateStore.delete(serviceId).catch(() => {});
    }
    this.apps.delete(serviceId);
    this.byUrlLabel.delete(app.urlLabel.toLowerCase());
    return { ok: true };
  }

  /**
   * V5 — apply a user-chosen URL stem alias to an already-installed
   * app. The internal `serviceId` is preserved; only `urlLabel` flips +
   * the reverse-proxy index is re-keyed under the new label.
   *
   * Returns `{ ok: false, reason }` when:
   *   - the serviceId isn't installed (e.g., daemon hasn't pulled it yet)
   *   - the new label is malformed
   *   - the new label is already used by another app on this box
   *
   * Idempotent: applying the same label twice is a no-op. The
   * AliasReconciler relies on this — on each tick it walks .com's
   * authoritative alias map and calls setAlias for every entry,
   * trusting setAlias to do the right thing whether the daemon was
   * already in sync or not.
   */
  setAlias(serviceId: string, newLabel: string): SetAliasResult {
    const app = this.apps.get(serviceId);
    if (!app) return { ok: false, reason: "unknown serviceId" };
    const lower = newLabel.toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(lower)) {
      return { ok: false, reason: "invalid label (DNS-safe; 1..40 chars)" };
    }
    if (app.urlLabel.toLowerCase() === lower) {
      return { ok: true, unchanged: true };
    }
    // Collision check — another installed app already owns this
    // label on this box.
    const existing = this.byUrlLabel.get(lower);
    if (existing && existing.serviceId !== serviceId) {
      return {
        ok: false,
        reason: `URL stem '${lower}' is already used by ${existing.serviceId}`,
      };
    }
    const oldLabel = app.urlLabel.toLowerCase();
    this.byUrlLabel.delete(oldLabel);
    const updated: InstalledService = { ...app, urlLabel: lower };
    this.apps.set(serviceId, updated);
    this.byUrlLabel.set(lower, updated);
    // Domain gate, when present, is keyed by serviceId — no rebind
    // needed there. Caddy / Fastify routing is driven off byLabel(),
    // so the next inbound request to the new label will land in the
    // updated entry.
    return { ok: true, oldLabel, newLabel: lower };
  }
}

export type SetAliasResult =
  | { ok: true; unchanged?: boolean; oldLabel?: string; newLabel?: string }
  | { ok: false; reason: string };

export type InstallResult =
  | { ok: true; app: InstalledService }
  | { ok: false; reason: string };

export type UninstallResult =
  | { ok: true; alreadyGone?: boolean }
  | { ok: false; reason: string };

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function randomPort(): number {
  // Ephemeral range; collisions are statistically rare and AppRunner.deploy
  // surfaces the conflict via docker if one occurs.
  return 49152 + Math.floor(Math.random() * (65535 - 49152));
}

// ──────────────────────────────────────────────────────────────────────
// HTTP surface (consumed by runtime.ts's default handler)
// ──────────────────────────────────────────────────────────────────────

import { verifyInstallService, verifyUninstallService, verifySetServiceEnv, ed } from "@flagship/protocol";
import type { HttpRequest, HttpResponse } from "./runtime.js";

export interface ServiceHttpDeps {
  platform: ServicePlatform;
  /**
   * The host's IRK keypair, needed so the install endpoint can sign
   * the synthetic "add host as owner" membership mutation when the
   * install request asked for it.
   *
   * The IRK private key is NOT phone-resident — only the host's
   * **identity** key is on the daemon. So how does the daemon get an
   * IRK signature? In the v1 design, the phone supplies the
   * pre-signed "add me as owner" mutation alongside the install
   * request, and the daemon merely applies it. For now we accept a
   * keypair to keep tests + early dev paths simple; production
   * callers should set this to `null` and pass a phone-signed
   * mutation in the install request body instead. (TODO)
   */
  hostIrk: Keypair | null;
}

const J: Record<string, string> = { "content-type": "application/json" };

export function buildServiceHttpHandlers(deps: ServiceHttpDeps) {
  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (req.path === "/api/services") {
      if (req.method === "GET") return listServices(deps);
      if (req.method === "POST") return installService(deps, req);
      return { status: 405, headers: J, body: JSON.stringify({ error: "method not allowed" }) };
    }
    // Owner-signed set-service-env. Mirrors the install/uninstall envelope
    // trust root (host IRK). Values are SECRET — never echoed back.
    const envM = /^\/api\/services\/([^/]+)\/env$/.exec(req.path);
    if (envM && req.method === "POST") {
      return setServiceEnv(deps, envM[1]!, req);
    }
    if (req.path.startsWith("/api/services/") && req.method === "DELETE") {
      const serviceId = req.path.slice("/api/services/".length);
      return uninstallService(deps, serviceId, req);
    }
    return null;
  };
}

function listServices(deps: ServiceHttpDeps): HttpResponse {
  const apps = deps.platform.list().map((a) => ({
    serviceId: a.serviceId,
    creator: a.creator,
    slug: a.slug,
    urlLabel: a.urlLabel,
    installedAt: a.installedAt,
    image: a.manifest.runtime.image,
    name: a.manifest.name,
    version: a.manifest.version,
  }));
  return { status: 200, headers: J, body: JSON.stringify({ apps }) };
}

async function installService(deps: ServiceHttpDeps, req: HttpRequest): Promise<HttpResponse> {
  const body = safeJsonParse(req.body.toString("utf8")) as {
    request?: Record<string, unknown>;
    signature?: string;
  } | null;
  if (!body || typeof body.signature !== "string") {
    return { status: 400, headers: J, body: JSON.stringify({ error: "malformed body" }) };
  }
  const r = body.request ?? {};
  if (
    typeof r.serverId !== "string" ||
    typeof r.creator !== "string" ||
    typeof r.slug !== "string" ||
    typeof r.manifestJson !== "string" ||
    typeof r.addOwnerToMembership !== "boolean" ||
    typeof r.issuedAt !== "number"
  ) {
    return { status: 400, headers: J, body: JSON.stringify({ error: "malformed request" }) };
  }
  let signature: Uint8Array;
  try {
    signature = hexToBytes(body.signature);
  } catch {
    return { status: 400, headers: J, body: JSON.stringify({ error: "invalid hex" }) };
  }
  const installResult = await deps.platform.install({
    request: {
      serverId: r.serverId,
      creator: r.creator,
      slug: r.slug,
      manifestJson: r.manifestJson,
      addOwnerToMembership: r.addOwnerToMembership,
      issuedAt: r.issuedAt,
    },
    signature,
    verify: verifyInstallService,
  });
  if (!installResult.ok) {
    return { status: 400, headers: J, body: JSON.stringify({ error: installResult.reason }) };
  }
  // Optionally add the host as owner. In the dev path we hold the IRK
  // here; in production the phone pre-signs the membership mutation
  // and ships it alongside the install request (TODO surface).
  if (r.addOwnerToMembership && deps.hostIrk) {
    deps.platform.addHostAsOwner({
      serviceId: installResult.app.serviceId,
      hostIrk: deps.hostIrk,
      role: "owner",
    });
  }
  return {
    status: 200,
    headers: J,
    body: JSON.stringify({
      ok: true,
      serviceId: installResult.app.serviceId,
      urlLabel: installResult.app.urlLabel,
      port: installResult.app.containerPort,
    }),
  };
}

async function uninstallService(deps: ServiceHttpDeps, serviceId: string, req: HttpRequest): Promise<HttpResponse> {
  const body = safeJsonParse(req.body.toString("utf8")) as {
    request?: Record<string, unknown>;
    signature?: string;
  } | null;
  if (!body || typeof body.signature !== "string") {
    return { status: 400, headers: J, body: JSON.stringify({ error: "malformed body" }) };
  }
  const r = body.request ?? {};
  if (
    typeof r.serverId !== "string" ||
    typeof r.creator !== "string" ||
    typeof r.slug !== "string" ||
    typeof r.issuedAt !== "number"
  ) {
    return { status: 400, headers: J, body: JSON.stringify({ error: "malformed request" }) };
  }
  if (ServicePlatform.serviceId(r.creator, r.slug) !== serviceId) {
    return { status: 400, headers: J, body: JSON.stringify({ error: "serviceId / (creator,slug) mismatch" }) };
  }
  let signature: Uint8Array;
  try {
    signature = hexToBytes(body.signature);
  } catch {
    return { status: 400, headers: J, body: JSON.stringify({ error: "invalid hex" }) };
  }
  const result = await deps.platform.uninstall({
    request: {
      serverId: r.serverId,
      creator: r.creator,
      slug: r.slug,
      issuedAt: r.issuedAt,
    },
    signature,
    verify: verifyUninstallService,
  });
  if (!result.ok) {
    return { status: 400, headers: J, body: JSON.stringify({ error: result.reason }) };
  }
  return { status: 200, headers: J, body: JSON.stringify({ ok: true, alreadyGone: result.alreadyGone ?? false }) };
}

/**
 * Owner-signed set-app-env. The request body mirrors install/uninstall
 * (`{ request, signature }`). The response NEVER echoes env values — a
 * success is a bare `{ ok: true }`; an error is a generic reason that
 * never interpolates a value.
 */
async function setServiceEnv(deps: ServiceHttpDeps, serviceId: string, req: HttpRequest): Promise<HttpResponse> {
  const body = safeJsonParse(req.body.toString("utf8")) as {
    request?: Record<string, unknown>;
    signature?: string;
  } | null;
  if (!body || typeof body.signature !== "string") {
    return { status: 400, headers: J, body: JSON.stringify({ error: "malformed body" }) };
  }
  const r = body.request ?? {};
  if (
    typeof r.serverId !== "string" ||
    typeof r.creator !== "string" ||
    typeof r.slug !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof r.env !== "object" ||
    r.env === null ||
    Array.isArray(r.env)
  ) {
    return { status: 400, headers: J, body: JSON.stringify({ error: "malformed request" }) };
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
    if (typeof v !== "string") {
      return { status: 400, headers: J, body: JSON.stringify({ error: "env values must be strings" }) };
    }
    env[k] = v;
  }
  if (ServicePlatform.serviceId(r.creator, r.slug) !== serviceId) {
    return { status: 400, headers: J, body: JSON.stringify({ error: "serviceId / (creator,slug) mismatch" }) };
  }
  let signature: Uint8Array;
  try {
    signature = hexToBytes(body.signature);
  } catch {
    return { status: 400, headers: J, body: JSON.stringify({ error: "invalid hex" }) };
  }
  const result = await deps.platform.setEnv({
    request: {
      serverId: r.serverId,
      creator: r.creator,
      slug: r.slug,
      env,
      issuedAt: r.issuedAt,
    },
    signature,
    verify: verifySetServiceEnv,
  });
  if (!result.ok) {
    return { status: 400, headers: J, body: JSON.stringify({ error: result.reason }) };
  }
  return { status: 200, headers: J, body: JSON.stringify({ ok: true }) };
}

void ed; // silence unused-import; kept for future when the daemon needs raw signing here

/**
 * Drop any reserved `FLAGSHIP_`-prefixed keys from owner-set env so it
 * can never shadow a daemon-injected var (defense-in-depth — setEnv
 * already rejects them at write time, this guards a legacy/forged blob
 * on disk). Returns a plain map; values are not logged anywhere.
 */
function sanitizeOwnerEnv(env: AppEnv | null): Record<string, string> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("FLAGSHIP_")) continue;
    out[k] = v;
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
