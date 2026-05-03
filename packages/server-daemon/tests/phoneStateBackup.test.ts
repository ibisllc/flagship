import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  deriveSWK,
  sealLlmPayload,
} from "@flagship/protocol";
import { AppMembership } from "../src/membership.js";
import { BootCoordinator } from "../src/bootCoordinator.js";
import { IdentityInjector } from "../src/identityInjector.js";
import { buildDaemonHttp, type DaemonContext } from "../src/httpApi.js";
import { InMemoryPhoneStateStore } from "../src/phoneStateStore.js";

const umk = { seed: new Uint8Array(32).fill(11) };
const irk = deriveIRK(umk);
const swk = deriveSWK(umk, "srv-1");

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function makeCtx(extra: { store?: InMemoryPhoneStateStore } = {}) {
  const apps = new Map<string, AppMembership>();
  apps.set("habit-tracker", new AppMembership("habit-tracker", "harry", irk.publicKey, swk));
  const sessions = new Map<string, Uint8Array>([["phone-token", irk.publicKey]]);
  const ctx: DaemonContext = {
    serverId: "srv-1",
    userId: "harry",
    bootCoordinator: new BootCoordinator("srv-1", irk.publicKey),
    apps,
    resolveSession: (t) => (t ? sessions.get(t) ?? null : null),
    injectors: new Map<string, IdentityInjector>(),
    phoneState: extra.store ?? new InMemoryPhoneStateStore(),
  };
  return ctx;
}

describe("daemon HTTP — PUT /phone-state", () => {
  it("stores an SWK-sealed blob and returns 200", async () => {
    const store = new InMemoryPhoneStateStore();
    const app = buildDaemonHttp(makeCtx({ store }));
    const sealed = sealLlmPayload(new TextEncoder().encode("phone-state-v1"), swk);
    const r = await app.inject({
      method: "PUT",
      url: "/phone-state",
      payload: {
        sessionToken: "phone-token",
        ciphertext: bytesToHex(sealed.ciphertext),
        nonce: bytesToHex(sealed.nonce),
        version: 1,
      },
    });
    expect(r.statusCode).toBe(200);
    expect(store.get()?.version).toBe(1);
  });

  it("rejects unauthenticated callers", async () => {
    const app = buildDaemonHttp(makeCtx());
    const r = await app.inject({
      method: "PUT",
      url: "/phone-state",
      payload: { ciphertext: "00", nonce: "00".repeat(12), version: 1 },
    });
    expect(r.statusCode).toBe(401);
  });

  it("rejects oversized blobs with 413", async () => {
    const app = buildDaemonHttp(makeCtx());
    const big = "00".repeat(257 * 1024);
    const r = await app.inject({
      method: "PUT",
      url: "/phone-state",
      payload: {
        sessionToken: "phone-token",
        ciphertext: big,
        nonce: "00".repeat(12),
        version: 1,
      },
    });
    expect(r.statusCode).toBe(413);
  });

  it("rejects non-monotonic versions with 409 (last-write-wins prevents rollback)", async () => {
    const store = new InMemoryPhoneStateStore();
    store.put({ ciphertext: new Uint8Array([1]), nonce: new Uint8Array(12), version: 5, storedAt: 1 });
    const app = buildDaemonHttp(makeCtx({ store }));
    const r = await app.inject({
      method: "PUT",
      url: "/phone-state",
      payload: {
        sessionToken: "phone-token",
        ciphertext: "01",
        nonce: "00".repeat(12),
        version: 3,
      },
    });
    expect(r.statusCode).toBe(409);
  });

  it("rejects malformed bodies with 400", async () => {
    const app = buildDaemonHttp(makeCtx());
    const r = await app.inject({
      method: "PUT",
      url: "/phone-state",
      payload: { sessionToken: "phone-token", ciphertext: 12, nonce: "00", version: "x" },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe("daemon HTTP — GET /phone-state", () => {
  it("returns the most recent blob", async () => {
    const store = new InMemoryPhoneStateStore();
    store.put({
      ciphertext: new Uint8Array([1, 2, 3]),
      nonce: new Uint8Array(12).fill(7),
      version: 4,
      storedAt: 100,
    });
    const app = buildDaemonHttp(makeCtx({ store }));
    const r = await app.inject({
      method: "GET",
      url: "/phone-state?sessionToken=phone-token",
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.version).toBe(4);
    expect(body.ciphertext).toBe("010203");
  });

  it("returns 404 when no blob stored", async () => {
    const app = buildDaemonHttp(makeCtx());
    const r = await app.inject({
      method: "GET",
      url: "/phone-state?sessionToken=phone-token",
    });
    expect(r.statusCode).toBe(404);
  });

  it("rejects unauthenticated callers", async () => {
    const app = buildDaemonHttp(makeCtx());
    const r = await app.inject({ method: "GET", url: "/phone-state" });
    expect(r.statusCode).toBe(401);
  });
});

describe("InMemoryPhoneStateStore", () => {
  it("returns a copy on get (caller mutation cannot poison the store)", () => {
    const store = new InMemoryPhoneStateStore();
    const cipher = new Uint8Array([1, 2, 3]);
    const nonce = new Uint8Array(12);
    store.put({ ciphertext: cipher, nonce, version: 1, storedAt: 1 });
    const blob = store.get()!;
    blob.ciphertext[0] = 99;
    expect(store.get()!.ciphertext[0]).toBe(1);
  });

  it("rejects empty ciphertext", () => {
    const store = new InMemoryPhoneStateStore();
    const r = store.put({ ciphertext: new Uint8Array(0), nonce: new Uint8Array(12), version: 1, storedAt: 1 });
    expect(r.ok).toBe(false);
  });
});
