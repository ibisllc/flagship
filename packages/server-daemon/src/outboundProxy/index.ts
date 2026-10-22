/**
 * Boot wiring for the box's outbound proxy (docs/outbound-proxy.md). Runs
 * before the daemon's first network call, so a box whose recipe names a proxy
 * never reaches Flagship directly from the daemon.
 */
import acme from "acme-client";
import { startOutboundBridge, type BridgeHandle } from "./bridge.js";
import { OUTBOUND_PROXY_CURLRC, syncCurlrc } from "./curlrc.js";
import { buildOutboundProxyHttp, outboundProxySummary, type OutboundProxySummary } from "./http.js";
import { outboundNet as defaultNet, type OutboundNet } from "./outboundNet.js";
import { OutboundProxyStore, settingOf, type OutboundProxyAuthority, type StoredOutboundProxy } from "./store.js";

export { isDirectHost, outboundNet, OutboundNet } from "./outboundNet.js";
export { OUTBOUND_PROXY_PATH, type OutboundProxySummary } from "./http.js";

export interface OutboundProxyRuntime {
  store: OutboundProxyStore;
  net: OutboundNet;
  summary(): OutboundProxySummary;
  /** Record the account's plan from `.com`'s heartbeat reply (Pro gate). */
  setAccountTier(tier: string): void;
  /** Called after every switch (the tunnel reconnects so the hub sees the new path). */
  onChange(fn: () => void): void;
  /** The screens handler; `probeTarget` is the hub. */
  http(probeTarget: () => { host: string; port: number }): ReturnType<typeof buildOutboundProxyHttp>;
}

export async function setUpOutboundProxy(opts: {
  dataDir: string;
  installBlobPath: string;
  authority: OutboundProxyAuthority;
  net?: OutboundNet;
  onLog?: (m: string) => void;
}): Promise<OutboundProxyRuntime> {
  const net = opts.net ?? defaultNet;
  const log = opts.onLog ?? ((m: string) => console.log(m));
  const store = new OutboundProxyStore(`${opts.dataDir}/outbound-proxy.json`, opts.authority, log);
  const listeners: Array<() => void> = [];
  let bridge: BridgeHandle | null = null;
  let accountTier: string | null = null;
  const readTier = () => accountTier;

  const activate = async (stored: StoredOutboundProxy | null) => {
    const setting = settingOf(stored);
    if (setting && !net.isHooked()) {
      net.hook((n) => {
        acme.axios.defaults.httpsAgent = n.httpsAgent();
        acme.axios.defaults.httpAgent = n.httpAgent();
        acme.axios.defaults.proxy = false;
      });
    }
    if (setting && !bridge) {
      try {
        bridge = await startOutboundBridge(net);
        net.setBridgeUrl(bridge.url);
      } catch (e) {
        log(`[outbound-proxy] couldn't start the local bridge (${(e as Error).message}); updates will fail until it starts`);
      }
    }
    net.configure(setting);
    try {
      await syncCurlrc(`${opts.dataDir}/${OUTBOUND_PROXY_CURLRC}`, setting);
    } catch (e) {
      log(`[outbound-proxy] couldn't update the health reporter's proxy file (${(e as Error).message})`);
    }
    const p = stored?.signed.proxy;
    if (setting && p) log(`[outbound-proxy] connecting through a ${p.kind} proxy`);
    else if (net.isHooked()) log("[outbound-proxy] connecting directly");
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* a listener's failure never blocks the switch */
      }
    }
  };

  await store.load();
  if (!store.current()) await store.adoptFromInstallBlob(opts.installBlobPath);
  await activate(store.current());

  return {
    store,
    net,
    summary: () => outboundProxySummary(store, net, readTier),
    setAccountTier: (tier) => {
      accountTier = tier;
    },
    onChange: (fn) => listeners.push(fn),
    http: (probeTarget) =>
      buildOutboundProxyHttp({ store, net, authority: opts.authority, probeTarget, activate, accountTier: readTier }),
  };
}
