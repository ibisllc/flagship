/**
 * The Dockerfile the box writes for a runtime app (docs/app-runtimes.md §6.2).
 * The app chooses none of it: the base is the catalog's pinned image, the only
 * RUN is the runtime's own dependency install, and the app runs as the
 * runtime's unprivileged user.
 */
import { RUNTIMES, type RuntimeId } from "./catalog.js";

export interface RuntimeBuildInput {
  base: RuntimeId;
  port: number;
  /** argv; null ⇒ the runtime's default (node: `npm start`). */
  start: string[] | null;
  /** `static`: the folder to serve, relative to the app's root. */
  root?: string;
  /** Which dependency files the app's folder has. */
  has: { packageLock: boolean; packageJson: boolean; requirements: boolean };
}

export type RuntimeBuild = { ok: true; dockerfile: string; dockerignore: string } | { ok: false; reason: string };

/** Never part of the image: the box installs dependencies itself, and secrets stay out. */
export const RUNTIME_DOCKERIGNORE = [
  ".git",
  "node_modules",
  "**/node_modules",
  "__pycache__",
  "**/__pycache__",
  ".venv",
  ".env",
  ".env.*",
  "Dockerfile",
  "Dockerfile.*",
  ".dockerignore",
].join("\n");

const HEADER = "# Written by the Flagship box (docs/app-runtimes.md). The app's own Dockerfile, if any, is ignored.";

export function runtimeBuildFile(i: RuntimeBuildInput): RuntimeBuild {
  const rt = RUNTIMES[i.base];
  if (!rt) return { ok: false, reason: `unknown runtime ${String(i.base)}` };
  if (!Number.isInteger(i.port) || i.port < 1 || i.port > 65535) return { ok: false, reason: "runtime.port must be a port number" };
  if (rt.fixedPort !== undefined && i.port !== rt.fixedPort) {
    return { ok: false, reason: `the ${rt.id} runtime listens on ${rt.fixedPort}: set runtime.port to ${rt.fixedPort}` };
  }
  const cmd = (argv: string[]) => `CMD ${JSON.stringify(argv)}`;
  const lines = [HEADER, `FROM ${rt.image}`];
  switch (rt.id) {
    case "node-24": {
      if (!i.has.packageJson) return { ok: false, reason: "a node-24 app needs a package.json" };
      lines.push(
        "WORKDIR /app",
        "ENV NODE_ENV=production",
        "COPY package*.json ./",
        i.has.packageLock ? "RUN npm ci --omit=dev --no-audit --no-fund" : "RUN npm install --omit=dev --no-audit --no-fund",
        "COPY . .",
        `USER ${rt.user}`,
        `EXPOSE ${i.port}`,
        cmd(i.start ?? ["npm", "start"]),
      );
      break;
    }
    case "python-3.13": {
      if (!i.start || i.start.length === 0) return { ok: false, reason: "a python-3.13 app needs runtime.start, e.g. [\"python\", \"app.py\"]" };
      lines.push("WORKDIR /app", "ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1");
      if (i.has.requirements) lines.push("COPY requirements.txt ./", "RUN pip install --no-cache-dir -r requirements.txt");
      lines.push("COPY . .", `USER ${rt.user}`, `EXPOSE ${i.port}`, cmd(i.start));
      break;
    }
    case "static": {
      if (i.start) return { ok: false, reason: "the static runtime serves files: remove runtime.start" };
      const root = normalizeRoot(i.root ?? ".");
      if (root === null) return { ok: false, reason: "runtime.root must be a folder inside the app" };
      lines.push(`COPY ${root === "" ? "." : root} /usr/share/nginx/html/`, `USER ${rt.user}`, `EXPOSE ${i.port}`);
      break;
    }
  }
  return { ok: true, dockerfile: `${lines.join("\n")}\n`, dockerignore: `${RUNTIME_DOCKERIGNORE}\n` };
}

/** The build files the box wrote into an app's working tree: rewritten on every deploy, so never the app's own. */
export function isBoxWrittenBuildFile(path: string, text: string): boolean {
  if (path === "Dockerfile") return text.startsWith(HEADER);
  if (path === ".dockerignore") return text === `${RUNTIME_DOCKERIGNORE}\n`;
  return false;
}

/** `./public/` → `public`; null when it would leave the app's folder or isn't a plain path. */
function normalizeRoot(root: string): string | null {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(root)) return null;
  const parts = root.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  return parts.join("/");
}
