import type { KeydInstallOutcome, TlsdInstallOutcome } from "./keydInstall.js";
import type { PrivdInstallOutcome } from "./privdInstall.js";

/**
 * A new box puts its host components in on its first start: flagship-keyd (the keys), the TLS frontend and
 * flagship-privd (the daemon off root). Each used to restart the daemon on its own, so a new box restarted three times
 * before it served anything (Studio Health: "restarted 4x"). keyd is answering once its install returns, so the other
 * two go in during the same start and the daemon restarts once into all three.
 */
export interface HostComponentSteps {
  keydRunning: boolean;
  keydRequired: boolean;
  tlsUpstreamSet: boolean;
  /** The daemon runs as root (not yet handed to privd). */
  root: boolean;
  installKeyd(): Promise<KeydInstallOutcome>;
  /** Whatever must run between keyd and the TLS frontend (the arch-v2 engine and units, GPUs). */
  afterKeyd(keydUp: boolean): Promise<void>;
  installTlsd(): Promise<TlsdInstallOutcome>;
  installPrivd(): Promise<PrivdInstallOutcome>;
}

export async function installHostComponents(o: HostComponentSteps): Promise<{ keydUp: boolean; restartFor: string[] }> {
  const restartFor: string[] = [];
  let keydUp = o.keydRunning;
  if (!keydUp && !o.keydRequired && (await o.installKeyd()) === "installed") {
    keydUp = true;
    restartFor.push("flagship-keyd holds the keys");
  }
  await o.afterKeyd(keydUp);
  if (keydUp && !o.tlsUpstreamSet && (await o.installTlsd()) === "installed") restartFor.push("flagship-tlsd terminates TLS");
  if (keydUp && o.root && (await o.installPrivd()) === "switched") restartFor.push("flagship-privd does the host operations");
  return { keydUp, restartFor };
}
