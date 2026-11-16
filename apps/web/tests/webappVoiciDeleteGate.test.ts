// Deleting a voi.ci conversation forgets it on every device, so the webapp asks the person first
// (docs/voici-calls.md "Deleting a conversation"): a passkey assertion with user verification when this browser has a
// custody passkey (lib/keyCustody.js), else this device's passphrase. A cancelled or failed check deletes nothing and
// sends nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATABASES, makeIndexedDBShim, makeLocalStorage } from "./support/idbShim";
import * as P from "../public/webapp/lib/voiciProtocol.js";
import { deleteConversationGated, world } from "../public/webapp/lib/voiciWorld.js";
import { confirmUserForDelete, FRESH_UNLOCK_WRONG } from "../public/webapp/lib/freshUnlock.js";
import { hasCustodyPasskey, setCustodyAuthenticatorForTests, verifyUserWithPasskey } from "../public/webapp/lib/keyCustody.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const CONV = "ab".repeat(32);
const PSEUDONYM = "cd".repeat(32);
const NOW = 1_800_000_000_000;
const UMK = new Uint8Array(32).fill(7);

function setup() {
  world.state = P.emptyMessagesState();
  world.stateLoaded = true;
  world.version = 1;
  world.page = { username: "alice", pageId: "ef".repeat(16) } as any;
  world.conversations = [{ conv: CONV, pseudonymPub: PSEUDONYM, messages: [] }] as any;
  world.missedCalls = [{ conv: CONV, callId: "c1" }] as any;
  world.state = { ...world.state, accepted: [CONV] };
  const sent: Array<{ page: unknown; conv: string }> = [];
  const deps = {
    now: () => NOW,
    post: async (page: unknown, conv: string) => {
      sent.push({ page, conv });
    },
    updateMessagesState: async (fn: (s: any) => any, { current }: any) => ({ state: fn(current.state), version: current.version + 1 }),
    forgetPlacedCalls: () => {},
  };
  return { sent, deps };
}

describe("webapp: deleting a conversation asks the person first", () => {
  it("a passed check sends the signed delete and forgets the conversation", async () => {
    const { sent, deps } = setup();
    const r = await deleteConversationGated(world.conversations[0], { ...deps, confirm: async () => ({ ok: true }) });
    expect(r).toEqual({ ok: true });
    expect(sent).toEqual([{ page: world.page, conv: CONV }]);
    expect(world.conversations).toEqual([]);
    expect(world.missedCalls).toEqual([]);
    expect(world.state.forgotten?.[CONV]).toEqual({ at: NOW, pseudonymPub: PSEUDONYM });
    expect(world.state.accepted).not.toContain(CONV);
  });

  it("a cancelled check deletes nothing and sends nothing", async () => {
    const { sent, deps } = setup();
    const r = await deleteConversationGated(world.conversations[0], { ...deps, confirm: async () => ({ ok: false, cancelled: true }) });
    expect(r).toEqual({ ok: false, cancelled: true });
    expect(sent).toEqual([]);
    expect(world.conversations.map((c: any) => c.conv)).toEqual([CONV]);
    expect(world.missedCalls).toHaveLength(1);
    expect(world.state.forgotten ?? {}).toEqual({});
    expect(world.state.accepted).toContain(CONV);
  });

  it("a failed check deletes nothing, sends nothing and says why", async () => {
    const { sent, deps } = setup();
    const r = await deleteConversationGated(world.conversations[0], { ...deps, confirm: async () => ({ ok: false, error: "nope" }) });
    expect(r).toEqual({ ok: false, error: "nope" });
    expect(sent).toEqual([]);
    expect(world.conversations).toHaveLength(1);
  });

  it("the thread's Delete goes through the gate, never straight to .com", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "public", "webapp", "views", "thread.js"), "utf8");
    expect(src).toContain("deleteConversationGated(cv)");
    expect(src).not.toContain("postConversationDelete");
  });
});

describe("webapp: the check itself (confirmUserForDelete)", () => {
  const prompt = { title: "Delete this conversation?", message: "It goes from all your devices and from Flagship." };

  beforeEach(() => {
    DATABASES.clear();
    (globalThis as any).indexedDB = makeIndexedDBShim();
    (globalThis as any).localStorage = makeLocalStorage();
  });
  afterEach(() => {
    setCustodyAuthenticatorForTests(null);
    delete (globalThis as any).indexedDB;
    delete (globalThis as any).localStorage;
  });

  it("with a passkey: one assertion with user verification; a closed prompt is a cancel", async () => {
    const { kvPut, activeProfileId } = await import("../public/webapp/keystore.js");
    await kvPut(`flagship.custodyPasskey.v1.${activeProfileId()}`, { credentialId: "cred-1" });
    expect(await hasCustodyPasskey()).toBe(true);
    let mode: "ok" | "cancel" | "no-uv" = "ok";
    let gets = 0;
    setCustodyAuthenticatorForTests({
      create: async () => {
        throw new Error("never creates");
      },
      get: async ({ credentialId }: { credentialId: string }) => {
        gets++;
        expect(credentialId).toBe("cred-1");
        if (mode === "cancel") throw Object.assign(new Error("no"), { name: "NotAllowedError" });
        if (mode === "no-uv") throw Object.assign(new Error("custody-no-uv"), { code: "custody-no-uv" });
        return { prf: new Uint8Array(32).fill(1) };
      },
    });
    let asked = 0;
    const noPassphrase = { prompt: async () => (asked++, "x") };
    expect(await confirmUserForDelete(prompt, noPassphrase)).toEqual({ ok: true });
    mode = "cancel";
    expect(await confirmUserForDelete(prompt, noPassphrase)).toEqual({ ok: false, cancelled: true });
    mode = "no-uv";
    const failed = await confirmUserForDelete(prompt, noPassphrase);
    expect(failed.ok).toBe(false);
    expect(failed.cancelled).toBeUndefined();
    expect(typeof failed.error).toBe("string");
    expect(gets).toBe(3);
    expect(asked).toBe(0);
  });

  it("without a passkey: verifyUserWithPasskey refuses, and the device's passphrase is asked instead", async () => {
    expect(await hasCustodyPasskey()).toBe(false);
    await expect(verifyUserWithPasskey()).rejects.toMatchObject({ code: "custody-no-passkey" });
    // An admin-key handle in the session doesn't skip the passphrase here (it would for an admin order).
    const session = { umk: UMK, adminRootSeed: { [Symbol.for("flagship.lockedKey")]: true, role: "admin-root" } };
    const unlock = async (p: string) => {
      if (p === "right") return UMK.slice();
      throw new Error("wrong");
    };
    expect(await confirmUserForDelete(prompt, { session, unlock, prompt: async () => "right" })).toEqual({ ok: true });
    expect(await confirmUserForDelete(prompt, { session, unlock, prompt: async () => null })).toEqual({ ok: false, cancelled: true });
    expect(await confirmUserForDelete(prompt, { session, unlock, prompt: async () => "wrong" })).toEqual({ ok: false, error: FRESH_UNLOCK_WRONG });
  });
});
