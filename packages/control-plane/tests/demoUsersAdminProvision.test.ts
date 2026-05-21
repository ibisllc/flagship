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
  InMemoryBuildTicketStorage,
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
  base: Map<string, Uint8Array>;
  temp: Map<string, Uint8Array>;
}

function makeR2(baseBytes: Uint8Array, baseKey: string): {
  isoBucket: DemoProvisionDeps["isoBucket"];
  isoTempBucket: DemoProvisionDeps["isoTempBucket"];
  state: FakeR2;
} {
  const state: FakeR2 = {
    base: new Map([[baseKey, baseBytes]]),
    temp: new Map(),
  };
  const isoBucket = {
    async get(key: string) {
      const v = state.base.get(key);
      if (!v) return null;
      let off = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (off >= v.length) {
            controller.close();
            return;
          }
          const end = Math.min(off + 4096, v.length);
          controller.enqueue(v.subarray(off, end));
          off = end;
        },
      });
      return { body: stream, size: v.length };
    },
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
  return { isoBucket, isoTempBucket, state };
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
  const baseBytes = new Uint8Array(8 * 1024);
  for (let i = 0; i < baseBytes.length; i++) baseBytes[i] = (i * 11) & 0xff;
  const baseKey = "build/iso/flagship-base.iso";
  const r2helpers = makeR2(baseBytes, baseKey);
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
      username: "demo-alice",
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
    const irk = deriveDemoUserIrk(KEK, "demo-alice");
    const hex = (b: Uint8Array) =>
      Array.from(b)
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
    await usernames.put({
      username: "demo-alice",
      irkPubHex: hex(irk.publicKey),
      claimedAt: 1_000_000,
      isDemo: true,
    });
  }
  const deps: DemoProvisionDeps = {
    storage,
    usernames,
    authCodes: new InMemoryAuthCodeStorage(),
    buildTickets: new InMemoryBuildTicketStorage(),
    deviceCapabilityGrants: new InMemoryDeviceCapabilityGrantStorage(),
    isoBucket: r2helpers.isoBucket,
    isoTempBucket: r2helpers.isoTempBucket,
    isoTempPublicBase: "https://pub-xyz.r2.dev",
    baseIsoKey: baseKey,
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
  it("renders wget → dd → sync → reboot with the iso URL inline", () => {
    const url =
      "https://pub-xyz.r2.dev/demo-isos/demo-alice-deadbeef.iso";
    const s = buildCloudInitUserData(url);
    expect(s.startsWith("#!/bin/bash\n")).toBe(true);
    expect(s).toContain("set -euo pipefail");
    expect(s).toContain(`wget --no-verbose -O /tmp/flagship.iso '${url}'`);
    expect(s).toContain("dd if=/tmp/flagship.iso of=/dev/sda bs=4M");
    expect(s).toContain("conv=fsync");
    expect(s).toMatch(/\nsync\n/);
    expect(s).toMatch(/reboot -f/);
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
    const r = await handleAdminSnapshotNow(deps, "demo-alice");
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toMatch(/admin-claim-and-issue/);
  });

  it("happy path: 202, stamps activeServerId + isoR2Key, posts cloud-init with the expected R2 URL", async () => {
    const { deps, hetzner, r2 } = await mkDeps({ seedDemo: true, seedUsername: true });
    const r = await handleAdminSnapshotNow(deps, "demo-alice");
    expect(r.status).toBe(202);
    const body = r.body as {
      state: string;
      activeServerId: string;
      isoR2Key: string;
      ticketCode: string;
      ipv4: string | null;
    };
    expect(body.state).toBe("provisioning");
    expect(body.activeServerId).toBe("srv-abc");
    expect(body.isoR2Key).toMatch(/^demo-isos\/demo-alice-[0-9a-f]{8}\.iso$/);
    expect(body.ticketCode.length).toBeGreaterThan(0);

    // demo_users row is stamped + transitioned to provisioning.
    const row = await deps.storage.get("demo-alice");
    expect(row?.state).toBe("provisioning");
    expect(row?.activeServerId).toBe("srv-abc");
    expect(row?.isoR2Key).toBe(body.isoR2Key);

    // The Hetzner client received the right body shape.
    expect(hetzner.calls).toHaveLength(1);
    const call = hetzner.calls[0]!;
    expect(call.image).toBe("ubuntu-22.04");
    expect(call.username).toBe("demo-alice");
    expect(call.location).toBe("fsn1");
    expect(call.serverType).toBe("cpx11");
    expect(call.userData).toContain(
      `https://pub-xyz.r2.dev/${body.isoR2Key}`,
    );
    expect(call.userData).toContain("dd if=/tmp/flagship.iso of=/dev/sda");

    // R2 temp bucket has the personalized ISO + it's larger than the
    // base ISO (by the trailer length).
    const tempObj = r2.temp.get(body.isoR2Key);
    expect(tempObj).toBeDefined();
    expect(tempObj!.length).toBeGreaterThan(8 * 1024);
  });

  it("uses FixedLengthStream when the Workers runtime provides it (regression)", async () => {
    // R2 PUT on the live Workers runtime requires a stream with a
    // known length. A bare ReadableStream throws:
    //   TypeError: Provided readable stream must have a known length
    //   (request/response body or readable half of FixedLengthStream)
    // Live-observed on 2026-05-21 attempt 2 of the W11 live test.
    // This test installs a global FixedLengthStream mock and verifies
    // the handler reaches for it and pipes through its readable half.
    type FLLike = { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> };
    const flCalls: Array<{ length: number }> = [];
    class FLMock {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
      constructor(length: number) {
        flCalls.push({ length });
        const ts = new TransformStream<Uint8Array, Uint8Array>();
        this.readable = ts.readable;
        this.writable = ts.writable;
      }
    }
    const g = globalThis as unknown as { FixedLengthStream?: new (length: number) => FLLike };
    const had = g.FixedLengthStream;
    g.FixedLengthStream = FLMock as unknown as new (length: number) => FLLike;
    try {
      const { deps } = await mkDeps({ seedDemo: true, seedUsername: true });
      const r = await handleAdminSnapshotNow(deps, "demo-alice");
      expect(r.status).toBe(202);
      // The handler MUST have constructed the FixedLengthStream
      // exactly once with the streamPersonalize totalBytes value.
      expect(flCalls).toHaveLength(1);
      expect(flCalls[0]!.length).toBeGreaterThan(8 * 1024);
    } finally {
      if (had === undefined) delete g.FixedLengthStream;
      else g.FixedLengthStream = had;
    }
  });

  it("idempotent — second call with state=provisioning returns 200 + reused", async () => {
    const { deps } = await mkDeps({ seedDemo: true, seedUsername: true });
    await handleAdminSnapshotNow(deps, "demo-alice");
    const r2 = await handleAdminSnapshotNow(deps, "demo-alice");
    expect(r2.status).toBe(200);
    expect((r2.body as { reused: boolean }).reused).toBe(true);
  });

  it("502 when the Hetzner client throws", async () => {
    const { deps, hetzner } = await mkDeps({ seedDemo: true, seedUsername: true });
    hetzner.failNext = new Error("hetzner upstream 503");
    const r = await handleAdminSnapshotNow(deps, "demo-alice");
    expect(r.status).toBe(502);
    expect((r.body as { error: string }).error).toMatch(/hetzner/);
    // Row should NOT have been stamped (Hetzner call happens before
    // the storage transition).
    const row = await deps.storage.get("demo-alice");
    expect(row?.state).toBe("none");
  });

  it("400 on malformed username (after lowercasing)", async () => {
    const { deps } = await mkDeps();
    // 'a' lowercased is still 1 char; below the 3-char minimum.
    const r = await handleAdminSnapshotNow(deps, "a");
    expect(r.status).toBe(400);
  });
});
