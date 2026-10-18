// Home keeps the names it learned across a reload, and Add/Restore server
// takes no tap right after the layout above it moved. Mirrors Android's
// PresentationNameStore and its 450 ms settle.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cachedHomeIdentity, rememberHomeIdentity } from "../public/webapp/lib/homeIdentity.js";
import { SETTLE_MS, createSettleGuard } from "../public/webapp/lib/settleGuard.js";
import { homeIdentityLine } from "../public/webapp/views/home.js";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as unknown as Storage;
}

describe("home identity line across a reload", () => {
  it("shows the saved names before the directory answers", () => {
    const storage = memoryStorage();
    rememberHomeIdentity("elated-iris", { accountDisplayName: "Elated Iris", deviceDisplayName: "Chrome" }, { storage });
    const saved = cachedHomeIdentity("elated-iris", { storage });
    expect(homeIdentityLine({ username: "elated-iris", ...saved })).toBe("Elated Iris > Chrome");
  });

  it("falls back to the handle with nothing saved, and keys by account", () => {
    const storage = memoryStorage();
    rememberHomeIdentity("elated-iris", { accountDisplayName: "Elated Iris" }, { storage });
    expect(cachedHomeIdentity("someone-else", { storage })).toBeNull();
    expect(homeIdentityLine({ username: "someone-else", ...(cachedHomeIdentity("someone-else", { storage }) ?? {}) })).toBe("someone-else");
  });

  it("an empty read never wipes the saved names", () => {
    const storage = memoryStorage();
    rememberHomeIdentity("elated-iris", { accountDisplayName: "Elated Iris", deviceDisplayName: "Chrome" }, { storage });
    rememberHomeIdentity("elated-iris", {}, { storage });
    expect(cachedHomeIdentity("elated-iris", { storage })).toEqual({ accountDisplayName: "Elated Iris", deviceDisplayName: "Chrome" });
  });

  it("a corrupt entry reads as nothing saved", () => {
    const storage = memoryStorage();
    storage.setItem("flagship.homeIdentity.x", "{not json");
    expect(cachedHomeIdentity("x", { storage })).toBeNull();
  });

  it("Home paints the saved line first and saves what the directory returns", () => {
    const home = readFileSync(resolve(__dirname, "..", "public", "webapp", "views", "home.js"), "utf8");
    expect(home).toContain("cachedHomeIdentity(session?.username)");
    expect(home).toContain("rememberHomeIdentity(session?.username");
  });
});

describe("Add/Restore server settling", () => {
  it("takes a tap until the layout moves, then not for 450 ms", () => {
    let t = 10_000;
    const guard = createSettleGuard({ now: () => t });
    expect(SETTLE_MS).toBe(450);
    expect(guard.ready()).toBe(true);
    guard.note();
    expect(guard.ready()).toBe(false);
    t += 449;
    expect(guard.ready()).toBe(false);
    t += 1;
    expect(guard.ready()).toBe(true);
    guard.note();
    t += 100;
    guard.note();
    t += 449;
    expect(guard.ready()).toBe(false);
  });

  it("the Home button is wired through the guard", () => {
    const home = readFileSync(resolve(__dirname, "..", "public", "webapp", "views", "home.js"), "utf8");
    expect(home).toMatch(/#home-add-server"\)\?\.addEventListener\("click", \(\) => \{\n    if \(!addServerSettle\.ready\(\)\) return;/);
  });
});
