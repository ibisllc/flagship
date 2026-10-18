// "This account was removed" (docs/account-gone.md): the state
// (lib/accountGone.js), where it is noticed (the global fetch guard in
// lib/comFetch.js and accountReadFetch), what it stops, how the browser
// forgets the account (lib/accountGoneUi.js) and the exact strings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LIB = resolve(__dirname, "../public/webapp/lib");
const imp = (f: string) => import(pathToFileURL(resolve(LIB, f)).href);

const GONE_BODY = { error: "account-not-found", code: "account-not-found" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(async () => {
  const g = await imp("accountGone.js");
  g._resetAccountGoneForTests();
  g.setOwnAccountNames(() => ["Bright-Maple"]);
});

describe("accountNameInUrl", () => {
  it("reads the account from the users and accounts routes only", async () => {
    const g = await imp("accountGone.js");
    expect(g.accountNameInUrl("https://flagshipserver.com/api/users/Bright-Maple/pods")).toBe("bright-maple");
    expect(g.accountNameInUrl("https://flagshipserver.com/api/accounts/bright-maple/read-token")).toBe("bright-maple");
    expect(g.accountNameInUrl("https://flagshipserver.com/api/users/bright-maple")).toBe("bright-maple");
    expect(g.accountNameInUrl("https://flagshipserver.com/api/users/check")).toBeNull();
    expect(g.accountNameInUrl("https://flagshipserver.com/api/account/resolve/bright-maple")).toBeNull();
    expect(g.accountNameInUrl("https://flagshipserver.com/api/username/bright-maple")).toBeNull();
    expect(g.accountNameInUrl("https://flagshipserver.com/api/users/%E0%A4%A/pods")).toBeNull();
  });
});

describe("noticing the 404", () => {
  it("flips only for 404 account-not-found naming the browser's own account", async () => {
    const g = await imp("accountGone.js");
    const url = "https://flagshipserver.com/api/users/bright-maple/pods";
    expect(await g.noteAccountGoneResponse(url, json({ error: "x" }, 401))).toBe(false);
    expect(await g.noteAccountGoneResponse(url, json({ error: "username not registered" }, 404))).toBe(false);
    expect(await g.noteAccountGoneResponse(url, new Response("not json", { status: 404 }))).toBe(false);
    expect(await g.noteAccountGoneResponse("https://flagshipserver.com/api/users/someone-else/pods", json(GONE_BODY, 404))).toBe(false);
    expect(g.isAccountGone()).toBe(false);

    const heard: unknown[] = [];
    g.onAccountGone((n: unknown) => heard.push(n));
    expect(await g.noteAccountGoneResponse(url, json(GONE_BODY, 404))).toBe(true);
    expect(g.isAccountGone()).toBe(true);
    expect(g.goneAccountName()).toBe("bright-maple");
    await g.noteAccountGoneResponse(url, json(GONE_BODY, 404));
    expect(heard).toEqual(["bright-maple"]);
  });

  it("answers later calls for that account locally and lets other accounts through", async () => {
    const g = await imp("accountGone.js");
    expect(g.answerIfAccountGone("https://flagshipserver.com/api/users/bright-maple/pods")).toBeNull();
    g.markAccountGone("bright-maple");
    const local = g.answerIfAccountGone("https://flagshipserver.com/api/users/bright-maple/stream?cursor=1");
    expect(local.status).toBe(404);
    expect(await local.json()).toEqual(GONE_BODY);
    expect(g.answerIfAccountGone("https://flagshipserver.com/api/users/someone-else/pods")).toBeNull();
    expect(g.answerIfAccountGone("https://flagshipserver.com/api/username/claim")).toBeNull();
    g.clearAccountGone();
    expect(g.answerIfAccountGone("https://flagshipserver.com/api/users/bright-maple/pods")).toBeNull();
  });
});

describe("the global fetch guard", () => {
  const realFetch = globalThis.fetch;
  const realLoc = (globalThis as { location?: unknown }).location;
  let sent: string[];

  beforeEach(() => {
    sent = [];
    (globalThis as { location?: unknown }).location = { href: "https://webapp.flagshipserver.com/", origin: "https://webapp.flagshipserver.com" };
    globalThis.fetch = (async (input: string | Request) => {
      const url = typeof input === "string" ? input : input.url;
      sent.push(url);
      if (url.includes("/api/users/bright-maple/") || url.includes("/api/accounts/bright-maple/")) return json(GONE_BODY, 404);
      return json({ ok: true });
    }) as typeof fetch;
  });

  afterEach(async () => {
    (await imp("comFetch.js")).uninstallComFetchGuard();
    globalThis.fetch = realFetch;
    (globalThis as { location?: unknown }).location = realLoc;
  });

  it("flips on the first 404 and then sends nothing more for that account (no retry storm)", async () => {
    const cf = await imp("comFetch.js");
    const g = await imp("accountGone.js");
    cf.installComFetchGuard();
    const first = await fetch("https://flagshipserver.com/api/users/bright-maple/pods");
    expect(first.status).toBe(404);
    expect(g.isAccountGone()).toBe(true);
    for (let i = 0; i < 20; i++) {
      const r = await fetch("https://flagshipserver.com/api/users/bright-maple/stream");
      expect(r.status).toBe(404);
      expect(((await r.json()) as { code: string }).code).toBe("account-not-found");
    }
    await fetch("https://flagshipserver.com/api/accounts/bright-maple/read-token", { method: "POST" });
    expect(sent).toEqual(["https://flagshipserver.com/api/users/bright-maple/pods"]);
    await fetch("https://flagshipserver.com/api/users/someone-else/pods");
    await fetch("https://flagshipserver.com/api/username/claim", { method: "POST" });
    expect(sent).toHaveLength(3);
  });

  it("does not flip for another account's 404, or for a 404 from a box", async () => {
    const cf = await imp("comFetch.js");
    const g = await imp("accountGone.js");
    globalThis.fetch = (async () => json(GONE_BODY, 404)) as typeof fetch;
    cf.installComFetchGuard();
    await fetch("https://flagshipserver.com/api/users/owner-of-shared/pods");
    await fetch("https://home.bright-maple.flagship.services/api/users/bright-maple/pods");
    expect(g.isAccountGone()).toBe(false);
  });
});

describe("accountReadFetch", () => {
  it("notes the 404, then answers locally without calling fetch", async () => {
    const g = await imp("accountGone.js");
    const { accountReadFetch } = await imp("accountRead.js");
    const fetchMock = vi.fn(async () => json(GONE_BODY, 404));
    const deps = {
      fetch: fetchMock,
      getSession: () => ({ username: "bright-maple", umk: null }),
      getProfile: () => ({ cloudName: "bright-maple", accountId: "bright-maple" }),
      isCompanion: () => false,
      baseUrl: "https://com.test",
    };
    const url = "https://com.test/api/users/bright-maple/pods";
    const first = await accountReadFetch(url, {}, deps);
    expect(first.status).toBe(404);
    expect(g.isAccountGone()).toBe(true);
    const calls = fetchMock.mock.calls.length;
    const again = await accountReadFetch(url, {}, deps);
    expect(again.status).toBe(404);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
});

describe("removing the account from this browser", () => {
  it("forgets the identity, the profile and the tokens, and returns whether another profile remains", async () => {
    const ui = await imp("accountGoneUi.js");
    const g = await imp("accountGone.js");
    g.markAccountGone("bright-maple");
    const order: string[] = [];
    const othersRemain = await ui.removeGoneAccountFromBrowser({
      getActiveProfile: () => ({ cloudName: "bright-maple", accountId: "bright-maple" }),
      stopRenewals: () => order.push("stopRenewals"),
      resetDevice: async () => void order.push("resetDevice"),
      profileRemove: (slot: string) => void order.push(`slot:${slot}`),
      forgetProfile: (name: string) => void order.push(`forget:${name}`),
      clearAccountReadTokens: () => void order.push("tokens"),
      lockSession: () => void order.push("lock"),
      loadProfiles: () => ({ profiles: [], activeCloudName: null }),
    });
    expect(othersRemain).toBe(false);
    expect(order).toEqual([
      "stopRenewals",
      "resetDevice",
      "slot:sessionId",
      "slot:sessionToken",
      "slot:podBaseUrl",
      "slot:username",
      "forget:bright-maple",
      "tokens",
      "lock",
    ]);
    expect(g.isAccountGone()).toBe(false);
  });

  it("reports another saved profile", async () => {
    const ui = await imp("accountGoneUi.js");
    const remains = await ui.removeGoneAccountFromBrowser({
      getActiveProfile: () => ({ cloudName: "a" }),
      stopRenewals: () => {},
      resetDevice: async () => {},
      profileRemove: () => {},
      forgetProfile: () => {},
      clearAccountReadTokens: () => {},
      lockSession: () => {},
      loadProfiles: () => ({ profiles: [{ cloudName: "b" }], activeCloudName: "b" }),
    });
    expect(remains).toBe(true);
  });
});

describe("the screen's exact strings", () => {
  it("says what happened in plain words", async () => {
    const ui = await imp("accountGoneUi.js");
    expect(ui.ACCOUNT_GONE_COPY.title).toBe("This account was removed");
    expect(ui.ACCOUNT_GONE_COPY.body).toBe("This account no longer exists on Flagship. This can happen after a reset.");
    expect(ui.ACCOUNT_GONE_COPY.create).toBe("Create a new account");
    expect(ui.ACCOUNT_GONE_COPY.remove).toBe("Remove it from this browser");
    expect(ui.ACCOUNT_GONE_COPY.account("bright-maple")).toBe("Account: bright-maple");
  });

  it("has no em dash, en dash or emoji", async () => {
    const ui = await imp("accountGoneUi.js");
    const all = Object.values(ui.ACCOUNT_GONE_COPY)
      .map((v) => (typeof v === "function" ? (v as (s: string) => string)("x") : String(v)))
      .join(" ");
    expect(all).not.toMatch(/[–—]/);
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
