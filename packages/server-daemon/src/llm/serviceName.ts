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

export type DeployTarget =
  | { ok: true; slug: string; edit: false }
  | { ok: true; slug: string; edit: true; serviceId: string; urlLabel: string }
  | { ok: false; reason: string };

/**
 * Where a build deploys: over the installed service it edits (same slug, same
 * address), or as a new service under a name nothing else holds. Checked
 * before any file is written, so a clash never touches another app's tree.
 */
export function resolveDeployTarget(a: {
  editsServiceId?: string;
  name: string;
  hostUsername: string;
  installed: {
    byLabel(label: string): { serviceId: string } | undefined;
    byServiceId(id: string): { serviceId: string; creator: string; slug: string; urlLabel: string } | undefined;
  } | null;
  registry?: ServiceNameDeps["registry"];
  sessionId?: string;
}): DeployTarget {
  if (a.editsServiceId) {
    const app = a.installed?.byServiceId(a.editsServiceId);
    if (!app) return { ok: false, reason: "The service this build changes is no longer installed." };
    if (app.creator !== a.hostUsername) return { ok: false, reason: "Only services made on this server can be edited here." };
    return { ok: true, slug: app.slug, edit: true, serviceId: app.serviceId, urlLabel: app.urlLabel };
  }
  const slug = a.name.toLowerCase();
  const check = checkServiceName(
    slug,
    { registry: a.registry ?? { holderOf: () => undefined }, hostUsername: a.hostUsername, installed: a.installed },
    a.sessionId,
  );
  if (!check.ok) {
    return {
      ok: false,
      reason: check.kind === "invalid" ? `"${slug}" can't be a web address. ${check.message}` : `${check.message} Pick another name and start a new build.`,
    };
  }
  return { ok: true, slug, edit: false };
}

/** A version's SQL migrations, from its files. */
export function migrationFiles(files: Record<string, string>): { filename: string; sql: string }[] {
  return Object.entries(files)
    .filter(([p]) => /^migrations\/[^/]+\.sql$/i.test(p))
    .map(([p, sql]) => ({ filename: p.slice("migrations/".length), sql }));
}
