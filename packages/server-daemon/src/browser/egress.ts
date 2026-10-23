/**
 * Where the app browser's traffic may go (SECURITY-HARDENING-PLAN.md 10.4, SEC-BROWSER-002). The judge
 * decides each request on what CDP shows; this decides where the bytes really go.
 *
 *   - Every app's browser context gets its own pinning proxy (`Target.createBrowserContext` takes a
 *     `proxyServer`), fed only with the addresses the judge approved for THAT app: an approval for one
 *     app never opens a host to another, and a name is never resolved again between the judge's check
 *     and the connection (DNS rebinding).
 *   - Chromium's own default proxy is one with no approvals (every request refused), its resolver is
 *     switched off (`MAP * ~NOTFOUND`, no DNS-over-HTTPS, no prefetch) and QUIC and non-proxied WebRTC
 *     are off, so nothing leaves around the proxies.
 */
import { classifyAddress, type AddressClass } from "@flagship/protocol";
import { PinningProxy } from "./pinningProxy.js";

const NEVER: AddressClass[] = ["loopback", "link-local", "metadata", "multicast", "reserved", "invalid"];

export interface ServiceProxiesOptions {
  /** The address the proxies listen on, which Chromium must reach (loopback, or the browser network's gateway). */
  listenHost?: string;
  /** Who may use a proxy, by connecting address. Default: loopback only. */
  acceptFrom?: (remoteAddress: string) => boolean;
  /** This server's own addresses: never connected to, whatever was approved. */
  protectedAddresses?: () => string[];
  dial?: (address: string, port: number) => { host: string; port: number };
  ttlMs?: number;
  /** A fixed port for the deny-all proxy, which Chromium's launch flags name (0: any). */
  denyPort?: number;
}

export class ServiceProxies {
  private readonly proxies = new Map<string, { proxy: PinningProxy; url: string }>();
  private readonly pending = new Map<string, Promise<{ proxy: PinningProxy; url: string }>>();
  private deny: { proxy: PinningProxy; url: string } | null = null;

  constructor(private readonly o: ServiceProxiesOptions = {}) {}

  private make(): PinningProxy {
    return new PinningProxy({
      forbidden: (a) => NEVER.includes(classifyAddress(a)) || (this.o.protectedAddresses?.() ?? []).includes(a),
      ...(this.o.acceptFrom ? { acceptFrom: this.o.acceptFrom } : {}),
      ...(this.o.dial ? { dial: this.o.dial } : {}),
      ...(this.o.ttlMs ? { ttlMs: this.o.ttlMs } : {}),
    });
  }

  private async open(proxy: PinningProxy, fixedPort = 0): Promise<{ proxy: PinningProxy; url: string }> {
    const host = this.o.listenHost ?? "127.0.0.1";
    const port = await proxy.listen(fixedPort, host);
    return { proxy, url: `http://${host.includes(":") ? `[${host}]` : host}:${port}` };
  }

  /** The proxy with no approvals at all: Chromium's default, for anything outside an app's context. */
  async denyAll(): Promise<string> {
    this.deny ??= await this.open(this.make(), this.o.denyPort ?? 0);
    return this.deny.url;
  }

  /** The proxy for one app's context, started on first use. */
  async proxyFor(serviceId: string): Promise<string> {
    const have = this.proxies.get(serviceId);
    if (have) return have.url;
    let p = this.pending.get(serviceId);
    if (!p) {
      p = this.open(this.make());
      this.pending.set(serviceId, p);
    }
    const made = await p;
    this.pending.delete(serviceId);
    this.proxies.set(serviceId, made);
    return made.url;
  }

  /** The judge approved `host` at these addresses for this app. */
  allow(serviceId: string, host: string, addresses: string[]): void {
    this.proxies.get(serviceId)?.proxy.allow(host, addresses);
  }

  /** The app's browser access ended: its proxy stops and forgets everything. */
  async close(serviceId: string): Promise<void> {
    const p = this.proxies.get(serviceId);
    this.proxies.delete(serviceId);
    if (p) {
      p.proxy.clear();
      await p.proxy.close();
    }
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.proxies.keys()]) await this.close(id);
    if (this.deny) await this.deny.proxy.close();
    this.deny = null;
  }
}

/** The Chromium flags that leave no way out except the proxies. `denyProxyUrl` from {@link ServiceProxies.denyAll}. */
export function chromiumEgressFlags(denyProxyUrl: string): string[] {
  return [
    `--proxy-server=${denyProxyUrl}`,
    // Loopback is not exempt: it goes to the proxy too, which refuses it.
    "--proxy-bypass-list=<-loopback>",
    // Chromium resolves nothing itself: the proxy is given names, and anything else fails. The proxies'
    // own address is excluded, or Chromium could not reach them either.
    `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${new URL(denyProxyUrl).hostname.replace(/^\[|\]$/g, "")}`,
    "--disable-features=DnsOverHttps,NetworkPrediction",
    "--dns-prefetch-disable",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--no-pings",
  ];
}

/** The session a "session" grant lives in: the app's browser context, until it is disposed. */
export const contextSession = (serviceId: string): string => `ctx:${serviceId}`;
