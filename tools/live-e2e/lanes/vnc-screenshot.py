#!/usr/bin/env python3
"""Screenshot (and optionally type into) the VNC console of an UpCloud server.
Used to see a burn-lane server that has no serial output: it turns remote access on
first (PUT /server/<uuid> {"server":{"remote_access_enabled":"yes","remote_access_type":"vnc"}}).
  python3 vnc-screenshot.py <server uuid> out.png [enter|esc|ctrl+c|alt+f2|waitN|text:abc ...]
Keys without shift only (no ( ) $ | _ or capitals). Reads the token from
~/.config/flagship/upcloud-token and never prints it."""
import socket, struct, subprocess, sys, json, zlib, urllib.request, os
S = sys.argv[1]; out = sys.argv[2]; keys = sys.argv[3:]
tok = open(os.path.expanduser("~/.config/flagship/upcloud-token")).read().strip()
req = urllib.request.Request(f"https://api.upcloud.com/1.3/server/{S}", headers={"Authorization": f"Bearer {tok}"})
srv = json.load(urllib.request.urlopen(req))["server"]
host, port, pw = srv["remote_access_host"], int(srv["remote_access_port"]), srv["remote_access_password"]
s = socket.create_connection((host, port), timeout=20)
def rd(n):
    b = b""
    while len(b) < n:
        c = s.recv(n - len(b))
        if not c: raise EOFError
        b += c
    return b
rd(12); s.send(b"RFB 003.008\n")
n = rd(1)[0]; types = list(rd(n))
assert 2 in types, types
s.send(bytes([2])); ch = rd(16)
key = bytes(int(f"{b:08b}"[::-1], 2) for b in (pw.encode()[:8].ljust(8, b"\0")))
enc = subprocess.run(["openssl", "enc", "-des-ecb", "-nopad", "-K", key.hex(), "-provider", "legacy", "-provider", "default"], input=ch, capture_output=True).stdout
s.send(enc)
assert struct.unpack(">I", rd(4))[0] == 0, "vnc auth failed"
s.send(b"\x01")
w, h = struct.unpack(">HH", rd(4)); pf = rd(16); nl = struct.unpack(">I", rd(4))[0]; rd(nl)
# 32bpp little-endian true colour rgb888
s.send(struct.pack(">BxxxBBBBHHHBBBxxx", 0, 32, 24, 0, 1, 255, 255, 255, 16, 8, 0))
import time
def key(ks, down): s.send(struct.pack(">BBxxI", 4, down, ks))
for k in keys:
    if k == "enter": key(0xff0d,1); key(0xff0d,0)
    elif k == "ctrl+c": key(0xffe3,1); key(ord("c"),1); key(ord("c"),0); key(0xffe3,0)
    elif k == "esc": key(0xff1b,1); key(0xff1b,0)
    elif k.startswith("alt+f"):
        f = 0xffbe + int(k[5:]) - 1
        key(0xffe9,1); key(f,1); key(f,0); key(0xffe9,0)
    elif k.startswith("text:"):
        for ch in k[5:]:
            key(ord(ch),1); key(ord(ch),0)
    elif k.startswith("wait"):
        time.sleep(float(k[4:]))
    else: raise SystemExit("bad key "+k)
    time.sleep(0.3)
s.send(struct.pack(">BxHi", 2, 1, 0))
s.send(struct.pack(">BBHHHH", 3, 0, 0, 0, w, h))
fb = bytearray(w * h * 4)
got = 0
while got < w * h:
    t = rd(1)[0]
    if t != 0: continue
    rd(1); nr = struct.unpack(">H", rd(2))[0]
    for _ in range(nr):
        x, y, rw, rh, enc_ = struct.unpack(">HHHHi", rd(12))
        assert enc_ == 0, enc_
        data = rd(rw * rh * 4)
        for r in range(rh):
            fb[((y + r) * w + x) * 4:((y + r) * w + x + rw) * 4] = data[r * rw * 4:(r + 1) * rw * 4]
        got += rw * rh
raw = b"".join(b"\0" + bytes(fb[(r * w) * 4:(r * w + w) * 4][i + k] for i in range(0, w * 4, 4) for k in (2, 1, 0)) for r in range(h))
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
open(out, "wb").write(png); print("saved", w, h)
