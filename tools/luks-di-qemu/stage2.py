import socket, time, sys, re, subprocess, os
os.chdir(os.environ["WORK"])
log = open("ok.stage2.log", "wb")
text = open("ok.serial.log", errors="ignore").read()
m = re.search(r"REAL=(\S+) OLD=(\S+)", text)
real, old = m.group(1), m.group(2)
sock = "stage2.sock"
if os.path.exists(sock): os.remove(sock)
q = subprocess.Popen(["qemu-system-aarch64","-machine","virt","-accel","hvf","-cpu","host","-m","2048","-smp","2",
  "-drive","if=pflash,format=raw,readonly=on,file=/opt/homebrew/share/qemu/edk2-aarch64-code.fd",
  "-drive","if=pflash,format=raw,file=ok.vars.fd",
  "-drive","file=ok.qcow2,if=none,id=hd,format=qcow2","-device","virtio-blk-pci,drive=hd",
  "-nic","user,model=virtio-net-pci","-serial",f"unix:{sock},server,nowait","-display","none","-monitor","none"])
for _ in range(50):
    if os.path.exists(sock): break
    time.sleep(0.2)
s = socket.socket(socket.AF_UNIX); s.connect(sock); s.settimeout(1)
buf = b""
def pump(seconds):
    global buf
    end = time.time() + seconds
    while time.time() < end:
        try:
            d = s.recv(4096)
            if d: buf += d; log.write(d); log.flush()
        except socket.timeout: pass
def wait_for(pat, timeout):
    global buf
    end = time.time() + timeout
    while time.time() < end:
        pump(1)
        if re.search(pat, buf.decode(errors="ignore")): return True
    return False
step = 0
ok = wait_for(r"Please unlock disk", 240)
print("unlock prompt seen:", ok)
if ok:
    buf = b""; s.send((old + "\r").encode()); 
    r = wait_for(r"No key available|Please unlock disk[^\n]*\n?[^\n]*Please unlock|try again", 60)
    print("old (install-time) key rejected:", r, bool(re.search(r"No key available", buf.decode(errors='ignore'))))
    time.sleep(5); pump(3)
    buf = b""; s.send((real + "\r").encode())
    up = wait_for(r"login:", 240)
    print("real key unlocked and system reached login prompt:", up)
pump(2)
q.terminate()
