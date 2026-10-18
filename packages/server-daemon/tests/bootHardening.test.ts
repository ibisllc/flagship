import { describe, expect, it } from "vitest";
import { shouldReuseCert, shouldServeStaleCert } from "../src/acme/persistentStore.js";
import { waitForRelay } from "../src/runtime.js";

describe("boot hardening: a box with no relay still comes up", () => {
  it("goes on after the grace period when the relay never answers", async () => {
    const started = Date.now();
    expect(await waitForRelay(() => new Promise(() => {}), 40)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });
  it("goes on at once when the relay answers, and says so", async () => {
    const started = Date.now();
    expect(await waitForRelay(async () => {}, 60_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it("does not hang on a relay that fails", async () => {
    expect(await waitForRelay(() => Promise.reject(new Error("no route")), 60_000)).toBe(false);
  });
});

describe("the certificate a rebooted box shows when it cannot get a new one", () => {
  const day = 86_400_000;
  const now = 2_000_000_000_000;
  const sans = ["home.alice.flagship.services", "*.home.alice.flagship.services"];
  const cert = (notAfter: number, names = sans) => ({ certPem: "x", privateKeyPem: "y", names, notAfter, issuedAt: now - 60 * day });

  it("reuses a cert with time left, as before", () => {
    expect(shouldReuseCert(cert(now + 80 * day), sans, 30 * day, now)).toBe(true);
  });
  it("is not reused inside the renewal window or past its end, but is still served", () => {
    for (const left of [29 * day, 1 * day, -5 * day]) {
      const c = cert(now + left);
      expect(shouldReuseCert(c, sans, 30 * day, now)).toBe(false);
      expect(shouldServeStaleCert(c, sans)).toBe(true);
    }
  });
  it("is not served when it names something else (a renamed or re-homed box) or does not exist", () => {
    expect(shouldServeStaleCert(cert(now - day, ["home.bob.flagship.services"]), sans)).toBe(false);
    expect(shouldServeStaleCert(null, sans)).toBe(false);
  });
});
