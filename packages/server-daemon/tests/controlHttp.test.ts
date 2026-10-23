/**
 * SEC N01: the control API's HTTP framing, over real sockets. Each case has
 * one bounded result and the handler runs at most once.
 */
import { createServer, connect, type Server, type Socket } from "node:net";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONTROL_JSON_BYTES,
  MAX_HEADER_BYTES,
  bodyLimitFor,
  hostWithoutPort,
  inspectRequest,
  serveControlHttp,
  type ControlHttpOptions,
} from "../src/controlHttp.js";
import type { HttpRequest, HttpResponse } from "../src/runtime.js";

let srv: Server;
let port = 0;
let seen: HttpRequest[] = [];
let handler: (r: HttpRequest) => Promise<HttpResponse>;
let sni: string | undefined;
let opts: ControlHttpOptions | undefined;

beforeEach(async () => {
  seen = [];
  sni = undefined;
  opts = undefined;
  handler = async (r) => {
    seen.push(r);
    return { status: 200, headers: { "content-type": "text/plain" }, body: "ok" };
  };
  srv = createServer((s) => {
    if (sni) Object.assign(s, { servername: sni });
    serveControlHttp(s, (r) => handler(r), opts);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  port = (srv.address() as { port: number }).port;
});
afterEach(() => new Promise<void>((r) => srv.close(() => r())));

function exchange(raw: string | Buffer | Array<string | Buffer>, wait = 150): Promise<string> {
  return new Promise((resolve) => {
    const parts = Array.isArray(raw) ? raw : [raw];
    const s: Socket = connect(port, "127.0.0.1");
    let out = "";
    s.on("data", (d) => (out += d.toString("latin1")));
    s.on("error", () => {});
    s.on("close", () => resolve(out));
    s.on("connect", async () => {
      for (const p of parts) {
        s.write(p);
        await new Promise((r) => setTimeout(r, 20));
      }
      setTimeout(() => s.destroy(), wait);
    });
  });
}

const status = (out: string) => Number(/^HTTP\/1\.1 (\d{3})/.exec(out)?.[1] ?? 0);
const post = (extra = "", body = "x", host = "box.test") =>
  `POST /api/x HTTP/1.1\r\nHost: ${host}\r\n${extra}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

describe("one dispatch per request", () => {
  it("a byte arriving while the handler is pending does not run it again (E02)", async () => {
    let calls = 0;
    handler = async () => {
      calls++;
      return new Promise<HttpResponse>(() => {});
    };
    await exchange([post(), "y"]);
    expect(calls).toBe(1);
  });

  it("a pipelined second request is never dispatched", async () => {
    const out = await exchange(post() + post("", "second"));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body.toString()).toBe("x");
    expect(out).toMatch(/Connection: close/i);
  });

  it("answers a normal request with the handler's response", async () => {
    const out = await exchange("GET /api/health HTTP/1.1\r\nHost: box.test\r\n\r\n");
    expect(status(out)).toBe(200);
    expect(out).toMatch(/content-length: 2/i);
    expect(out.endsWith("ok")).toBe(true);
    expect(seen[0]).toMatchObject({ method: "GET", path: "/api/health" });
  });
});

describe("ambiguous framing is refused before any handler", () => {
  const cases: Array<[string, string, number]> = [
    ["duplicate Host", "GET / HTTP/1.1\r\nHost: a.test\r\nHost: b.test\r\n\r\n", 400],
    ["missing Host", "GET / HTTP/1.1\r\n\r\n", 400],
    ["duplicate Content-Length", "POST / HTTP/1.1\r\nHost: a.test\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx", 400],
    ["conflicting Content-Length", "POST / HTTP/1.1\r\nHost: a.test\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nxx", 400],
    ["Content-Length with a sign", "POST / HTTP/1.1\r\nHost: a.test\r\nContent-Length: +1\r\n\r\nx", 400],
    ["TE and CL together", "POST / HTTP/1.1\r\nHost: a.test\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", 400],
    ["chunked body", "POST / HTTP/1.1\r\nHost: a.test\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n\r\n", 400],
    ["duplicate Authorization", "GET / HTTP/1.1\r\nHost: a.test\r\nAuthorization: Flagship-Session a\r\nAuthorization: Flagship-Session b\r\n\r\n", 400],
    ["obsolete line folding", "GET / HTTP/1.1\r\nHost: a.test\r\nX-A: 1\r\n  folded\r\n\r\n", 400],
    ["bare LF line ending", "GET / HTTP/1.1\nHost: a.test\n\n", 400],
    ["absolute-form target", "GET http://evil.test/ HTTP/1.1\r\nHost: a.test\r\n\r\n", 400],
    ["protocol-relative target", "GET //evil.test/ HTTP/1.1\r\nHost: a.test\r\n\r\n", 400],
    ["space in the target", "GET /a b HTTP/1.1\r\nHost: a.test\r\n\r\n", 400],
    ["NUL in a header", "GET / HTTP/1.1\r\nHost: a.test\r\nX-A: a\u0000b\r\n\r\n", 400],
    ["junk Host", "GET / HTTP/1.1\r\nHost: a.test/evil\r\n\r\n", 400],
    ["HTTP/0.9 request", "GET /\r\n\r\n", 400],
  ];
  it.each(cases)("%s", async (_name, raw, want) => {
    const out = await exchange(raw);
    expect(status(out)).toBe(want);
    expect(seen).toHaveLength(0);
  });
});

describe("limits", () => {
  it("answers 431 for headers over the cap", async () => {
    const out = await exchange(`GET / HTTP/1.1\r\nHost: a.test\r\nX-Big: ${"a".repeat(MAX_HEADER_BYTES + 100)}\r\n\r\n`);
    expect(status(out)).toBe(431);
    expect(seen).toHaveLength(0);
  });

  it("answers 413 for a declared body over the route's cap, without reading it", async () => {
    const out = await exchange(`POST /api/x HTTP/1.1\r\nHost: a.test\r\nContent-Length: ${CONTROL_JSON_BYTES + 1}\r\n\r\n`);
    expect(status(out)).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("accepts a body at the cap and gives upload routes their own ceiling", async () => {
    const out = await exchange(post("", "a".repeat(CONTROL_JSON_BYTES)), 500);
    expect(status(out)).toBe(200);
    expect(bodyLimitFor("/api/x")).toBe(CONTROL_JSON_BYTES);
    expect(bodyLimitFor("/api/screens/server-archive/restore/1/chunk?offset=0")).toBeGreaterThan(4 * 1024 * 1024);
    expect(bodyLimitFor("/api/llm/sessions/s/message")).toBeGreaterThan(CONTROL_JSON_BYTES);
  });

  it("a request cut off mid-body is not dispatched", async () => {
    await exchange("POST /api/x HTTP/1.1\r\nHost: a.test\r\nContent-Length: 10\r\n\r\nabc");
    expect(seen).toHaveLength(0);
  });
});

describe("headers the handler sees", () => {
  it("drops forwarding headers and anything the Connection header nominates", async () => {
    await exchange(
      "GET / HTTP/1.1\r\nHost: a.test\r\nConnection: close, X-Secret\r\nX-Secret: s\r\nX-Forwarded-For: 1.2.3.4\r\nForwarded: for=1.2.3.4\r\nX-Real-IP: 9.9.9.9\r\nAuthorization: Flagship-Session t\r\n\r\n",
    );
    const h = seen[0]!.headers;
    expect(h["x-secret"]).toBeUndefined();
    expect(h["x-forwarded-for"]).toBeUndefined();
    expect(h["forwarded"]).toBeUndefined();
    expect(h["x-real-ip"]).toBeUndefined();
    expect(h["authorization"]).toBe("Flagship-Session t");
  });

  it("matches Host to the connection's server name", async () => {
    sni = "box.example";
    expect(status(await exchange("GET / HTTP/1.1\r\nHost: box.example:443\r\n\r\n"))).toBe(200);
    expect(status(await exchange("GET / HTTP/1.1\r\nHost: other.example\r\n\r\n"))).toBe(421);
    expect(seen).toHaveLength(1);
  });
});

describe("responses", () => {
  it("HEAD gets the length and no body; the handler's own framing headers are ignored", async () => {
    handler = async () => ({ status: 200, headers: { "Content-Length": "999", Connection: "keep-alive", "Transfer-Encoding": "chunked" }, body: "hello" });
    const out = await exchange("HEAD / HTTP/1.1\r\nHost: a.test\r\n\r\n");
    expect(out).toMatch(/content-length: 5/i);
    expect(out).not.toMatch(/999|chunked|keep-alive/i);
    expect(out.endsWith("\r\n\r\n")).toBe(true);
  });

  it("streams a large body with its declared length", async () => {
    const data = Buffer.alloc(300_000, 7);
    handler = async () => ({ status: 200, body: "", stream: { length: data.length, open: () => Readable.from([data]) } });
    const out = await exchange("GET / HTTP/1.1\r\nHost: a.test\r\n\r\n", 400);
    expect(out).toMatch(/content-length: 300000/i);
    expect(out.length - out.indexOf("\r\n\r\n") - 4).toBe(300_000);
  });

  it("a throwing handler gives a generic 500 with no message", async () => {
    handler = async () => {
      throw new Error("secret detail");
    };
    const out = await exchange("GET / HTTP/1.1\r\nHost: a.test\r\n\r\n");
    expect(status(out)).toBe(500);
    expect(out).not.toMatch(/secret detail/);
  });

  it("a header value with CR/LF in the handler's response cannot split the response", async () => {
    handler = async () => ({ status: 200, headers: { "x-a": "v\r\nSet-Cookie: pwn=1" }, body: "" });
    const out = await exchange("GET / HTTP/1.1\r\nHost: a.test\r\n\r\n");
    expect(out).not.toMatch(/pwn=1/);
  });
});

describe("WebSocket upgrades", () => {
  const upgrade = "GET /ws HTTP/1.1\r\nHost: a.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n";

  it("hands the socket to the hook, with the head buffer", async () => {
    let got: { path: string; method: string } | null = null;
    opts = {
      onUpgrade: ({ socket, path, method }) => {
        got = { path, method };
        socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        return true;
      },
    };
    const out = await exchange(upgrade);
    expect(status(out)).toBe(101);
    expect(got).toEqual({ path: "/ws", method: "GET" });
    expect(seen).toHaveLength(0);
  });

  it("answers 400 when the hook declines or none is installed, and for other protocols", async () => {
    opts = { onUpgrade: () => false };
    expect(status(await exchange(upgrade))).toBe(400);
    opts = undefined;
    expect(status(await exchange(upgrade))).toBe(400);
    opts = { onUpgrade: () => true };
    expect(status(await exchange("GET / HTTP/1.1\r\nHost: a.test\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\n"))).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe("pure checks", () => {
  it("inspectRequest and hostWithoutPort", () => {
    expect(inspectRequest(["Host", "a.test"], "/x", null)).toBeNull();
    expect(inspectRequest(["Host", "a.test", "Accept", "a", "Accept", "b"], "/x", null)).toBeNull();
    expect(inspectRequest(["Host", "a.test", "host", "b.test"], "/x", null)?.status).toBe(400);
    expect(hostWithoutPort("Box.Example:8443")).toBe("box.example");
    expect(hostWithoutPort("[::1]:443")).toBe("[::1]");
    expect(hostWithoutPort("a b")).toBeNull();
  });
});
