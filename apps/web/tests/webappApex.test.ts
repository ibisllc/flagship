// lib/apex.js — the single apex accessor (G2). Proves the prod-default
// invariant (no browser origin / no override ⇒ today's literals), the
// origin-driven retarget (serving from gym.flagshipserver.com adopts the gym
// backend), the sub-origin derivation, and the explicit override seam.

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const APEX_URL = pathToFileURL(
  resolve(__dirname, "../public/webapp/lib/apex.js"),
).href;

// Each test gets a fresh module instance so module-level `override` state
// never leaks across cases (a `?t=` query busts the ESM cache).
async function loadApex() {
  return import(`${APEX_URL}?t=${Math.random()}`);
}

function setLocation(origin: string | null) {
  if (origin === null) {
    delete (globalThis as { location?: unknown }).location;
    return;
  }
  const u = new URL(origin);
  (globalThis as { location?: unknown }).location = {
    origin: u.origin,
    protocol: u.protocol,
    host: u.host,
    href: u.href,
  };
}

describe("apex — prod default (no browser origin, no override)", () => {
  beforeEach(() => setLocation(null));
  afterEach(() => setLocation(null));

  it("control apex falls back to the prod literal byte-for-byte", async () => {
    const a = await loadApex();
    expect(a.controlApex()).toBe("https://flagshipserver.com");
    expect(a.controlHost()).toBe("flagshipserver.com");
  });

  it("data apex falls back to the prod literal", async () => {
    const a = await loadApex();
    expect(a.dataApex()).toBe("flagship.services");
    expect(a.serverFqdn("home", "harry")).toBe("home.harry.flagship.services");
    expect(a.userZoneHost("harry")).toBe("harry.flagship.services");
  });

  it("sub-origins fall back to the prod sub-origins", async () => {
    const a = await loadApex();
    expect(a.bootOrigin()).toBe("https://boot.flagshipserver.com");
    expect(a.recoveryOrigin()).toBe("https://recovery.flagshipserver.com");
    expect(a.webappOrigin()).toBe("https://webapp.flagshipserver.com");
  });
});

describe("apex — origin-driven retarget (served from a flagship host)", () => {
  afterEach(() => setLocation(null));

  it("served from webapp.flagshipserver.com ⇒ adopts the prod apex (prod behaviour)", async () => {
    setLocation("https://webapp.flagshipserver.com");
    const a = await loadApex();
    expect(a.controlApex()).toBe("https://flagshipserver.com");
    expect(a.controlHost()).toBe("flagshipserver.com");
    expect(a.dataApex()).toBe("flagship.services");
    expect(a.bootOrigin()).toBe("https://boot.flagshipserver.com");
  });

  it("served from the bare apex ⇒ adopts it", async () => {
    setLocation("https://flagshipserver.com");
    const a = await loadApex();
    expect(a.controlApex()).toBe("https://flagshipserver.com");
  });

  it("served from gym.flagshipserver.com ⇒ retargets the WHOLE stack at gym", async () => {
    setLocation("https://gym.flagshipserver.com");
    const a = await loadApex();
    expect(a.controlApex()).toBe("https://gym.flagshipserver.com");
    expect(a.controlHost()).toBe("gym.flagshipserver.com");
    // The data plane mirrors the gym prefix.
    expect(a.dataApex()).toBe("gym.flagship.services");
    expect(a.serverFqdn("home", "harry")).toBe("home.harry.gym.flagship.services");
    // Sub-origins ride the gym apex too.
    expect(a.bootOrigin()).toBe("https://boot.gym.flagshipserver.com");
    expect(a.recoveryOrigin()).toBe("https://recovery.gym.flagshipserver.com");
  });

  it("served from webapp.gym.flagshipserver.com ⇒ strips web., keeps gym", async () => {
    setLocation("https://webapp.gym.flagshipserver.com");
    const a = await loadApex();
    expect(a.controlApex()).toBe("https://gym.flagshipserver.com");
    expect(a.dataApex()).toBe("gym.flagship.services");
  });

  it("a non-flagship host does NOT retarget — falls back to prod (no silent hijack)", async () => {
    setLocation("https://evil.example.com");
    const a = await loadApex();
    expect(a.controlApex()).toBe("https://flagshipserver.com");
    expect(a.dataApex()).toBe("flagship.services");
  });

  it("localhost dev is accepted (kept on the served origin)", async () => {
    setLocation("http://localhost:8787");
    const a = await loadApex();
    expect(a.controlApex()).toBe("http://localhost:8787");
  });
});

describe("apex — explicit override seam (gym harness / non-browser callers)", () => {
  beforeEach(() => setLocation(null));
  afterEach(() => setLocation(null));

  it("setApexOverride forces both apexes, ignoring the origin", async () => {
    setLocation("https://webapp.flagshipserver.com"); // would otherwise be prod
    const a = await loadApex();
    a.setApexOverride({
      control: "https://gym.flagshipserver.com",
      data: "gym.flagship.services",
    });
    expect(a.controlApex()).toBe("https://gym.flagshipserver.com");
    expect(a.dataApex()).toBe("gym.flagship.services");
    expect(a.bootOrigin()).toBe("https://boot.gym.flagshipserver.com");
    expect(a.serverFqdn("blog", "alice")).toBe("blog.alice.gym.flagship.services");
  });

  it("a trailing slash on the control override is trimmed", async () => {
    const a = await loadApex();
    a.setApexOverride({ control: "https://gym.flagshipserver.com/", data: "gym.flagship.services" });
    expect(a.controlApex()).toBe("https://gym.flagshipserver.com");
  });

  it("setApexOverride(null) restores the prod default", async () => {
    const a = await loadApex();
    a.setApexOverride({ control: "https://gym.flagshipserver.com", data: "gym.flagship.services" });
    a.setApexOverride(null);
    expect(a.controlApex()).toBe("https://flagshipserver.com");
    expect(a.dataApex()).toBe("flagship.services");
  });
});
