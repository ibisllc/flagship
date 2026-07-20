"""Sector-aligned raw write to a removable block device (Python port of
DiskWrite.swift).

Streams a prepared image to /dev/sdX in 1 MiB chunks, padding ONLY the final
short chunk up to the sector size so the write stays block-aligned (raw block
devices reject misaligned writes with EINVAL). The box finds the trailer by the
ISO volume size, not the device end, so trailing zeros are harmless.

This needs CAP_SYS_ADMIN (effectively root) for raw block access, so the GUI
runs it elevated. Two shapes:

  * As a library: `write(image_path, device_path, progress)` — call this when
    already privileged (e.g. inside the pkexec'd process).
  * As a CLI: `python3 disk_write.py <image> <device>` — emit progress as
    `FLAGSHIP_PROGRESS:<0..1>` lines on stdout. The GUI pkexec's THIS so the
    polkit prompt elevates a small, auditable script (not the whole GUI).

Stdlib only.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Callable, Optional

SECTOR = 512
CHUNK = 1024 * 1024

ProgressCb = Callable[[float], None]


class DiskWriteError(Exception):
    """Raw write refused or failed."""


def _is_block_device(path: str) -> bool:
    try:
        import stat

        return stat.S_ISBLK(Path(path).stat().st_mode)
    except OSError:
        return False


def pad_to_sector(data: bytes, sector: int = SECTOR) -> bytes:
    """Zero-pad `data` up to the next `sector` multiple. Raw block devices reject
    misaligned writes with EINVAL; only the FINAL short chunk of an image is ever
    partial (base ISO + ~1 KB trailer), and the box finds the trailer by the ISO
    volume size — not the device end — so trailing zeros are harmless."""
    rem = len(data) % sector
    if rem == 0:
        return data
    return data + b"\x00" * (sector - rem)


def write(
    image_path: str,
    device_path: str,
    progress: Optional[ProgressCb] = None,
) -> None:
    """Write `image_path` to `device_path` (e.g. /dev/sdb), reporting a 0…1
    fraction roughly once per percent. Must run as root.

    Mirrors DiskWrite.write: size floor, device-prefix guard, 1 MiB chunked
    copy with final-chunk zero-pad to the sector, fsync at the end.
    """
    progress = progress or (lambda _p: None)

    size = Path(image_path).stat().st_size
    if size < 1024:
        raise DiskWriteError(f"Image too small ({size} bytes); refusing to write.")
    # On Linux the device node is /dev/sdX | /dev/mmcblkN | /dev/nvmeNnN. Guard
    # against obvious non-/dev targets; the GUI's enumerator already filters to
    # removable USB disks, and the kernel block-device check is the real gate.
    if not device_path.startswith("/dev/"):
        raise DiskWriteError(f"Refusing non-/dev device: {device_path}")
    if not _is_block_device(device_path):
        raise DiskWriteError(f"Not a block device: {device_path}")

    try:
        inp = open(image_path, "rb")
    except OSError as e:
        raise DiskWriteError(f"Can't open {image_path}: {e}") from e
    try:
        try:
            out = open(device_path, "wb")
        except OSError as e:
            raise DiskWriteError(
                f"Can't open {device_path}: permission denied or busy ({e})"
            ) from e
        try:
            written = 0
            last_pct = -1
            while True:
                data = inp.read(CHUNK)
                if not data:
                    break
                # Full CHUNK reads are already sector-aligned; only the final
                # short chunk needs padding.
                data = pad_to_sector(data, SECTOR)
                out.write(data)
                written += len(data)
                pct = int(written / size * 100)
                if pct != last_pct:
                    last_pct = pct
                    progress(min(1.0, written / size))
            out.flush()
            import os as _os

            _os.fsync(out.fileno())
            progress(1.0)
        finally:
            out.close()
    finally:
        inp.close()


def _main(argv: list[str]) -> int:
    """pkexec entry: `disk_write.py <image> <device>`. Emits machine-readable
    `FLAGSHIP_PROGRESS:<f>` lines the GUI parses; errors go to stderr + a
    non-zero exit."""
    if len(argv) != 3:
        sys.stderr.write("usage: disk_write.py <image> <device>\n")
        return 2
    image_path, device_path = argv[1], argv[2]

    def emit(p: float) -> None:
        sys.stdout.write(f"FLAGSHIP_PROGRESS:{p:.4f}\n")
        sys.stdout.flush()

    try:
        sys.stdout.write("FLAGSHIP_PHASE:write\n")
        sys.stdout.flush()
        write(image_path, device_path, progress=emit)
    except DiskWriteError as e:
        sys.stderr.write(f"{e}\n")
        return 1
    except OSError as e:
        sys.stderr.write(f"write failed: {e}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv))
