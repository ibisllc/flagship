#!/usr/bin/env node
// Local preview of the built voi.ci site with signed sample pages (dev/fixture.mjs) and a stand-in for `.com`:
// account keys, the files host, the mailbox and thread routes, and a /qr-pipe that answers "accepted" and, after a
// moment, a peer hello (so the sign-in sheet shows its code). Same CSP as production, adapted to localhost.
//
//   node apps/voici-site/build.mjs && node apps/voici-site/dev/serve.mjs [--port 4173]
//   then open http://127.0.0.1:4173/alice  (also /bruno, /cora, /nobody, /-/about)
//
// startDevServer({port, images}) is what dev/screenshots.mjs (and a headless gym run) call.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OUT, buildSite } from "../build.mjs";
import { M, SAMPLE_USERS, sampleThread, samplePage } from "./fixture.mjs";

const TYPES = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

function wsAccept(key) {
  return createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}
function wsFrame(text) {
  const p = Buffer.from(text);
  const head = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([head, p]);
}

export function startDevServer({ port = 4173, images = {} } = {}) {
  const build = buildSite();
  const now = Date.now();
  const pages = new Map(SAMPLE_USERS.map((u) => [u, samplePage(u, images, now)]));
  const threads = new Map();
  const origin = `http://127.0.0.1:${port}`;
  const devConfig = { origin: "https://voi.ci", host: "voi.ci", apex: `127.0.0.1:${port}`, services: "flagship.services", files: `${origin}/files`, apiBase: origin, secure: false };
  const metaContent = JSON.stringify(devConfig).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const shell = build.shell.replace("<title>", `<meta name="voici-dev" content="${metaContent}">\n<title>`);
  const csp =
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; " +
    `connect-src 'self' ws://127.0.0.1:${port} https://*.flagship.services; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`;
  const headers = { "content-security-policy": csp, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };

  const json = (res, status, v) => {
    res.writeHead(status, { ...headers, "content-type": "application/json" });
    res.end(JSON.stringify(v));
  };
  const read = (req) =>
    new Promise((resolve) => {
      const parts = [];
      req.on("data", (c) => parts.push(c));
      req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const p = url.pathname;
    let m;
    if ((m = /^\/_\/([0-9a-f]{16})\/(.+)$/.exec(p)) && m[1] === build.dir) {
      const f = join(OUT, m[1], m[2]);
      if (!existsSync(f) || !build.files.has(m[2])) return json(res, 404, { error: "not found" });
      res.writeHead(200, { ...headers, "content-type": TYPES[f.slice(f.lastIndexOf("."))] ?? "application/octet-stream" });
      return res.end(readFileSync(f));
    }
    if ((m = /^\/files\/v1\/u\/([a-z0-9-]+)\.json$/.exec(p))) {
      const pg = pages.get(m[1]);
      return pg ? json(res, 200, pg.index) : json(res, 404, { error: "not found" });
    }
    if ((m = /^\/files\/v1\/p\/([0-9a-f]{32})\/([0-9a-f]{64})$/.exec(p))) {
      for (const pg of pages.values()) {
        if (pg.index.pageId === m[1] && pg.pieces.has(m[2])) {
          res.writeHead(200, { ...headers, "content-type": "application/octet-stream" });
          return res.end(Buffer.from(pg.pieces.get(m[2])));
        }
      }
      return json(res, 404, { error: "not found" });
    }
    if ((m = /^\/api\/username\/([a-z0-9-]+)$/.exec(p))) {
      const pg = pages.get(m[1]);
      return pg ? json(res, 200, { ...pg.account, claimedAt: now, accountType: "single", totpEnrolledAt: null }) : json(res, 404, { error: "not found" });
    }
    if (p === "/api/voici/web/send" && req.method === "POST") {
      const env = JSON.parse(await read(req));
      const list = threads.get(env.conv) ?? [];
      list.push({ envelope: env, storedAt: Date.now(), fetchedAt: null, direct: false });
      threads.set(env.conv, list);
      return json(res, 200, { accepted: true });
    }
    if (p === "/api/voici/web/thread" && req.method === "POST") {
      const body = JSON.parse(await read(req));
      if (!threads.has(body.conv) && body.conv === M.derivations.conv) {
        threads.set(body.conv, sampleThread());
      }
      return json(res, 200, { items: threads.get(body.conv) ?? [], next: "" });
    }
    if (p === "/api/voici/reports" && req.method === "POST") return json(res, 200, { ok: true });
    if (p === "/" || p === "/favicon.ico") return json(res, 404, { error: "not found" });
    res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
    res.end(shell);
  });

  const upgraded = new Set();
  server.on("upgrade", (req, socket) => {
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    if (!req.url.startsWith("/qr-pipe/")) return socket.destroy();
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(req.headers["sec-websocket-key"])}\r\n\r\n`);
    socket.write(wsFrame(JSON.stringify({ kind: "accepted" })));
    const phonePk = Buffer.from(createHash("sha256").update("dev-phone").digest()).toString("base64url");
    const t = setTimeout(() => socket.writable && socket.write(wsFrame(JSON.stringify({ kind: "peer-hello", phonePk }))), 1500);
    socket.on("close", () => clearTimeout(t));
    socket.on("error", () => clearTimeout(t));
  });

  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, origin, close: () => new Promise((r) => {
    for (const s of upgraded) s.destroy();
    server.closeAllConnections();
    server.close(r);
  }) })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf("--port");
  const port = i > 0 ? Number(process.argv[i + 1]) : 4173;
  startDevServer({ port }).then(({ origin }) => console.log(`voi.ci preview: ${origin}/alice  ${origin}/bruno  ${origin}/cora  ${origin}/-/about`));
}
