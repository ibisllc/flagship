/**
 * Which app holds which port in the apps gateway's owned range
 * (egress/gateway.ts OWNED_PORT_RANGE): an app group's member links and the
 * dedicated databases. Kept across restarts so a member's address and a
 * database URL never change under an app.
 */
import { readFile } from "node:fs/promises";
import { writeFileDurable } from "../durableFile.js";
import { OWNED_PORT_RANGE } from "../egress/gateway.js";

export interface PortBookStore {
  load(): Promise<Record<string, number>>;
  save(book: Record<string, number>): Promise<void>;
}

export function memoryPortBookStore(initial: Record<string, number> = {}): PortBookStore {
  let book = { ...initial };
  return {
    load: async () => ({ ...book }),
    save: async (b) => {
      book = { ...b };
    },
  };
}

export function filePortBookStore(path: string): PortBookStore {
  return {
    load: async () => {
      try {
        const v = JSON.parse(await readFile(path, "utf8")) as unknown;
        if (!v || typeof v !== "object" || Array.isArray(v)) return {};
        const out: Record<string, number> = {};
        for (const [k, p] of Object.entries(v as Record<string, unknown>)) if (typeof p === "number" && Number.isInteger(p)) out[k] = p;
        return out;
      } catch {
        return {};
      }
    },
    save: (b) => writeFileDurable(path, JSON.stringify(b, null, 2) + "\n", 0o600),
  };
}

/** Keys: `db:<serviceId>` or `group:<serviceId>:<component>`. */
export class OwnedPortBook {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: PortBookStore,
    private readonly range: { from: number; to: number } = OWNED_PORT_RANGE,
  ) {}

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /** The port `key` holds, taking the lowest free one the first time. */
  portFor(key: string): Promise<number> {
    return this.locked(async () => {
      const book = await this.store.load();
      if (book[key] !== undefined) return book[key]!;
      const used = new Set(Object.values(book));
      for (let p = this.range.from; p <= this.range.to; p++) {
        if (used.has(p)) continue;
        book[key] = p;
        await this.store.save(book);
        return p;
      }
      throw new Error("this server has no free port left for app links and dedicated databases");
    });
  }

  /** Free every key that starts with `prefix` (an uninstalled app). Returns the ports freed. */
  release(prefix: string): Promise<number[]> {
    return this.locked(async () => {
      const book = await this.store.load();
      const freed: number[] = [];
      for (const k of Object.keys(book)) {
        if (k.startsWith(prefix)) {
          freed.push(book[k]!);
          delete book[k];
        }
      }
      if (freed.length) await this.store.save(book);
      return freed;
    });
  }

  entries(): Promise<Record<string, number>> {
    return this.store.load();
  }
}
