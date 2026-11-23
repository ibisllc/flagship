// "Choose your own account name" at sign-up (lib/chooseName.js): the rename after the account opened under the
// suggested name, its payment, what the device signs again afterwards, the resume after a reload, and the owner's
// name-grant links.
import { describe, expect, it, vi } from "vitest";
import {
  NAME_CHOICE_KEY,
  claimChosenName,
  loadNameChoice,
  localNameProblem,
  nameChoicePendingFor,
  nameChoiceRefusalText,
  parseNameGrantLink,
  resumeNameChoice,
  saveNameChoice,
  stripAddressPrefix,
} from "../public/webapp/lib/chooseName.js";

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const IRK = "ab".repeat(32);

/** A fake .com and device: answers by path, records the order of calls. */
function harness(over: { quote?: unknown; rename?: (body: any) => Response; lookup?: unknown; vouchers?: number } = {}) {
  const storage = memStorage();
  const calls: string[] = [];
  const bodies: Record<string, any> = {};
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method ?? "GET"} ${path}`);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    bodies[path] = body;
    if (path.endsWith("/name-change/quote")) return json(200, over.quote ?? { available: true, kind: "name-change", priceUsd: 10, units: 10 });
    if (path.endsWith("/name-change")) return over.rename ? over.rename(body) : json(200, { ok: true, newUsername: body.request.newUsername });
    if (path.startsWith("/api/username/")) return over.lookup === undefined ? json(404, {}) : json(200, over.lookup);
    return json(200, { ok: true });
  });
  const events: string[] = [];
  const io = {
    storage,
    session: { umk: new Uint8Array(32).fill(1), username: "fresh-poppy" },
    apex: "https://flagshipserver.com",
    fetch,
    now: () => 1_000,
    randomUUID: () => "11111111-2222-3333-4444-555555555555",
    aidPubHex: "cd".repeat(32),
    irkPubHex: IRK,
    signAdmin: vi.fn(async () => new Uint8Array(64).fill(7)),
    signIrk: vi.fn(async () => new Uint8Array(64).fill(8)),
    deriveAccountDeviceSeed: vi.fn(async (_u: Uint8Array, name: string) => new Uint8Array(32).fill(name === "fresh-poppy" ? 3 : 4)),
    persistAccountDeviceSeed: vi.fn(async (_u: Uint8Array, name: string, _d: string, seed: Uint8Array) => {
      events.push(`keep-key ${name} ${seed[0]}`);
    }),
    deriveAccountDeviceKey: vi.fn(async () => ({ publicKey: new Uint8Array(32).fill(3) })),
    reputProfiles: vi.fn(async ({ newName }: { newName: string }) => void events.push(`profiles ${newName}`)),
    moveLocalAccount: vi.fn(async (o: string, n: string) => void events.push(`move ${o}->${n}`)),
    mintReadToken: vi.fn(async (n: string) => void events.push(`token ${n}`)),
    buyPack: vi.fn(async () => ({ url: "https://checkout.stripe.com/x" })),
    navigate: vi.fn(),
    consumeShopReturn: vi.fn(() => "stripe"),
    finishShopOrders: vi.fn(async () => ({ added: over.vouchers ?? 10 })),
    takeVouchers: vi.fn(async (n: number) => Array.from({ length: Math.min(n, over.vouchers ?? 10) }, (_, i) => ({ k: "k", p: "p", n: `n${i}`, s: "s" }))),
    voucherNullifier: (v: { n: string }) => `nf-${v.n}`,
    dropSpentVouchers: vi.fn(async () => {}),
  };
  return { io, calls, bodies, events, storage };
}

const base = { suggested: "fresh-poppy", wanted: "acme-tools", stage: "quote", deviceId: "0".repeat(32), oldGrantId: "old-grant" };

describe("the local check", () => {
  it("uses the sign-up name rules", () => {
    expect(localNameProblem("acme-tools")).toBeNull();
    expect(localNameProblem("ab")).toBe("At least 3 characters");
    expect(localNameProblem("-acme")).toBe("No hyphen at the start or end, or two in a row");
    expect(localNameProblem("Acme!")).toBe("Letters, numbers and hyphens only");
  });
});

describe("claimChosenName", () => {
  it("with a code: quote, rename, then the grant swap before the profiles, then the local move and a token", async () => {
    const h = harness();
    const out = await claimChosenName({ ...base, method: "code", code: "FLAG-AAAAA-BBBBB" }, h.io);
    expect(out).toEqual({ ok: true, name: "acme-tools" });
    expect(h.calls).toEqual([
      "POST /api/account/name-change/quote",
      "POST /api/account/name-change",
      "POST /api/users/acme-tools/device-grants",
      "POST /api/users/acme-tools/device-grants/revoke",
    ]);
    expect(h.bodies["/api/account/name-change"]).toMatchObject({
      request: { oldUsername: "fresh-poppy", newUsername: "acme-tools", issuedAt: 1_000 },
      voucherCode: "FLAG-AAAAA-BBBBB",
    });
    expect(h.bodies["/api/users/acme-tools/device-grants"].grant).toMatchObject({ username: "acme-tools", deviceId: "0".repeat(32), devicePubKey: "03".repeat(32) });
    expect(h.bodies["/api/users/acme-tools/device-grants/revoke"].request).toMatchObject({ grantId: "old-grant", reason: "replaced" });
    // The key .com registered (from the old name) is kept under the new one.
    expect(h.events).toEqual(["keep-key acme-tools 3", "profiles acme-tools", "move fresh-poppy->acme-tools", "token acme-tools"]);
    expect(loadNameChoice(h.storage)).toBeNull();
  });

  it("never keeps the code in storage", async () => {
    const h = harness({ rename: () => new Promise(() => {}) as never });
    void claimChosenName({ ...base, method: "code", code: "FLAG-SECRET" }, h.io);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.storage.getItem(NAME_CHOICE_KEY)).not.toContain("FLAG-SECRET");
  });

  it("a taken name or a dibs-held one is refused before paying, and can be fixed on the screen", async () => {
    const taken = harness({ quote: { available: false, code: "taken" } });
    expect(await claimChosenName({ ...base, method: "pay" }, taken.io)).toMatchObject({ ok: false, fixable: true, refusal: "Taken or too similar to an existing name" });
    expect(taken.io.buyPack).not.toHaveBeenCalled();
    const held = harness({ quote: { available: false, code: "dibs-held", heldUntil: Date.UTC(2027, 4, 5) } });
    const r = await claimChosenName({ ...base, wanted: "acme", method: "pay" }, held.io);
    expect(r.refusal).toMatch(/^This name is held for the owner of acme\.com until .*2027/);
  });

  it("a bad or used code says so and keeps the suggested name", async () => {
    const bad = harness({ rename: () => json(402, { code: "code-invalid" }) });
    expect(await claimChosenName({ ...base, method: "code", code: "X" }, bad.io)).toMatchObject({
      ok: false,
      fixable: true,
      refusal: "That voucher code isn't valid for an account name.",
    });
    expect(bad.io.moveLocalAccount).not.toHaveBeenCalled();
    const used = harness({ rename: () => json(402, { code: "code-used" }) });
    expect((await claimChosenName({ ...base, method: "code", code: "X" }, used.io)).refusal).toBe("That voucher code was already used.");
  });

  it("a rename .com refuses after paying leaves the suggested name and says the payment is kept", async () => {
    const h = harness({ rename: () => json(409, { code: "rename-failed" }) });
    h.storage.setItem(NAME_CHOICE_KEY, JSON.stringify({ ...base, method: "pay", stage: "paying" }));
    const out = await claimChosenName({ ...base, method: "pay", stage: "paying" }, h.io);
    expect(out.refusal).toBe("The name change didn't go through. Your account keeps the name fresh-poppy, and your $10 stays in your account as vouchers.");
    expect(h.io.dropSpentVouchers).not.toHaveBeenCalled();
    expect(h.io.moveLocalAccount).not.toHaveBeenCalled();
    expect(loadNameChoice(h.storage)).toBeNull();
  });

  it("Pay $10: off to the card page, then after the unlock ten vouchers pay and are dropped from the wallet", async () => {
    const h = harness();
    expect(await claimChosenName({ ...base, method: "pay" }, h.io)).toEqual({ redirected: true });
    expect(h.io.buyPack).toHaveBeenCalledWith(10);
    expect(h.io.navigate).toHaveBeenCalledWith("https://checkout.stripe.com/x");
    expect(loadNameChoice(h.storage)).toMatchObject({ stage: "paying" });
    const back = await resumeNameChoice(h.io);
    expect(back).toEqual({ ok: true, name: "acme-tools" });
    expect(h.bodies["/api/account/name-change"].vouchers).toHaveLength(10);
    expect(h.io.dropSpentVouchers).toHaveBeenCalledWith(Array.from({ length: 10 }, (_, i) => `nf-n${i}`));
  });

  it("a cancelled payment keeps the suggested name", async () => {
    const h = harness();
    h.io.consumeShopReturn = vi.fn(() => "cancel");
    saveNameChoice({ ...base, method: "pay", stage: "paying" }, h.storage);
    expect(await resumeNameChoice(h.io)).toMatchObject({ ok: false, refusal: "Payment cancelled. Your account keeps the name fresh-poppy." });
    expect(loadNameChoice(h.storage)).toBeNull();
  });

  it("a payment that can't start keeps the suggested name", async () => {
    const h = harness();
    h.io.buyPack = vi.fn(async () => {
      throw new Error("rail-off");
    });
    expect(await claimChosenName({ ...base, method: "pay" }, h.io)).toMatchObject({
      refusal: "The payment didn't go through. Your account keeps the name fresh-poppy.",
    });
  });
});

describe("after a reload or a crash", () => {
  it("settles a rename .com already made (the new name holds this account's key)", async () => {
    const h = harness({ lookup: { irkPub: IRK } });
    saveNameChoice({ ...base, method: "code", stage: "settling" }, h.storage);
    expect(await resumeNameChoice(h.io)).toEqual({ ok: true, name: "acme-tools" });
    expect(h.events).toContain("move fresh-poppy->acme-tools");
  });

  it("drops a rename that never happened: the account keeps its suggested name", async () => {
    const h = harness();
    saveNameChoice({ ...base, method: "code", stage: "renaming" }, h.storage);
    expect(await resumeNameChoice(h.io)).toBeNull();
    expect(loadNameChoice(h.storage)).toBeNull();
    expect(h.io.moveLocalAccount).not.toHaveBeenCalled();
  });

  it("while pending, nothing may bind keys to either name, and the account-gone screen stays away", () => {
    const s = memStorage();
    saveNameChoice({ ...base, method: "code" }, s);
    expect(nameChoicePendingFor("fresh-poppy", s)).toBe(true);
    expect(nameChoicePendingFor("acme-tools", s)).toBe(true);
    expect(nameChoicePendingFor("someone-else", s)).toBe(false);
  });
});

describe("a name the owner set aside", () => {
  it("reads the link's fragment", () => {
    expect(parseNameGrantLink("https://flagshipserver.com/app/choose-name#n=acme&g=FLAG-AAAAA&e=99&f=1")).toEqual({
      name: "acme", code: "FLAG-AAAAA", expiresAt: 99, paid: true,
    });
    expect(parseNameGrantLink("https://flagshipserver.com/app/choose-name#n=acme&g=FLAG-AAAAA&e=99")?.paid).toBe(false);
    expect(parseNameGrantLink("https://flagshipserver.com/app/choose-name#n=a--b&g=X&e=1")).toBeNull();
    expect(parseNameGrantLink("https://flagshipserver.com/app/other#n=acme&g=X&e=1")).toBeNull();
  });

  it("a free grant pays: the rename carries it and no code or vouchers", async () => {
    const h = harness();
    const grant = { name: "acme-tools", code: "FLAG-G", expiresAt: 5_000, paid: true };
    expect(await claimChosenName({ ...base, method: "grant", grant }, h.io)).toMatchObject({ ok: true });
    expect(h.bodies["/api/account/name-change/quote"].nameGrant).toEqual({ code: "FLAG-G", expiresAt: 5_000 });
    const body = h.bodies["/api/account/name-change"];
    expect(body.nameGrant).toEqual({ code: "FLAG-G", expiresAt: 5_000 });
    expect(body.voucherCode).toBeUndefined();
    expect(body.vouchers).toBeUndefined();
    expect(h.io.buyPack).not.toHaveBeenCalled();
  });

  it("is sent only for its own name", async () => {
    const h = harness();
    const grant = { name: "acme", code: "FLAG-G", expiresAt: 5_000, paid: false };
    await claimChosenName({ ...base, method: "code", code: "C", grant }, h.io);
    expect(h.bodies["/api/account/name-change"].nameGrant).toBeUndefined();
  });

  it("says so when the link expired, and points an existing account at the sign-up", async () => {
    const h = harness({ quote: { available: false, code: "grant-expired" } });
    expect((await claimChosenName({ ...base, method: "grant", grant: { name: "acme-tools", code: "G", expiresAt: 1, paid: true } }, h.io)).refusal).toBe(
      "This link has expired. Ask for a new one.",
    );
    expect(nameChoiceRefusalText({ code: "rename-unavailable" }, { kept: "x", existing: true })).toBe("Open this link when you create your account.");
    expect(nameChoiceRefusalText({ code: "grant-used" })).toBe("This link doesn't work any more. Ask for a new one.");
  });
});

describe("the voi.ci/ prefix", () => {
  it("keeps only the name from a pasted address", () => {
    expect(stripAddressPrefix("voi.ci/john")).toBe("john");
    expect(stripAddressPrefix("https://voi.ci/john")).toBe("john");
    expect(stripAddressPrefix("  HTTP://Voi.Ci/john")).toBe("john");
    expect(stripAddressPrefix("john")).toBe("john");
    expect(stripAddressPrefix("https://example.com/john")).toBe("https://example.com/john");
    expect(stripAddressPrefix("voici")).toBe("voici");
  });

  it("shows voi.ci/ before the suggested name and inside the choose field, outside the value", async () => {
    const fs = await import("node:fs");
    const modal = fs.readFileSync(new URL("../public/webapp/lib/modal.js", import.meta.url), "utf8");
    expect(modal).toContain('<span class="address-prefix">${ADDRESS_PREFIX}</span><span class="modal-suggest-name" data-suggest-name></span>');
    expect(modal).toContain('tr("Your page address, if you turn it on.")');
    const view = fs.readFileSync(new URL("../public/webapp/views/choose-name.js", import.meta.url), "utf8");
    expect(view).toMatch(/<span class="input-prefix" aria-hidden="true">\$\{ADDRESS_PREFIX\}<\/span>\s*<input id="choose-name-input"/);
  });
});
