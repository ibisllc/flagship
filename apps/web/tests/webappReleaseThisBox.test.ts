// "Release this box" on the webapp (docs/retail-box-setup.md §8.2): the order against the shared
// vectors (packages/protocol/test-vectors/box-release), signing with the admin root only, the
// server page's card (retail boxes only, admin vs other devices), and the box's refusals.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { verifyBoxRelease } from "@flagship/protocol";

const V = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/box-release/vectors.json"), "utf8"));
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const ADMIN_SEED = fromHex(V.keys.adminRootSeedHex);
const ADMIN_PUB = fromHex(V.keys.adminRootPubHex);
const FIELDS = V.order.fields;
const ADMIN = { umk: new Uint8Array(1), adminRootSeed: ADMIN_SEED };

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}

describe("box release order (shared vectors)", () => {
  it("reproduces the canonical bytes and the pinned signature with the admin root seed", async () => {
    const R = await load("lib/releaseThisBox.js");
    expect(utf8(R.canonicalBoxRelease(FIELDS))).toBe(V.order.canonical);
    const body = await R.signBoxRelease(FIELDS, ADMIN_SEED);
    expect(body.signatureHex).toBe(V.order.signatureHex);
    expect(body.order).toEqual(FIELDS);
    expect(verifyBoxRelease(FIELDS, fromHex(body.signatureHex), ADMIN_PUB)).toBe(true);
  });

  it("refuses every bad shape before signing", async () => {
    const R = await load("lib/releaseThisBox.js");
    for (const r of V.refuse) {
      expect(R.boxReleaseProblem(r.fields), r.why).toBe(r.problem);
      expect(() => R.canonicalBoxRelease(r.fields), r.why).toThrow();
    }
  });

  it("none of the reject cases verifies", async () => {
    const R = await load("lib/releaseThisBox.js");
    for (const r of V.reject) {
      expect(ed25519.verify(fromHex(r.signatureHex), R.canonicalBoxRelease(r.fields), fromHex(r.verifyUnder)), r.why).toBe(false);
    }
  });

  it("a fresh order is lowercase with a 16-byte nonce", async () => {
    const R = await load("lib/releaseThisBox.js");
    const o = R.makeBoxRelease({ serverDomain: "Home.Alice.flagship.services", stkPubHex: FIELDS.stkPubHex.toUpperCase(), issuedAt: 5 });
    expect(o.serverDomain).toBe("home.alice.flagship.services");
    expect(o.stkPubHex).toBe(FIELDS.stkPubHex);
    expect(o.nonceHex).toMatch(/^[0-9a-f]{32}$/);
    expect(R.boxReleaseProblem(o)).toBeNull();
  });
});

describe("the server page's Release this box", () => {
  const RETAIL = { stkPubHex: FIELDS.stkPubHex };

  it("shows only on a retail box; other devices see why they can't", async () => {
    const view = await load("views/release-this-box.js");
    expect(view.releaseThisBoxCardHtml(undefined, { isAdmin: true })).toBe("");
    expect(view.releaseThisBoxCardHtml({ stkPubHex: "nope" }, { isAdmin: true })).toBe("");
    const admin = view.releaseThisBoxCardHtml(RETAIL, { isAdmin: true });
    expect(admin).toContain("release-box-btn");
    expect(admin).toMatch(/wipes everything on this box/);
    const other = view.releaseThisBoxCardHtml(RETAIL, { isAdmin: false });
    expect(other).not.toContain("release-box-btn");
    expect(other).toContain("Only an admin device of this account can release this box.");
  });

  it("refuses a device without the admin root before asking or sending", async () => {
    const view = await load("views/release-this-box.js");
    let asked = false;
    const deps = {
      session: { umk: new Uint8Array(1), adminRootSeed: null },
      freshUnlock: async () => ((asked = true), { ok: true }),
      fetchJson: async () => {
        throw new Error("must not send");
      },
    };
    const r = await view.submitRelease({ fqdn: FIELDS.serverDomain, stkPubHex: FIELDS.stkPubHex }, deps);
    expect(r).toEqual({ ok: false, error: "Only an admin device of this account can release this box." });
    expect(asked).toBe(false);
  });

  it("signs with the admin root and sends what the box verifies", async () => {
    const view = await load("views/release-this-box.js");
    let sent: { path: string; body: { order: typeof FIELDS; signatureHex: string } } | null = null;
    const r = await view.submitRelease(
      { fqdn: FIELDS.serverDomain, stkPubHex: FIELDS.stkPubHex },
      {
        session: ADMIN,
        freshUnlock: async () => ({ ok: true }),
        now: () => FIELDS.issuedAt,
        random: () => fromHex(FIELDS.nonceHex),
        fetchJson: async (path: string, init: { body: string }) => ((sent = { path, body: JSON.parse(init.body) }), { ok: true }),
      },
    );
    expect(r).toEqual({ ok: true });
    expect(sent!.path).toBe("/api/screens/box-release");
    expect(sent!.body.order).toEqual(FIELDS);
    expect(sent!.body.signatureHex).toBe(V.order.signatureHex);
    expect(sent!.body).not.toHaveProperty("pqSignature");
  });

  it("a cancelled unlock sends nothing; the box's refusals read as sentences", async () => {
    const view = await load("views/release-this-box.js");
    let sent = false;
    const base = { fqdn: FIELDS.serverDomain, stkPubHex: FIELDS.stkPubHex };
    expect(await view.submitRelease(base, { session: ADMIN, freshUnlock: async () => ({ ok: false, cancelled: true }), fetchJson: async () => ((sent = true), {}) })).toEqual({
      ok: false,
      cancelled: true,
    });
    expect(sent).toBe(false);
    const refuse = (code: string) =>
      view.submitRelease(base, {
        session: ADMIN,
        freshUnlock: async () => ({ ok: true }),
        fetchJson: async () => {
          throw Object.assign(new Error(code), { status: 403, body: { error: code, code } });
        },
      });
    expect((await refuse("release-needs-hybrid")).error).toMatch(/quantum-safe signature, which the webapp can.t make/);
    expect((await refuse("release-not-admin")).error).toBe("Only this account's admin key can release this box.");
    expect((await refuse("release-not-claimed")).error).toBe("This box is already released.");
    expect((await refuse("release-whatever")).error).toBe("The box couldn't be released. Try again in a moment.");
  });
});
