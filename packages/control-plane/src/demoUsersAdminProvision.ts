/**
 * W11 — Worker-side provisioning admin handler.
 *
 * Replaces the laptop's `HCLOUD_TOKEN` + SSH-key + R2 upload + ISO build
 * pipeline with a single admin POST. The Worker:
 *
 *   1. Looks up the demo_users row + the usernames row.
 *   2. Re-derives the deterministic User IRK from `DEMO_IRK_KEK` + the
 *      username (same HKDF call as `admin-claim-and-issue` — re-exported
 *      here so a freshly-built install ticket can be signed without
 *      reaching into private helpers).
 *   3. Mints a fresh AuthCode + InstallBlob signed under that IRK and
 *      persists the auth-code + build-ticket rows.
 *   4. Streams the base ISO out of R2 through the trailer-glueing
 *      `streamPersonalize` and into the temp R2 bucket — never landing
 *      the 240 MB ISO in V8 heap.
 *   5. Builds a cloud-init `user_data` shell script that wgets the
 *      personalized ISO from R2's public dev-url and `dd`s it onto
 *      /dev/sda + reboots — same primitive as nixos-infect /
 *      hetzner-installimage. NO SSH is involved.
 *   6. POSTs Hetzner `/servers` with the cloud-init script as
 *      `user_data` and an `ubuntu-22.04` image. Cloud-init runs the
 *      script as root at first boot.
 *   7. Stamps `demo_users` with `state='provisioning'` + the active
 *      server id + the R2 key.
 *
 * The existing 10-minute demo cron handles the rest (poll
 * `/api/users/<u>/pods` until the daemon registers, then snapshot +
 * destroy the temp VPS — see `runDemoProvisioningPoller`).
 *
 * NOT in this handler:
 *   - Re-claiming the username (W11 assumes `admin-claim-and-issue`
 *     was called first; the W11 happy path is `create` →
 *     `admin-claim-and-issue` → `admin-snapshot-now`).
 *   - The actual snapshot + destroy of the temp VPS (those happen on
 *     the cron).
 */

import {
  signAuthCode,
  signDeviceCapabilityGrant,
  signInstallBlob,
  type AuthCode,
  type DeviceCapabilityGrant,
  type InstallBlob,
  type DeviceScope,
} from "@flagship/protocol";
import { streamPersonalize } from "@flagship/iso-personalizer";
import type {
  AuthCodeStorage,
  DemoUsersStorage,
  DeviceCapabilityGrantStorage,
  UsernameStorage,
} from "@flagship/storage";
import { bytesToHex } from "./hex.js";
import {
  deriveDemoDelegatedKey,
  deriveDemoRckKey,
  deriveDemoUserIrk,
  parseDiskEncryption,
  _internalDefaultDemoPrimaryScopes,
} from "./demoUsersAdmin.js";
import {
  conflict,
  malformed,
  notFound,
  type HandlerResponseWithHeaders,
} from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// Hetzner + R2 structural deps (kept inline so this module doesn't
// depend on apps/com — concrete implementations live there.)
// ──────────────────────────────────────────────────────────────────────

export interface ProvisioningHetznerClient {
  createServerWithUserData(args: {
    name: string;
    location: string;
    serverType: string;
    image?: string;
    userData: string;
    username: string;
    sshKeyId?: number;
    fallbackServerTypes?: readonly string[];
  }): Promise<{ serverId: string; ipv4: string | null }>;
}

export interface ReadableR2Bucket {
  get(key: string): Promise<{
    body: ReadableStream<Uint8Array> | null;
    size: number;
  } | null>;
}

export interface WritableR2Bucket {
  put(
    key: string,
    value: ReadableStream<Uint8Array> | Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

// ──────────────────────────────────────────────────────────────────────
// Deps + body shapes
// ──────────────────────────────────────────────────────────────────────

export interface DemoProvisionDeps {
  storage: DemoUsersStorage;
  usernames: UsernameStorage;
  authCodes: AuthCodeStorage;
  deviceCapabilityGrants: DeviceCapabilityGrantStorage;
  /** R2 bucket the per-demo TRAILER (~1 KB) is written to. Cloud-init
   *  wgets the trailer from here over the public dev-url base + cats
   *  it onto the base ISO on the VPS. */
  isoTempBucket: WritableR2Bucket;
  /** Public-dev-url base for the temp bucket, e.g.
   *  `https://pub-260717…r2.dev`. Concatenated with the trailer R2 key
   *  by the cloud-init script. */
  isoTempPublicBase: string;
  /** Public URL of the BASE ISO that cloud-init wgets directly (no
   *  Worker pass-through), then cats the trailer onto it.
   *
   *  W12: defaults to the Debian-12-netinst-based ISO (built via
   *  scripts/build-flagship-netboot-iso.sh). Alpine apkovl-mode boot
   *  doesn't mount its modloop kernel-modules squashfs on Hetzner cloud
   *  VMs, so DHCP never comes up — the netboot ISO uses d-i, whose
   *  installer kernel has every common driver built IN. The wire +
   *  trailer layout is identical to the Alpine ISO (trailer at
   *  disk_size - trailer_size).
   *
   *  Either an Alpine URL (legacy /build/ flow) or the netboot URL
   *  (cloud demo flow) works — the trailer-at-end mechanism is
   *  ISO-agnostic. */
  baseIsoUrl: string;
  hetzner: ProvisioningHetznerClient;
  demoIrkKek: Uint8Array;
  /** OPTIONAL — when present, Hetzner attaches this numeric SSH key id
   *  to the temp VPS. The W11 flow does NOT depend on SSH; this is
   *  only useful if the operator wants to ssh in to debug a stalled
   *  cloud-init. */
  demoSshKeyId?: number;
  /** Default Hetzner location. */
  defaultRegion: string;
  /** Default Hetzner server_type. */
  defaultSize: string;
  /** Ordered fallback list tried on a 422. */
  fallbackServerTypes?: readonly string[];
  random?: (n: number) => Uint8Array;
  now?: () => number;
}

export interface AdminSnapshotNowBody {
  region?: unknown;
  size?: unknown;
  /** Disk-encryption choice threaded into the signed InstallBlob (auth.ts
   *  `de=` field). "luks"/absent ⇒ encrypted; "none" ⇒ unencrypted boot. */
  diskEncryption?: unknown;
}

const USERNAME_RE = /^[a-z0-9-]{3,32}$/;

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

function nowOf(deps: DemoProvisionDeps): number {
  return (deps.now ?? Date.now)();
}

function v4Uuid(rand: (n: number) => Uint8Array): string {
  const b = rand(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const DEFAULT_DEMO_PRIMARY_SCOPES: readonly DeviceScope[] =
  _internalDefaultDemoPrimaryScopes;

// ──────────────────────────────────────────────────────────────────────
// Cloud-init user_data script
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the cloud-init `user_data` shell script that wgets the
 * personalized ISO and dd's it onto /dev/sda. Exported for the unit
 * test in `tests/demoUsersAdminProvision.test.ts` so the operator can
 * eyeball the exact script Hetzner runs.
 *
 * Why these specific flags:
 *   - `set -euo pipefail` — fail-fast on any error (wget retry exhaust,
 *     dd I/O error, missing /dev/sda).
 *   - `wget --no-verbose -O /tmp/flagship.iso <url>` — explicit
 *     filename + quiet progress (cloud-init's log is the only sink).
 *   - `dd if=…iso of=/dev/sda bs=4M conv=fsync status=none` —
 *     bs=4M is empirically fastest on Hetzner's NVMe; conv=fsync
 *     flushes per-block so a power-cut in the dd window doesn't leave
 *     a half-written disk; status=none keeps the log clean.
 *   - `sync; reboot -f` — `sync` flushes the page cache (defense in
 *     depth on top of conv=fsync); `-f` skips userspace teardown
 *     because the rootfs underneath us no longer matches what's on
 *     disk.
 *
 * CORRUPTION WINDOW: dd'ing the running root disk overwrites the very
 * partition table the running kernel was booted from. This is
 * intentional — same model as nixos-infect / hetzner-installimage /
 * DigitalOcean's "Reinstall from URL". Safe because the script runs
 * end-to-end without touching anything that re-reads /dev/sda mid-
 * stream. A power-cut during the dd would brick the temp VPS; the
 * failure mode is "VPS won't boot" not "data loss" — we just destroy
 * + re-provision.
 */
/**
 * Cloud-init shell script. Originally tried to wget a single
 * pre-personalized ISO from R2, but the Worker can't stream the 240 MB
 * personalized ISO into R2 within the CPU budget (every chunk costs JS
 * pull/enqueue time → Workers hit the CPU limit at ~30s on the live
 * 2026-05-21 attempt 3). Fix: have the Worker write only the small
 * trailer (~1 KB) and let the VPS itself concatenate the base ISO
 * (publicly served at `flagshipserver.com/build/iso/…`) with the
 * trailer (publicly served at the R2-temp-bucket dev-url). The cat is
 * piped into dd so neither file ever needs to land on disk.
 */
export function buildCloudInitUserData(args: {
  baseIsoUrl: string;
  trailerUrl: string;
}): string {
  return `#!/bin/bash
set -euo pipefail
LOG=/var/log/flagship-cloud-init.log
echo "[flagship-cloud-init] starting at $(date)" > "$LOG"

# Phase 1: stream the base ISO + trailer into /dev/sda starting at
# offset 0. Hybrid ISO bootloader at offset 0 → ISO9660 content →
# trailer immediately after. End-of-disk past offset 240 MB stays as
# whatever Hetzner provisioned (typically zero on a fresh VM).
echo "[flagship-cloud-init] writing base+trailer to /dev/sda offset 0" >> "$LOG"
( wget -qO- '${args.baseIsoUrl}' && wget -qO- '${args.trailerUrl}' ) \
    | dd of=/dev/sda bs=4M conv=fsync status=none \
    >> "$LOG" 2>&1

# Phase 2: ALSO write the trailer at the END of /dev/sda. The
# bootstrap's flagship-trailer-probe reads the last ~20 bytes of the
# block device looking for the FLAGSHIP-END magic — on a Hetzner cx23
# (40 GB virtual disk) with the ISO occupying only the first 240 MB,
# the magic at offset 240 MB is invisible to that probe. Writing the
# trailer a SECOND time at offset (disk_size - trailer_size) puts the
# magic where the probe expects it. The mid-disk copy + the
# end-of-disk copy are byte-identical; daemon's parseTrailerFromHandle
# reads the END copy on first boot.
echo "[flagship-cloud-init] fetching trailer to disk-end" >> "$LOG"
wget -qO /tmp/flagship.trailer '${args.trailerUrl}' >> "$LOG" 2>&1
TRAILER_SIZE=$(stat -c %s /tmp/flagship.trailer)
DISK_SIZE=$(blockdev --getsize64 /dev/sda)
SEEK=$((DISK_SIZE - TRAILER_SIZE))
echo "[flagship-cloud-init] trailer=$TRAILER_SIZE bytes; disk=$DISK_SIZE bytes; seek=$SEEK" >> "$LOG"
dd if=/tmp/flagship.trailer of=/dev/sda \
    seek=$SEEK oflag=seek_bytes conv=notrunc,fsync status=none \
    >> "$LOG" 2>&1

sync
echo "[flagship-cloud-init] dd complete; rebooting" >> "$LOG"
sleep 2
reboot -f
`;
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/dev/sample-user/<u>/admin-snapshot-now
// ──────────────────────────────────────────────────────────────────────

/**
 * Worker-side provisioning kickoff. Idempotent: if the row is already
 * `provisioning` or `up`, returns 200 with the current state.
 *
 * Why this endpoint name (rather than e.g. `admin-provision`):
 *   The operator's mental model is "give me a snapshot of this user
 *   right now"; the endpoint kicks off the dance that ultimately ends
 *   in `snapshot_id` being stamped on the row by the cron. The name
 *   matches that user-facing verb even though "snapshot" itself
 *   doesn't happen until the cron tick that follows registration.
 */
export async function handleAdminSnapshotNow(
  deps: DemoProvisionDeps,
  username: string,
  body?: AdminSnapshotNowBody,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  if (!USERNAME_RE.test(u)) {
    return malformed("username must match [a-z0-9-]{3,32}");
  }
  const row = await deps.storage.get(u);
  if (!row) return notFound("no such demo user");

  // Idempotency: don't spawn a second Hetzner VPS if one's already in
  // flight.
  if (row.state === "up" || row.state === "provisioning") {
    return {
      status: 200,
      body: {
        state: row.state,
        activeServerId: row.activeServerId,
        isoR2Key: row.isoR2Key,
        reused: true,
      },
    };
  }

  // The usernames row must already exist — admin-claim-and-issue is
  // a prerequisite. We could re-call it inline, but keeping the two
  // endpoints separate makes the orchestration trace easier to read
  // and lets a Worker outage at admin-claim-and-issue not leak into
  // an unrelated provisioning attempt.
  const userRow = await deps.usernames.get(u);
  if (!userRow) {
    return conflict(
      "usernames row missing; call /admin-claim-and-issue first",
    );
  }

  const rand = deps.random ?? defaultRandom;
  const now = nowOf(deps);
  const region = typeof body?.region === "string" ? body.region : deps.defaultRegion;
  const size = typeof body?.size === "string" ? body.size : deps.defaultSize;
  const diskEncryption = parseDiskEncryption(body?.diskEncryption);
  if (diskEncryption !== undefined && typeof diskEncryption === "object") {
    return malformed(diskEncryption.error);
  }
  const serverName = "home";

  // Re-derive the User IRK + delegated + RCK keypair from the KEK +
  // username. Mirrors handleAdminClaimAndIssue's mint logic exactly so
  // the trailer's signer matches the previously-claimed usernames
  // row's IRK pub.
  const userIrk = deriveDemoUserIrk(deps.demoIrkKek, u);
  const delegated = deriveDemoDelegatedKey(deps.demoIrkKek, u);
  const rck = deriveDemoRckKey(deps.demoIrkKek, u);
  const userIrkHex = bytesToHex(userIrk.publicKey);
  if (userRow.irkPubHex !== userIrkHex) {
    // Should be impossible — if the username was claimed via
    // admin-claim-and-issue with this same KEK + username, the
    // derivation MUST agree. If it doesn't, something has rotated the
    // KEK; fail closed.
    return conflict(
      "derived User IRK mismatches the claimed usernames row; KEK rotated?",
    );
  }

  const serial = bytesToHex(rand(16));
  const serverDomain = `${serverName}.${u}.flagship.services`;
  const issuedAt = now;
  const expiresAt = now + 24 * 3_600_000;

  const authCode: AuthCode = {
    version: 1,
    serial,
    username: u,
    serverName,
    serverDomain,
    delegatedPubKey: delegated.publicKey,
    userPubKey: userIrk.publicKey,
    issuedAt,
    expiresAt,
  };
  const authCodeSig = signAuthCode(authCode, userIrk);
  const acResult = await deps.authCodes.put({
    serial,
    username: u,
    serverName,
    serverDomain,
    delegatedPubKeyHex: bytesToHex(delegated.publicKey),
    userPubKeyHex: userIrkHex,
    userSignatureHex: bytesToHex(authCodeSig),
    issuedAt,
    expiresAt,
    status: "active",
    recordedAt: now,
  });
  if (!acResult.ok) {
    return conflict(`auth-code persist failed: ${acResult.reason}`);
  }

  const blob: InstallBlob = {
    version: 2,
    serverDomain,
    username: u,
    serverName,
    phoneDelegatedPubKey: delegated.publicKey,
    registrationUrl: "https://flagshipserver.com/api/server/register",
    authCode,
    authCodeUserSignature: authCodeSig,
    installerGitRef: "main",
    rckPubKey: rck.publicKey,
    // Carry diskEncryption ONLY for "none" — keeps the signed bytes
    // byte-identical to a legacy recipe for the default encrypted case.
    ...(diskEncryption === "none" ? { diskEncryption: "none" as const } : {}),
  };
  const blobSig = signInstallBlob(blob, userIrk);

  // No build-ticket emission — QR-pipe is the only flow; cloud-init
  // embeds the signed blob directly in user_data.

  // (Re-)mint the primary DeviceCapabilityGrant. The Worker's
  // re-issuance flow is "revoke active then put new" — preserves the
  // semantics admin-claim-and-issue uses.
  const existing = await deps.deviceCapabilityGrants.getActiveForUserLabel(
    u,
    "primary",
  );
  if (existing) {
    await deps.deviceCapabilityGrants.revoke(existing.grantId, now);
  }
  const grantId = v4Uuid(rand);
  const grant: DeviceCapabilityGrant = {
    grantId,
    username: u,
    deviceLabel: "primary",
    devicePubKey: userIrk.publicKey,
    scopes: [...DEFAULT_DEMO_PRIMARY_SCOPES],
    issuedAt: now,
    expiresAt: now + 90 * 24 * 3_600_000,
  };
  const grantSig = signDeviceCapabilityGrant(grant, userIrk);
  await deps.deviceCapabilityGrants.put({
    grantId,
    username: u,
    deviceLabel: "primary",
    devicePubHex: userIrkHex,
    scopesJson: JSON.stringify(grant.scopes),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    signatureHex: bytesToHex(grantSig),
    revokedAt: null,
  });

  // Write JUST the small trailer (~1 KB) to R2. The cloud-init script
  // on the VPS wgets the base ISO from its existing public URL +
  // wgets the trailer from R2 + pipes both into dd. This avoids
  // streaming 240 MB through the Worker (which busts the CPU budget;
  // see the comment on buildCloudInitUserData).
  //
  // The R2 key embeds an 8-hex tag from the blob signature so a retry
  // of admin-snapshot-now produces the same trailer + key — R2 PUT
  // becomes a no-op on flapping operator retries.
  const sig8 = bytesToHex(blobSig.subarray(0, 4));
  const trailerR2Key = `demo-isos/${u}-${sig8}.trailer`;

  // Build the trailer envelope by running streamPersonalize against an
  // empty base stream — we only need its trailerBytes field. (The
  // streamPersonalize import stays in case a later use-case needs the
  // full streaming path again.)
  const emptyBase = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  const personalized = streamPersonalize({
    baseIsoStream: emptyBase,
    baseIsoSize: 0,
    blob,
    blobSignature: blobSig,
  });
  // Tiny PUT — trailer is < ~2 KB. Pass the Uint8Array directly; no
  // FixedLengthStream needed.
  await deps.isoTempBucket.put(trailerR2Key, personalized.trailerBytes, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  // For backward-compat in tests + the response payload, keep the
  // legacy field name. The semantic shifted (now points at the trailer
  // not the personalized ISO) but the field name is informational.
  const isoR2Key = trailerR2Key;

  const trailerUrl = `${deps.isoTempPublicBase.replace(/\/+$/, "")}/${trailerR2Key}`;
  const userData = buildCloudInitUserData({
    baseIsoUrl: deps.baseIsoUrl,
    trailerUrl,
  });

  let prov: { serverId: string; ipv4: string | null };
  try {
    prov = await deps.hetzner.createServerWithUserData({
      name: `flagship-demo-${u}-${bytesToHex(rand(4))}`,
      location: region,
      serverType: size,
      image: "ubuntu-22.04",
      userData,
      username: u,
      ...(deps.demoSshKeyId !== undefined ? { sshKeyId: deps.demoSshKeyId } : {}),
      ...(deps.fallbackServerTypes
        ? { fallbackServerTypes: deps.fallbackServerTypes }
        : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: 502,
      body: { error: "hetzner upstream rejected", detail: msg.slice(0, 280) },
    };
  }

  // CAS none → provisioning so a concurrent /connect or duplicate
  // /admin-snapshot-now doesn't race us. If the CAS misses (i.e. the
  // row already transitioned), we still stamp the activeServerId so
  // the next cron pass can act on it.
  const transitioned = await deps.storage.transition(u, "none", "provisioning", {
    activeServerId: prov.serverId,
    activeServerIp: prov.ipv4,
    image: "ubuntu-22.04",
    isoR2Key,
    lastActivityAt: now,
  });
  if (!transitioned) {
    await deps.storage.update(u, {
      activeServerId: prov.serverId,
      activeServerIp: prov.ipv4,
      image: "ubuntu-22.04",
      isoR2Key,
    });
  }

  return {
    status: 202,
    body: {
      state: "provisioning",
      activeServerId: prov.serverId,
      isoR2Key,
      ipv4: prov.ipv4,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Local InstallBlob → JSON serializer
//
// Duplicated from demoUsersAdmin.ts so we don't depend on a private
// helper. The build-ticket consumer never re-reads this JSON for crypto
// purposes (the daemon reads the trailer the ISO carries — built by
// streamPersonalize from the same blob + signature), so the shape just
// has to round-trip through JSON.stringify/parse.
// ──────────────────────────────────────────────────────────────────────

interface InstallBlobJsonShort {
  version: 2;
  serverDomain: string;
  username: string;
  serverName: string;
  phoneDelegatedPubKey: string;
  registrationUrl: string;
  authCode: {
    version: number;
    serial: string;
    username: string;
    serverName: string;
    serverDomain: string;
    delegatedPubKey: string;
    userPubKey: string;
    issuedAt: number;
    expiresAt: number;
  };
  authCodeUserSignature: string;
  installerGitRef: string;
  rckPubKey: string;
}

function installBlobToJsonShort(b: InstallBlob): InstallBlobJsonShort {
  return {
    version: 2,
    serverDomain: b.serverDomain,
    username: b.username,
    serverName: b.serverName,
    phoneDelegatedPubKey: bytesToHex(b.phoneDelegatedPubKey),
    registrationUrl: b.registrationUrl,
    authCode: {
      version: 1,
      serial: b.authCode.serial,
      username: b.authCode.username,
      serverName: b.authCode.serverName,
      serverDomain: b.authCode.serverDomain,
      delegatedPubKey: bytesToHex(b.authCode.delegatedPubKey),
      userPubKey: bytesToHex(b.authCode.userPubKey),
      issuedAt: b.authCode.issuedAt,
      expiresAt: b.authCode.expiresAt,
    },
    authCodeUserSignature: bytesToHex(b.authCodeUserSignature),
    installerGitRef: b.installerGitRef,
    rckPubKey: bytesToHex(b.rckPubKey),
  };
}
