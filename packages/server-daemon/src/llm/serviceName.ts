/**
 * Is a name free for a new vibe-coded service? The name becomes the app's
 * slug and web-address label (`<name>.<server fqdn>`), so it must be a valid
 * label that no installed app and no open build session already uses. The
 * describe form asks this as the owner types; the start and deploy paths ask
 * again because the box, not the phone, is the authority.
 */

import type { VibeCodeSessionRegistry } from "./vibeCodeSession.js";

export type ServiceNameCheck =
  | { ok: true; name: string }
  | { ok: false; kind: "invalid"; message: string }
  | { ok: false; kind: "app"; serviceId: string; message: string }
  | { ok: false; kind: "session"; sessionId: string; message: string };

export interface ServiceNameDeps {
  registry: Pick<VibeCodeSessionRegistry, "holderOf">;
  /** Host username: self-authored apps are `<host>--<slug>`. */
  hostUsername: string;
  /** The installed app serving this label or service id, if any. */
  installed: {
    byLabel(label: string): { serviceId: string } | undefined;
    byServiceId(serviceId: string): { serviceId: string } | undefined;
  } | null;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function checkServiceName(
  raw: string,
  deps: ServiceNameDeps,
  exceptSessionId?: string,
): ServiceNameCheck {
  const name = raw.trim().toLowerCase();
  if (!LABEL.test(name) || name.includes("--")) {
    return {
      ok: false,
      kind: "invalid",
      message: "Use lowercase letters, digits and single dashes, starting and ending with a letter or digit.",
    };
  }
  const app =
    deps.installed?.byServiceId(`${deps.hostUsername}--${name}`) ?? deps.installed?.byLabel(name);
  if (app) {
    return {
      ok: false,
      kind: "app",
      serviceId: app.serviceId,
      message: `You already have a service called "${name}".`,
    };
  }
  const holder = deps.registry.holderOf(name, exceptSessionId);
  if (holder) {
    return {
      ok: false,
      kind: "session",
      sessionId: holder.sessionId,
      message: `A build session already uses the name "${name}".`,
    };
  }
  return { ok: true, name };
}
