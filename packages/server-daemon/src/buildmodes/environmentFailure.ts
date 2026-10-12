/**
 * Staging failures the app's code can't cause, and can't fix.
 *
 * When the box itself is broken (its data layer down, the egress fence down,
 * dockerd gone, a registry outage, a full disk), handing the failure to the AI
 * as if it were the app's fault makes it "fix" the app: a chat deploy on home3
 * spent all its turns rewriting the manifest and finally deleted the owner's
 * migration. So these never reach the AI: the deploy fails at once with a
 * reason the owner can act on, and a running loop stops.
 */

import { isDataLayerUnavailable } from "../dataLayer/stack.js";

export type EnvironmentFailureKind = "data-layer" | "fence" | "docker" | "registry" | "disk";

export interface EnvironmentFailure {
  kind: EnvironmentFailureKind;
  /** What the owner reads (the deploy's failure reason). */
  ownerReason: string;
}

const OWNER_REASONS: Record<EnvironmentFailureKind | "data-layer-starting", string> = {
  "data-layer":
    "This server's database isn't running, so apps that store data can't start yet. " +
    "The server keeps trying to start it: try again in a few minutes, and restart the server if it still fails.",
  "data-layer-starting":
    "This server's database is still starting, so apps that store data can't start yet. Try again in a few minutes.",
  fence:
    "This server can't wall the AI's test copy off from the internet right now, so it won't run AI-written code. " +
    "Restart the server, then try again.",
  docker:
    "This server's container engine (Docker) isn't responding, so no app can be built or started. " +
    "Restart the server, then try again.",
  registry:
    "This server couldn't download what the app is built from: the image registry or the server's internet " +
    "connection isn't answering. Try again later.",
  disk: "This server's disk is full, so the app can't be built or started. Remove apps or data you don't need, then try again.",
};

export function environmentFailure(
  kind: EnvironmentFailureKind,
  opts: { starting?: boolean } = {},
): EnvironmentFailure {
  const ownerReason = kind === "data-layer" && opts.starting ? OWNER_REASONS["data-layer-starting"] : OWNER_REASONS[kind];
  return { kind, ownerReason };
}

/** A data-store error that is the store not answering, not the app's SQL. */
const DATA_CONNECTION_RE =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|Connection terminated|connection timeout|timeout expired|the database system is (starting up|shutting down|in recovery mode)|too many clients already|server closed the connection unexpectedly/i;

const DOCKER_DAEMON_RE =
  /Cannot connect to the Docker daemon|Is the docker daemon running|docker\.sock|spawn docker ENOENT|docker: (command )?not found|error during connect/i;

const DISK_FULL_RE = /no space left on device|ENOSPC|disk quota exceeded/i;

const REGISTRY_HOST_RE = /registry|\/v2\/|docker\.io|ghcr\.io|quay\.io|gcr\.io|mcr\.microsoft\.com|public\.ecr\.aws|pull/i;
const NETWORK_TROUBLE_RE =
  /timeout|timed out|request canceled|connection refused|connection reset|no such host|TLS handshake|Service Unavailable|Bad Gateway|Gateway Timeout|Internal Server Error|server misbehaving|temporary failure in name resolution|unexpected EOF/i;

/** True when `message` is a data store refusing or dropping the connection. */
export function looksLikeDataConnectionError(message: string): boolean {
  return DATA_CONNECTION_RE.test(message);
}

/**
 * Classify a staging failure from its text. Returns null for anything the
 * app could have caused (its build steps, its code, its manifest).
 */
export function classifyEnvironmentFailure(text: string): EnvironmentFailure | null {
  const reason = text.replace(/^install rejected: /, "");
  if (/^data provisioning failed:/.test(reason)) {
    return environmentFailure("data-layer", { starting: /still starting/.test(reason) });
  }
  if (/has no data layer|admin not configured|the data layer \(Postgres[^)]*\)/.test(reason)) {
    return environmentFailure("data-layer", { starting: /still starting/.test(reason) });
  }
  if (/^migration \S+ failed: /.test(reason) && looksLikeDataConnectionError(reason)) {
    return environmentFailure("data-layer");
  }
  if (/wall off the test copy|egress fence/i.test(reason)) return environmentFailure("fence");
  if (DISK_FULL_RE.test(reason)) return environmentFailure("disk");
  if (DOCKER_DAEMON_RE.test(reason)) return environmentFailure("docker");
  if (/toomanyrequests|pull rate limit/i.test(reason)) return environmentFailure("registry");
  // A registry the box can't reach. A RUN step that fetches from a host the
  // build fence blocks is the app's doing, so only image fetches count.
  if (/(FROM|pull|manifest|resolve|fetch|Get|Head)\b/.test(reason) && REGISTRY_HOST_RE.test(reason) && NETWORK_TROUBLE_RE.test(reason)) {
    if (!/RUN |npm ERR|pip |apt-get|returned a non-zero code/.test(reason)) return environmentFailure("registry");
  }
  return null;
}

/** Classify a thrown provisioning error (the data layer's typed error, or any other). */
export function classifyProvisioningError(e: unknown): EnvironmentFailure {
  if (isDataLayerUnavailable(e)) return environmentFailure("data-layer", { starting: e.state === "starting" });
  return environmentFailure("data-layer");
}

/** What a model or IDE reads instead of the failure itself. */
export function environmentFailureForAgent(f: EnvironmentFailure): string {
  return (
    `The server can't run the test copy right now, and nothing in the app's files caused it: ${f.ownerReason} ` +
    `Don't change or delete any files to work around it. Stop here; the owner has been told.`
  );
}
