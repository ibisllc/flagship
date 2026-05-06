/**
 * Tests for the subscriber registry — the source of truth for who can
 * pull an app's update packs. Uses InMemory + File implementations to
 * verify both the in-memory contract and the on-disk persistence.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAppDistribution,
  FileSubscriberRegistry,
  InMemorySubscriberRegistry,
} from "../src/subscriberRegistry.js";
import type { InstalledApp } from "../src/appPlatform.js";

describe("InMemorySubscriberRegistry", () => {
  it("starts empty", async () => {
    const r = new InMemorySubscriberRegistry();
    expect(await r.list("a--x")).toEqual([]);
    expect((await r.subscribersFor("a--x")).size).toBe(0);
  });

  it("add + list returns sorted FQDNs", async () => {
    const r = new InMemorySubscriberRegistry();
    await r.add("a--x", "home.bob.flagship.services");
    await r.add("a--x", "home.carol.flagship.services");
    expect(await r.list("a--x")).toEqual([
      "home.bob.flagship.services",
      "home.carol.flagship.services",
    ]);
  });

  it("add is case-normalized", async () => {
    const r = new InMemorySubscriberRegistry();
    await r.add("a--x", "Home.Bob.Flagship.Services");
    const s = await r.subscribersFor("a--x");
    expect(s.has("home.bob.flagship.services")).toBe(true);
  });

  it("rejects malformed FQDNs", async () => {
    const r = new InMemorySubscriberRegistry();
    await expect(r.add("a--x", "not-a-fqdn")).rejects.toThrow(/invalid FQDN/);
    await expect(r.add("a--x", "http://x.com/")).rejects.toThrow(/invalid FQDN/);
    await expect(r.add("a--x", "x.com/path")).rejects.toThrow(/invalid FQDN/);
  });

  it("remove drops the entry; idempotent on missing", async () => {
    const r = new InMemorySubscriberRegistry();
    await r.add("a--x", "home.bob.flagship.services");
    await r.remove("a--x", "home.bob.flagship.services");
    expect(await r.list("a--x")).toEqual([]);
    await r.remove("a--x", "home.bob.flagship.services");
    expect(await r.list("a--x")).toEqual([]);
  });

  it("subscribersFor returns a defensive copy", async () => {
    const r = new InMemorySubscriberRegistry();
    await r.add("a--x", "home.bob.flagship.services");
    const s = await r.subscribersFor("a--x");
    s.delete("home.bob.flagship.services");
    expect((await r.subscribersFor("a--x")).has("home.bob.flagship.services")).toBe(true);
  });
});

describe("FileSubscriberRegistry", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flagship-sub-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists across instances", async () => {
    const r1 = new FileSubscriberRegistry(dir);
    await r1.add("a--x", "home.bob.flagship.services");
    const r2 = new FileSubscriberRegistry(dir);
    expect(await r2.list("a--x")).toEqual(["home.bob.flagship.services"]);
  });

  it("empty after last remove deletes the file", async () => {
    const r = new FileSubscriberRegistry(dir);
    await r.add("a--x", "home.bob.flagship.services");
    await r.remove("a--x", "home.bob.flagship.services");
    expect(await r.list("a--x")).toEqual([]);
    expect(r.knownApps()).toEqual([]);
  });

  it("serial writes accumulate", async () => {
    const r = new FileSubscriberRegistry(dir);
    await r.add("a--x", "home.bob.flagship.services");
    await r.add("a--x", "home.carol.flagship.services");
    await r.add("a--x", "home.dave.flagship.services");
    const list = await r.list("a--x");
    expect(list.sort()).toEqual([
      "home.bob.flagship.services",
      "home.carol.flagship.services",
      "home.dave.flagship.services",
    ]);
    const buf = await readFile(join(dir, "a--x.json"), "utf8");
    expect(() => JSON.parse(buf)).not.toThrow();
  });

  it("knownApps lists every app with subscribers", async () => {
    const r = new FileSubscriberRegistry(dir);
    await r.add("alice--game1", "home.bob.flagship.services");
    await r.add("alice--game2", "home.carol.flagship.services");
    expect(r.knownApps().sort()).toEqual(["alice--game1", "alice--game2"]);
  });
});

describe("buildAppDistribution", () => {
  function fakeApp(args: { appId: string; public?: boolean }): InstalledApp {
    return {
      creator: "alice",
      slug: "x",
      appId: args.appId,
      manifest: {
        schema_version: 1,
        name: "x",
        version: "0.1.0",
        runtime: { image: "x", port: 80 },
        data: {},
        network: { subdomain: "x" },
        access: { enabled: true, default_role: "viewer" },
        migration: { verification: "standard" },
        distribution: args.public ? { public: true } : undefined,
      },
      urlLabel: "x",
      membership: {} as never,
      containerPort: 8080,
      data: null,
      installedAt: 0,
    };
  }

  it("public flag flows through from manifest", async () => {
    const reg = new InMemorySubscriberRegistry();
    const f = buildAppDistribution({
      platform: {} as never,
      registry: reg,
      repoPath: () => "/tmp/repo",
    });
    const r = await f(fakeApp({ appId: "alice--x", public: true }));
    expect(r?.publicDistribution).toBe(true);
    expect(r?.subscribers.size).toBe(0);
  });

  it("subscribers source from the registry", async () => {
    const reg = new InMemorySubscriberRegistry();
    await reg.add("alice--x", "home.bob.flagship.services");
    const f = buildAppDistribution({
      platform: {} as never,
      registry: reg,
      repoPath: () => "/tmp/repo",
    });
    const r = await f(fakeApp({ appId: "alice--x" }));
    expect(r?.subscribers.has("home.bob.flagship.services")).toBe(true);
    expect(r?.publicDistribution).toBe(false);
  });

  it("returns null when repoPath is empty (no canonical-home repo on this box)", async () => {
    const reg = new InMemorySubscriberRegistry();
    const f = buildAppDistribution({
      platform: {} as never,
      registry: reg,
      repoPath: () => "",
    });
    const r = await f(fakeApp({ appId: "alice--x" }));
    expect(r).toBeNull();
  });
});
