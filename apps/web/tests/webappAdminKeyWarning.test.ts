// The admin key is the way out (docs/account-gone.md): exact strings, who gets
// the warning, and what "Save my data first" does before the rescue flow exists.
import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LIB = resolve(__dirname, "../public/webapp/lib");
const imp = (f: string) => import(pathToFileURL(resolve(LIB, f)).href);

describe("exact strings", () => {
  it("says it in plain words", async () => {
    const { ADMIN_KEY_COPY: c } = await imp("adminKeyWarning.js");
    expect(c.saveData).toBe("Save my servers' data");
    expect(c.comingSoon).toBe("Coming soon");
    expect(c.removeMessage).toBe(
      "This also removes this browser's admin key. Without it you can no longer save your servers' data. Save it first, or remove anyway.",
    );
    expect(c.saveFirst).toBe("Save my data first");
    expect(c.removeAnyway).toBe("Remove anyway");
    expect(c.signOutMessage).toBe(
      "Signing out removes this device's admin key. Without it you can no longer save your servers' data. Save it first, or sign out anyway.",
    );
    expect(c.signOutAnyway).toBe("Sign out anyway");
    expect(c.signOutBackedUpMessage).toBe(
      "Signing out removes this device's admin key. You backed up your account key, so keep that file and its passphrase safe: with them you can still save your servers' data.",
    );
  });

  it("has no em dash, en dash or emoji", async () => {
    const { ADMIN_KEY_COPY } = await imp("adminKeyWarning.js");
    const all = Object.values(ADMIN_KEY_COPY).join(" ");
    expect(all).not.toMatch(/[–—]/);
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("the dialogs", () => {
  it("sign out offers save first and sign out anyway until a key file was written", async () => {
    const { signOutWarning } = await imp("adminKeyWarning.js");
    const fresh = signOutWarning(false);
    expect(fresh.title).toBe("Sign out?");
    expect(fresh.choices.map((c: { id: string; label: string }) => [c.id, c.label])).toEqual([
      ["save", "Save my data first"],
      ["go", "Sign out anyway"],
    ]);
    const backed = signOutWarning(true);
    expect(backed.choices.map((c: { id: string; label: string }) => [c.id, c.label])).toEqual([
      ["cancel", "Cancel"],
      ["go", "Sign out"],
    ]);
    expect(backed.message).toContain("keep that file and its passphrase safe");
  });

  it("remove always offers save first and remove anyway", async () => {
    const { removeWarning } = await imp("adminKeyWarning.js");
    expect(removeWarning().choices.map((c: { id: string; label: string }) => c.label)).toEqual([
      "Save my data first",
      "Remove anyway",
    ]);
  });
});

describe("who is warned", () => {
  it("an admin root in memory, a sealed admin root, or a server session", async () => {
    const { holdsRescueKey } = await imp("adminKeyWarning.js");
    expect(await holdsRescueKey({ session: { adminRootSeed: new Uint8Array(32) } })).toBe(true);
    expect(await holdsRescueKey({ session: {}, hasAdminRootRecord: async () => true })).toBe(true);
    expect(await holdsRescueKey({ session: {}, hasAdminRootRecord: async () => false, serverTokenCount: () => 2 })).toBe(true);
  });

  it("not a device with none of them, and an unreadable record never blocks the check", async () => {
    const { holdsRescueKey } = await imp("adminKeyWarning.js");
    expect(await holdsRescueKey({ session: {}, hasAdminRootRecord: async () => false, serverTokenCount: () => 0 })).toBe(false);
    expect(await holdsRescueKey({})).toBe(false);
    expect(
      await holdsRescueKey({ session: {}, hasAdminRootRecord: async () => { throw new Error("idb"); }, serverTokenCount: () => 1 }),
    ).toBe(true);
  });
});

describe("Save my data first", () => {
  it("runs the rescue flow when the build has one", async () => {
    const { saveDataFirst } = await imp("adminKeyWarning.js");
    const rescue = vi.fn(async () => true);
    const backupKey = vi.fn(async () => true);
    expect(await saveDataFirst({ rescue, session: {}, backupKey })).toBe(true);
    expect(rescue).toHaveBeenCalled();
    expect(backupKey).not.toHaveBeenCalled();
  });

  it("falls back to the account-key backup while unlocked, and says to unlock otherwise", async () => {
    const { saveDataFirst } = await imp("adminKeyWarning.js");
    const backupKey = vi.fn(async () => true);
    expect(await saveDataFirst({ session: { umk: new Uint8Array(32) }, backupKey })).toBe(true);
    const notify = vi.fn();
    expect(await saveDataFirst({ session: { umk: null }, backupKey, notify })).toBe(false);
    expect(notify).toHaveBeenCalledWith("Unlock first to save your key.");
    expect(backupKey).toHaveBeenCalledTimes(1);
  });
});
