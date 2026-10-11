/**
 * The box's list of installed services, kept on disk so a daemon restart (an
 * update, a reboot, a crash) brings every service back with the same address,
 * data-store credentials and members. Without it the registry lived only in
 * memory: after a restart the box no longer routed to its apps, and the
 * credentials to their databases were gone.
 *
 * One file, sealed under the SWK like the other secrets at rest (it holds the
 * per-app database passwords), replaced atomically on every save.
 */

import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SwkOps } from "./keyCustodian.js";
import type { AppDataCredentials } from "./dataLayer/provisioner.js";
import type { AppMembershipSnapshot } from "./membership.js";

export interface PersistedService {
  creator: string;
  slug: string;
  serviceId: string;
  manifestJson: string;
  urlLabel: string;
  /** The loopback port the proxy dials (InstalledService.containerPort). */
  hostPort: number;
  data: AppDataCredentials | null;
  installedAt: number;
  membership: AppMembershipSnapshot;
}

export interface InstalledServicesStore {
  load(): Promise<PersistedService[]>;
  save(services: PersistedService[]): Promise<void>;
}

export class InMemoryInstalledServicesStore implements InstalledServicesStore {
  saved: PersistedService[] = [];
  async load(): Promise<PersistedService[]> {
    return structuredClone(this.saved);
  }
  async save(services: PersistedService[]): Promise<void> {
    this.saved = structuredClone(services);
  }
}

export class SealedInstalledServicesStore implements InstalledServicesStore {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly swk: Pick<SwkOps, "sealWithSwk" | "openWithSwk">,
  ) {}

  async load(): Promise<PersistedService[]> {
    let hex: string;
    try {
      hex = (await readFile(this.path, "utf8")).trim();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const buf = Buffer.from(hex, "hex");
    if (buf.length < 12) throw new Error("installed-services file is truncated");
    const plain = this.swk.openWithSwk({ nonce: buf.subarray(0, 12), ciphertext: buf.subarray(12) });
    const parsed = JSON.parse(Buffer.from(plain).toString("utf8")) as { v: number; services: PersistedService[] };
    return Array.isArray(parsed.services) ? parsed.services : [];
  }

  save(services: PersistedService[]): Promise<void> {
    const next = this.chain.then(() => this.write(services));
    this.chain = next.catch(() => {});
    return next;
  }

  private async write(services: PersistedService[]): Promise<void> {
    const blob = this.swk.sealWithSwk(new TextEncoder().encode(JSON.stringify({ v: 1, services })));
    const hex = Buffer.concat([Buffer.from(blob.nonce), Buffer.from(blob.ciphertext)]).toString("hex");
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, hex, { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
