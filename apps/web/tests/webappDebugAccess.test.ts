// Owner debug access on the webapp (docs/recipe-delivery-and-remote-install.md
// "Debug access"): the envelopes against the shared vectors, signing with the
// sensitive-order key, the server page's section (admin vs other devices),
// turn on / renew / turn off against a fake box, and the Activity labels.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { verifyDebugAccessGrant, verifyDebugAccessRevoke } from "@flagship/protocol";

const V = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/debug-access/vectors.json"), "utf8"),
);
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const ADMIN_SEED = fromHex(V.keys.adminRootSeedHex);
const ADMIN_PUB = fromHex(V.keys.adminRootPubHex);
const KEY = V.grant.fields.sshPublicKey as string;
const FQDN = V.grant.fields.serverDomain as string;
const adminSign = async (_umk: Uint8Array, bytes: Uint8Array) => ed25519.sign(bytes, ADMIN_SEED);

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}

describe("debug access envelopes (shared vectors)", () => {
  it("normalizes and fingerprints SSH keys", async () => {
    const D = await load("lib/debugAccess.js");
    for (const k of V.sshKeys.accept) {
      expect(D.normalizeSshPublicKey(k.input)).toBe(k.normalized);
      expect(D.sshKeyFingerprint(k.input)).toBe(k.fingerprint);
    }
    for (const r of V.sshKeys.reject) expect(D.normalizeSshPublicKey(r), r).toBeNull();
  });

  it("reproduces the canonical strings; the pinned signatures verify under the admin root only", async () => {
    const D = await load("lib/debugAccess.js");
    expect(utf8(D.canonicalDebugAccessGrant(V.grant.fields))).toBe(V.grant.canonical);
    expect(utf8(D.canonicalDebugAccessRevoke(V.revoke.fields))).toBe(V.revoke.canonical);
    const grantBytes = D.canonicalDebugAccessGrant(V.grant.fields);
    expect(ed25519.verify(fromHex(V.grant.signatureHex), grantBytes, ADMIN_PUB)).toBe(true);
    expect(ed25519.verify(fromHex(V.grant.signatureHex), grantBytes, fromHex(V.keys.irkPubHex))).toBe(false);
    expect(ed25519.verify(fromHex(V.grant.reject.signatureHex), grantBytes, ADMIN_PUB)).toBe(false);
    const revokeBytes = D.canonicalDebugAccessRevoke(V.revoke.fields);
    expect(ed25519.verify(fromHex(V.revoke.signatureHex), revokeBytes, ADMIN_PUB)).toBe(true);
    expect(ed25519.verify(fromHex(V.revoke.reject.signatureHex), revokeBytes, ADMIN_PUB)).toBe(false);
  });

  it("refuses every refuse case before signing", async () => {
    const D = await load("lib/debugAccess.js");
    for (const r of V.refuse) expect(D.debugAccessGrantProblem(r.fields), r.why).not.toBeNull();
  });

  it("signs carriers the box takes, with the pasted key normalized", async () => {
    const D = await load("lib/debugAccess.js");
    const now = V.grant.fields.issuedAt;
    const g = await D.buildDebugAccessGrant(
      { serverDomain: FQDN, sshPublicKey: `${KEY} me@laptop`, durationMs: D.DEBUG_ACCESS_DEFAULT_MS },
      { umk: new Uint8Array(1), sign: adminSign, now: () => now },
    );
    expect(g.grant).toEqual(V.grant.fields);
    expect(verifyDebugAccessGrant(g.grant, fromHex(g.signatureHex), ADMIN_PUB)).toBe(true);
    const r = await D.buildDebugAccessRevoke(
      { serverDomain: FQDN },
      { umk: new Uint8Array(1), sign: adminSign, now: () => V.revoke.fields.issuedAt },
    );
    expect(r.revoke).toEqual(V.revoke.fields);
    expect(verifyDebugAccessRevoke(r.revoke, fromHex(r.signatureHex), ADMIN_PUB)).toBe(true);
    let signed = false;
    const spy = async () => ((signed = true), new Uint8Array(64));
    await expect(
      D.buildDebugAccessGrant({ serverDomain: FQDN, sshPublicKey: "", durationMs: 1000 }, { umk: new Uint8Array(1), sign: spy }),
    ).rejects.toThrow("Debug access needs an SSH public key.");
    await expect(
      D.buildDebugAccessGrant({ serverDomain: FQDN, sshPublicKey: KEY, durationMs: 8 * 24 * 3600_000 }, { umk: new Uint8Array(1), sign: spy }),
    ).rejects.toThrow(/7 days/);
    expect(signed).toBe(false);
  });

  it("both tags sign with the admin root", async () => {
    const { SENSITIVE_TAGS } = await load("lib/adminRoot.js");
    expect(SENSITIVE_TAGS.has("flagship/debug-access/v2")).toBe(true);
    expect(SENSITIVE_TAGS.has("flagship/debug-access-revoke/v1")).toBe(true);
  });

  it("offers 1 hour, 24 hours (default) and 7 days", async () => {
    const D = await load("lib/debugAccess.js");
    expect(D.DEBUG_DURATIONS.map((d: { label: string }) => d.label)).toEqual(["1 hour", "24 hours", "7 days"]);
    expect(D.DEBUG_DEFAULT_DURATION).toBe("24h");
    expect(D.debugAccessBanner({ on: true, expiresAt: 5 }, () => "5pm")).toBe("Debug access is on until 5pm.");
    expect(D.debugAccessBanner({ on: false, expiresAt: null }, () => "x")).toBeNull();
  });
});

describe("the server page's Debug access section", () => {
  const ON = { on: true, expiresAt: Date.now() + 3600_000, keyFingerprint: V.sshKeys.accept[0].fingerprint, grantedBy: "admin" };
  const OFF = { on: false, expiresAt: null, keyFingerprint: null, grantedBy: null };
  const ADMIN = { umk: new Uint8Array(1), adminRootSeed: ADMIN_SEED };

  it("is hidden on a box that doesn't report it, and read-only for other devices", async () => {
    const view = await load("views/debug-access.js");
    expect(view.debugAccessCardHtml(undefined, { isAdmin: true })).toBe("");
    const html = view.debugAccessCardHtml(ON, { isAdmin: false });
    expect(html).toContain("Only an admin device can turn debug access on or off.");
    expect(html).not.toContain("debug-access-on-btn");
    expect(html).toContain(ON.keyFingerprint);
    const admin = view.debugAccessCardHtml(ON, { isAdmin: true });
    expect(admin).toContain(">Renew<");
    expect(admin).toContain("debug-access-off-btn");
    expect(admin).toMatch(/Anyone with this key can read everything on this server while it.{1,6}s on\./);
    expect(view.debugAccessCardHtml(OFF, { isAdmin: true })).toContain(">Turn on<");
    expect(view.debugAccessBannerHtml(ON)).toMatch(/Debug access is on until /);
    expect(view.debugAccessBannerHtml(OFF)).toContain('class="hidden"');
  });

  it("refuses non-admin devices and bad keys before asking or signing", async () => {
    const view = await load("views/debug-access.js");
    let asked = false;
    const confirm = async () => ((asked = true), true);
    const fetchJson = async () => {
      throw new Error("must not send");
    };
    const base = { fqdn: FQDN, durationId: "24h", renewing: false };
    expect(await view.submitDebugOn({ ...base, rawKey: KEY }, { session: { umk: new Uint8Array(1), adminRootSeed: null }, confirm, fetchJson }))
      .toEqual({ ok: false, error: "Only an admin device can turn debug access on or off." });
    expect(await view.submitDebugOn({ ...base, rawKey: "" }, { session: ADMIN, confirm, fetchJson }))
      .toEqual({ ok: false, error: "Debug access needs an SSH public key." });
    expect(await view.submitDebugOn({ ...base, rawKey: "not a key" }, { session: ADMIN, confirm, fetchJson }))
      .toEqual({ ok: false, error: "That isn't an SSH public key this server can use." });
    expect(await view.submitDebugOff({ fqdn: FQDN }, { session: { umk: null, adminRootSeed: ADMIN_SEED }, confirm, fetchJson }))
      .toEqual({ ok: false, error: "Unlock the webapp first." });
    expect(asked).toBe(false);
  });

  it("an admin device turns it on, renews and turns it off; a refusal reads in the box's words", async () => {
    const view = await load("views/debug-access.js");
    const { ScreensError } = await load("lib/api.js");
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    let refuse: string | null = null;
    const fetchJson = async (path: string, init: { body: string }) => {
      posts.push({ path, body: JSON.parse(init.body) });
      if (refuse) throw new ScreensError(refuse, 403, { error: refuse });
      if (path.endsWith("/revoke")) return { ok: true, change: "revoked", debugAccess: OFF };
      return { ok: true, change: posts.length > 1 ? "renewed" : "granted", debugAccess: ON };
    };
    const deps = { session: ADMIN, confirm: async () => true, fetchJson, sign: adminSign };

    const on = await view.submitDebugOn({ fqdn: FQDN, rawKey: `${KEY} me@laptop`, durationId: "1h", renewing: false }, deps);
    expect(on).toEqual({ ok: true, change: "granted", view: ON });
    expect(posts[0]!.path).toBe("/api/screens/debug-access");
    const g = posts[0]!.body.grant as { sshPublicKey: string; issuedAt: number; expiresAt: number; serverDomain: string };
    expect(g.sshPublicKey).toBe(KEY);
    expect(g.serverDomain).toBe(FQDN);
    expect(g.expiresAt - g.issuedAt).toBe(3600_000);
    expect(verifyDebugAccessGrant(g as never, fromHex(posts[0]!.body.signatureHex as string), ADMIN_PUB)).toBe(true);

    const renew = await view.submitDebugOn({ fqdn: FQDN, rawKey: KEY, durationId: "7d", renewing: true }, deps);
    expect(renew.change).toBe("renewed");
    const g2 = posts[1]!.body.grant as { issuedAt: number; expiresAt: number };
    expect(g2.expiresAt - g2.issuedAt).toBe(7 * 24 * 3600_000);

    const off = await view.submitDebugOff({ fqdn: FQDN }, deps);
    expect(off).toEqual({ ok: true, change: "revoked", view: OFF });
    expect(posts[2]!.path).toBe("/api/screens/debug-access/revoke");
    expect(verifyDebugAccessRevoke(posts[2]!.body.revoke as never, fromHex(posts[2]!.body.signatureHex as string), ADMIN_PUB)).toBe(true);

    refuse = "This server takes debug access only from an admin device of this account.";
    expect(await view.submitDebugOn({ fqdn: FQDN, rawKey: KEY, durationId: "24h", renewing: false }, deps))
      .toEqual({ ok: false, error: refuse });
  });

  it("cancelling the warning sends nothing", async () => {
    const view = await load("views/debug-access.js");
    let sent = false;
    const r = await view.submitDebugOn(
      { fqdn: FQDN, rawKey: KEY, durationId: "24h", renewing: false },
      { session: ADMIN, confirm: async () => false, fetchJson: async () => ((sent = true), {}) },
    );
    expect(r).toEqual({ ok: false, cancelled: true });
    expect(sent).toBe(false);
  });
});

describe("Activity labels", () => {
  it("labels the four debug-access entries", async () => {
    const { BOX_EVENT_LABELS } = await load("lib/activityFeed.js");
    expect(BOX_EVENT_LABELS["server.debug-access.granted"].label).toBe("Debug access turned on");
    expect(BOX_EVENT_LABELS["server.debug-access.renewed"].label).toBe("Debug access renewed");
    expect(BOX_EVENT_LABELS["server.debug-access.expired"].label).toBe("Debug access ended");
    expect(BOX_EVENT_LABELS["server.debug-access.revoked"].label).toBe("Debug access turned off");
  });
});
