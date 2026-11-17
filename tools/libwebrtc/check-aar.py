#!/usr/bin/env python3
"""check-aar.py <libwebrtc.aar> <llvm-nm>: refuses an AAR whose Java and native halves do not meet.

1. Every class a class in classes.jar names (CONSTANT_Class) under org/webrtc/, org/jni_zero/ or J/ is in the jar.
   libwebrtc-157-43884507084 shipped without the generated org/webrtc/*Jni bridges, so the first call threw
   NoClassDefFoundError at PeerConnectionFactory.initialize.
2. Every native method in the jar has its JNI symbol exported by libjingle_peerconnection_so.so for every ABI, so a
   bridge that is there but bound to a name the library lacks (UnsatisfiedLinkError) fails here too.
"""
import io
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

PACKAGES = ("org/webrtc/", "org/jni_zero/", "J/")
ACC_NATIVE = 0x0100


def parse_class(data):
    """Returns (this class, class names referenced, [(method name, descriptor)] of native methods)."""
    pos = 10
    (count,) = struct.unpack_from(">H", data, 8)
    utf8, classes = {}, {}
    i = 1
    while i < count:
        tag = data[pos]
        pos += 1
        if tag == 1:
            (n,) = struct.unpack_from(">H", data, pos)
            utf8[i] = data[pos + 2:pos + 2 + n].decode("utf-8", "replace")
            pos += 2 + n
        elif tag in (7, 8, 16, 19, 20):
            if tag == 7:
                classes[i] = struct.unpack_from(">H", data, pos)[0]
            pos += 2
        elif tag in (3, 4, 9, 10, 11, 12, 17, 18):
            pos += 4
        elif tag in (5, 6):
            pos += 8
            i += 1
        elif tag == 15:
            pos += 3
        else:
            raise ValueError(f"constant pool tag {tag}")
        i += 1
    _, this, _ = struct.unpack_from(">HHH", data, pos)
    pos += 6
    (n_if,) = struct.unpack_from(">H", data, pos)
    pos += 2 + 2 * n_if

    def members():
        nonlocal pos
        (n,) = struct.unpack_from(">H", data, pos)
        pos += 2
        out = []
        for _ in range(n):
            acc, name, desc, n_attr = struct.unpack_from(">HHHH", data, pos)
            pos += 8
            for _ in range(n_attr):
                (length,) = struct.unpack_from(">I", data, pos + 2)
                pos += 6 + length
            out.append((acc, utf8[name], utf8[desc]))
        return out

    members()
    natives = [(name, desc) for acc, name, desc in members() if acc & ACC_NATIVE]
    this_name = utf8[classes[this]]
    names = set()
    for c in classes.values():
        n = utf8[c]
        if n.startswith("["):
            n = n.lstrip("[")
            if not n.startswith("L"):
                continue
            n = n[1:-1]
        names.add(n)
    return this_name, names, natives


def mangle(s):
    out = []
    for ch in s:
        if ch == "/":
            out.append("_")
        elif ch == "_":
            out.append("_1")
        elif ch == ";":
            out.append("_2")
        elif ch == "[":
            out.append("_3")
        elif ch.isascii() and ch.isalnum():
            out.append(ch)
        else:
            out.append(f"_0{ord(ch):04x}")
    return "".join(out)


def main():
    aar, nm = sys.argv[1], sys.argv[2]
    errors = []
    with zipfile.ZipFile(aar) as z, tempfile.TemporaryDirectory() as tmp:
        cj = zipfile.ZipFile(io.BytesIO(z.read("classes.jar")))
        present, wanted, natives = set(), {}, []
        for n in cj.namelist():
            if not n.endswith(".class"):
                continue
            this, refs, nat = parse_class(cj.read(n))
            present.add(this)
            for r in refs:
                if r.startswith(PACKAGES):
                    wanted.setdefault(r, this)
            natives += [(this, m, d) for m, d in nat]
        missing = sorted(set(wanted) - present)
        if missing:
            errors.append(f"classes.jar lacks {len(missing)} classes it uses: " + ", ".join(missing[:12]))
        abis = sorted({n.split("/")[1] for n in z.namelist()
                       if n.startswith("jni/") and n.endswith("/libjingle_peerconnection_so.so")})
        if not abis:
            errors.append("no jni/<abi>/libjingle_peerconnection_so.so")
        for abi in abis:
            so = Path(tmp) / f"{abi}.so"
            so.write_bytes(z.read(f"jni/{abi}/libjingle_peerconnection_so.so"))
            out = subprocess.run([nm, "-D", "--defined-only", str(so)], check=True, capture_output=True, text=True)
            syms = {line.split()[-1] for line in out.stdout.splitlines() if line.strip()}
            unbound = []
            for cls, m, d in natives:
                short = f"Java_{mangle(cls)}_{mangle(m)}"
                long = f"{short}__{mangle(d[1:d.index(')')])}"
                if short not in syms and long not in syms:
                    unbound.append(f"{cls}.{m}")
            if unbound:
                errors.append(f"{abi}: {len(unbound)} native methods have no symbol: " + ", ".join(unbound[:8]))
        if not any(c == "org/webrtc/PeerConnectionFactoryJni" for c, _, _ in natives):
            errors.append("org/webrtc/PeerConnectionFactoryJni declares no native methods")
        print(f"check-aar: {len(present)} classes, {len(natives)} native methods, ABIs {', '.join(abis)}")
    if errors:
        sys.exit("check-aar: " + "\n  ".join(errors))


if __name__ == "__main__":
    main()
