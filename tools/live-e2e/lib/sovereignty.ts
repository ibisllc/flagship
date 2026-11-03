/**
 * Pure helpers for the sovereignty lane (lanes/sovereignty.ts, docs/data-sovereignty.md section 7):
 * the egress cut applied on the box (one nft table, counted per rule), its counter parser, and the
 * phone side of a rescue session (request builders and the state readers), so the lane's decisions
 * are unit-tested (tests/sovereignty.test.ts) without a box.
 */
import { randomBytes } from "node:crypto";
import type { OfflineControlAction, OfflineControlOrder, RescueExchange } from "@flagship/protocol";

/** The nft table the cut lives in; deleting it restores the box's egress exactly. */
export const CUT_TABLE = "flagship_sovereignty_cut";

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * The cut, as an `nft -f` script. Host-originated traffic (the OUTPUT hook; app containers go
 * through forward and are dropped by the same rules in the forward hook) may only reach loopback,
 * private ranges (the LAN the phone rescues over: UpCloud's utility network is 10/8), IPv6 link-
 * local/multicast (neighbour discovery) and ULA, and the runner's SSH client, and only as SSH
 * replies (source port 22). Everything else, the relay tunnel already established included (no
 * conntrack accept on purpose), is dropped and counted. Each rule carries a comment the parser
 * keys on.
 */
export function cutScript(o: { runnerV4: string; sshPort?: number }): string {
  const m = V4.exec(o.runnerV4);
  if (!m || m.slice(1).some((x) => Number(x) > 255)) throw new Error(`not an IPv4 address: ${o.runnerV4}`);
  const port = o.sshPort ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad ssh port ${port}`);
  const rules = (hook: "output" | "forward") => [
    `    ${hook === "output" ? 'oifname "lo" counter accept comment "lo"' : 'iifname "lo" counter accept comment "lo-fwd"'}`,
    `    ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8 } counter accept comment "private${hook === "forward" ? "-fwd" : ""}"`,
    `    ip6 daddr { ::1, fe80::/10, ff00::/8, fc00::/7 } counter accept comment "private6${hook === "forward" ? "-fwd" : ""}"`,
    ...(hook === "output" ? [`    ip daddr ${o.runnerV4} tcp sport ${port} counter accept comment "runner-ssh"`] : []),
    `    meta nfproto ipv4 counter drop comment "drop4${hook === "forward" ? "-fwd" : ""}"`,
    `    meta nfproto ipv6 counter drop comment "drop6${hook === "forward" ? "-fwd" : ""}"`,
  ];
  return [
    `table inet ${CUT_TABLE} {`,
    "  chain out {",
    "    type filter hook output priority -50; policy accept;",
    ...rules("output"),
    "  }",
    "  chain fwd {",
    "    type filter hook forward priority -50; policy accept;",
    ...rules("forward"),
    "  }",
    "}",
    "",
  ].join("\n");
}

/** The shell run on the box (as root) to apply the cut: nft must exist first (installed while the box still has internet). */
export function applyCutCommand(script: string): string {
  const b64 = Buffer.from(script, "utf8").toString("base64");
  return `set -e; command -v nft >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q nftables >/dev/null; ` +
    `nft delete table inet ${CUT_TABLE} 2>/dev/null || true; echo ${b64} | base64 -d | nft -f -; nft list table inet ${CUT_TABLE}`;
}

export const LIFT_CUT_COMMAND = `nft delete table inet ${CUT_TABLE} 2>/dev/null; echo lifted`;
export const LIST_CUT_COMMAND = `nft list table inet ${CUT_TABLE}`;

export interface RuleCounter {
  packets: number;
  bytes: number;
}

/** `nft list table` output → counters per rule comment. */
export function parseCutCounters(text: string): Record<string, RuleCounter> {
  const out: Record<string, RuleCounter> = {};
  for (const line of text.split("\n")) {
    const m = /counter packets (\d+) bytes (\d+).*comment "([^"]+)"/.exec(line);
    if (m) out[m[3]!] = { packets: Number(m[1]), bytes: Number(m[2]) };
  }
  return out;
}

/** What the counters say about the cut between two readings: packets the drop rules caught, and packets that left for the runner (SSH only). */
export function cutDelta(before: Record<string, RuleCounter>, after: Record<string, RuleCounter>): { dropped: number; runnerSsh: number; missing: string[] } {
  const want = ["drop4", "drop6", "runner-ssh"];
  const missing = want.filter((k) => !after[k]);
  const d = (k: string) => (after[k]?.packets ?? 0) - (before[k]?.packets ?? 0);
  return { dropped: d("drop4") + d("drop6") + d("drop4-fwd") + d("drop6-fwd"), runnerSsh: d("runner-ssh"), missing };
}

/** `$SSH_CLIENT` on the box ("<ip> <port> <port>"): the address the runner's SSH arrives from. */
export function parseSshClient(line: string): string | null {
  const ip = line.trim().split(/\s+/)[0] ?? "";
  return V4.test(ip) ? ip : null;
}

export const nonceHex = (): string => randomBytes(16).toString("hex");

/** The session order answering a hello; `certSha256` defaults to the hello's (the phone checked it equals what its TLS saw). */
export function sessionOrderFor(hello: RescueExchange, now: number, certSha256 = hello.certSha256): RescueExchange {
  return { serverDomain: hello.serverDomain, clientNonce: hello.clientNonce, boxNonce: hello.boxNonce, certSha256, issuedAt: now };
}

export function controlOrderFor(o: { serverDomain: string; sessionNonce: string; action: OfflineControlAction; target: string; now: number; nonce?: string }): OfflineControlOrder {
  return { serverDomain: o.serverDomain.toLowerCase(), sessionNonce: o.sessionNonce, action: o.action, target: o.target, nonce: o.nonce ?? nonceHex(), issuedAt: o.now };
}

export function rescueHeaders(token: string): Record<string, string> {
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("a rescue token is 32 bytes of hex");
  return { "x-flagship-rescue": token };
}

/** An app's state in a `/api/rescue/server` answer, or "missing". */
export function appStateIn(server: unknown, serviceId: string): string {
  const apps = (server as { apps?: Array<{ serviceId?: string; state?: string }> } | null)?.apps;
  if (!Array.isArray(apps)) return "missing";
  const a = apps.find((x) => x.serviceId === serviceId);
  return a ? String(a.state ?? "unknown") : "missing";
}

/** The parts of a `.flagship` bundle to fetch, 4 MiB each, from `have` bytes on (resume). */
export function bundleOffsets(total: number, have = 0, part = 4 * 1024 * 1024): number[] {
  if (!Number.isSafeInteger(total) || total < 0 || have < 0 || have > total || part <= 0) throw new Error("bad bundle size");
  const out: number[] = [];
  for (let o = have; o < total; o += part) out.push(o);
  return out;
}
