import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { parseHttpHost, startProxyServer, startTcpForwarder, type ProxyDeps, type ProxyServerHandle } from "../../src/egress/proxy.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A plain TCP "upstream" that records what it receives and answers. */
async function upstream(reply = "UPSTREAM-OK"): Promise<{ port: number; received: () => Buffer }> {
  let got = Buffer.alloc(0);
  const srv: Server = createServer((s) => {
    s.on("data", (d) => {
      got = Buffer.concat([got, d]);
      s.write(reply);
    });
    s.on("error", () => {});
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
  return { port: (srv.address() as AddressInfo).port, received: () => got };
}

async function proxy(kind: "tls" | "http", deps: ProxyDeps): Promise<number> {
  for (let i = 0; i < 5; i++) {
    const port = 20000 + Math.floor(Math.random() * 30000);
    try {
      const h: ProxyServerHandle = await startProxyServer(deps, kind, "127.0.0.1", port);
      cleanups.push(() => h.close());
      return port;
    } catch {
      /* port taken; try another */
    }
  }
  throw new Error("no free port");
}

function rawExchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const s: Socket = connect({ host: "127.0.0.1", port });
    let out = "";
    s.on("connect", () => s.write(payload));
    s.on("data", (d) => {
      out += d.toString();
      if (out.includes("UPSTREAM-OK")) s.destroy();
    });
    s.on("close", () => resolve(out));
    s.on("error", () => resolve(out));
  });
}

function tlsHello(port: number, servername: string): Promise<void> {
  return new Promise((resolve) => {
    const s = tlsConnect({ host: "127.0.0.1", port, servername, rejectUnauthorized: false });
    s.on("error", () => resolve());
    s.on("close", () => resolve());
    setTimeout(() => {
      s.destroy();
      resolve();
    }, 500);
  });
}

describe("HTTP Host parsing", () => {
  it("reads the Host header and drops :80", () => {
    expect(parseHttpHost("GET / HTTP/1.1\r\nHost: deb.debian.org\r\nAccept: */*")).toBe("deb.debian.org");
    expect(parseHttpHost("GET /x HTTP/1.0\r\nhost:   deb.debian.org:80  ")).toBe("deb.debian.org");
  });
  it("refuses a missing, doubled or odd Host, other ports and non-HTTP heads", () => {
    expect(parseHttpHost("GET / HTTP/1.1\r\nAccept: */*")).toBeNull();
    expect(parseHttpHost("GET / HTTP/1.1\r\nHost: a.com\r\nHost: b.com")).toBeNull();
    expect(parseHttpHost("GET / HTTP/1.1\r\nHost: a.com:8080")).toBeNull();
    expect(parseHttpHost("GET / HTTP/1.1\r\nHost: a b.com")).toBeNull();
    expect(parseHttpHost("\u0016\u0003\u0001 tls")).toBeNull();
  });
});

describe("TLS proxy (SNI)", () => {
  it("splices an allowed ClientHello to the SNI host, by name", async () => {
    const up = await upstream();
    const dialed: Array<[string, number]> = [];
    const resolved: string[] = [];
    const port = await proxy("tls", {
      allow: (_src, host) => host === "api.github.com",
      resolve: async (h) => {
        resolved.push(h);
        return ["140.82.112.5"];
      },
      dial: (a, p) => {
        dialed.push([a, p]);
        return connect({ host: "127.0.0.1", port: up.port });
      },
    });
    await tlsHello(port, "api.github.com");
    expect(resolved).toEqual(["api.github.com"]);
    expect(dialed).toEqual([["140.82.112.5", 443]]);
    expect(up.received()[0]).toBe(0x16);
  });

  it("drops a denied SNI without dialing", async () => {
    const denied: Array<string | null> = [];
    let dialed = 0;
    const port = await proxy("tls", {
      allow: async (_src, host) => host === "api.github.com",
      dial: () => {
        dialed++;
        return connect({ host: "127.0.0.1", port: 9 });
      },
      onDenied: (_s, h) => denied.push(h),
    });
    await tlsHello(port, "evil.example.com");
    expect(dialed).toBe(0);
    expect(denied).toEqual(["evil.example.com"]);
  });

  it("drops a ClientHello with no SNI, and plain text", async () => {
    const denied: Array<string | null> = [];
    const port = await proxy("tls", { allow: () => true, onDenied: (_s, h) => denied.push(h) });
    await rawExchange(port, "GET / HTTP/1.1\r\nHost: api.github.com\r\n\r\n");
    expect(denied).toEqual([null]);
  });

  it("refuses an allowed name that resolves to a private address", async () => {
    let dialed = 0;
    const denied: Array<string | null> = [];
    const port = await proxy("tls", {
      allow: () => true,
      resolve: async () => ["127.0.0.1", "192.168.1.1"],
      dial: () => {
        dialed++;
        return connect({ host: "127.0.0.1", port: 9 });
      },
      onDenied: (_s, h) => denied.push(h),
    });
    await tlsHello(port, "rebind.example.com");
    expect(dialed).toBe(0);
    expect(denied).toEqual(["rebind.example.com"]);
  });
});

describe("HTTP proxy (Host)", () => {
  it("forwards an allowed request head unchanged to the Host, port 80", async () => {
    const up = await upstream();
    const dialed: Array<[string, number]> = [];
    const port = await proxy("http", {
      allow: (_s, h) => h === "deb.debian.org",
      resolve: async () => ["151.101.2.132"],
      dial: (a, p) => {
        dialed.push([a, p]);
        return connect({ host: "127.0.0.1", port: up.port });
      },
    });
    const head = "GET /debian/dists/trixie/InRelease HTTP/1.1\r\nHost: deb.debian.org\r\n\r\n";
    const out = await rawExchange(port, head);
    expect(out).toContain("UPSTREAM-OK");
    expect(dialed).toEqual([["151.101.2.132", 80]]);
    expect(up.received().toString()).toBe(head);
  });

  it("answers 403 for a denied Host and never dials", async () => {
    let dialed = 0;
    const port = await proxy("http", {
      allow: (_s, h) => h === "deb.debian.org",
      dial: () => {
        dialed++;
        return connect({ host: "127.0.0.1", port: 9 });
      },
    });
    const out = await rawExchange(port, "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n");
    expect(out).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    expect(dialed).toBe(0);
  });
});

describe("data-port forwarder", () => {
  it("forwards accepted sources and drops the rest", async () => {
    const up = await upstream("PG");
    const port = 20000 + Math.floor(Math.random() * 30000);
    let allow = true;
    const h = await startTcpForwarder("127.0.0.1", port, { host: "127.0.0.1", port: up.port }, () => allow);
    cleanups.push(() => h.close());
    const ask = () =>
      new Promise<string>((resolve) => {
        const s = connect({ host: "127.0.0.1", port });
        let out = "";
        s.on("connect", () => s.write("hello"));
        s.on("data", (d) => {
          out += d.toString();
          s.destroy();
        });
        s.on("close", () => resolve(out));
        s.on("error", () => resolve(out));
      });
    expect(await ask()).toBe("PG");
    allow = false;
    expect(await ask()).toBe("");
  });
});
