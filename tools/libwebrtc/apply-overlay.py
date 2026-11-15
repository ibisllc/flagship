#!/usr/bin/env python3
"""apply-overlay.py <webrtc src>: copies overlay/ into the checkout and lists the files in the SDK's BUILD.gn.

Each insertion goes after an upstream anchor line; a missing anchor fails the build, so a new pin that moved a target
is caught here rather than as a link error later.
"""
import pathlib
import shutil
import sys

here = pathlib.Path(__file__).resolve().parent
src = pathlib.Path(sys.argv[1]).resolve()
overlay = here / "overlay"

for f in overlay.rglob("*"):
    if f.is_file():
        dest = src / f.relative_to(overlay)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(f, dest)

# (BUILD.gn, anchor line, lines to add after it, at least this many anchors)
EDITS = [
    ("sdk/BUILD.gn", '"objc/api/peerconnection/RTCRtpSender.mm",',
     ['"objc/api/peerconnection/RTCFlagshipFrameCrypto.mm",'], 1),
    ("sdk/BUILD.gn", '"objc/api/peerconnection/RTCRtpSender.h",',
     ['"objc/api/peerconnection/RTCFlagshipFrameCrypto.h",'], 2),
    ("sdk/android/BUILD.gn", '"api/org/webrtc/RtpSender.java",',
     ['"api/org/webrtc/FlagshipFrameCrypto.java",'], 2),
    ("sdk/android/BUILD.gn", '"src/jni/pc/rtp_sender.cc",',
     ['"src/jni/pc/flagship_frame_crypto.cc",'], 1),
]

for path, anchor, add, minimum in EDITS:
    gn = src / path
    lines = gn.read_text().splitlines(keepends=True)
    if any(a.strip() in (l.strip() for l in lines) for a in add):
        continue
    out, hits = [], 0
    for line in lines:
        out.append(line)
        if line.strip() == anchor:
            hits += 1
            indent = line[: len(line) - len(line.lstrip())]
            out.extend(f"{indent}{a}\n" for a in add)
    if hits < minimum:
        sys.exit(f"apply-overlay: {path}: anchor {anchor} found {hits} times, need {minimum}")
    gn.write_text("".join(out))
    print(f"apply-overlay: {path}: {add[0]} after {hits} anchor(s)")
