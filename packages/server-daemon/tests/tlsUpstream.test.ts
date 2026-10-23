import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listenForFrontend, parseFrontendHeader } from "../src/tlsUpstream.js";

describe("the frontend's header line", () => {
  it("accepts the shape the frontend sends and nothing else", () => {
    expect(parseFrontendHeader('{"sni":"chess.home.alice.flagship.services","alpn":"http/1.1","tls":"1.3"}')).toEqual({ sni: "chess.home.alice.flagship.services", alpn: "http/1.1", tls: "1.3" });
    expect(parseFrontendHeader('{"sni":"","alpn":"","tls":"1.2"}')).not.toBeNull();
    for (const bad of ["", "not json", "{}", '{"sni":1,"alpn":"","tls":""}', '{"sni":"A B","alpn":"","tls":""}', `{"sni":"${"a".repeat(300)}","alpn":"","tls":""}`, '{"sni":"x","alpn":"x","tls":"1.2.3.4.5.6"}']) {
      expect(parseFrontendHeader(bad), bad).toBeNull();
    }
  });
});

describe("listening for the frontend", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "tlsu-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const send = (path: string, data: string | Buffer) =>
    new Promise<Socket>((resolve) => {
      const s = connect(path, () => {
        s.write(data);
        resolve(s);
      });
    });

  it("hands a handler a stream with servername and alpnProtocol set, and the bytes after the header intact", async () => {
    const path = join(dir, "u.sock");
    const got = new Promise<{ sni: string; alpn: unknown; body: string }>((resolve) => {
      void listenForFrontend(path, (s: TLSSocket) => {
        let body = "";
        s.on("data", (d) => {
          body += d.toString();
          if (body.includes("END")) resolve({ sni: s.servername as string, alpn: s.alpnProtocol, body });
        });
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    const c = await send(path, '{"sni":"home.a.flagship.services","alpn":"http/1.1","tls":"1.3"}\nGET / HTTP/1.1\r\nEND');
    const r = await got;
    expect(r).toMatchObject({ sni: "home.a.flagship.services", alpn: "http/1.1" });
    expect(r.body).toBe("GET / HTTP/1.1\r\nEND");
    c.destroy();
    expect(statSync(path).mode & 0o777).toBe(0o660);
  });

  it("gives the frontend's group both the socket and the directory it sits in", async (ctx) => {
    // systemd re-applies RuntimeDirectory= ownership before each Exec command, so the group on the
    // directory has to come from the daemon itself or the frontend cannot reach the socket.
    const sub = join(dir, "run");
    mkdirSync(sub, { mode: 0o750 });
    const path = join(sub, "u.sock");
    const gid = execFileSync("id", ["-G"], { encoding: "utf8" }).trim().split(/\s+/).map(Number).find((g) => g !== statSync(sub).gid);
    if (gid === undefined) return ctx.skip();
    const server = await listenForFrontend(path, () => {}, String(gid));
    expect(statSync(sub).gid).toBe(gid);
    expect(statSync(path).gid).toBe(gid);
    expect(statSync(path).mode & 0o777).toBe(0o660);
    server.close();
  });

  it("drops a connection with a bad or oversize header without calling the handler", async () => {
    const path = join(dir, "u.sock");
    let called = 0;
    await listenForFrontend(path, () => void called++);
    for (const payload of ["garbage\n", Buffer.alloc(4096, 0x41)]) {
      const c = await send(path, payload);
      await new Promise<void>((r) => c.on("close", () => r()));
    }
    expect(called).toBe(0);
  });
});
