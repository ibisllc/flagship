/**
 * A plain HTTP proxy on the box's loopback that forwards through the owner's
 * proxy (docs/outbound-proxy.md). Child processes (git, npm) only need to
 * speak to a local HTTP proxy, whatever the upstream is: npm can't do SOCKS,
 * and the credentials never land in an environment variable or a config file.
 * Containers can't reach the host's loopback, so apps never see it.
 */
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import type { OutboundNet } from "./outboundNet.js";

export interface BridgeHandle {
  url: string;
  close(): Promise<void>;
}

export async function startOutboundBridge(net: OutboundNet, port = 0): Promise<BridgeHandle> {
  const server: Server = createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("This is a forward proxy; send an absolute URL.");
      return;
    }
    if (target.protocol !== "http:") {
      res.writeHead(400).end("Use CONNECT for https.");
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const up = request(
      {
        host: target.hostname,
        port: Number(target.port) || 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers,
        agent: net.httpAgent(),
      },
      (upRes: IncomingMessage) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502).end("The outbound proxy couldn't make this connection.");
      else res.destroy();
    });
    req.pipe(up);
  });

  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on("error", () => {});
    const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(req.url ?? "");
    const port = m ? Number(m[2]) : 0;
    if (!m || port < 1 || port > 65535) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    net.connectTcp(m[1]!, port).then(
      (up) => {
        up.on("error", () => client.destroy());
        client.on("close", () => up.destroy());
        up.on("close", () => client.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) up.write(head);
        client.pipe(up);
        up.pipe(client);
        up.resume();
      },
      () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  return {
    url: `http://127.0.0.1:${bound}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
