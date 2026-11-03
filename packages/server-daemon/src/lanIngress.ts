/**
 * Which connections reached the box's TLS server through LAN-direct (docs/data-sovereignty.md, "LAN only").
 *
 * The relay tunnel and the LAN listener both feed the same loopback TLS server, so the request itself can't tell
 * them apart, and no header a client sends may decide it. Instead the LAN listener records the loopback source port
 * of each connection it opens to the TLS server while that connection lives; the TLS server (or flagship-ingress,
 * which passes the port it accepted from in its header line) looks the port up. A port is held by the listener's own
 * socket while it is recorded, so nothing else on the box can connect from it.
 */
import type { HttpRequest, HttpResponse } from "./runtime.js";

export class LanIngressPorts {
  private readonly ports = new Set<number>();

  /** Record a LAN connection's loopback source port; the returned function forgets it. */
  add(port: number): () => void {
    this.ports.add(port);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.ports.delete(port);
    };
  }

  has(port: number): boolean {
    return this.ports.has(port);
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * The loopback source port of a connection to the TLS server: flagship-ingress's `peer` field on its handed-over
 * stream, else the socket's own peer when it is loopback. Null when neither says (an older ingress), which counts as
 * not LAN.
 */
export function ingressPeerPort(socket: { remoteAddress?: string | undefined; remotePort?: number | undefined; frontendPeerPort?: number | undefined }): number | null {
  if (typeof socket.frontendPeerPort === "number") return socket.frontendPeerPort;
  if (socket.remoteAddress && LOOPBACK.has(socket.remoteAddress) && typeof socket.remotePort === "number") return socket.remotePort;
  return null;
}

export function cameViaLan(socket: Parameters<typeof ingressPeerPort>[0], lanPorts: LanIngressPorts): boolean {
  const port = ingressPeerPort(socket);
  return port !== null && lanPorts.has(port);
}

/** `/api/rescue/*` answers only on the LAN: through the relay it is the same 404 as a path the box doesn't have. */
export function refuseRescueOffLan(req: HttpRequest, viaLan: boolean): HttpResponse | null {
  const path = req.path.split("?")[0]!;
  if (viaLan || (path !== "/api/rescue" && !path.startsWith("/api/rescue/"))) return null;
  return { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
}
