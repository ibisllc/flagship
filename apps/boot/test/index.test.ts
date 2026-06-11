/**
 * apps/boot is the OPTIONAL cloneable boot worker — the reference
 * deployment now serves boot.flagshipserver.com from flagship-com (see
 * apps/com/test/bootHost.integration.test.ts). These smoke tests just
 * confirm the standalone worker still wires @flagship/boot-core correctly:
 * health answers, the 503 guards fire when unconfigured, and a non-boot
 * path 404s. The full route/gate behaviour is covered by the boot-core
 * package tests (packages/boot-core/tests/*).
 */

import { describe, it, expect } from "vitest";
import worker, { type BootEnv } from "../src/index.js";

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`https://boot.flagshipserver.com${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("apps/boot standalone worker entry", () => {
  it("answers /api/health without any config", async () => {
    const res = await worker.fetch(req("GET", "/api/health"), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("flagship-boot");
  });

  it("404s a non-boot path", async () => {
    const res = await worker.fetch(req("GET", "/api/users/alice/pods"), {});
    expect(res.status).toBe(404);
  });

  it("503s a /api/boot/* path when IDENTITY_PLANE_URL is unset", async () => {
    const res = await worker.fetch(req("GET", "/api/boot/lease/kitchen.alice.flagship.services"), {});
    expect(res.status).toBe(503);
  });

  it("503s a /api/boot/* path when DB is unbound", async () => {
    const env: BootEnv = { IDENTITY_PLANE_URL: "https://flagshipserver.com" };
    const res = await worker.fetch(req("GET", "/api/boot/lease/kitchen.alice.flagship.services"), env);
    expect(res.status).toBe(503);
  });
});
