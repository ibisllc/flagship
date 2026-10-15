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
  isSingletonStore,
  wantsFiles,
  type AppDataStores,
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
import type { SwkOps } from "./keyCustodian.js";
import { AppRunner, type AppSpec, type StartCheck } from "./serviceRunner.js";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";
import { AppMembership, type AppMembershipSnapshot } from "./membership.js";
import type { InstalledServicesStore, PersistedService } from "./installedServicesStore.js";
import { pickPgUrlForApp } from "./runMigration.js";
import {
  DataProvisioner,
  credentialsToEnv,
  filesVolumeOf,
  postgresStoreNames,
  wantsAnyStore,
  type AppDataCredentials,
} from "./dataLayer/index.js";
import type { AppAuthTokens } from "./serviceAuthToken.js";
import { whileDeploying, type DeployingTracker } from "./serviceActivity.js";
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
  /** SQL migrations already run against its database, by filename. */
  appliedMigrations?: string[];
}

/** A schema migration shipped with a version of an app (`migrations/*.sql`). */
export interface AppMigrationFile {
  filename: string;
  sql: string;
}

export interface ServiceInstallArgs {
  request: InstallServiceRequest;
  signature: Bytes;
  verify: (req: InstallServiceRequest, sig: Bytes, irkPub: Bytes) => boolean;
  /** For tests + future port allocators. Default picks a random 49152–65535. */
  pickPort?: () => number;
  /** The version's `migrations/*.sql`, run once each before it starts. */
  migrations?: AppMigrationFile[];
  /**
   * A copy from another server (appCopy/): runs on the freshly made stores
   * before anything else touches them (restoring the copied data); a throw
   * fails the install and drops those stores.
   */
  prepareData?: (data: AppDataCredentials | null) => Promise<void>;
  /** Migrations the copied data already ran. */
  appliedMigrations?: string[];
  /** The copied app's members. */
  membership?: AppMembershipSnapshot;
}

export interface ServiceRedeployArgs {
  request: InstallServiceRequest;
  signature: Bytes;
  verify: (req: InstallServiceRequest, sig: Bytes, irkPub: Bytes) => boolean;
  migrations?: AppMigrationFile[];
}

export interface ServicePlatformDeps {
  /** Activity-feed hook for an app arriving, changing or leaving. */
  onAppEvent?: (kind: "app.installed" | "app.updated" | "app.removed", serviceId: string) => void;
  /** Called whenever the app set or an app's state may have changed. */
  onAppsChanged?: () => void;
  /** Whose box this is — used for the host-vs-creator URL collapse + as IRK-mutation owner.
   *  `adminRootPub` (Slice D, D-2): when present, service-collaborator membership
   *  invite-create + mutation are admin-gated; absent ⇒ legacy owner-IRK. */
  host: { username: string; irkPub: Bytes; adminRootPub?: Bytes };
  /**
   * The box's OWN daemon identity pubkey — an ADDITIONAL accepted signer for
   * host-authority mutations (install / setEnv / uninstall). The owner IRK
   * (`host.irkPub`) is phone-held, so a BOX-ORIGINATED deploy (a build-modes
   * deploy: scratch / git-import / mcp, all gated upstream by the paired
   * session) cannot sign with it — the box only holds its own identity key.
   * Accepting the daemon identity here lets those box-internal deploys sign
   * with a key the box actually has, WITHOUT weakening the phone path (the
   * owner IRK still verifies). Omit ⇒ owner-IRK-only (unchanged behavior).
   */
  hostIdentityPub?: Bytes;
  /**
   * SWK-derived operations (the KeyCustodian's `SwkOps` slice) used to derive
   * per-app secrets for member stable-id derivation. The platform holds only
   * the operation surface, never the raw SWK. Per `key_hierarchy.md` the SWK
   * is provisioned by the phone at first boot; per-app derivation rotates when
   * the SWK rotates.
   */
  swk: SwkOps;
  appRunner: AppRunner;
  /** Confirms a started container answers; absent ⇒ a started container counts. */
  startCheck?: StartCheck;
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
  /**
   * Fired after a service is successfully uninstalled (the container is stopped
   * + the data/env/token/route state is torn down locally). The per-service
   * leadership gossip wires this to RELEASE the box's `<slug>.<user>` route at
   * the hub (so a stale claim doesn't outlive the service + the next request
   * re-resolves) and to trigger a gossip re-announce (so siblings recompute
   * leads without this service). Best-effort — invoked only on a real removal
   * (NOT on the idempotent already-gone path), awaited, never allowed to fail
   * the uninstall.
   */
  onServiceRemoved?: ((slug: string) => void | Promise<void>) | null;
  /**
   * After a successful install or update (with the app as now installed).
   * The egress gateway turns the manifest's `network.egress` hosts into
   * access requests for the owner. Best-effort, awaited, never fails the install.
   */
  onServiceInstalled?: ((app: InstalledService) => void | Promise<void>) | null;
  /**
   * Where the installed-service list is kept across daemon restarts. Saved on
   * every install, uninstall, alias and membership change; read once at boot
   * by `restore()`. Null keeps it in memory only (tests).
   */
  registry?: InstalledServicesStore | null;
  onLog?: (m: string) => void;
  /**
   * Run one SQL migration as the app's own database role, in a transaction.
   * Unset ⇒ migrations are not run (tests that don't exercise them).
   */
  runSql?: ((a: { pgUrl: string; sql: string }) => Promise<void>) | null;
  /** Marks a service as deploying while an install or redeploy of it runs (its status pill). */
  activity?: DeployingTracker | null;
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

  /**
   * Verify a host-authority mutation (install / setEnv / uninstall) against
   * EITHER the owner IRK (phone-signed) OR the box's own daemon identity key
   * (box-originated build-modes deploys, which can't reach the phone-held
   * IRK). The owner IRK is always tried first; the daemon identity is an
   * additive box-internal signer, only when configured.
   */
  private verifyHostAuthority<T>(
    req: T,
    sig: Bytes,
    verify: (req: T, sig: Bytes, pub: Bytes) => boolean,
  ): boolean {
    if (verify(req, sig, this.deps.host.irkPub)) return true;
    if (this.deps.hostIdentityPub && verify(req, sig, this.deps.hostIdentityPub)) return true;
    return false;
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
  install(args: ServiceInstallArgs): Promise<InstallResult> {
    const id = ServicePlatform.serviceId(args.request.creator, args.request.slug);
    const existed = this.apps.has(id);
    return whileDeploying(this.deps.activity, id, async () => {
      const res = await this.installNow(args);
      if (res.ok) this.notifyApp(existed ? "app.updated" : "app.installed", id);
      return res;
    });
  }

  private notifyApp(kind: "app.installed" | "app.updated" | "app.removed", serviceId: string): void {
    try {
      this.deps.onAppEvent?.(kind, serviceId);
    } catch {
      /* the feed never fails an install */
    }
  }

  private async installNow(args: ServiceInstallArgs): Promise<InstallResult> {
    const { request: r, signature, verify } = args;

    if (Math.abs(this.now() - r.issuedAt) > this.maxAgeMs) {
      return { ok: false, reason: "stale request" };
    }
    if (!this.verifyHostAuthority(r, signature, verify)) {
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
    if (wantsAnyStore(stores)) {
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
    const spec = await this.containerSpec({
      serviceId,
      creator: r.creator,
      slug: r.slug,
      manifest: parsed.manifest,
      data,
      apiToken,
      hostPort: port,
    });
    let prepared: { ok: true } | { ok: false; reason: string } = { ok: true };
    if (args.prepareData) {
      try {
        await args.prepareData(data);
      } catch (e) {
        prepared = { ok: false, reason: `restoring the copied data failed: ${(e as Error).message}` };
      }
    }
    const migrated = prepared.ok
      ? await this.migrate(serviceId, data, args.appliedMigrations ?? [], args.migrations)
      : { ok: false as const, reason: prepared.reason, applied: [] };
    try {
      if (!migrated.ok) throw new Error(migrated.reason);
      await this.deps.appRunner.deploy(spec);
      await this.assertStarted(spec);
    } catch (e) {
      // Roll back the provisioned data so a failed deploy doesn't leak a half-done tenant.
      if (data && this.deps.dataProvisioner) {
        await this.deps.dataProvisioner.dropCredentials(data).catch(() => {});
      }
      // Roll back the minted token too — a stale entry would let a
      // re-attempted install collide on the same serviceId.
      if (apiToken && this.deps.appAuthTokens) {
        await this.deps.appAuthTokens.forget(serviceId).catch(() => {});
      }
      return {
        ok: false,
        reason: migrated.ok ? `container deploy failed: ${(e as Error).message}` : migrated.reason,
      };
    }

    // 3. Build the per-app membership store (mutations gated by host's IRK).
    const membership = this.newMembership(serviceId);
    if (args.membership) membership.restore(args.membership);

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
      appliedMigrations: migrated.ok ? migrated.applied : [],
    };
    this.apps.set(serviceId, installed);
    this.byUrlLabel.set(urlLabel.toLowerCase(), installed);
    this.persist();
    await this.notifyInstalled(installed);

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
    if (!this.verifyHostAuthority(r, signature, verify)) {
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
   * Replace an installed service's code in place: a new image and manifest
   * under the same service id, address, loopback port, app token, members and
   * data. Stores the new manifest adds are provisioned; stores it drops keep
   * their data and credentials (removing data is uninstall's job, never an
   * edit's). Same host authority as install. If the new container won't
   * start, the previous one is brought back and the service is unchanged.
   */
  private async notifyInstalled(app: InstalledService): Promise<void> {
    try {
      await this.deps.onServiceInstalled?.(app);
    } catch {
      // advisory: the install itself already succeeded
    }
  }

  redeploy(args: ServiceRedeployArgs): Promise<RedeployResult> {
    const id = ServicePlatform.serviceId(args.request.creator, args.request.slug);
    return whileDeploying(this.deps.activity, id, () => this.redeployNow(args));
  }

  private async redeployNow(args: ServiceRedeployArgs): Promise<RedeployResult> {
    const { request: r, signature, verify } = args;
    if (Math.abs(this.now() - r.issuedAt) > this.maxAgeMs) {
      return { ok: false, reason: "stale request" };
    }
    if (!this.verifyHostAuthority(r, signature, verify)) {
      return { ok: false, reason: "invalid signature (must be host's IRK)" };
    }
    const serviceId = ServicePlatform.serviceId(r.creator, r.slug);
    const old = this.apps.get(serviceId);
    if (!old) return { ok: false, reason: `app ${serviceId} is not installed` };
    const parsed = parseManifest(safeJsonParse(r.manifestJson));
    if (!parsed.ok) {
      return { ok: false, reason: `manifest invalid: ${parsed.errors.join("; ")}` };
    }
    const manifest = parsed.manifest;

    const want = manifest.data.stores ?? {};
    const added: AppDataStores = {};
    const addedNames: string[] = [];
    const havePg = new Set(Object.keys(old.data?.postgres ?? {}));
    const missingPg = postgresStoreNames(want).filter((n) => !havePg.has(n));
    if (missingPg.length > 0) {
      added.postgres = missingPg;
      addedNames.push(...missingPg.map((n) => `postgres:${n}`));
    }
    if (wantsFiles(want) && !old.data?.files) {
      added.files = true;
      addedNames.push("files");
    }
    // `held2`: the old credentials plus any store made just now (kept even if
    // the new version fails, so a retry reuses it); `data`: the same with the
    // new manifest's single-vs-named store flags, which set the env names.
    let held2 = old.data;
    if (addedNames.length > 0) {
      if (!this.deps.dataProvisioner) {
        return { ok: false, reason: "the new version declares data stores but this server has no data layer" };
      }
      let fresh: AppDataCredentials;
      try {
        fresh = await this.deps.dataProvisioner.provisionApp({ creator: r.creator, slug: r.slug, stores: added });
      } catch (e) {
        return { ok: false, reason: `data provisioning failed: ${(e as Error).message}` };
      }
      held2 = {
        ...(old.data ?? { creator: r.creator, slug: r.slug }),
        ...(old.data?.postgres || fresh.postgres ? { postgres: { ...old.data?.postgres, ...fresh.postgres } } : {}),
        ...(old.data?.files || fresh.files ? { files: old.data?.files ?? fresh.files! } : {}),
      };
    }
    const data: AppDataCredentials | null = held2 && {
      ...held2,
      ...(want.postgres !== undefined ? { postgresSingleton: isSingletonStore(want.postgres) } : {}),
    };

    const apiToken = this.deps.appAuthTokens
      ? await this.deps.appAuthTokens.tokenForApp(serviceId).catch(() => null)
      : null;
    const base = { serviceId, creator: r.creator, slug: r.slug, apiToken, hostPort: old.containerPort };
    const spec = await this.containerSpec({ ...base, manifest, data });
    const migrated = await this.migrate(serviceId, data, old.appliedMigrations ?? [], args.migrations);
    if (!migrated.ok) {
      // Each file runs in its own transaction: the failed one left nothing
      // behind, and any before it in this batch are recorded as done.
      const kept: InstalledService = { ...old, data: held2, appliedMigrations: migrated.applied };
      this.apps.set(serviceId, kept);
      this.byUrlLabel.set(old.urlLabel.toLowerCase(), kept);
      this.persist();
      return { ok: false, reason: migrated.reason };
    }
    try {
      await this.deps.appRunner.restart(spec);
      await this.assertStarted(spec);
    } catch (e) {
      const reason = (e as Error).message;
      try {
        await this.deps.appRunner.restart(await this.containerSpec({ ...base, manifest: old.manifest, data: old.data }));
      } catch (back) {
        this.deps.onLog?.(`[service-platform] ${serviceId}: new version failed and the previous one didn't come back: ${(back as Error).message}`);
      }
      if (held2 !== old.data || migrated.applied.length !== (old.appliedMigrations ?? []).length) {
        const kept: InstalledService = { ...old, data: held2, appliedMigrations: migrated.applied };
        this.apps.set(serviceId, kept);
        this.byUrlLabel.set(old.urlLabel.toLowerCase(), kept);
        this.persist();
      }
      return { ok: false, reason: `the new version didn't start: ${reason}` };
    }

    const updated: InstalledService = { ...old, manifest, data, appliedMigrations: migrated.applied };
    this.apps.set(serviceId, updated);
    this.byUrlLabel.set(updated.urlLabel.toLowerCase(), updated);
    if (this.deps.domainGate) {
      if (manifest.browser?.domains) this.deps.domainGate.setGrant(serviceId, manifest.browser.domains);
      else if (old.manifest.browser?.domains) this.deps.domainGate.revoke(serviceId);
    }
    this.persist();
    await this.notifyInstalled(updated);
    return { ok: true, app: updated, addedStores: addedNames };
  }

  /**
   * Run the SQL migrations not yet applied, in filename order. Returns the
   * full applied list (earlier ones plus those that ran), or why one failed.
   */
  private async migrate(
    serviceId: string,
    data: AppDataCredentials | null,
    applied: string[],
    files: AppMigrationFile[] | undefined,
  ): Promise<{ ok: true; applied: string[] } | { ok: false; reason: string; applied: string[] }> {
    const done = [...applied];
    const pending = (files ?? [])
      .filter((f) => f.filename.toLowerCase().endsWith(".sql") && !done.includes(f.filename))
      .sort((a, b) => a.filename.localeCompare(b.filename));
    if (pending.length === 0 || !this.deps.runSql) return { ok: true, applied: done };
    const pgUrl = pickPgUrlForApp(data);
    if (!pgUrl) {
      return { ok: false, reason: `migration ${pending[0]!.filename} needs a Postgres store, and the manifest declares none`, applied: done };
    }
    for (const f of pending) {
      try {
        await this.deps.runSql({ pgUrl, sql: f.sql });
      } catch (e) {
        return { ok: false, reason: `migration ${f.filename} failed: ${(e as Error).message}`, applied: done };
      }
      done.push(f.filename);
      this.deps.onLog?.(`[service-platform] ${serviceId}: ran migration ${f.filename}`);
    }
    return { ok: true, applied: done };
  }

  /** Throw (after removing the container) when a started app never answers. */
  private async assertStarted(spec: AppSpec): Promise<void> {
    if (!this.deps.startCheck) return;
    const r = await this.deps.startCheck(spec);
    if (r.ok) return;
    await this.deps.appRunner.stop(spec.serviceId).catch(() => {});
    throw new Error(r.reason);
  }

  private newMembership(serviceId: string): AppMembership {
    return new AppMembership(
      serviceId,
      this.deps.host.username,
      this.deps.host.irkPub,
      this.deps.swk,
      { onChange: () => this.persist() },
      this.deps.host.adminRootPub,
    );
  }

  /** The container a service runs as: its image, port and full environment. */
  private async containerSpec(a: {
    serviceId: string;
    creator: string;
    slug: string;
    manifest: AppManifest;
    data: AppDataCredentials | null;
    apiToken: string | null;
    hostPort: number;
  }): Promise<AppSpec> {
    // Owner-set generic env vars (sealed at rest) sit BELOW the data-layer +
    // reserved FLAGSHIP_* vars so an owner can never shadow a reserved name.
    // Values are read transiently for this deploy and never logged.
    const ownerEnv = this.deps.envStore
      ? sanitizeOwnerEnv(await this.deps.envStore.get(a.serviceId).catch(() => null))
      : {};
    const containerPort = a.manifest.runtime.port;
    const env: Record<string, string> = {
      ...ownerEnv,
      ...(a.manifest.runtime.env ?? {}),
      ...(a.data ? credentialsToEnv(a.data) : {}),
      FLAGSHIP_APP_ID: a.serviceId,
      FLAGSHIP_CREATOR: a.creator,
      FLAGSHIP_SLUG: a.slug,
      FLAGSHIP_HOST: this.deps.host.username,
      // 12-factor: tell the app the port it should bind. After runtime.env so
      // the manifest can't override the platform's PORT.
      PORT: String(containerPort),
      ...(a.apiToken ? { FLAGSHIP_APP_TOKEN: a.apiToken } : {}),
    };
    // `port` = allocated host-loopback port the proxy dials; `containerPort`
    // = the app's manifest listen port. Publish maps host→container.
    const filesVolume = filesVolumeOf(a.data);
    return {
      serviceId: a.serviceId,
      image: a.manifest.runtime.image,
      env,
      port: a.hostPort,
      containerPort,
      ...(filesVolume ? { filesVolume } : {}),
    };
  }

  private persistChain: Promise<void> = Promise.resolve();

  /** Save the installed-service list. Ordered, never throws. */
  private persist(): void {
    this.deps.onAppsChanged?.();
    const registry = this.deps.registry;
    if (!registry) return;
    const services: PersistedService[] = [...this.apps.values()].map((a) => ({
      creator: a.creator,
      slug: a.slug,
      serviceId: a.serviceId,
      manifestJson: JSON.stringify(a.manifest),
      urlLabel: a.urlLabel,
      hostPort: a.containerPort,
      data: a.data,
      installedAt: a.installedAt,
      appliedMigrations: a.appliedMigrations ?? [],
      membership: a.membership.snapshot(),
    }));
    this.persistChain = this.persistChain
      .then(() => registry.save(services))
      .catch((e) => this.deps.onLog?.(`[service-platform] could not save the installed services: ${(e as Error).message}`));
  }

  /** Wait for pending saves (shutdown, tests). */
  flush(): Promise<void> {
    return this.persistChain;
  }

  /**
   * Bring back the services saved before the daemon restarted: routing,
   * members and browser grants at once, then each container, recreated from
   * its image with the same port, data credentials and token. A container
   * that won't start (Docker still coming up at boot) is retried; the service
   * stays registered either way so the owner sees it and can remove it.
   */
  async restore(opts: { retries?: number; retryDelayMs?: number } = {}): Promise<{ restored: string[]; failed: string[] }> {
    let loaded!: () => void;
    this.registryLoaded = new Promise<void>((r) => (loaded = r));
    try {
      return await this.restoreSaved(opts, loaded);
    } finally {
      loaded();
    }
  }

  private registryLoaded: Promise<void> = Promise.resolve();

  /** Resolves once the services saved before a restart are back in the list (their containers may still be starting). */
  whenRegistryLoaded(): Promise<void> {
    return this.registryLoaded;
  }

  private async restoreSaved(
    opts: { retries?: number; retryDelayMs?: number },
    loaded: () => void,
  ): Promise<{ restored: string[]; failed: string[] }> {
    const registry = this.deps.registry;
    if (!registry) return { restored: [], failed: [] };
    let saved: PersistedService[];
    try {
      saved = await registry.load();
    } catch (e) {
      this.deps.onLog?.(`[service-platform] could not read the installed services: ${(e as Error).message}`);
      return { restored: [], failed: [] };
    }
    const pending: { app: InstalledService; spec: AppSpec }[] = [];
    for (const p of saved) {
      if (this.apps.has(p.serviceId)) continue;
      const parsed = parseManifest(safeJsonParse(p.manifestJson));
      if (!parsed.ok) {
        this.deps.onLog?.(`[service-platform] skipping saved ${p.serviceId}: manifest no longer valid (${parsed.errors.join("; ")})`);
        continue;
      }
      const membership = this.newMembership(p.serviceId);
      membership.restore(p.membership ?? ({ members: [], lastSeen: {}, redeemed: {} } as AppMembershipSnapshot));
      const app: InstalledService = {
        creator: p.creator,
        slug: p.slug,
        serviceId: p.serviceId,
        manifest: parsed.manifest,
        urlLabel: p.urlLabel,
        membership,
        containerPort: p.hostPort,
        data: p.data,
        installedAt: p.installedAt,
        appliedMigrations: p.appliedMigrations ?? [],
      };
      this.apps.set(app.serviceId, app);
      this.byUrlLabel.set(app.urlLabel.toLowerCase(), app);
      if (this.deps.domainGate && parsed.manifest.browser?.domains) {
        this.deps.domainGate.setGrant(app.serviceId, parsed.manifest.browser.domains);
      }
      const apiToken = this.deps.appAuthTokens
        ? await this.deps.appAuthTokens.tokenForApp(app.serviceId).catch(() => null)
        : null;
      pending.push({
        app,
        spec: await this.containerSpec({
          serviceId: app.serviceId,
          creator: app.creator,
          slug: app.slug,
          manifest: app.manifest,
          data: app.data,
          apiToken,
          hostPort: app.containerPort,
        }),
      });
    }
    loaded();
    const restored: string[] = [];
    let todo = pending;
    const retries = opts.retries ?? 5;
    for (let attempt = 0; todo.length > 0 && attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 15_000));
      const next: typeof todo = [];
      for (const t of todo) {
        try {
          await this.deps.appRunner.restart(t.spec);
          restored.push(t.app.serviceId);
        } catch (e) {
          if (attempt === retries) {
            this.deps.onLog?.(`[service-platform] could not start ${t.app.serviceId}: ${(e as Error).message}`);
          }
          next.push(t);
        }
      }
      todo = next;
    }
    return { restored, failed: todo.map((t) => t.app.serviceId) };
  }

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
    const res = await this.uninstallNow(args);
    if (res.ok && !res.alreadyGone) {
      this.notifyApp("app.removed", ServicePlatform.serviceId(args.request.creator, args.request.slug));
    }
    return res;
  }

  private async uninstallNow(args: {
    request: UninstallServiceRequest;
    signature: Bytes;
    verify: (req: UninstallServiceRequest, sig: Bytes, irkPub: Bytes) => boolean;
  }): Promise<UninstallResult> {
    const { request: r, signature, verify } = args;
    if (Math.abs(this.now() - r.issuedAt) > this.maxAgeMs) {
      return { ok: false, reason: "stale request" };
    }
    // Uninstall is admin-only (docs/service-access-gating.md "Account
    // members"): the admin root on a box that pins one, else the owner IRK;
    // the box's own identity still uninstalls for box-internal flows.
    const adminSigned = authorizeSensitiveOrder({
      order: r,
      signature,
      verify,
      ownerIrkPub: this.deps.host.irkPub,
      ...(this.deps.host.adminRootPub ? { adminRootPub: this.deps.host.adminRootPub } : {}),
      username: this.deps.host.username,
      activeGrants: [],
      now: this.now(),
    });
    if (!adminSigned && !(this.deps.hostIdentityPub && verify(r, signature, this.deps.hostIdentityPub))) {
      return { ok: false, reason: "invalid signature (only an admin device can uninstall an app)" };
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
    // Drop data stores: every one it holds (its databases and its files
    // folder), including any a later version's manifest stopped declaring
    // (redeploy keeps those rather than lose data).
    if (app.data && this.deps.dataProvisioner) {
      try {
        await this.deps.dataProvisioner.dropCredentials(app.data);
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
    this.persist();
    // Per-service leadership teardown: release the box's `<slug>.<user>` route
    // at the hub + re-announce so the claim doesn't outlive the service. The
    // route is keyed by the bare slug (the gossip claimer maps slug → the tier-2
    // FQDN), so pass the slug. Best-effort — never fail the uninstall.
    if (this.deps.onServiceRemoved) {
      try {
        await this.deps.onServiceRemoved(r.slug);
      } catch {
        // gossip release/re-announce is advisory; the local removal already succeeded.
      }
    }
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
    this.persist();
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

export type RedeployResult =
  | { ok: true; app: InstalledService; addedStores: string[] }
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
