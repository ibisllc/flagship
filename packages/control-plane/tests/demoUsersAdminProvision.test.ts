/**
 * W11 — Worker-side provisioning admin handler tests.
 *
 * Covers:
 *   - 404 on missing demo_users row
 *   - 409 when usernames row missing (admin-claim-and-issue is the
 *     prerequisite)
 *   - 200 + reused on idempotent re-call when state is already 'up' or
 *     'provisioning'
 *   - 202 on happy path; stamps activeServerId + isoR2Key, persists
 *     auth-code + build-ticket + grant
 *   - cloud-init user_data shell script shape:
 *       wget → dd → sync → reboot, with the R2 URL containing the
 *       expected key
 *   - 502 when the Hetzner client throws
 */

import { describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import {
  InMemoryAuditEventStorage,
  InMemoryAuthCodeStorage,
  InMemoryDemoUsersStorage,
  InMemoryDeviceCapabilityGrantStorage,
  InMemoryUsernameStorage,
} from "@flagship/storage";
import {
  buildCloudInitUserData,
  deriveDemoUserIrk,
  handleAdminSnapshotNow,
  type DemoProvisionDeps,
  type ProvisioningHetznerClient,
} from "../src/index.js";

const KEK = new Uint8Array(32).fill(0x42);

interface FakeR2 {
  temp: Map<string, Uint8Array>;
}

function makeR2(): {
  isoTempBucket: DemoProvisionDeps["isoTempBucket"];
  state: FakeR2;
} {
  const state: FakeR2 = {
    temp: new Map(),
  };
  const isoTempBucket = {
    async put(
      key: string,
      value: ReadableStream<Uint8Array> | Uint8Array | string,
    ) {
      let bytes: Uint8Array;
      if (value instanceof Uint8Array) {
        bytes = value;
      } else if (typeof value === "string") {
        bytes = new TextEncoder().encode(value);
      } else {
        const reader = value.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value!);
        }
        let total = 0;
        for (const c of chunks) total += c.length;
        bytes = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          bytes.set(c, off);
          off += c.length;
        }
      }
      state.temp.set(key, bytes);
      return {};
    },
  };
  return { isoTempBucket, state };
}

interface FakeHetzner extends ProvisioningHetznerClient {
  calls: Array<{
    name: string;
    location: string;
    serverType: string;
    image?: string;
    userData: string;
    username: string;
    sshKeyId?: number;
    fallbackServerTypes?: readonly string[];
  }>;
  failNext?: Error;
}

function makeHetzner(): FakeHetzner {
  const calls: FakeHetzner["calls"] = [];
  return {
    calls,
    async createServerWithUserData(args) {
      if (this.failNext) {
        const e = this.failNext;
        this.failNext = undefined;
        throw e;
      }
      calls.push(args);
      return { serverId: "srv-abc", ipv4: "9.9.9.9" };
    },
  };
}

async function mkDeps(opts: { seedDemo?: boolean; seedUsername?: boolean } = {}): Promise<{
  deps: DemoProvisionDeps;
  hetzner: FakeHetzner;
  r2: FakeR2;
}> {
  const r2helpers = makeR2();
  const hetzner = makeHetzner();
  let counter = 0;
  const rand = (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (counter + i) & 0xff;
    counter += n;
    return out;
  };
  const storage = new InMemoryDemoUsersStorage();
  const usernames = new InMemoryUsernameStorage();
  if (opts.seedDemo) {
    await storage.insert({
      username: "demoalice",
      display: "Demo Alice",
      snapshotId: null,
      isoR2Key: null,
      ttlIdleMinutes: 30,
      region: "fsn1",
      size: "cpx11",
      activeServerId: null,
      activeServerFqdn: null,
      lastActivityAt: 0,
      state: "none",
      createdAt: 1_000_000,
    });
  }
  if (opts.seedUsername) {
    const irk = deriveDemoUserIrk(KEK, "demoalice");
    const hex = (b: Uint8Array) =>
      Array.from(b)
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
    await usernames.put({
      username: "demoalice",
      irkPubHex: hex(irk.publicKey),
      claimedAt: 1_000_000,
      isDemo: true,
    });
  }
  const deps: DemoProvisionDeps = {
    storage,
    usernames,
    authCodes: new InMemoryAuthCodeStorage(),
    deviceCapabilityGrants: new InMemoryDeviceCapabilityGrantStorage(),
    isoTempBucket: r2helpers.isoTempBucket,
    isoTempPublicBase: "https://pub-xyz.r2.dev",
    baseIsoUrl: "https://flagshipserver.com/build/iso/flagship-base-alpine-3.21.0-x86_64.iso",
    hetzner,
    demoIrkKek: KEK,
    defaultRegion: "fsn1",
    defaultSize: "cpx11",
    random: rand,
    now: () => 2_000_000,
  };
  return { deps, hetzner, r2: r2helpers.state };
}

describe("buildCloudInitUserData", () => {
  it("renders cat(base + trailer) | dd → sync → reboot with both URLs", () => {
    const baseIsoUrl =
      "https://flagshipserver.com/build/iso/flagship-base-alpine.iso";
    const trailerUrl =
      "https://pub-xyz.r2.dev/demo-isos/demoalice-deadbeef.trailer";
    const s = buildCloudInitUserData({ baseIsoUrl, trailerUrl });
    expect(s.startsWith("#!/bin/bash\n")).toBe(true);
    expect(s).toContain("set -euo pipefail");
    expect(s).toContain(`wget -qO- '${baseIsoUrl}'`);
    expect(s).toContain(`wget -qO- '${trailerUrl}'`);
    expect(s).toContain("dd of=/dev/sda bs=4M");
    expect(s).toContain("conv=fsync");
    expect(s).toMatch(/\nsync\n/);
    expect(s).toMatch(/reboot -f/);
    // The cloud-init MUST also write the trailer at the disk's END so
    // flagship-trailer-probe (which reads last ~20 bytes for the
    // FLAGSHIP-END magic) finds it on a Hetzner cx23 (40 GB disk).
    expect(s).toContain("blockdev --getsize64 /dev/sda");
    expect(s).toContain("seek=$SEEK oflag=seek_bytes");
    expect(s).toContain("conv=notrunc,fsync");
  });

  it("works identically with a W12 netboot (Debian) base-ISO URL", () => {
    // W12: the trailer-at-disk-end mechanism is ISO-agnostic. The
    // cloud-init script is the same shape for both Alpine + Debian
    // netinst — only the baseIsoUrl differs.
    const netbootIsoUrl =
      "https://flagshipserver.com/build/iso/flagship-netboot-debian-13.5.0-x86_64.iso";
    const trailerUrl =
      "https://pub-xyz.r2.dev/demo-isos/demoalice-deadbeef.trailer";
    const s = buildCloudInitUserData({ baseIsoUrl: netbootIsoUrl, trailerUrl });
    expect(s).toContain(`wget -qO- '${netbootIsoUrl}'`);
    expect(s).toContain(`wget -qO- '${trailerUrl}'`);
    expect(s).toContain("dd of=/dev/sda");
  });
});

describe("handleAdminSnapshotNow (W11)", () => {
  it("404s on missing demo_users row", async () => {
    const { deps } = await mkDeps();
    const r = await handleAdminSnapshotNow(deps, "ghost-user");
    expect(r.status).toBe(404);
  });

  it("409s when usernames row missing (must call admin-claim-and-issue first)", async () => {
    const { deps } = await mkDeps({ seedDemo: true });
    const r = await handleAdminSnapshotNow(deps, "demoalice");
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toMatch(/admin-claim-and-issue/);
  });

  it("happy path: 202, stamps activeServerId + isoR2Key, posts cloud-init with the expected R2 URL", async () => {
    const { deps, hetzner, r2 } = await mkDeps({ seedDemo: true, seedUsername: true });
    const r = await handleAdminSnapshotNow(deps, "demoalice");
    expect(r.status).toBe(202);
    const body = r.body as {
      state: string;
      activeServerId: string;
      isoR2Key: string;
      ipv4: string | null;
    };
    expect(body.state).toBe("provisioning");
    expect(body.activeServerId).toBe("srv-abc");
    expect(body.isoR2Key).toMatch(/^demo-isos\/demoalice-[0-9a-f]{8}\.trailer$/);

    // demo_users row is stamped + transitioned to provisioning.
    const row = await deps.storage.get("demoalice");
    expect(row?.state).toBe("provisioning");
    expect(row?.activeServerId).toBe("srv-abc");
    expect(row?.isoR2Key).toBe(body.isoR2Key);

    // The Hetzner client received the right body shape.
    expect(hetzner.calls).toHaveLength(1);
    const call = hetzner.calls[0]!;
    expect(call.image).toBe("ubuntu-22.04");
    expect(call.username).toBe("demoalice");
    expect(call.location).toBe("fsn1");
    expect(call.serverType).toBe("cpx11");
    // cloud-init must wget BOTH the base ISO (public URL) AND the
    // per-demo trailer (R2 temp dev-url) — concatenating onto dd.
    expect(call.userData).toContain(
      "https://flagshipserver.com/build/iso/flagship-base-alpine-3.21.0-x86_64.iso",
    );
    expect(call.userData).toContain(
      `https://pub-xyz.r2.dev/${body.isoR2Key}`,
    );
    expect(call.userData).toContain("dd of=/dev/sda");

    // R2 temp bucket has the trailer — small (~1-2 KB), much less than
    // the full ISO. This is the W11-rev-2 fix: Worker writes only the
    // trailer; cloud-init cats it onto the base on the VPS.
    const tempObj = r2.temp.get(body.isoR2Key);
    expect(tempObj).toBeDefined();
    expect(tempObj!.length).toBeGreaterThan(100);
    expect(tempObj!.length).toBeLessThan(4 * 1024);
  });

  it("idempotent — second call with state=provisioning returns 200 + reused", async () => {
    const { deps } = await mkDeps({ seedDemo: true, seedUsername: true });
    await handleAdminSnapshotNow(deps, "demoalice");
    const r2 = await handleAdminSnapshotNow(deps, "demoalice");
    expect(r2.status).toBe(200);
    expect((r2.body as { reused: boolean }).reused).toBe(true);
  });

  it("502 when the Hetzner client throws", async () => {
    const { deps, hetzner } = await mkDeps({ seedDemo: true, seedUsername: true });
    hetzner.failNext = new Error("hetzner upstream 503");
    const r = await handleAdminSnapshotNow(deps, "demoalice");
    expect(r.status).toBe(502);
    expect((r.body as { error: string }).error).toMatch(/hetzner/);
    // Row should NOT have been stamped (Hetzner call happens before
    // the storage transition).
    const row = await deps.storage.get("demoalice");
    expect(row?.state).toBe("none");
  });

  it("400 on malformed username (after lowercasing)", async () => {
    const { deps } = await mkDeps();
    // 'a' lowercased is still 1 char; below the 3-char minimum.
    const r = await handleAdminSnapshotNow(deps, "a");
    expect(r.status).toBe(400);
  });
});
