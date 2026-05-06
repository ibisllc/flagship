/**
 * Tests for the phone-gated admin proxy.
 *
 *   /.flagship/admin/postgres/*  → Adminer
 *   /.flagship/admin/objects/*   → MinIO Console
 *   /.flagship/admin/kv/*        → redis-commander
 *
 * We use an injected `forward` function so tests run without binding
 * upstream containers. The gate is a TokenSetSessionGate.
 */

import { describe, expect, it } from "vitest";
import {
  buildAdminProxyHandler,
  type AdminTarget,
} from "../src/adminProxy.js";
import { TokenSetSessionGate } from "../src/alertInboxHttp.js";
import type { HttpRequest } from "../src/runtime.js";

function req(args: {
  method?: string;
  path: string;
  token?: string;
  headers?: Record<string, string>;
}): HttpRequest {
  const headers: Record<string, string> = { ...(args.headers ?? {}) };
  if (args.token) headers["authorization"] = `Flagship-Session ${args.token}`;
  return {
    method: args.method ?? "GET",
    path: args.path,
    headers,
    body: Buffer.alloc(0),
  };
}

function captureForward(
  capture: { target?: AdminTarget; req?: HttpRequest },
) {
  return async (target: AdminTarget, r: HttpRequest) => {
    capture.target = target;
    capture.req = r;
    return {
      status: 200,
      headers: { "content-type": "text/html" },
      body: Buffer.from("<html>upstream</html>"),
    };
  };
}

describe("admin proxy — gate", () => {
  it("returns null for non-admin paths so runtime falls through", async () => {
    const gate = new TokenSetSessionGate(new Set(["secret"]));
    const handle = buildAdminProxyHandler({ gate });
    const r = await handle(
      req({ path: "/api/health", token: "secret" }),
    );
    expect(r).toBeNull();
  });

  it("rejects without a paired-session token (401)", async () => {
    const gate = new TokenSetSessionGate(new Set(["secret"]));
    const handle = buildAdminProxyHandler({ gate });
    const r = await handle(
      req({ path: "/.flagship/admin/postgres/" }),
    );
    expect(r?.status).toBe(401);
  });

  it("rejects a stale token (401)", async () => {
    const gate = new TokenSetSessionGate(new Set(["secret"]));
    const handle = buildAdminProxyHandler({ gate });
    const r = await handle(
      req({ path: "/.flagship/admin/postgres/", token: "wrong" }),
    );
    expect(r?.status).toBe(401);
  });
});

describe("admin proxy — section routing", () => {
  it("/postgres/* forwards to Adminer (8081)", async () => {
    const gate = new TokenSetSessionGate(new Set(["s"]));
    const cap: { target?: AdminTarget; req?: HttpRequest } = {};
    const handle = buildAdminProxyHandler({
      gate,
      forward: captureForward(cap),
    });
    const r = await handle(
      req({ path: "/.flagship/admin/postgres/index.php", token: "s" }),
    );
    expect(r?.status).toBe(200);
    expect(cap.target).toEqual({ host: "127.0.0.1", port: 8081 });
    expect(cap.req?.path).toBe("/index.php");
  });

  it("/objects/* forwards to MinIO Console (9001)", async () => {
    const gate = new TokenSetSessionGate(new Set(["s"]));
    const cap: { target?: AdminTarget; req?: HttpRequest } = {};
    const handle = buildAdminProxyHandler({
      gate,
      forward: captureForward(cap),
    });
    await handle(req({ path: "/.flagship/admin/objects/login", token: "s" }));
    expect(cap.target?.port).toBe(9001);
    expect(cap.req?.path).toBe("/login");
  });

  it("/kv/* forwards to redis-commander (8082)", async () => {
    const gate = new TokenSetSessionGate(new Set(["s"]));
    const cap: { target?: AdminTarget; req?: HttpRequest } = {};
    const handle = buildAdminProxyHandler({
      gate,
      forward: captureForward(cap),
    });
    await handle(req({ path: "/.flagship/admin/kv/", token: "s" }));
    expect(cap.target?.port).toBe(8082);
    expect(cap.req?.path).toBe("/");
  });

  it("preserves query string", async () => {
    const gate = new TokenSetSessionGate(new Set(["s"]));
    const cap: { target?: AdminTarget; req?: HttpRequest } = {};
    const handle = buildAdminProxyHandler({
      gate,
      forward: captureForward(cap),
    });
    await handle(
      req({
        path: "/.flagship/admin/postgres/sql.php?db=main&q=SELECT+1",
        token: "s",
      }),
    );
    expect(cap.req?.path).toBe("/sql.php?db=main&q=SELECT+1");
  });

  it("strips X-Flagship-* headers before forwarding", async () => {
    const gate = new TokenSetSessionGate(new Set(["s"]));
    const cap: { target?: AdminTarget; req?: HttpRequest } = {};
    const handle = buildAdminProxyHandler({
      gate,
      forward: captureForward(cap),
    });
    await handle(
      req({
        path: "/.flagship/admin/postgres/",
        token: "s",
        headers: {
          "x-flagship-user": "alice",
          "x-flagship-signature": "deadbeef",
          "user-agent": "Mozilla/5.0",
        },
      }),
    );
    expect(cap.req?.headers["x-flagship-user"]).toBeUndefined();
    expect(cap.req?.headers["x-flagship-signature"]).toBeUndefined();
    expect(cap.req?.headers["user-agent"]).toBe("Mozilla/5.0");
  });

  it("strips Host header (upstream sets its own)", async () => {
    const gate = new TokenSetSessionGate(new Set(["s"]));
    const cap: { target?: AdminTarget; req?: HttpRequest } = {};
    const handle = buildAdminProxyHandler({
      gate,
      forward: captureForward(cap),
    });
    await handle(
      req({
        path: "/.flagship/admin/postgres/",
        token: "s",
        headers: { Host: "external.example.com" },
      }),
    );
    expect(cap.req?.headers["host"]).toBeUndefined();
    expect(cap.req?.headers["Host"]).toBeUndefined();
  });

  it("respects custom targets in deps", async () => {
    const gate = new TokenSetSessionGate(new Set(["s"]));
    const cap: { target?: AdminTarget; req?: HttpRequest } = {};
    const handle = buildAdminProxyHandler({
      gate,
      postgresUi: { host: "10.0.0.1", port: 8888 },
      forward: captureForward(cap),
    });
    await handle(req({ path: "/.flagship/admin/postgres/", token: "s" }));
    expect(cap.target).toEqual({ host: "10.0.0.1", port: 8888 });
  });
});
