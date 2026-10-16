/**
 * Which published repo adapter each installed service was built from, so
 * its owner can report a problem with that adapter from the service page.
 * Only the repo's public address and the adapter's hash: nothing private.
 */

import { readFile } from "node:fs/promises";
import { writeFileDurable } from "../durableFile.js";

export interface AdapterOrigin {
  repo: string;
  /** sha256 of the published adapter file. */
  file: string;
}

export interface AdapterOrigins {
  get(serviceId: string): AdapterOrigin | null;
  /** Null forgets it (the service was rebuilt some other way). */
  set(serviceId: string, origin: AdapterOrigin | null): Promise<void>;
}

export class InMemoryAdapterOrigins implements AdapterOrigins {
  readonly map = new Map<string, AdapterOrigin>();
  get(serviceId: string) {
    return this.map.get(serviceId) ?? null;
  }
  async set(serviceId: string, origin: AdapterOrigin | null) {
    if (origin) this.map.set(serviceId, origin);
    else this.map.delete(serviceId);
  }
}

export class FileAdapterOrigins implements AdapterOrigins {
  private map = new Map<string, AdapterOrigin>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Record<string, AdapterOrigin>;
      this.map = new Map(
        Object.entries(parsed).filter(([, o]) => typeof o?.repo === "string" && /^[0-9a-f]{64}$/.test(o?.file ?? "")),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  get(serviceId: string): AdapterOrigin | null {
    return this.map.get(serviceId) ?? null;
  }

  set(serviceId: string, origin: AdapterOrigin | null): Promise<void> {
    if (origin) this.map.set(serviceId, origin);
    else if (!this.map.delete(serviceId)) return Promise.resolve();
    const snapshot = JSON.stringify(Object.fromEntries(this.map));
    const next = this.chain.then(async () => {
      await writeFileDurable(this.path, snapshot, 0o644);
    });
    this.chain = next.catch(() => {});
    return next;
  }
}
