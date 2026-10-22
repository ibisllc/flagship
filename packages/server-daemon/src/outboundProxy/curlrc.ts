/**
 * A curl config naming the owner's proxy, for the box's shell scripts that
 * run outside the daemon (the health timer keeps reporting while the daemon is
 * down, so it can't use the daemon's loopback bridge). Mode 0600 under the
 * data dir: it holds the proxy password when there is one.
 */
import { removeDurable, writeFileDurable } from "../durableFile.js";
import type { OutboundProxySetting } from "./outboundNet.js";

export const OUTBOUND_PROXY_CURLRC = "outbound-proxy.curlrc";

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function buildCurlrc(setting: OutboundProxySetting): string {
  const u = setting.upstream;
  const host = u.host.includes(":") ? `[${u.host}]` : u.host;
  const scheme = u.kind === "socks5" ? "socks5h" : "http";
  const lines = [`proxy = ${quote(`${scheme}://${host}:${u.port}`)}`];
  if (u.username !== undefined && u.password !== undefined) {
    lines.push(`proxy-user = ${quote(`${u.username}:${u.password}`)}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function syncCurlrc(path: string, setting: OutboundProxySetting | null): Promise<void> {
  if (setting) await writeFileDurable(path, buildCurlrc(setting), 0o600);
  else await removeDurable(path);
}
