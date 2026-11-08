#!/usr/bin/env python3
"""Userspace link emulator: two TUN devices (root netns <-> 'phone' netns), each
direction gets one-way delay, jitter (FIFO kept), random loss and periodic outages.
No netem in this kernel, so this is how TCP gets a real RTT and real retransmits."""
import argparse, fcntl, heapq, os, random, select, struct, sys, time

TUNSETIFF, IFF_TUN, IFF_NO_PI = 0x400454CA, 0x0001, 0x1000

def open_tun(name):
    fd = os.open("/dev/net/tun", os.O_RDWR)
    fcntl.ioctl(fd, TUNSETIFF, struct.pack("16sH", name.encode(), IFF_TUN | IFF_NO_PI))
    os.set_blocking(fd, False)
    return fd

ap = argparse.ArgumentParser()
ap.add_argument("--netns", default="phone")
ap.add_argument("--delay-ms", type=float, default=40)
ap.add_argument("--jitter-ms", type=float, default=0)
ap.add_argument("--loss", type=float, default=0.0)
ap.add_argument("--outage-every-s", type=float, default=0)
ap.add_argument("--outage-ms", type=float, default=0)
ap.add_argument("--seed", type=int, default=1)
a = ap.parse_args()
random.seed(a.seed)

fa = open_tun("tunA")
with open(f"/var/run/netns/{a.netns}") as ns:
    root = os.open("/proc/self/ns/net", os.O_RDONLY)
    os.setns(ns.fileno(), os.CLONE_NEWNET)
    fb = open_tun("tunB")
    os.setns(root, os.CLONE_NEWNET)
print("ready", flush=True)

t0 = time.monotonic()
q, last, seq = [], {fa: 0.0, fb: 0.0}, 0
stats = {"fwd": 0, "lost": 0, "outage": 0}
def in_outage(now):
    if not a.outage_every_s: return False
    return ((now - t0) % a.outage_every_s) < a.outage_ms / 1000
peer = {fa: fb, fb: fa}
while True:
    now = time.monotonic()
    timeout = max(0.0, q[0][0] - now) if q else 0.5
    r, _, _ = select.select([fa, fb], [], [], timeout)
    now = time.monotonic()
    for fd in r:
        while True:
            try: pkt = os.read(fd, 65535)
            except BlockingIOError: break
            if in_outage(now): stats["outage"] += 1; continue
            if random.random() < a.loss: stats["lost"] += 1; continue
            d = a.delay_ms + (random.uniform(-a.jitter_ms, a.jitter_ms) if a.jitter_ms else 0)
            out = peer[fd]
            at = max(now + d / 1000, last[out])
            last[out] = at
            seq += 1
            heapq.heappush(q, (at, seq, out, pkt))
    while q and q[0][0] <= now:
        _, _, out, pkt = heapq.heappop(q)
        try: os.write(out, pkt); stats["fwd"] += 1
        except OSError: pass
