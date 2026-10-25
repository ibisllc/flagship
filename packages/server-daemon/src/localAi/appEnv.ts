/**
 * The one line an app's deploy asks of local AI: `FLAGSHIP_AI_URL`, when its manifest declares
 * `localAi.inference` and the box can route it (localAi/appSdk.ts). Unset in tests and tools, and on
 * a box without the egress gateway: then the app simply has no endpoint.
 */
import type { NormalizedApp } from "@flagship/protocol";

type Provider = (serviceId: string, declares: boolean) => Promise<Record<string, string>>;
let provider: Provider | null = null;

export function setLocalAiEnvProvider(p: Provider | null): void {
  provider = p;
}

export async function localAiEnvFor(serviceId: string, app: NormalizedApp | undefined): Promise<Record<string, string>> {
  if (!provider) return {};
  try {
    return await provider(serviceId, app?.localAi?.inference === true);
  } catch {
    return {};
  }
}
