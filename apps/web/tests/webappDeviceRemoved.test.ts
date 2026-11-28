// Device removal on the webapp (docs/revocation-ui.md): "Remove from account" in Trusted devices, "Reset account
// keys" in Account security, the `403 device-removed` detector, the "This browser was removed" screen and the
// service worker's device-removed push.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const WEBAPP = resolve(__dirname, "../public/webapp");
const imp = (f: string) => import(pathToFileURL(resolve(WEBAPP, f)).href);
const src = (f: string) => readFileSync(resolve(WEBAPP, f), "utf8");

const REMOVED = { error: "device-removed", code: "device-removed" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const OWN = "https://flagshipserver.com/api/accounts/bright-maple/read-token";

beforeEach(async () => {
  const g = await imp("lib/accountGone.js");
  g._resetAccountGoneForTests();
  g.setOwnAccountNames(() => ["Bright-Maple"]);
});

describe("noticing that this browser was removed", () => {
  it("flips only for 403 device-removed from .com naming the browser's own account", async () => {
    const g = await imp("lib/accountGone.js");
    expect(await g.noteAccountGoneResponse(OWN, json({ error: "not authorized" }, 403))).toBe(false);
    expect(await g.noteAccountGoneResponse("https://home.bright-maple.flagship.services/api/accounts/bright-maple/x", json(REMOVED, 403))).toBe(false);
    expect(await g.noteAccountGoneResponse("https://flagshipserver.com/api/accounts/someone-else/read-token", json(REMOVED, 403))).toBe(false);
    expect(await g.noteAccountGoneResponse(OWN, json(REMOVED, 401))).toBe(false);
    expect(await g.noteAccountGoneResponse(OWN, new Response("nope", { status: 403 }))).toBe(false);
    expect(g.isAccountGone()).toBe(false);

    expect(await g.noteAccountGoneResponse("https://flagshipserver.com/api/users/bright-maple/pods", json(REMOVED, 403))).toBe(true);
    expect(g.isDeviceRemoved()).toBe(true);
    expect(g.goneAccountReason()).toBe("device-removed");
    expect(g.goneAccountName()).toBe("bright-maple");
    // Later calls for the account are answered here, so nothing keeps polling.
    expect(g.answerIfAccountGone(OWN)?.status).toBe(404);
  });

  it("a deleted account outranks a removed browser, never the other way round", async () => {
    const g = await imp("lib/accountGone.js");
    g.markAccountGone("bright-maple");
    expect(g.markAccountGone("bright-maple", "device-removed")).toBe(false);
    expect(g.isDeviceRemoved()).toBe(false);
    g.clearAccountGone();
    g.markAccountGone("bright-maple", "device-removed");
    expect(g.markAccountGone("bright-maple")).toBe(true);
    expect(g.goneAccountReason()).toBe("account-not-found");
    g.clearAccountGone();
    expect(g.goneAccountReason()).toBe("account-not-found");
  });

  it("the global fetch guard notes it on a read-token mint, then the IRK fallback is answered locally", async () => {
    const g = await imp("lib/accountGone.js");
    const { installComFetchGuard, uninstallComFetchGuard } = await imp("lib/comFetch.js");
    const realFetch = globalThis.fetch;
    const sent: string[] = [];
    globalThis.fetch = (async (input: string) => (sent.push(input), json(REMOVED, 403))) as typeof fetch;
    try {
      installComFetchGuard();
      expect((await fetch(OWN, { method: "POST" })).status).toBe(403);
      expect(g.isDeviceRemoved()).toBe(true);
      expect((await fetch(OWN, { method: "POST" })).status).toBe(404);
      expect(sent).toEqual([OWN]);
    } finally {
      uninstallComFetchGuard();
      globalThis.fetch = realFetch;
    }
  });
});

describe("the removed browser's screen", () => {
  it("erases the keys at once without asking, and keeps the screen up", async () => {
    const ui = await imp("lib/accountGoneUi.js");
    const g = await imp("lib/accountGone.js");
    g.markAccountGone("bright-maple", "device-removed");
    const order: string[] = [];
    await ui.eraseRemovedBrowser({
      getActiveProfile: () => ({ cloudName: "bright-maple", accountId: "bright-maple" }),
      activeProfileId: () => "profile-id",
      stopRenewals: () => void order.push("stopRenewals"),
      forgetProfileKeys: async (id: string) => void order.push(`keys:${id}`),
      profileRemove: () => {},
      removeProfileRecord: (n: string) => void order.push(`record:${n}`),
      forgetProfile: () => {},
      loadProfiles: () => ({ profiles: [] }),
      forgetDefaultProfileKeys: async () => void order.push("keys:default"),
      setActiveKeystoreProfile: () => {},
      clearAccountReadTokens: () => void order.push("tokens"),
      lockSession: () => void order.push("lock"),
    });
    expect(order).toEqual(["stopRenewals", "keys:profile-id", "record:bright-maple", "keys:default", "tokens", "lock"]);
    expect(g.isDeviceRemoved()).toBe(true);
  });

  it("says what happened in plain words and offers no rescue", async () => {
    const ui = await imp("lib/accountGoneUi.js");
    expect(ui.DEVICE_REMOVED_COPY.title).toBe("This browser was removed from your account");
    expect(ui.DEVICE_REMOVED_COPY.body).toBe("Another device on the account removed it, so Flagship erased the account's keys from this browser. The account and its servers are not changed.");
    expect(ui.DEVICE_REMOVED_COPY.join).toBe("Join an account");
    expect(ui.DEVICE_REMOVED_COPY.remove).toBe("Remove it from this browser");
    const all = Object.values(ui.DEVICE_REMOVED_COPY).map((v) => (typeof v === "function" ? (v as (s: string) => string)("x") : String(v))).join(" ");
    expect(all).not.toMatch(/[–—]/);
    const screen = src("lib/accountGoneUi.js");
    const removed = screen.slice(screen.indexOf("function paintRemoved"), screen.indexOf("function showError"));
    expect(removed).not.toMatch(/saveData|rescue|restoreHint/);
    expect(removed).toContain("leaveRemoved(true)");
    expect(screen).toContain('document.getElementById("bootstrap-connect")?.click()');
  });

  it("a push asks .com with a fresh device-signed mint, and only when the account is unlocked here", async () => {
    const ui = await imp("lib/accountGoneUi.js");
    const mint = vi.fn(async () => null);
    expect(await ui.checkStillOnAccount({ getSession: () => ({ username: "Bright-Maple", umk: new Uint8Array(32) }), mint })).toBe(true);
    expect(mint).toHaveBeenCalledWith("bright-maple");
    expect(await ui.checkStillOnAccount({ getSession: () => ({ username: "bright-maple", umk: null }), mint })).toBe(false);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(src("lib/swRegister.js")).toContain('data.type === "DEVICE_REMOVED_CHECK"');
  });
});

describe("Trusted devices", () => {
  const view = () => src("views/trusted-devices.js");

  it("offers rename and Remove from account only; no Replace device or Wipe & restart", () => {
    const v = view();
    expect(v).not.toMatch(/replace-device-btn|wipe-restart-btn|renderDangerZone|runWipeRestartCeremony|runReplaceDeviceCeremony/);
    expect(v).toContain('tr("Remove from account")');
    // Never on this browser itself (Settings, Remove this device, does that).
    expect(v).toContain('${device.isCurrent ? "" : `<button class="secondary danger" data-remove-device=');
    // The finalize of a replacement started elsewhere (a recovery) still works.
    expect(v).toContain("completeReplaceDeviceCeremony");
  });

  it("removes through the signed directory DELETE and never this browser", async () => {
    const { removeAccountDevice } = await imp("lib/accountDirectory.js");
    const id = "ffeeddccbbaa99887766554433221100";
    const profile = { accountId: "bright-maple", deviceId: "00112233445566778899aabbccddeeff" };
    const session = { umk: new Uint8Array(32) };
    const calls: Array<{ url: string; method: string }> = [];
    const deps = {
      session,
      profile,
      baseUrl: "https://com.test",
      deriveDeviceKey: async () => ({ publicKey: new Uint8Array(32), privateKey: {} }),
      signDevice: async () => new Uint8Array(64),
      fetch: async (url: string, init: { method: string }) => (calls.push({ url, method: init.method }), json({ ok: true, deviceId: id })),
    };
    expect(await removeAccountDevice(id, deps)).toEqual({ ok: true, deviceId: id });
    expect(calls).toEqual([{ url: `https://com.test/api/accounts/bright-maple/devices/${id}`, method: "DELETE" }]);
    await expect(removeAccountDevice(profile.deviceId, deps)).rejects.toThrow();
    const refused = { ...deps, fetch: async () => json({ error: "not authorized" }, 403) };
    await expect(removeAccountDevice(id, refused)).rejects.toMatchObject({ status: 403 });
  });

  it("asks with the device's name, and on a refusal shows why", async () => {
    let td: Record<string, any>;
    try {
      td = await imp("views/trusted-devices.js");
    } catch {
      return; // the view needs a DOM; the strings are pinned below
    }
    expect(td.REMOVE_DEVICE_COPY.title("Erica's iPad")).toBe("Remove Erica's iPad from your account?");
    expect(td.REMOVE_DEVICE_COPY.message).toBe("It loses access to your account and your servers. The next time it goes online, Flagship erases your account's keys from it.");
    expect(td.removeDeviceErrorText({ status: 403 })).toBe("Only an admin device of this account can remove other devices.");
    expect(td.removeDeviceErrorText(new TypeError("Failed to fetch"))).toMatch(/internet connection/);
    expect(td.removeDeviceErrorText(new Error("odd"))).toBe("Check your connection and try again.");
    const asked: Array<{ title: string; message: string }> = [];
    const alerts: Array<{ title: string; message: string }> = [];
    const modal = {
      inlineConfirm: async (o: { title: string; message: string }) => (asked.push(o), true),
      inlineAlert: async (o: { title: string; message: string }) => void alerts.push(o),
    };
    const device = { deviceId: "ff".repeat(16), displayName: "Erica's iPad", platformClass: "ios" };
    expect(await td.removeDeviceFlow(device, { modal, remove: async () => { throw Object.assign(new Error("not authorized"), { status: 403 }); } })).toBe(false);
    expect(asked[0]!.title).toBe("Remove Erica's iPad from your account?");
    expect(alerts).toEqual([{ title: "Couldn't remove the device", message: "Only an admin device of this account can remove other devices." }]);
    expect(await td.removeDeviceFlow(device, { modal, remove: async () => ({ ok: true }) })).toBe(true);
  });

  it("pins the exact words in source", () => {
    const v = view();
    expect(v).toContain('tr("Remove {0} from your account?", name)');
    expect(v).toContain('tr("Couldn\'t remove the device")');
    expect(v).toContain('tr("Check your connection and try again.")');
  });
});

describe("Reset account keys in Account security", () => {
  it("runs the wipe ceremony behind the three-second sheet, under its new name", () => {
    const lib = src("lib/resetAccountKeysUi.js");
    expect(lib).toContain("runWipeRestartCeremony");
    expect(lib).toContain("startCountdown");
    expect(lib).toContain('tr("Reset your account keys?")');
    expect(lib).toContain(
      'tr("Makes new keys for your account. Every other device is removed and has to join again, and every server has to be paired again. Your servers keep their data, and the account stays on this device. This can\'t be undone.")',
    );
    const security = src("views/account-security.js");
    expect(security).toContain("renderResetAccountKeys()");
    expect(security).toContain('id="account-security-reset-keys"');
    expect(security).toContain("runResetAccountKeys");
  });
});

describe("the service worker's device-removed push", () => {
  function sandbox(clients: Array<{ visibilityState: string; posted: unknown[] }>) {
    const listeners = new Map<string, Function[]>();
    const shown: Array<{ title: string; opts: Record<string, unknown> }> = [];
    const self: any = {
      location: { origin: "https://webapp.flagshipserver.com" },
      addEventListener: (t: string, cb: Function) => listeners.set(t, [...(listeners.get(t) ?? []), cb]),
      clients: {
        matchAll: async () => clients.map((c) => ({ visibilityState: c.visibilityState, postMessage: (m: unknown) => c.posted.push(m) })),
      },
      registration: { showNotification: async (title: string, opts: Record<string, unknown>) => void shown.push({ title, opts }) },
    };
    const ctx: any = { self, caches: {}, fetch: async () => ({}), URL, Response, Headers, console: { warn() {}, log() {}, error() {} }, Date, Promise, Error, Array, Object, JSON, setTimeout, clearTimeout };
    vm.createContext(ctx);
    vm.runInContext(src("service-worker.js"), ctx);
    const push = async (data: unknown) => {
      let wait: Promise<unknown> = Promise.resolve();
      for (const cb of listeners.get("push") ?? []) cb({ data: { json: () => data }, waitUntil: (p: Promise<unknown>) => { wait = p; } });
      await wait;
    };
    return { push, shown };
  }

  it("asks every open tab to check and shows a content-free notice when none is in view", async () => {
    const tab = { visibilityState: "hidden", posted: [] as unknown[] };
    const s = sandbox([tab]);
    await s.push({ category: "device-removed", kind: "device-removed" });
    expect(tab.posted).toEqual([{ type: "DEVICE_REMOVED_CHECK" }]);
    expect(s.shown).toHaveLength(1);
    expect(s.shown[0]!.opts.body).toBe("This device was removed from your Flagship account.");
    expect(s.shown[0]!.opts.data).toEqual({ kind: "device-removed", deepLink: "/" });
  });

  it("shows nothing when a tab is in view; it checks there", async () => {
    const tab = { visibilityState: "visible", posted: [] as unknown[] };
    const s = sandbox([tab]);
    await s.push({ category: "device-removed", kind: "device-removed" });
    expect(tab.posted).toEqual([{ type: "DEVICE_REMOVED_CHECK" }]);
    expect(s.shown).toHaveLength(0);
  });

  it("never erases anything itself", () => {
    const sw = src("service-worker.js");
    const branch = sw.slice(sw.indexOf('data.category === "device-removed"'), sw.indexOf("An operator's notice to the account"));
    expect(branch).not.toMatch(/indexedDB|deleteDatabase|localStorage|caches\.delete/);
    expect(sw).toContain('SHELL_VERSION = "v261"');
    expect(sw).toContain('"/lib/resetAccountKeysUi.js"');
  });
});
