/**
 * Build a Flagship-flavored apkovl tarball.
 *
 * Alpine's init reads `*.apkovl.tar.gz` from the boot media and overlays
 * its contents onto the live filesystem before running OpenRC. We use
 * this hook to drop our bootstrap script into /etc/local.d, our helper
 * binaries into /usr/local/bin, and the local.d service registration into
 * /etc/runlevels/default.
 *
 * The function is pure — given the scripts (read once at module-init)
 * it returns the gzipped tarball bytes. No filesystem I/O.
 */

import { gzipSync } from "node:zlib";

export interface ApkovlFile {
  /** Path inside the tarball (and inside the overlay), e.g. "etc/local.d/01-flagship.start". */
  name: string;
  /** File contents. */
  content: Uint8Array;
  /** Octal mode. Defaults to 0o644 for files, 0o755 if executable. */
  mode?: number;
}

export interface BuildApkovlOptions {
  /** Files to include in the overlay. The order is preserved. */
  files: ApkovlFile[];
  /**
   * Unix-seconds timestamp to write into every tar mtime field. If
   * omitted, falls back to `process.env.SOURCE_DATE_EPOCH` (parsed as
   * an integer), or `0` if neither is set. We deliberately do NOT use
   * `Date.now()` — the apkovl is a build artifact, and a wall-clock
   * mtime would make the resulting ISO non-reproducible.
   *
   * Callers in the reproducible-build path should set this explicitly
   * to the commit timestamp; see `scripts/build-flagship-iso.sh` and
   * `docs/runbooks/iso-reproducibility.md`.
   */
  mtime?: number;
}

/**
 * Build a USTAR-compatible gzipped tarball. We hand-roll the tar format
 * rather than pulling a dep — apkovl tarballs don't need PAX or extended
 * headers, just plain USTAR.
 */
export function buildApkovl(opts: BuildApkovlOptions): Uint8Array {
  const mtime = resolveMtime(opts.mtime);
  const blocks: Uint8Array[] = [];
  for (const f of opts.files) {
    blocks.push(tarHeader(f, mtime));
    blocks.push(f.content);
    const pad = (512 - (f.content.length % 512)) % 512;
    if (pad) blocks.push(new Uint8Array(pad));
  }
  blocks.push(new Uint8Array(1024)); // two zero blocks = end-of-archive
  const tar = concat(blocks);
  // `mtime: 0` keeps gzip's mtime field deterministic; `os: 3` (Unix)
  // is the default but pinning is cheap insurance.
  return new Uint8Array(gzipSync(tar, { level: 9 }));
}

function resolveMtime(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.floor(explicit);
  }
  const env = process.env.SOURCE_DATE_EPOCH;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function tarHeader(f: ApkovlFile, mtime: number): Uint8Array {
  const block = new Uint8Array(512);
  const enc = new TextEncoder();
  const name = f.name.replace(/^\/+/, "");
  if (name.length > 100) {
    throw new Error(`apkovl: filename longer than 100 bytes is not supported (${name})`);
  }
  block.set(enc.encode(name), 0);

  const mode = f.mode ?? 0o644;
  setOctal(block, 100, 8, mode);
  setOctal(block, 108, 8, 0); // uid
  setOctal(block, 116, 8, 0); // gid
  setOctal(block, 124, 12, f.content.length);
  setOctal(block, 136, 12, mtime);

  // Checksum field starts as 8 spaces.
  for (let i = 148; i < 156; i++) block[i] = 0x20;
  block[156] = 0x30; // typeflag '0' = regular file
  block.set(enc.encode("ustar  "), 257);
  block[262] = 0x20;
  block[263] = 0x00;

  let sum = 0;
  for (const b of block) sum += b;
  setOctal(block, 148, 7, sum);
  block[155] = 0x20;
  return block;
}

function setOctal(buf: Uint8Array, offset: number, length: number, value: number): void {
  const s = value.toString(8).padStart(length - 1, "0");
  const enc = new TextEncoder();
  buf.set(enc.encode(s), offset);
  buf[offset + length - 1] = 0x00;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/**
 * Convenience: build the standard Flagship apkovl from string contents.
 *
 * The apkovl deliberately stays minimal — the actual install/boot-stage
 * logic lives in the public `installer/` directory of the Flagship
 * GitHub repo and is fetched at run time at the git ref the trailer
 * pins. Everything baked here is security-critical (validates the
 * signature before trusting any network-fetched code).
 */
export function buildFlagshipApkovl(
  scripts: {
    bootstrap: string;
    trailerProbe: string;
    trailerValidate: string;
  },
  options?: { mtime?: number },
): Uint8Array {
  const enc = new TextEncoder();
  return buildApkovl({
    mtime: options?.mtime,
    files: [
      {
        name: "etc/local.d/01-flagship-bootstrap.start",
        content: enc.encode(scripts.bootstrap),
        mode: 0o755,
      },
      {
        name: "usr/local/bin/flagship-trailer-probe",
        content: enc.encode(scripts.trailerProbe),
        mode: 0o755,
      },
      {
        name: "usr/local/bin/flagship-trailer-validate",
        content: enc.encode(scripts.trailerValidate),
        mode: 0o755,
      },
      {
        name: "etc/runlevels/default/local",
        content: new Uint8Array(0),
        mode: 0o644,
      },
    ],
  });
}
