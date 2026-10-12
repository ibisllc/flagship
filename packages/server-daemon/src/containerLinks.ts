import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { writeFileDurable } from "./durableFile.js";
import type { CommandRunner } from "./serviceRunner.js";

/**
 * The VM appliances shipped through 2026-10-12 hand every `Type=ether` link
 * to systemd-networkd, and a Docker container's veth is one. networkd then
 * runs DHCP on it and, since KeepMaster= defaults to no, pulls it off its
 * Docker bridge, so the box can't reach its own containers (an app answered
 * every request with "bad gateway: read ECONNRESET" after a 3 s ARP timeout)
 * and `docker build` RUN steps had no network. A file that sorts first and
 * leaves veths and bridges unmanaged fixes it; this writes it on boxes that
 * predate the fix, before any container starts.
 */
export const CONTAINER_LINKS_PATH = "/etc/systemd/network/10-flagship-containers.network";

export const CONTAINER_LINKS_NETWORK = `[Match]
Kind=veth bridge

[Link]
Unmanaged=yes
`;

export async function ensureContainerLinksUnmanaged(
  cmd: CommandRunner,
  opts: { path?: string; log?: (m: string) => void } = {},
): Promise<"written" | "present" | "skipped"> {
  const path = opts.path ?? CONTAINER_LINKS_PATH;
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (!existsSync(dir)) return "skipped";
  const current = await readFile(path, "utf-8").catch(() => null);
  if (current === CONTAINER_LINKS_NETWORK) return "present";
  try {
    await writeFileDurable(path, CONTAINER_LINKS_NETWORK, 0o644);
    await cmd.run("networkctl", ["reload"]).catch(() => {});
    opts.log?.("[runtime] container links are now left to Docker (systemd-networkd no longer manages veths/bridges)");
    return "written";
  } catch (e) {
    opts.log?.(`[runtime] could not write ${path}: ${(e as Error).message}`);
    return "skipped";
  }
}
