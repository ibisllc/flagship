import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, chmodSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { TLSSocket } from "node:tls";

/**
 * The daemon's side of flagship-tlsd (SECURITY-HARDENING-PLAN.md 6.3). The frontend terminates
 * TLS and hands each decrypted connection to this Unix socket behind one JSON line naming the
 * SNI and the negotiated protocol. The handlers that used to receive a `TLSSocket` get the
 * same stream with `servername` and `alpnProtocol` filled in from that line, and `frontendPeerPort` from its
 * optional `peer`: the loopback port the frontend accepted the connection from (lanIngress.ts).
 */

export interface FrontendHeader {
  sni: string;
  alpn: string;
  tls: string;
  peer?: number;
}

const MAX_HEADER = 2048;

/** Parse the header line; null when it is not the shape the frontend sends. */
export function parseFrontendHeader(line: string): FrontendHeader | null {
  try {
    const j = JSON.parse(line) as Partial<Record<keyof FrontendHeader, unknown>>;
    if (typeof j.sni !== "string" || typeof j.alpn !== "string" || typeof j.tls !== "string") return null;
    if (j.sni.length > 253 || !/^[a-z0-9.*-]*$/.test(j.sni)) return null;
    if (j.alpn.length > 32 || j.tls.length > 8) return null;
    if (j.peer === undefined) return { sni: j.sni, alpn: j.alpn, tls: j.tls };
    if (typeof j.peer !== "number" || !Number.isInteger(j.peer) || j.peer < 1 || j.peer > 65535) return null;
    return { sni: j.sni, alpn: j.alpn, tls: j.tls, peer: j.peer };
  } catch {
    return null;
  }
}

export function listenForFrontend(
  socketPath: string,
  onConnection: (socket: TLSSocket) => void,
  group?: string,
): Promise<Server> {
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = createServer((raw: Socket) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => raw.destroy(), 5000);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > MAX_HEADER) raw.destroy();
        return;
      }
      raw.off("data", onData);
      clearTimeout(timer);
      const header = parseFrontendHeader(buf.subarray(0, nl).toString("utf8"));
      if (!header) {
        raw.destroy();
        return;
      }
      raw.pause();
      const rest = buf.subarray(nl + 1);
      if (rest.length > 0) raw.unshift(rest);
      const s = raw as unknown as TLSSocket & { servername: string; alpnProtocol: string | false; frontendPeerPort?: number };
      s.servername = header.sni;
      s.alpnProtocol = header.alpn === "" ? false : header.alpn;
      if (header.peer !== undefined) s.frontendPeerPort = header.peer;
      (s as unknown as { encrypted: boolean }).encrypted = true;
      onConnection(s);
      raw.resume();
    };
    raw.on("data", onData);
    raw.on("error", () => raw.destroy());
    raw.on("close", () => clearTimeout(timer));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o660);
      // The frontend runs as another user in this group; nothing else may open the socket. The
      // directory's group is set here too: systemd re-applies RuntimeDirectory= ownership before
      // every command it runs, so a chgrp in ExecStartPre is undone before this process starts.
      if (group) execFileSync("chgrp", [group, dirname(socketPath), socketPath]);
      resolve(server);
    });
  });
}
