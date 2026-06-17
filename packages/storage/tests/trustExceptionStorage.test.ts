/**
 * TrustExceptionStorage adapter contract (maintainer-trust enforcement).
 *
 * Runs the SAME assertion set against BOTH adapters: InMemory directly +
 * the D1 adapter over a REAL node:sqlite database with every migration
 * applied (so the `0055_trust_exceptions` PRIMARY-KEY upsert + ordering
 * are the production ones). Any divergence fails here, fast.
 */
import { describe, expect, it } from "vitest";
import {
  D1Storage,
  InMemoryStorage,
  type TrustExceptionStorage,
} from "../src/index.js";
import { createSqliteD1 } from "./support/sqliteD1.js";

/** Fresh store + cleanup, per adapter, per test. */
function freshStore(adapter: "InMemory" | "D1"): {
  store: TrustExceptionStorage;
  cleanup: () => void;
} {
  if (adapter === "InMemory") {
    return { store: new InMemoryStorage().trustExceptions, cleanup: () => {} };
  }
  const sqlite = createSqliteD1();
  return {
    store: new D1Storage(sqlite).trustExceptions,
    cleanup: () => sqlite.close(),
  };
}

function exc(
  certHash: string,
  grantedAt: number,
  certClass: "control" | "relay" = "relay",
  devicePub = "11".repeat(32),
) {
  return {
    kind: "TrustException",
    certClass,
    certHash,
    grantedAt,
    grantedByDevicePub: devicePub,
    signatures: [{ pubkey: devicePub, sig: "ab".repeat(64) }],
  };
}

const ADAPTERS: ("InMemory" | "D1")[] = ["InMemory", "D1"];

describe("TrustExceptionStorage parity", () => {
  for (const adapter of ADAPTERS) {
    describe(adapter, () => {
      const run = async (
        fn: (store: TrustExceptionStorage) => Promise<void>,
      ) => {
        const { store, cleanup } = freshStore(adapter);
        try {
          await fn(store);
        } finally {
          cleanup();
        }
      };

      it("stores and reads back a single exception", () =>
        run(async (store) => {
          await store.put("Alice", exc("h1", 1000), 5000);
          const got = await store.get("alice", "h1");
          expect(got).toBeDefined();
          expect(got!.certHash).toBe("h1");
          expect(got!.certClass).toBe("relay");
          expect(got!.grantedAt).toBe(1000);
          expect(got!.username).toBe("alice");
          expect(got!.grantedByDevicePub).toBe("11".repeat(32));
          expect(got!.storedAt).toBe(5000);
          expect(JSON.parse(got!.envelopeJson).certHash).toBe("h1");
        }));

      it("is case-insensitive on username + certHash lookups", () =>
        run(async (store) => {
          await store.put("Bob", exc("ABC", 1), 1);
          expect(await store.get("bob", "abc")).toBeDefined();
          expect(await store.get("BOB", "ABC")).toBeDefined();
        }));

      it("upserts by (username, certHash) — last write wins (replay-safe)", () =>
        run(async (store) => {
          await store.put("u", exc("dup", 1, "control"), 1);
          await store.put("u", exc("dup", 2, "relay"), 2);
          const got = await store.get("u", "dup");
          expect(got!.grantedAt).toBe(2);
          expect(got!.certClass).toBe("relay");
          expect((await store.listForUser("u")).length).toBe(1);
        }));

      it("lists a user's exceptions granted_at DESC", () =>
        run(async (store) => {
          await store.put("u", exc("a", 100), 1);
          await store.put("u", exc("b", 300), 1);
          await store.put("u", exc("c", 200), 1);
          const all = await store.listForUser("u");
          expect(all.map((r) => r.certHash)).toEqual(["b", "c", "a"]);
        }));

      it("scopes lists per user", () =>
        run(async (store) => {
          await store.put("u1", exc("x", 1), 1);
          await store.put("u2", exc("y", 1), 1);
          expect(
            (await store.listForUser("u1")).map((r) => r.certHash),
          ).toEqual(["x"]);
          expect(
            (await store.listForUser("u2")).map((r) => r.certHash),
          ).toEqual(["y"]);
        }));

      it("returns undefined / [] for unknown keys", () =>
        run(async (store) => {
          expect(await store.get("nobody", "nope")).toBeUndefined();
          expect(await store.listForUser("nobody")).toEqual([]);
        }));
    });
  }
});
