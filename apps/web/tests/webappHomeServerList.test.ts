// Home lists an open account's servers from `.com`'s /pods, as iOS and
// Android do, and a refused list with nothing to show is "locked" with a
// "Show my servers" button (iOS 8469ea8f: home-locked-state /
// home-show-my-servers), never "No servers yet" / "Your account is ready".
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SERVER_LIST_LOCKED_TITLE,
  SHOW_MY_SERVERS,
  fetchPodInventory,
  homeServerSource,
  renderLockedServersList,
  serversFromPods,
} from "../public/webapp/views/home.js";

const VIEW = readFileSync(resolve(__dirname, "..", "public", "webapp", "views", "home.js"), "utf8");

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Home's server source", () => {
  it("an open account reads its servers from /pods", () => {
    expect(homeServerSource(null, { demoServer: null }, 0, { username: "plucky-avocet" })).toEqual({ kind: "account" });
  });

  it("a remote (keyless) browser and a browser with no account stay empty", () => {
    expect(homeServerSource(null, {}, 0, { username: "plucky-avocet", companion: true })).toEqual({ kind: "empty" });
    expect(homeServerSource(null, {}, 0, {})).toEqual({ kind: "empty" });
  });

  it("a demo account keeps its own server", () => {
    const source = homeServerSource(null, { demoServer: { fqdn: "demo.x.flagship.services" } }, 0, { username: "x" });
    expect(source.kind).toBe("demo");
  });

  it("each /pods row becomes a list row", () => {
    const pods = new Map([
      ["home.plucky-avocet.flagship.services", { serverDomain: "home.plucky-avocet.flagship.services" }],
      ["office.plucky-avocet.flagship.services", { serverDomain: "office.plucky-avocet.flagship.services", revokedAt: 5 }],
    ]);
    expect(serversFromPods(pods)).toEqual([
      { serverId: "home.plucky-avocet.flagship.services", revoked: null },
      { serverId: "office.plucky-avocet.flagship.services", revoked: null },
    ]);
  });
});

describe("fetchPodInventory says whether the list could be read", () => {
  it("ok on a read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { pods: [] })));
    expect((await fetchPodInventory("demo")).status).toBe("ok");
  });

  it("refused on a 401 (no read token)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { error: "read token required" })));
    expect((await fetchPodInventory("demo")).status).toBe("refused");
  });

  it("error when offline or on a 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(503, {})));
    expect((await fetchPodInventory("demo")).status).toBe("error");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect((await fetchPodInventory("demo")).status).toBe("error");
  });
});

describe("the locked server list", () => {
  function fakeRoot() {
    const listeners: Record<string, () => Promise<void>> = {};
    const btn = {
      disabled: false,
      textContent: "",
      isConnected: true,
      addEventListener: (_: string, fn: () => Promise<void>) => { listeners.click = fn; },
    };
    return {
      root: { innerHTML: "", querySelector: (sel: string) => (sel === "#home-show-my-servers" ? btn : null) },
      btn,
      click: () => listeners.click!(),
    };
  }

  it("says it's locked and offers Show my servers", async () => {
    const { root, btn, click } = fakeRoot();
    const onShow = vi.fn(async () => {
      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toBe("Unlocking…");
    });
    renderLockedServersList(root, { onShow });
    expect(root.innerHTML).toContain('id="home-locked-state"');
    expect(root.innerHTML).toContain(SERVER_LIST_LOCKED_TITLE);
    expect(root.innerHTML).toContain(`id="home-show-my-servers" type="button">${SHOW_MY_SERVERS}<`);
    expect(root.innerHTML).not.toContain("No servers yet");
    await click();
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(false);
  });

  it("renderHome shows it only when the read was refused and nothing is listed", () => {
    expect(VIEW).toMatch(
      /inventory\.status === "refused" && inventory\.statusByDomain\.size === 0 && inventory\.pending\.length === 0\) \{[\s\S]{0,300}renderLockedServersList\(list, \{ onShow: showMyServers \}\)/,
    );
  });

  it("Show my servers re-mints with the keys unlocked, else opens the unlock screen", () => {
    const fn = VIEW.slice(VIEW.indexOf("async function showMyServers"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("clearAccountReadTokens();");
    expect(body).toContain("await renderHome();");
    expect(body).toContain('show(pinSet ? "view-pin-unlock" : "view-unlock")');
  });
});
