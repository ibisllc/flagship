import { describe, expect, it } from "vitest";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import type { D1Database } from "@flagship/storage";

function stubDb(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        all: async () => ({ results: [], success: true, meta: {} }),
        run: async () => ({ success: true, meta: {} }),
      }),
    }),
    batch: async () => [],
  } as unknown as D1Database;
}
const env = (extra: Partial<ControlPlaneEnv> = {}): ControlPlaneEnv => ({ DB: stubDb(), ...extra });

describe("name dibs routes", () => {
  it("GET /api/name-dibs/window reports off when no window is configured", async () => {
    const r = await tryControlPlane(new Request("https://flagshipserver.com/api/name-dibs/window"), env());
    expect(r!.status).toBe(200);
    expect(await r!.json()).toMatchObject({ configured: false, open: false, scope: ".com", priceUsd: 20 });
  });

  it("GET /api/name-dibs/window reads the window from env", async () => {
    const r = await tryControlPlane(
      new Request("https://flagshipserver.com/api/name-dibs/window"),
      env({ DIBS_WINDOW_START: "2000-01-01", DIBS_WINDOW_END: "2999-01-01" }),
    );
    expect(await r!.json()).toMatchObject({ configured: true, open: true });
  });

  it("POST initiate and verify reach their handlers", async () => {
    for (const p of ["initiate", "verify"]) {
      const r = await tryControlPlane(
        new Request(`https://flagshipserver.com/api/name-dibs/${p}`, { method: "POST", body: "{}" }),
        env(),
      );
      expect(r!.status).toBe(400);
      expect(((await r!.json()) as { error: string }).error).toMatch(/malformed dibs/);
    }
  });
});
