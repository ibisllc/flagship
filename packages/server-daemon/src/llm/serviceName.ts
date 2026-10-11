/**
 * Is a name free for a new vibe-coded service? The name becomes the app's
 * slug and web-address label (`<name>.<server fqdn>`), so it must be a valid
 * label that no installed app and no open build session already uses. The
 * describe form asks this as the owner types; the start and deploy paths ask
 * again because the box, not the phone, is the authority.
 */

export type ServiceNameCheck =
  | { ok: true; name: string }
  | { ok: false; kind: "invalid"; message: string }
  | { ok: false; kind: "app"; serviceId: string; message: string }
  | { ok: false; kind: "session"; sessionId: string; message: string };

export interface NameHolders {
  holderOf(name: string, exceptId?: string): { sessionId: string } | undefined;
}

export interface ServiceNameDeps {
  /** Open builds (AI chats, git imports) and the names they hold. */
  registry: NameHolders;
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

/** Several holders read as one: the first that holds a name wins. */
export function combineNameHolders(...holders: (NameHolders | null | undefined)[]): NameHolders {
  return {
    holderOf: (name, exceptId) => {
      for (const h of holders) {
        const held = h?.holderOf(name, exceptId);
        if (held) return held;
      }
      return undefined;
    },
  };
}

const FALLBACK_NAME = "app";
const DEFAULT_BRANCHES = new Set(["main", "master", "trunk", "default", "head", "develop"]);

/** A label made from free text: lowercase, single dashes, at most `max` long. */
export function slugifyLabel(raw: string, max = 63): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/** The repository's own name, from an https or git@ clone URL. */
export function repoNameFromUrl(gitUrl: string): string {
  const path = gitUrl.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  const last = path.split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/i, "");
}

/**
 * The name a git import gets when the owner leaves it blank: the repo's name,
 * plus the branch when it isn't the usual default one, then -2, -3… past any
 * name an app or an open build already holds.
 */
export function deriveServiceName(
  a: { gitUrl: string; ref?: string },
  deps: ServiceNameDeps,
  exceptSessionId?: string,
): string {
  const repo = slugifyLabel(repoNameFromUrl(a.gitUrl), 40) || FALLBACK_NAME;
  const ref = (a.ref ?? "").trim();
  const branch = ref && !DEFAULT_BRANCHES.has(ref.toLowerCase()) ? slugifyLabel(ref.split("/").pop() ?? ref, 18) : "";
  const base = branch && branch !== repo ? `${repo}-${branch}` : repo;
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (checkServiceName(candidate, deps, exceptSessionId).ok) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
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
  registry?: NameHolders;
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
