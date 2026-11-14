// Getting a headless box online and saying exactly why it could not (docs/retail-box-setup.md §15
// "Network"). Supported: Ethernet with DHCP; WPA2/WPA3-Personal Wi-Fi sent over Bluetooth. Not
// supported, said up front: captive portals, 802.1X enterprise Wi-Fi, networks blocking outbound
// 443. The box reports the first failing step before the Bluetooth session closes.

import { promises as dns } from "node:dns";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import type { NetworkFailure, WiFiConfig, WifiNetwork, WifiSecurity } from "@flagship/protocol";
import type { CommandRunner } from "../serviceRunner.js";
import { writeFileDurable } from "../durableFile.js";

export type WifiJoin = { ok: true } | { ok: false; failure: "wrong-password" | "network-not-found" | "unsupported-security" };

export interface NetworkProbes {
  /** Carrier on a wired port. */
  ethernetLink(): Promise<boolean>;
  scanWifi(): Promise<WifiNetwork[]>;
  joinWifi(cfg: WiFiConfig, seen?: WifiNetwork): Promise<WifiJoin>;
  /** A routable address on the interface the box is using (DHCP or RA). */
  hasAddress(via: "ethernet" | "wifi"): Promise<boolean>;
  resolves(host: string): Promise<boolean>;
  /** An HTTP probe of the control apex: "clear", "portal" (something answered in its place) or "unreachable". */
  portalCheck(): Promise<"clear" | "portal" | "unreachable">;
  /** TCP to the relay's passthrough port. */
  relayReachable(): Promise<boolean>;
}

export type NetworkResult = { ok: true; via: "ethernet" | "wifi" } | { ok: false; via: "ethernet" | "wifi"; failure: NetworkFailure };

/**
 * Brings the box online and diagnoses in order: link (or join), address, DNS, portal, relay. With
 * no Wi-Fi details the box uses Ethernet; with them it joins that network even if a cable is in.
 */
export async function connectAndDiagnose(
  probes: NetworkProbes,
  wifi: WiFiConfig | null,
  hosts: { control: string; relay: string },
): Promise<NetworkResult> {
  const via = wifi ? "wifi" : "ethernet";
  const failed = (failure: NetworkFailure): NetworkResult => ({ ok: false, via, failure });
  if (wifi) {
    const visible = await probes.scanWifi().catch(() => [] as WifiNetwork[]);
    const seen = visible.find((n) => n.ssid === wifi.ssid);
    if (seen && (seen.security === "enterprise" || seen.security === "wep")) return failed("unsupported-security");
    const j = await probes.joinWifi(wifi, seen);
    if (!j.ok) return failed(j.failure);
  } else if (!(await probes.ethernetLink())) {
    return failed("no-link");
  }
  if (!(await probes.hasAddress(via))) return failed("no-dhcp");
  if (!(await probes.resolves(hosts.control)) || !(await probes.resolves(hosts.relay))) return failed("no-dns");
  const portal = await probes.portalCheck();
  if (portal === "portal") return failed("captive-portal");
  if (portal === "unreachable" || !(await probes.relayReachable())) return failed("relay-unreachable");
  return { ok: true, via };
}

/** `nmcli -t -f SSID,SECURITY,SIGNAL,FREQ dev wifi list` (terse output, `\:` escapes a colon). */
export function parseNmcliWifiList(out: string): WifiNetwork[] {
  const best = new Map<string, WifiNetwork>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const fields: string[] = [];
    let cur = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (c === "\\" && i + 1 < line.length) cur += line[++i];
      else if (c === ":") {
        fields.push(cur);
        cur = "";
      } else cur += c;
    }
    fields.push(cur);
    const [ssid, sec, signal, freq] = fields;
    if (!ssid || fields.length < 4) continue;
    const mhz = parseInt(freq ?? "", 10);
    const net: WifiNetwork = {
      ssid,
      security: securityOf(sec ?? ""),
      signal: Math.max(0, Math.min(100, parseInt(signal ?? "0", 10) || 0)),
      band: mhz >= 5925 ? "6" : mhz >= 4900 ? "5" : "2.4",
    };
    const prev = best.get(ssid);
    if (!prev || prev.signal < net.signal) best.set(ssid, net);
  }
  return [...best.values()].sort((a, b) => b.signal - a.signal);
}

function securityOf(s: string): WifiSecurity {
  const u = s.toUpperCase();
  if (!u || u === "--") return "open";
  if (u.includes("802.1X")) return "enterprise";
  if (u.includes("WEP")) return "wep";
  const wpa3 = u.includes("SAE") || u.includes("WPA3");
  const wpa2 = u.includes("WPA2") || u.includes("WPA1") || /\bWPA\b/.test(u);
  return wpa3 && wpa2 ? "wpa2-wpa3" : wpa3 ? "wpa3" : "wpa2";
}

/** Maps `nmcli dev wifi connect` failures to what the phone shows. */
export function nmcliJoinFailure(stderr: string): "wrong-password" | "network-not-found" | "unsupported-security" {
  const s = stderr.toLowerCase();
  if (s.includes("no network with ssid")) return "network-not-found";
  if (s.includes("802.1x") || s.includes("key-mgmt")) return "unsupported-security";
  return "wrong-password";
}

export const NM_CONNECTION_ID = "flagship-claim-wifi";
const NM_KEYFILE_PATH = "/etc/NetworkManager/system-connections/flagship-claim-wifi.nmconnection";

const keyfileEscape = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/^ /, "\\s");

/**
 * A NetworkManager keyfile for the network the phone sent. Written 0600 and loaded by path, so the
 * password never appears on a command line (`/proc/<pid>/cmdline` is world-readable). The SSID is
 * written as its bytes, which takes any name.
 */
export function nmKeyfile(cfg: WiFiConfig, security?: WifiSecurity): string {
  const ssidBytes = [...new TextEncoder().encode(cfg.ssid)].join(";") + ";";
  const lines = ["[connection]", `id=${NM_CONNECTION_ID}`, "type=wifi", "autoconnect=true", "", "[wifi]", "mode=infrastructure", `ssid=${ssidBytes}`];
  if (cfg.psk) lines.push("", "[wifi-security]", `key-mgmt=${security === "wpa3" ? "sae" : "wpa-psk"}`, `psk=${keyfileEscape(cfg.psk)}`);
  lines.push("", "[ipv4]", "method=auto", "", "[ipv6]", "method=auto", "");
  return lines.join("\n");
}

/**
 * Real probes. Wi-Fi goes through `nmcli` here; which Wi-Fi stack the metal image ships
 * (NetworkManager, iwd or wpa_supplicant under systemd-networkd) is a phase 2 decision per SKU,
 * and only `scanWifi`/`joinWifi` change with it.
 */
export function systemNetworkProbes(
  cmd: CommandRunner,
  hosts: { control: string; relay: string; relayPort?: number; keyfileDir?: string },
): NetworkProbes {
  const capture = async (c: string, args: string[]) => {
    if (!cmd.capture) throw new Error("no capture");
    return cmd.capture(c, args, { timeoutMs: 45_000 });
  };
  const ifaces = (want: "ethernet" | "wifi") =>
    Object.entries(networkInterfaces()).filter(([name]) => (want === "wifi" ? /^wl/.test(name) : /^(en|eth)/.test(name)));
  return {
    async ethernetLink() {
      try {
        const { stdout } = await capture("ip", ["-o", "link", "show", "up"]);
        return stdout.split("\n").some((l) => /^\d+: (en|eth)\S*:.*LOWER_UP/.test(l));
      } catch {
        return ifaces("ethernet").length > 0;
      }
    },
    async scanWifi() {
      const { stdout } = await capture("nmcli", ["-t", "-f", "SSID,SECURITY,SIGNAL,FREQ", "dev", "wifi", "list", "--rescan", "yes"]);
      return parseNmcliWifiList(stdout);
    },
    async joinWifi(cfg, seen) {
      const path = hosts.keyfileDir ? `${hosts.keyfileDir}/flagship-claim-wifi.nmconnection` : NM_KEYFILE_PATH;
      try {
        await writeFileDurable(path, nmKeyfile(cfg, seen?.security), 0o600);
        await capture("nmcli", ["connection", "load", path]);
        await capture("nmcli", ["--wait", "30", "connection", "up", "id", NM_CONNECTION_ID]);
        return { ok: true };
      } catch (e) {
        return { ok: false, failure: nmcliJoinFailure(String((e as { stderr?: string }).stderr ?? (e as Error).message)) };
      }
    },
    async hasAddress(via) {
      return ifaces(via).some(([, addrs]) => (addrs ?? []).some((a) => !a.internal && (a.family === "IPv4" ? !a.address.startsWith("169.254.") : !a.address.toLowerCase().startsWith("fe80"))));
    },
    async resolves(host) {
      try {
        await dns.lookup(host);
        return true;
      } catch {
        return false;
      }
    },
    async portalCheck() {
      try {
        const r = await fetch(`http://${hosts.control}/api/health`, { redirect: "manual", signal: AbortSignal.timeout(8_000) });
        if (r.status >= 300 && r.status < 400) {
          const loc = r.headers.get("location") ?? "";
          return loc.startsWith(`https://${hosts.control}/`) ? "clear" : "portal";
        }
        if (r.status !== 200) return "portal";
        const body = await r.text();
        try {
          JSON.parse(body);
          return "clear";
        } catch {
          return "portal";
        }
      } catch {
        return "unreachable";
      }
    },
    relayReachable() {
      return new Promise((resolve) => {
        const s = connect({ host: hosts.relay, port: hosts.relayPort ?? 443, timeout: 8_000 });
        const done = (ok: boolean) => {
          s.destroy();
          resolve(ok);
        };
        s.once("connect", () => done(true));
        s.once("timeout", () => done(false));
        s.once("error", () => done(false));
      });
    },
  };
}
