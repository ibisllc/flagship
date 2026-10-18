/**
 * The device book is refreshed on a timer (which the `.com` doorbell may answer
 * with "unchanged since the last beat") and whenever a person is waiting: an
 * unknown key signed, or the members screen asked. The second kind must never be
 * satisfied by the first, or a device added a moment ago would be refused for up
 * to a heartbeat.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import { AccountDeviceBook } from "../src/accessPrincipals.js";

function book(hold = false) {
  const asked: boolean[] = [];
  let gate: (() => void) | null = null;
  let held = hold;
  const b = new AccountDeviceBook({
    path: join(mkdtempSync(join(tmpdir(), "book-")), "account-devices.json"),
    username: "alice",
    ownerIrkPub: () => ed.getPublicKey(new Uint8Array(32).fill(1)),
    adminRootPub: () => undefined,
    fetchGrants: async ({ live }) => {
      asked.push(live);
      if (!live && held) await new Promise<void>((r) => (gate = r));
      return { grants: [] };
    },
    minRefreshMs: 0,
  });
  return {
    b,
    asked,
    release: () => {
      held = false;
      gate?.();
    },
  };
}

describe("device book refresh", () => {
  it("a periodic refresh is not live; an unknown key's refresh is", async () => {
    const { b, asked } = book();
    await b.refresh();
    await b.ensure("ab".repeat(32));
    expect(asked).toEqual([false, true]);
  });

  it("a live refresh does not join a periodic one already in flight", async () => {
    const { b, asked, release } = book(true);
    const periodic = b.refresh();
    await new Promise((r) => setTimeout(r, 0));
    const live = b.refresh({ live: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([false]); // waiting for the periodic one to finish first
    release();
    await Promise.all([periodic, live]);
    expect(asked).toEqual([false, true]);
  });

  it("two live refreshes share one read", async () => {
    const { b, asked } = book();
    await Promise.all([b.refresh({ live: true }), b.refresh({ live: true })]);
    expect(asked).toEqual([true]);
  });
});
