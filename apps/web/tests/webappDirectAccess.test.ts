// Direct access on the webapp (docs/direct-access-and-domains.md §5, §7, §8): the
// direct-access/v1 and direct-name/v1 orders against the shared vectors, the
// sensitive-order signer, the `.com` client and its sentence table, the server
// page's section (admin vs other devices) with its submit functions against a
// fake box and a fake `.com`, and the app page's link to share.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { verifyDirectAccessOrder, verifyDirectNameOrder } from "@flagship/protocol";

const VECTORS = resolve(__dirname, "../../../packages/protocol");
const VA = JSON.parse(readFileSync(resolve(VECTORS, "test-vectors/direct-access/vectors.json"), "utf8"));
const VN = JSON.parse(readFileSync(resolve(VECTORS, "test-vectors/direct-name/vectors.json"), "utf8"));
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const ADMIN_SEED = fromHex(VA.keys.adminRootSeedHex);
const ADMIN_PUB = fromHex(VA.keys.adminRootPubHex);
const adminSign = async (_umk: Uint8Array, bytes: Uint8Array) => ed25519.sign(bytes, ADMIN_SEED);
const FQDN = VA.order.fields.serverDomain as string;
const USER = "plucky-avocet";

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}

describe("direct-access/v1 (shared vectors)", () => {
  it("canonicalises addresses and classifies them", async () => {
    const D = await load("lib/directAccess.js");
    for (const c of VA.addresses.canonical) expect(D.canonicalIp(c.input), c.input).toBe(c.canonical);
    for (const a of VA.addresses.public) expect(D.isPublicAddress(a), a).toBe(true);
    for (const a of VA.addresses.notPublic) expect(D.isPublicAddress(a), a).toBe(false);
  });

  it("parses prefixes and their membership", async () => {
    const D = await load("lib/directAccess.js");
    for (const p of VA.prefixes.valid) expect(D.formatPrefix(D.parsePrefix(p.input)), p.input).toBe(p.canonical);
    for (const p of VA.prefixes.invalid) expect(D.parsePrefix(p), p).toBeNull();
    for (const c of VA.prefixes.contains) {
      expect(D.prefixContains(D.parsePrefix(c.prefix), c.address), `${c.prefix} ${c.address}`).toBe(c.inside);
    }
  });

  it("reproduces the canonical bytes and sha256; the pinned signatures verify under the admin root only", async () => {
    const D = await load("lib/directAccess.js");
    expect(utf8(D.canonicalDirectAccessOrder(VA.order.fields))).toBe(VA.order.canonical);
    expect(D.directAccessOrderSha256(VA.order.fields)).toBe(VA.order.sha256);
    expect(utf8(D.canonicalDirectAccessOrder(VA.order.off.fields))).toBe(VA.order.off.canonical);
    expect(await D.verifyDirectAccessOrder(VA.order.fields, VA.order.signatureHex, VA.keys.adminRootPubHex)).toBe(true);
    expect(await D.verifyDirectAccessOrder(VA.order.fields, VA.order.signatureHex, VA.keys.irkPubHex)).toBe(false);
    expect(await D.verifyDirectAccessOrder(VA.order.off.fields, VA.order.off.signatureHex, VA.keys.adminRootPubHex)).toBe(true);
    expect(await D.verifyDirectAccessOrder(VA.order.off.fields, VA.order.off.signatureHex, VA.keys.irkPubHex)).toBe(false);
    expect(D.directAccessOrderProblem(VA.order.fields)).toBeNull();
  });

  it("refuses every refused order with its reason code, and none verifies", async () => {
    const D = await load("lib/directAccess.js");
    for (const r of VA.order.refused) {
      expect(D.directAccessOrderProblem(r.fields), r.name).toBe(r.problem);
      expect(await D.verifyDirectAccessOrder(r.fields, VA.order.signatureHex, VA.keys.adminRootPubHex), r.name).toBe(false);
    }
  });

  it("signs what the box and .com take, and refuses to sign a bad order", async () => {
    const D = await load("lib/directAccess.js");
    const s = await D.signDirectAccessOrder(VA.order.fields, { umk: new Uint8Array(1), sign: adminSign });
    expect(s.signatureHex).toBe(VA.order.signatureHex);
    expect(verifyDirectAccessOrder(s.order, fromHex(s.signatureHex), ADMIN_PUB)).toBe(true);
    let signed = false;
    const spy = async () => ((signed = true), new Uint8Array(64));
    await expect(D.signDirectAccessOrder(VA.order.refused[0].fields, { umk: new Uint8Array(1), sign: spy })).rejects.toMatchObject({
      code: VA.order.refused[0].problem,
    });
    expect(signed).toBe(false);
  });

  it("reads the form's lists into canonical, sorted text", async () => {
    const D = await load("lib/directAccess.js");
    expect(D.parseAddressList("81.2.69.142\n2A02:8010:6400:0001::10, 81.2.69.142")).toEqual({ ok: true, list: ["2a02:8010:6400:1::10", "81.2.69.142"] });
    expect(D.parseAddressList("nope")).toEqual({ ok: false, code: "bad-address" });
    expect(D.parsePrefixList("2A02:8010:6400:0000::/56")).toEqual({ ok: true, list: ["2a02:8010:6400::/56"] });
    expect(D.parsePrefixList("81.2.69.1/24")).toEqual({ ok: false, code: "bad-prefix" });
    expect(D.parsePort(" 443 ")).toBe(443);
    expect(D.parsePort("44x")).toBeNull();
  });
});

describe("direct-name/v1 (shared vectors)", () => {
  it("reproduces the canonical bytes; the pinned signatures verify under the admin root only", async () => {
    const N = await load("lib/directName.js");
    for (const c of [VN.follow, VN.owned, VN.off]) {
      expect(utf8(N.canonicalDirectNameOrder(c.fields))).toBe(c.canonical);
      expect(N.directNameOrderProblem(c.fields)).toBeNull();
      expect(await N.verifyDirectNameOrder(c.fields, c.signatureHex, VN.keys.adminRootPubHex)).toBe(true);
      expect(await N.verifyDirectNameOrder(c.fields, c.signatureHex, VN.keys.irkPubHex)).toBe(false);
      const s = await N.signDirectNameOrder(c.fields, { umk: new Uint8Array(1), sign: adminSign });
      expect(s.signatureHex).toBe(c.signatureHex);
      expect(verifyDirectNameOrder(c.fields, fromHex(s.signatureHex), ADMIN_PUB)).toBe(true);
    }
  });

  it("refuses every refused order with its reason code, and none verifies", async () => {
    const N = await load("lib/directName.js");
    for (const r of VN.refused) {
      expect(N.directNameOrderProblem(r.fields), r.name).toBe(r.problem);
      expect(await N.verifyDirectNameOrder(r.fields, VN.follow.signatureHex, VN.keys.adminRootPubHex), r.name).toBe(false);
    }
  });

  it("knows what each label is, and derives an app's name", async () => {
    const N = await load("lib/directName.js");
    for (const k of VN.kinds) expect(N.directNameKind(k.label)?.kind ?? null, k.label).toBe(k.kind);
    expect(N.derivedDirectName("Game", "Plucky-Avocet")).toBe("game--plucky-avocet.fshp.app");
    expect(N.derivedDirectName("game", "x")).toBeNull();
    expect(N.directLabelOf("game--plucky-avocet.fshp.app")).toBe("game--plucky-avocet");
  });

  it("both tags sign with the admin root", async () => {
    const { SENSITIVE_TAGS } = await load("lib/adminRoot.js");
    expect(SENSITIVE_TAGS.has("flagship/direct-access/v1")).toBe(true);
    expect(SENSITIVE_TAGS.has("flagship/direct-name/v1")).toBe(true);
  });
});

describe("the .com client and its sentences", () => {
  it("maps every refusal code to the app's sentence, and an unknown one to the other side's words", async () => {
    const T = await load("lib/directNames.js");
    const table: Record<string, string> = {
      malformed: "That change couldn't be read. Try again.",
      "bad-caa": "That change couldn't be read. Try again.",
      "private-address": "Only public addresses can be used. Private, local and reserved addresses can't.",
      "non-canonical-address": "One of the addresses isn't an IP address.",
      "bad-prefix": "One of the address ranges isn't valid.",
      "prefix-too-wide": "An address range is too wide. Use an IPv6 /32 or longer, or an IPv4 /24 or longer.",
      "no-addresses": "Add at least one public address or address range.",
      "too-many": "Too many addresses: at most 8 addresses and 4 ranges.",
      duplicate: "An address is listed twice.",
      "bad-port": "The port must be a number from 1 to 65535.",
      "bad-name": "That name can't be used on fshp.app.",
      stale: "This device's clock is off. Check the time and try again.",
      "unknown-account": "This account wasn't found.",
      "unknown-server": "That server isn't one of this account's servers.",
      "not-admin": "Only an admin device of this account can change direct access.",
      replayed: "A newer change is already saved. Reload and try again.",
      "vanity-not-available": "Chosen names on fshp.app aren't available yet.",
      "not-your-name": "A direct name must end in this account's own name.",
      taken: "That name belongs to another account.",
      "unknown-name": "This name isn't on this account.",
      "probe-too-soon": "This name was checked a moment ago. Try again in a minute.",
    };
    for (const [code, sentence] of Object.entries(table)) expect(T.directRefusalText(code), code).toBe(sentence);
    expect(T.directRefusalText("something-new", "The box said so.")).toBe("The box said so.");
    expect(T.directRefusalText("something-new")).toBe("Direct access couldn't be changed. Try again.");
    expect(T.directNameStateText({ state: "published" })).toBe("Published");
    expect(T.directNameStateText({ state: "pending" })).toBe("Waiting to be published");
    expect(T.directNameStateText({ state: "empty", reason: "direct-access-off" })).toBe("Direct access is off on its server.");
    expect(T.directNameStateText({ state: "empty", reason: "?" })).toBe("Not published");
    expect(T.directNameStateText({ state: "published", suspended: { at: 1 } })).toBe("Suspended after an abuse report.");
    expect(T.directProbeText({ reachable: true })).toBe("Reachable from outside.");
    expect(T.directProbeText({ reachable: false })).toBe("Not reachable from outside.");
    expect(T.directProbeText({ reachable: null, why: "not-published" })).toBe("Not published yet, so there is nothing to check.");
  });

  it("reads with the account read token, posts orders, and throws the refusal's sentence", async () => {
    const T = await load("lib/directNames.js");
    const reads: Array<{ url: string; init: { method?: string }; deps: { username?: string } }> = [];
    const accountReadFetch = async (url: string, init: { method?: string }, deps: { username?: string }) => {
      reads.push({ url, init, deps });
      if (url.endsWith("/probe")) return new Response(JSON.stringify({ at: 5, reachable: true }), { status: 200 });
      return new Response(JSON.stringify({ apex: "fshp.app", servers: [{ serverDomain: FQDN, on: true }], names: [] }), { status: 200 });
    };
    const state = await T.fetchDirectState("Plucky-Avocet", { origin: "https://c.test", accountReadFetch });
    expect(reads[0]!.url).toBe("https://c.test/api/accounts/plucky-avocet/direct-access");
    expect(reads[0]!.deps.username).toBe("Plucky-Avocet");
    expect(T.serverStateOf(state, FQDN.toUpperCase())?.on).toBe(true);
    expect(await T.probeDirectName(USER, "game--plucky-avocet", { origin: "https://c.test", accountReadFetch })).toEqual({ at: 5, reachable: true });
    expect(reads[1]!.url).toBe("https://c.test/api/accounts/plucky-avocet/direct-names/game--plucky-avocet/probe");
    expect(reads[1]!.init.method).toBe("POST");

    const posts: Array<{ url: string; body: unknown }> = [];
    const fetch = async (url: string, init: { body: string }) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return url.endsWith("/direct-names")
        ? new Response(JSON.stringify({ error: "taken", code: "taken" }), { status: 409 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await T.postDirectAccessOrder(USER, { order: VA.order.fields, signatureHex: VA.order.signatureHex }, { origin: "https://c.test", fetch });
    expect(posts[0]!.url).toBe("https://c.test/api/accounts/plucky-avocet/direct-access");
    await expect(T.postDirectNameOrder(USER, { order: VN.follow.fields, signatureHex: VN.follow.signatureHex }, { origin: "https://c.test", fetch }))
      .rejects.toMatchObject({ status: 409, code: "taken", message: "That name belongs to another account." });
  });
});

const ADMIN = { umk: new Uint8Array(1), adminRootSeed: ADMIN_SEED, username: USER };
const VIEW_OFF = { on: false, addresses: [], prefixes: [], port: null, issuedAt: null, endpoints: [] };
const VIEW_ON = { on: true, addresses: ["81.2.69.142"], prefixes: [], port: 443, issuedAt: 1, endpoints: [{ address: "81.2.69.142", port: 443 }] };
const APPS = [
  { serviceId: "plucky-avocet--game", creator: USER, slug: "game", name: "Game" },
  { serviceId: "someone--chess", creator: "someone-else", slug: "chess", name: "Chess" },
];

function stateOf(over: Record<string, unknown> = {}) {
  return { fqdn: FQDN, username: USER, canManage: true, supported: true, loaded: true, view: VIEW_OFF, account: null, apps: APPS, busy: false, error: "", notice: "", editing: false, form: { addresses: "", prefixes: "", port: "443" }, nameDraft: null, ...over };
}

describe("the server page's Direct access section", () => {
  it("is hidden on a box that doesn't serve it, read-only on other devices, and shows the opt-in for admins", async () => {
    const V = await load("views/direct-access.js");
    expect(V.directAccessHtml(stateOf({ supported: false }))).toBe("");
    const ro = V.directAccessHtml(stateOf({ canManage: false }));
    expect(ro).toContain("Only an admin device can change direct access. This device can see it.");
    expect(ro).not.toContain("sd-direct-access-on");
    expect(ro).toContain("Off. Visitors reach this server");
    const admin = V.directAccessHtml(stateOf());
    expect(admin).toContain('id="sd-direct-access-on"');
    const form = V.directAccessHtml(stateOf({ editing: true }));
    expect(form).toContain('id="sd-direct-access-warning"');
    expect(form).toContain("public DNS history");
    expect(form).toContain('id="sd-direct-access-addresses-field"');
    expect(form).toContain('id="sd-direct-access-prefixes-field"');
    expect(form).toContain('id="sd-direct-access-port-field"');
  });

  it("lists a name per app once on, only for this account's apps", async () => {
    const V = await load("views/direct-access.js");
    const account = {
      apex: "fshp.app",
      servers: [{ serverDomain: FQDN, on: true, addresses: ["81.2.69.142"], prefixes: [], port: 443 }],
      names: [{ name: "game--plucky-avocet.fshp.app", serverDomain: FQDN, enabled: true, caa: "pin", addresses: [], state: "published", probe: { at: 1, reachable: false } }],
    };
    const st = stateOf({ view: VIEW_ON, account });
    const rows = V.directRows(st);
    expect(rows[0]).toMatchObject({ fqdn: "game--plucky-avocet.fshp.app", label: "game--plucky-avocet", isOn: true });
    expect(rows[1]!.fqdn).toBeNull();
    const html = V.directAccessHtml(st);
    expect(html).toContain("On. Visitors can reach this server");
    expect(html).toContain("Addresses: 81.2.69.142");
    expect(html).toContain("game--plucky-avocet.fshp.app");
    expect(html).toContain('id="sd-direct-name-state-plucky-avocet--game"');
    expect(html).toContain(">Published<");
    expect(html).toContain("Not reachable from outside.");
    expect(html).toContain('id="sd-direct-name-probe-btn-plucky-avocet--game"');
    expect(html).toContain('id="sd-direct-name-edit-plucky-avocet--game"');
    expect(html).toContain("This app was made by another account");
    const ro = V.directAccessHtml({ ...st, canManage: false });
    expect(ro).not.toContain("sd-direct-name-edit-");
    expect(ro).toContain("sd-direct-name-probe-btn-");
  });

  it("hides the section on a 404 and reads the box, .com and the apps otherwise", async () => {
    const V = await load("views/direct-access.js");
    const { ScreensError } = await load("lib/api.js");
    const gone = await V.loadDirectAccess({ fqdn: FQDN, username: USER }, { fetchJson: async () => { throw new ScreensError("no", 404, {}); } });
    expect(gone.supported).toBe(false);
    const paths: string[] = [];
    const ok = await V.loadDirectAccess(
      { fqdn: FQDN, username: USER },
      { fetchJson: async (p: string) => (paths.push(p), p.endsWith("apps-list") ? { apps: APPS } : VIEW_ON), fetchState: async () => ({ apex: "fshp.app", servers: [], names: [] }) },
    );
    expect(paths).toEqual(["/api/screens/direct-access", "/api/screens/apps-list"]);
    expect(ok).toMatchObject({ supported: true, view: VIEW_ON, apps: APPS });
  });

  it("refuses non-admin devices and bad forms before asking or signing", async () => {
    const V = await load("views/direct-access.js");
    let asked = false;
    const deps = { session: ADMIN, freshUnlock: async () => ((asked = true), { ok: true }), fetchJson: async () => { throw new Error("must not send"); } };
    const base = { fqdn: FQDN, username: USER, prefixesText: "", portText: "443", wasOn: false };
    expect(await V.submitDirectAccess({ ...base, addressesText: "81.2.69.142" }, { ...deps, session: { umk: new Uint8Array(1), adminRootSeed: null } }))
      .toEqual({ ok: false, error: "Only an admin device can change direct access. This device can see it." });
    expect(await V.submitDirectAccess({ ...base, addressesText: "192.168.1.20" }, deps))
      .toEqual({ ok: false, error: "Only public addresses can be used. Private, local and reserved addresses can't." });
    expect(await V.submitDirectAccess({ ...base, addressesText: "not-an-ip" }, deps)).toEqual({ ok: false, error: "One of the addresses isn't an IP address." });
    expect(await V.submitDirectAccess({ ...base, addressesText: "" }, deps)).toEqual({ ok: false, error: "Add at least one public address or address range." });
    expect(await V.submitDirectAccess({ ...base, addressesText: "81.2.69.142", portText: "70000" }, deps)).toEqual({ ok: false, error: "The port must be a number from 1 to 65535." });
    expect(await V.submitDirectAccess({ ...base, addressesText: "", prefixesText: "2a02::/16" }, deps)).toMatchObject({ ok: false, error: expect.stringContaining("too wide") });
    expect(await V.submitDirectAccessOff({ fqdn: FQDN, username: USER }, { ...deps, session: { umk: null, adminRootSeed: ADMIN_SEED } }))
      .toEqual({ ok: false, error: "Unlock the webapp first." });
    expect(asked).toBe(false);
  });

  it("turns on: one signature to the box, then the same order to .com; turns off the same way", async () => {
    const V = await load("views/direct-access.js");
    const box: Array<{ path: string; body: { order: Record<string, unknown>; signatureHex: string } }> = [];
    const com: Array<{ username: string; signed: { order: Record<string, unknown>; signatureHex: string } }> = [];
    let unlockText: { title?: string; message?: string } = {};
    const deps = {
      session: ADMIN,
      sign: adminSign,
      now: () => 1790000000000,
      freshUnlock: async (t: { title: string; message: string }) => ((unlockText = t), { ok: true }),
      fetchJson: async (path: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        box.push({ path, body });
        return { ok: true, change: "on", directAccess: body.order.enabled ? VIEW_ON : VIEW_OFF };
      },
      postAccess: async (username: string, signed: { order: Record<string, unknown>; signatureHex: string }) => void com.push({ username, signed }),
      fetchState: async () => ({ apex: "fshp.app", servers: [], names: [] }),
    };
    const on = await V.submitDirectAccess(
      { fqdn: FQDN, username: USER, addressesText: "81.2.69.142\n2A02:8010:6400:1::10", prefixesText: "2a02:8010:6400::/48", portText: "443", wasOn: false },
      deps,
    );
    expect(on).toMatchObject({ ok: true, view: VIEW_ON, notice: "Direct access is on." });
    expect(unlockText.title).toBe("Turn on direct access?");
    expect(unlockText.message).toContain("public DNS");
    expect(box[0]!.path).toBe("/api/screens/direct-access");
    expect(box[0]!.body.order).toEqual({ ...VA.order.fields, addresses: [...VA.order.fields.addresses].sort() });
    expect(box[0]!.body.signatureHex).toBe(VA.order.signatureHex);
    expect(com[0]!.signed).toEqual(box[0]!.body);
    expect(verifyDirectAccessOrder(box[0]!.body.order as never, fromHex(box[0]!.body.signatureHex), ADMIN_PUB)).toBe(true);

    const off = await V.submitDirectAccessOff({ fqdn: FQDN, username: USER, port: 443 }, { ...deps, now: () => 1790000060000 });
    expect(off).toMatchObject({ ok: true, view: VIEW_OFF, notice: "Direct access is off." });
    expect(box[1]!.body.order).toEqual(VA.order.off.fields);
    expect(box[1]!.body.signatureHex).toBe(VA.order.off.signatureHex);
  });

  it("reads a refusal by its code, from the box or .com; cancelling sends nothing", async () => {
    const V = await load("views/direct-access.js");
    const { ScreensError } = await load("lib/api.js");
    const T = await load("lib/directNames.js");
    const base = { fqdn: FQDN, username: USER, addressesText: "81.2.69.142", prefixesText: "", portText: "443", wasOn: true };
    const common = { session: ADMIN, sign: adminSign, freshUnlock: async () => ({ ok: true }), fetchState: async () => null };
    expect(
      await V.submitDirectAccess(base, { ...common, fetchJson: async () => { throw new ScreensError("x", 409, { error: "replayed order", code: "replayed" }); } }),
    ).toMatchObject({ ok: false, error: "A newer change is already saved. Reload and try again." });
    expect(
      await V.submitDirectAccess(base, {
        ...common,
        fetchJson: async () => ({ ok: true, directAccess: VIEW_ON }),
        postAccess: async () => { throw new T.DirectAccessRefusal(403, { code: "not-admin", error: "no" }); },
      }),
    ).toEqual({ ok: false, error: "Only an admin device of this account can change direct access.", view: VIEW_ON });
    let sent = false;
    expect(
      await V.submitDirectAccess(base, { ...common, freshUnlock: async () => ({ ok: false, cancelled: true }), fetchJson: async () => ((sent = true), {}) }),
    ).toEqual({ ok: false, cancelled: true, error: "Direct access wasn't changed." });
    expect(sent).toBe(false);
  });

  it("signs a name order with the defaults, with settings, and off; runs the outside check", async () => {
    const V = await load("views/direct-access.js");
    const names: Array<{ order: Record<string, unknown>; signatureHex: string }> = [];
    const deps = {
      session: ADMIN,
      sign: adminSign,
      freshUnlock: async () => ({ ok: true }),
      postName: async (_u: string, signed: { order: Record<string, unknown>; signatureHex: string }) => void names.push(signed),
      fetchState: async () => ({ apex: "fshp.app", servers: [], names: [] }),
    };
    const name = "game--plucky-avocet.fshp.app";
    expect(await V.submitDirectName({ fqdn: FQDN, username: USER, name, enabled: true }, { ...deps, now: () => 1790000000000 })).toMatchObject({ ok: true, notice: "Saved." });
    expect(names[0]).toEqual({ order: VN.follow.fields, signatureHex: VN.follow.signatureHex });
    await V.submitDirectName({ fqdn: FQDN, username: USER, name, enabled: true, addressesText: "81.2.69.142 2a02:8010:6400:1::10", caa: "off" }, { ...deps, now: () => 1790000000001 });
    expect(names[1]).toEqual({ order: { ...VN.owned.fields, addresses: [...VN.owned.fields.addresses].sort() }, signatureHex: VN.owned.signatureHex });
    await V.submitDirectName({ fqdn: FQDN, username: USER, name, enabled: false, caa: "pin" }, { ...deps, now: () => 1790000060000 });
    expect(names[2]).toEqual({ order: VN.off.fields, signatureHex: VN.off.signatureHex });
    expect(await V.submitDirectName({ fqdn: FQDN, username: USER, name: "www.fshp.app", enabled: true }, deps)).toEqual({ ok: false, error: "That name can't be used on fshp.app." });
    expect(await V.submitDirectName({ fqdn: FQDN, username: USER, name, enabled: true, addressesText: "10.0.0.1" }, deps)).toMatchObject({ ok: false, error: expect.stringContaining("Only public addresses") });
    expect(names).toHaveLength(3);

    const probed = await V.submitDirectProbe({ username: USER, label: "game--plucky-avocet" }, { probe: async () => ({ at: 5, reachable: true }), fetchState: async () => null });
    expect(probed).toMatchObject({ ok: true, notice: "Reachable from outside." });
    const T = await load("lib/directNames.js");
    expect(await V.submitDirectProbe({ username: USER, label: "x" }, { probe: async () => { throw new T.DirectAccessRefusal(429, { code: "probe-too-soon" }); } }))
      .toEqual({ ok: false, error: "This name was checked a moment ago. Try again in a minute." });
    expect(V.directProbeLine({ reachable: null })).toBe("Not published yet, so there is nothing to check.");
    expect(V.directProbeLine({ at: Date.now(), reachable: true })).toMatch(/^Checked .+: Reachable from outside\.$/);
  });
});

describe("the app page's link to share", () => {
  const state = { apex: "fshp.app", servers: [], names: [{ name: "game--plucky-avocet.fshp.app", state: "published" }] };
  it("shows only once the app's own direct name is published", async () => {
    const V = await load("views/direct-access.js");
    expect(V.publishedDirectName(state, { slug: "game", creator: USER, username: USER })).toBe("game--plucky-avocet.fshp.app");
    expect(V.publishedDirectName(state, { slug: "game", creator: USER, username: "someone-else" })).toBeNull();
    expect(V.publishedDirectName({ ...state, names: [{ name: "game--plucky-avocet.fshp.app", state: "pending" }] }, { slug: "game", creator: USER, username: USER })).toBeNull();
    expect(V.directLinkHtml({ published: null, relayUrl: "https://x" })).toBe("");
  });

  it("offers Direct or Through the relay and shares the chosen link", async () => {
    const V = await load("views/direct-access.js");
    const relayUrl = "https://game.plucky-avocet.flagship.services";
    const direct = V.directLinkHtml({ published: "game--plucky-avocet.fshp.app", relayUrl, choice: "direct" });
    expect(direct).toContain('id="app-direct-link-choice"');
    expect(direct).toContain('data-url="https://game--plucky-avocet.fshp.app"');
    expect(direct).toContain("uses none of your relay data");
    const relay = V.directLinkHtml({ published: "game--plucky-avocet.fshp.app", relayUrl, choice: "relay" });
    expect(relay).toContain(`data-url="${relayUrl}"`);
    expect(relay).toContain("Goes through the Flagship relay.");
    expect(V.directShareUrl({ published: "a.fshp.app", relayUrl: null, choice: "relay" })).toBe("https://a.fshp.app");
  });
});
