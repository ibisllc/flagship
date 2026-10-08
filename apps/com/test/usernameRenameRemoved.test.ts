/**
 * Regression: the legacy #93 `POST /api/username/rename` route is gone.
 *
 * It allocated any IRK-holder an arbitrary new handle with none of the
 * claim path's controls — no suggestion roster, no grammar/reserved-word
 * check, no name-change entitlement — and it was used in prod to squat the
 * reserved `e2e` label. The paid name change is a different route
 * (`POST /api/account/name-change`, docs/naming-recovery-and-name-change.md
 * §5-6). Until that lands, nothing on `.com` may rename an account, so this
 * replays the exact reported request (a correctly-signed rename of a
 * registered account onto a reserved name) and requires that no handler
 * takes it and nothing is written. The edge must also answer it itself:
 * an unhandled /api/ path is proxied to .services, so without the
 * tombstone the 404 would only hold for as long as the upstream also lacked
 * the route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { route, type RouteEnv } from "../src/route.js";
import type { D1Database } from "@flagship/storage";
import { deriveIRK, signUsernameRename } from "@flagship/protocol";

const irk = deriveIRK({ seed: new Uint8Array(32).fill(7) });
const irkPubHex = Buffer.from(irk.publicKey).toString("hex");

function recordingDb(sql: string[]): D1Database {
  return {
    prepare: (q: string) => {
      sql.push(q);
      return {
        bind: (...args: unknown[]) => ({
          first: async () =>
            /FROM usernames WHERE/.test(q) && args[0] === "rapid-bison"
              ? { username: "rapid-bison", irk_pub_hex: irkPubHex, claimed_at: 1 }
              : null,
          all: async () => ({ results: [], success: true, meta: {} }),
          run: async () => ({ success: true, meta: { changes: 1 } }),
        }),
      };
    },
    batch: async () => [],
  } as unknown as D1Database;
}

describe("username rename is not a .com route", () => {
  it("a validly-signed rename onto a reserved name is unhandled and writes nothing", async () => {
    const sql: string[] = [];
    const request = { oldUsername: "rapid-bison", newUsername: "e2e", effectiveAt: Date.now() };
    const signature = Buffer.from(signUsernameRename(request, irk)).toString("hex");
    const env: ControlPlaneEnv = { DB: recordingDb(sql) };

    const r = await tryControlPlane(
      new Request("https://flagshipserver.com/api/username/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request, signature }),
      }),
      env,
    );

    expect(r).toBeNull();
    expect(sql.filter((q) => /INSERT|UPDATE|DELETE/i.test(q))).toEqual([]);
  });

  it("the alias lookup that only the rename fed is gone too", async () => {
    const r = await tryControlPlane(
      new Request("https://flagshipserver.com/api/username/alias/rapid-bison"),
      { DB: recordingDb([]) },
    );
    expect(r).toBeNull();
  });
});

describe("the edge tombstones the retired routes instead of proxying them", () => {
  const realFetch = globalThis.fetch;
  let upstream: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    upstream = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = upstream as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function env(db?: D1Database): RouteEnv {
    return {
      SERVICES_BASE_URL: "https://flagship.services",
      ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
      ...(db ? { DB: db } : {}),
    };
  }

  const variants: Array<[string, string]> = [
    ["POST", "/api/username/rename"],
    ["POST", "/api/username/rename/"],
    ["POST", "/api/username//rename"],
    ["POST", "/api/username/RENAME"],
    ["POST", "/api/username/%72ename"],
    ["GET", "/api/username/alias/fresh-poppy"],
    ["GET", "/api/username/alias"],
    ["PUT", "/api/username/alias/x"],
  ];

  for (const withDb of [false, true]) {
    for (const [method, path] of variants) {
      it(`${method} ${path} → 404 without reaching .services or D1 (DB ${withDb ? "bound" : "unbound"})`, async () => {
        const sql: string[] = [];
        const r = await route(
          new Request(`https://flagshipserver.com${path}`, {
            method,
            headers: { "content-type": "application/json" },
            ...(method === "GET" ? {} : { body: "{}" }),
          }),
          env(withDb ? recordingDb(sql) : undefined),
        );
        expect(r.status).toBe(404);
        expect(upstream).not.toHaveBeenCalled();
        expect(sql).toEqual([]);
      });
    }
  }

  it("leaves the neighbouring username routes alone", async () => {
    await route(new Request("https://flagshipserver.com/api/username/rapid-bison"), env());
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
