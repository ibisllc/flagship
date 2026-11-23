import { describe, expect, it, vi } from "vitest";
import { ed, signTotpEnrollBegin } from "@flagship/protocol";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { route, type RouteEnv } from "../src/route.js";
import { outcomeOf, pruneTotpOutcomeLog, readTotpOutcomes, recordTotpOutcome } from "../src/totpOutcomeLog.js";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const today = () => new Date().toISOString().slice(0, 10);

function env(db: D1Database): RouteEnv {
  return {
    SERVICES_BASE_URL: "https://flagship.services",
    ASSETS: { async fetch() { return new Response("asset"); } },
    DB: db,
    FLAGSHIP_TOTP_KEK: "11".repeat(32),
    FLAGSHIP_ADMIN_SECRET: "s3cret",
  } as unknown as RouteEnv;
}

describe("code protection outcome log (F2)", () => {
  it("outcomeOf: ok, a refusal's code, else the status", () => {
    expect(outcomeOf(200, {})).toBe("ok");
    expect(outcomeOf(409, { code: "totp-already-enrolled" })).toBe("totp-already-enrolled");
    expect(outcomeOf(403, { error: "x" })).toBe("http-403");
    expect(outcomeOf(400, { code: "Not A Slug!" })).toBe("http-400");
  });

  it("counts each enrolment call's outcome through the Worker and reports it to the operator", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sqlite = createSqliteD1();
    const db = sqlite as unknown as D1Database;
    try {
      const priv = new Uint8Array(32).fill(7);
      const pub = ed.getPublicKey(priv);
      sqlite.raw.prepare("INSERT INTO usernames (username, irk_pub_hex, claimed_at) VALUES (?, ?, ?)").run("alice", hex(pub), 1);
      const post = (signature: string) => {
        const issuedAt = Date.now();
        return route(
          new Request("https://flagshipserver.com/api/users/alice/totp/enroll-begin", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "https://webapp.flagshipserver.com" },
            body: JSON.stringify({
              request: { username: "alice", issuedAt },
              signature: signature || hex(signTotpEnrollBegin({ username: "alice", issuedAt }, { privateKey: priv, publicKey: pub })),
            }),
          }),
          env(db),
        );
      };
      const bad = await post("00".repeat(64));
      expect(bad.status).toBe(403);
      expect(((await bad.json()) as { code: string }).code).toBe("invalid-signature");
      const good = await post("");
      expect(good.status).toBe(200);
      expect(good.headers.get("access-control-allow-origin")).toBe("https://webapp.flagshipserver.com");

      const rows = await readTotpOutcomes(db, today());
      expect(rows.map((r) => [r.endpoint, r.outcome, Number(r.count)])).toEqual([
        ["enroll-begin", "invalid-signature", 1],
        ["enroll-begin", "ok", 1],
      ]);

      const denied = await route(new Request("https://flagshipserver.com/api/admin/totp-outcomes"), env(db));
      expect(denied.status).toBe(401);
      const report = await route(
        new Request("https://flagshipserver.com/api/admin/totp-outcomes?days=3", { headers: { "x-admin-secret": "s3cret" } }),
        env(db),
      );
      expect(report.status).toBe(200);
      const body = (await report.json()) as { days: number; totals: Record<string, Record<string, number>> };
      expect(body.days).toBe(3);
      expect(body.totals["enroll-begin"]).toEqual({ "invalid-signature": 1, ok: 1 });
      expect(body.totals["enroll-confirm"]).toEqual({});
      // Nothing about the caller or the account is kept.
      const all = sqlite.raw.prepare("SELECT * FROM totp_outcome_log").all();
      expect(JSON.stringify(all)).not.toContain("alice");
    } finally {
      sqlite.close();
      vi.restoreAllMocks();
    }
  });

  it("prunes rows older than 90 days", async () => {
    const sqlite = createSqliteD1();
    const db = sqlite as unknown as D1Database;
    try {
      await recordTotpOutcome(db, "disable", "ok", new Date("2026-01-01T05:00:00Z"));
      await recordTotpOutcome(db, "disable", "ok", new Date("2026-06-01T05:00:00Z"));
      await pruneTotpOutcomeLog(db, new Date("2026-06-02T00:00:00Z"));
      expect((await readTotpOutcomes(db, "2025-01-01")).map((r) => r.day)).toEqual(["2026-06-01"]);
    } finally {
      sqlite.close();
    }
  });
});
