// The browser-JS port of the security notice (lib/securityNotice.js) against
// the shared vectors packages/protocol/test-vectors/security-notice, the same
// file the TypeScript reference passes. Swift and Kotlin pass it too.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const V = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/security-notice/vectors.json"), "utf8"),
);
const load = () => import(pathToFileURL(resolve(__dirname, "../public/webapp/lib/securityNotice.js")).href);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const auth = V.keys.authorityPubHex as string;

describe("webapp security notice: shared vectors", () => {
  it("reproduces every canonical string and verifies every positive", async () => {
    const sn = await load();
    for (const p of V.positive) {
      const n = sn.parseSecurityNotice(p.notice);
      expect(n, p.name).not.toBeNull();
      expect(text(sn.canonicalSecurityNotice(n, n.signedBy)), p.name).toBe(p.canonical);
      expect(await sn.verifySecurityNotice(n, [auth]), p.name).toEqual({ ok: true });
    }
  });

  it("refuses every reject with its reason", async () => {
    const sn = await load();
    for (const r of V.reject) {
      const n = sn.parseSecurityNotice(r.notice);
      const got = n ? await sn.verifySecurityNotice(n, [auth]) : { ok: false, reason: "malformed" };
      expect(got, r.name).toEqual({ ok: false, reason: r.expect });
    }
  });

  it("will not build bytes for a body that breaks a rule, with the same first code", async () => {
    const sn = await load();
    for (const u of V.unsignable) {
      let code = null;
      try {
        sn.canonicalSecurityNotice(u.body, auth);
      } catch (e) {
        code = (e as { code: string }).code;
      }
      expect(code, u.name).toBe(u.code);
    }
  });

  it("shows what the outcomes table says", async () => {
    const sn = await load();
    for (const o of V.outcomes) {
      const n = sn.parseSecurityNotice(o.notice);
      const got = sn.securityNoticeOutcome(n, o.client, o.now);
      const flat =
        got.action === "none" ? { action: "none", why: got.why } : got.action === "banner" ? { action: "banner", style: got.style } : { action: "lock" };
      expect(flat, o.name).toEqual(o.expect);
    }
  });

  it("absorbs candidates the way the accept table says", async () => {
    const sn = await load();
    for (const a of V.accept) {
      const st = { highestSeq: a.store.highestSeq, notice: a.store.notice ? sn.parseSecurityNotice(a.store.notice) : null };
      const r = await sn.acceptSecurityNotice(st, a.candidate, a.authorityKeys);
      expect({ highestSeq: r.store.highestSeq, seq: r.store.notice ? r.store.notice.seq : null, refused: r.refused }, a.name).toEqual(a.expect);
    }
  });
});
