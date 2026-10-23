import { Transform } from "node:stream";
import { ArchiveError } from "./format.js";

/**
 * Bounds on an archive being read (SECURITY-HARDENING-PLAN.md N09). The data file is
 * authenticated, but integrity does not prove benign content: every count and size is
 * checked as the bytes stream past, before anything is written or kept, and a name may
 * appear once.
 */
export const MAX_ARCHIVE_ENTRIES = 4096;
export const MAX_SMALL_ENTRY_BYTES = 2 * 1024 * 1024;
export const MAX_ARCHIVE_EXPANDED_BYTES = 512 * 1024 ** 3;

export class ArchiveLimits {
  private readonly seen = new Set<string>();
  private total = 0;

  constructor(
    private readonly caps: { entries?: number; small?: number; total?: number } = {},
  ) {}

  /** Call once per tar entry header. Returns the byte budget for this entry. */
  enter(name: string, small: boolean): number {
    if (this.seen.has(name)) throw new ArchiveError(`the archive lists ${name.slice(0, 80)} twice`);
    if (this.seen.size >= (this.caps.entries ?? MAX_ARCHIVE_ENTRIES)) throw new ArchiveError("the archive holds too many parts");
    this.seen.add(name);
    return small ? (this.caps.small ?? MAX_SMALL_ENTRY_BYTES) : Number.POSITIVE_INFINITY;
  }

  /** Call for every chunk; throws when a bound is crossed. `entryBytes` is this entry's running size. */
  chunk(len: number, entryBytes: number, budget: number): void {
    this.total += len;
    if (entryBytes > budget) throw new ArchiveError("a part of the archive is larger than it may be");
    if (this.total > (this.caps.total ?? MAX_ARCHIVE_EXPANDED_BYTES)) throw new ArchiveError("the archive expands to more than it may");
  }

  /** A pass-through that enforces the bounds on one entry's bytes as they flow to the next stage. */
  meter(budget: number): Transform {
    let entryBytes = 0;
    return new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        entryBytes += chunk.length;
        try {
          this.chunk(chunk.length, entryBytes, budget);
          cb(null, chunk);
        } catch (e) {
          cb(e as Error);
        }
      },
    });
  }
}
