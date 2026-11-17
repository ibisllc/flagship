#!/usr/bin/env python3
"""apply-overlay.py <webrtc src>: copies overlay/ into the checkout and lists the files in the SDK's BUILD.gn.

Each insertion goes after an upstream anchor line; a missing anchor fails the build, so a new pin that moved a target
is caught here rather than as a link error later.
"""
import pathlib
import re
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
    # The jar carries LibaomAv1Encoder (libaom_av1_encoder_java); upstream never linked its native half into the
    # library, so its one native method had no symbol (check-aar.py).
    ("sdk/android/BUILD.gn", '":dav1d_av1_jni",',
     ['":libaom_av1_encoder_jni",'], 1),
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

# The generated JNI bridges (org/webrtc/*Jni) live in each generate_jni()'s own `<name>_java` library, which the
# upstream dist_jar (direct deps only) leaves out, and by default they call natives on J.N, a class only an APK's
# final JNI step writes. An AAR has no final step, so: per-file natives (each FooJni declares its own natives, which
# the per-library headers export as Java_org_webrtc_FooJni_*; build-android.sh sets the GN args), and every bridge
# library in the jar. tools/libwebrtc/check-aar.py checks the result.
JNI_GNI = src / "third_party/jni_zero/jni_zero.gni"
if JNI_GNI.exists():
    text = JNI_GNI.read_text()
    if "jni_zero_per_file_natives" not in text:
        decl = '       "Multiplexing requires that hashed names be disabled.")\n'
        flag = '          args += [ "--use-proxy-hash" ]\n        }\n'
        if text.count(decl) != 1 or text.count(flag) != 1:
            sys.exit("apply-overlay: third_party/jni_zero/jni_zero.gni: per-file anchors moved")
        text = text.replace(decl, decl + """
declare_args() {
  # Flagship: FooJni.java declares its own natives, so no final JNI step (an APK's) is needed. For the AAR.
  jni_zero_per_file_natives = false
}

assert(!jni_zero_per_file_natives ||
           (!use_hashed_jni_names && !enable_jni_multiplexing),
       "Per-file natives exclude hashed names and multiplexing.")
""")
        text = text.replace(flag, flag + """        if (jni_zero_per_file_natives) {
          args += [ "--per-file-natives" ]
        }
""")
        JNI_GNI.write_text(text)
        print("apply-overlay: third_party/jni_zero/jni_zero.gni: jni_zero_per_file_natives")

    jz = src / "third_party/jni_zero/BUILD.gn"
    text = jz.read_text()
    vis = 'generate_jni("generate_jni") {'
    if '"//sdk/android:*"' not in text:
        a = text.find(vis)
        b = text.find('":*",\n', a)
        if a < 0 or b < 0 or text.find("}", a) < b:
            sys.exit("apply-overlay: third_party/jni_zero/BUILD.gn: generate_jni visibility moved")
        text = text[:b] + '":*",\n    "//sdk/android:*",\n' + text[b + len('":*",\n'):]
        jz.write_text(text)
        print("apply-overlay: third_party/jni_zero/BUILD.gn: bridges visible to sdk/android")

    gn = src / "sdk/android/BUILD.gn"
    text = gn.read_text()
    if "flagship: JNI bridges" not in text:
        names = []
        for m in re.finditer(r'^(\s*)generate_jni\("([^"]+)"\) \{\n(.*?)^\1\}', text, re.M | re.S):
            if "testonly = true" not in m.group(3):
                names.append(m.group(2))
        if "generated_peerconnection_jni" not in names:
            sys.exit("apply-overlay: sdk/android/BUILD.gn: no generate_jni targets found")
        anchor_dep = '      "../../third_party/jni_zero:jni_zero_java",\n'
        start = text.find('dist_jar("libwebrtc") {')
        at = text.find(anchor_dep, start)
        if start < 0 or at < 0:
            sys.exit("apply-overlay: sdk/android/BUILD.gn: dist_jar libwebrtc anchor moved")
        deps = ["      # flagship: JNI bridges\n"] + [f'      ":{n}_java",\n' for n in names] + [
            # Upstream packs Dav1dDecoderJni's user only through swcodecs_java, which the jar holds as a direct
            # dep alone.
            '      ":dav1d_java",\n',
            '      "../../rtc_base:base_java_jni_java",\n',
            '      "//third_party/jni_zero:generate_jni_java",\n',
        ]
        at += len(anchor_dep)
        text = text[:at] + "".join(deps) + text[at:]
        gn.write_text(text)
        print(f"apply-overlay: sdk/android/BUILD.gn: {len(deps) - 1} libraries added to libwebrtc.jar")

# Chromium compiles Java with `--release 25` (class files 69), which the app's Android Gradle Plugin cannot dex. The
# app targets Java 17, so the AAR's classes do too. Two upstream lines; a pin that moved them fails here.
JAVA_RELEASE = [
    ("build/android/gyp/compile_java.py", "        '--release',\n", "        '25',\n", "        '17',\n"),
    ("build/android/gyp/turbine.py", None, "    javac_cmd = ['--release', '25']\n", "    javac_cmd = ['--release', '17']\n"),
]
for path, before, old, new in JAVA_RELEASE:
    f = src / path
    if not f.exists():
        continue
    text = f.read_text()
    if new in text and old not in text:
        continue
    lines = text.splitlines(keepends=True)
    hits = 0
    for i, line in enumerate(lines):
        if line == old and (before is None or any(l == before for l in lines[max(0, i - 6):i])):
            lines[i] = new
            hits += 1
    if hits != 1:
        sys.exit(f"apply-overlay: {path}: expected one Java release line, found {hits}")
    f.write_text("".join(lines))
    print(f"apply-overlay: {path}: Java release 17")
