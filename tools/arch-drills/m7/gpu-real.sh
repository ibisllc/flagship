#!/bin/bash
# Real-hardware GPU receipts (docs/architecture-v2/gpu-runbooks/). Run as root on the GPU host
# after setup-box.sh (flagship-gpud built and installed). Every step writes its raw output into
# <out>; summary.json lists each check with ok/false. A receipt is the out directory plus the
# commit; `node scripts/gpu-catalog.mjs build` pins its SHA-256.
#
#   gpu-real.sh prepare-nvidia                 driver, container toolkit, runsc-nvproxy (then reboot)
#   gpu-real.sh qualify-nvidia <out>           H1 CUDA, H2 residue scrub, H9 render/video, H12 honesty
#   gpu-real.sh qualify-mig <out> <profiles>   H5 MIG layout + two concurrent partition jobs
#   gpu-real.sh qualify-multi <out>            H7 gang admission + DDP train/resume (2+ GPUs)
#   gpu-real.sh qualify-passthrough <out> <pci>  H8 VFIO bind/reset/release on this host
#   gpu-real.sh mega <out>                     ONE run: prepare if needed (reboots, run again), then qualify-nvidia,
#                                              MIG when the card has it, multi-GPU when 2+, passthrough when the card
#                                              has an IOMMU group of its own; every stage lands in one summary.json
#
# Images: CUDA_DEVEL_BASE, CUDA_RUNTIME_BASE, TORCH_BASE, FFMPEG_NVIDIA_BASE, RENDER_BASE must be
# name@sha256:<digest> references (the runbook says how to choose and record them).
set -uo pipefail
CMD="${1:-}"; OUT="${2:-/root/gpu-receipt}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$(cd "$HERE/../../gpu" 2>/dev/null && pwd || echo /opt/flagship-m7/tools/gpu)"
# The check images' pinned bases (tools/gpu/bases.env); anything exported beforehand wins.
# shellcheck source=/dev/null
[ -f "$TOOLS/bases.env" ] && . "$TOOLS/bases.env"
RUNSC_RELEASE=20260921.0
GPUD=/usr/local/bin/flagship-gpud
mkdir -p "$OUT"
SUMMARY="$OUT/summary.json"
[ -f "$SUMMARY" ] || echo '[]' > "$SUMMARY"
log() { echo "[gpu-real $(date -u +%H:%M:%S)] $*"; }
record() { # name ok detail
  jq --arg n "$1" --argjson ok "$2" --arg d "$3" '. + [{name: $n, ok: $ok, detail: $d}]' "$SUMMARY" > "$SUMMARY.tmp" && mv "$SUMMARY.tmp" "$SUMMARY"
  log "$([ "$2" = true ] && echo PASS || echo FAIL) $1 ${3:0:200}"
}
pinned() { [[ "${!1:-}" =~ ^[a-z0-9./:_-]+@sha256:[0-9a-f]{64}$ ]] || { log "$1 must be name@sha256:<digest>"; exit 2; }; }
gpud_flags() {
  echo --nvidia-smi /usr/bin/nvidia-smi --nvidia-ctk /usr/bin/nvidia-ctk --engine /usr/bin/podman \
    --runsc-version "$RUNSC_RELEASE" --cdi-generator "nvidia-ctk $(nvidia-ctk --version 2>/dev/null | sed -n 's/.*version \([0-9.]*\).*/\1/p' | head -n1)"
}
build() { # dir tag base-var
  pinned "$3"
  podman build -q --build-arg BASE="${!3}" -t "localhost/flagship-$2" "$TOOLS/$1" >/dev/null && podman image inspect --format '{{.Id}}' "localhost/flagship-$2"
}
gpu_run() { podman run --rm --network=none --read-only --cap-drop=ALL --runtime=runsc-nvproxy --device "nvidia.com/gpu=${GPU:-0}" "$@"; }

case "$CMD" in
prepare-nvidia)
  export DEBIAN_FRONTEND=noninteractive
  sed -i 's/^Components: main.*/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources
  apt-get update -q
  apt-get install -y -q "linux-headers-$(uname -r)" nvidia-driver nvidia-smi firmware-misc-nonfree jq podman curl gnupg
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit.gpg] https://#' > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update -q && apt-get install -y -q nvidia-container-toolkit
  ARCH=$(uname -m)
  base="https://storage.googleapis.com/gvisor/releases/release/$RUNSC_RELEASE/$ARCH"
  curl -fsSL "$base/runsc" -o /tmp/runsc && curl -fsSL "$base/runsc.sha512" -o /tmp/runsc.sha512
  (cd /tmp && sha512sum -c runsc.sha512) && install -m 0755 /tmp/runsc /usr/local/bin/runsc
  mkdir -p /usr/local/lib/flagship-gpu /etc/containers/containers.conf.d
  printf '#!/bin/sh\nexec /usr/local/bin/runsc --nvproxy "$@"\n' > /usr/local/lib/flagship-gpu/runsc-nvproxy
  chmod 0755 /usr/local/lib/flagship-gpu/runsc-nvproxy
  printf '[engine]\ncdi_spec_dirs = ["/var/run/cdi"]\n\n[engine.runtimes]\nrunsc-nvproxy = ["/usr/local/lib/flagship-gpu/runsc-nvproxy"]\n' > /etc/containers/containers.conf.d/flagship-gpu.conf
  log "prepared; reboot so the driver loads, then: gpu-real.sh qualify-nvidia <out>"
  ;;
qualify-nvidia)
  lspci -nn > "$OUT/lspci.txt"; uname -r > "$OUT/kernel.txt"
  mokutil --sb-state > "$OUT/secureboot.txt" 2>&1 || true
  modinfo -F signer nvidia > "$OUT/module-signer.txt" 2>&1 || true
  nvidia-smi -q -x > "$OUT/nvidia-smi.xml" && record "nvidia-smi answers (not acceptance on its own)" true "$(grep -o '<product_name>[^<]*' "$OUT/nvidia-smi.xml" | head -n1)"
  # shellcheck disable=SC2046
  $GPUD probe $(gpud_flags) > "$OUT/probe.json"
  record "flagship-gpud enumerates the device" "$(jq '.available and (.devices|length>0)' "$OUT/probe.json")" "$(jq -c '[.devices[]|{model,memoryMiB,driver,unqualifiedReasons}]' "$OUT/probe.json")"
  record "the CDI spec was generated, sanitised and written" "$(jq '.cdi.status=="written"' "$OUT/probe.json")" "$(jq -c .cdi "$OUT/probe.json")"
  cp /var/run/cdi/nvidia_com_gpu.json "$OUT/cdi.json" 2>/dev/null || true
  VA=$(build vector-add vector-add CUDA_DEVEL_BASE) && gpu_run "$VA" > "$OUT/vector-add.json"
  $GPUD verify-report --kind vector-add --api cuda --file "$OUT/vector-add.json" > "$OUT/vector-add.verdict.json"
  record "H1 CUDA vector add matches bit for bit under gVisor/nvproxy" "$(jq .ok "$OUT/vector-add.verdict.json")" "$(cat "$OUT/vector-add.verdict.json" | tr -d '\n')"
  TC=$(build torch-check torch-check TORCH_BASE) && gpu_run "$TC" cuda > "$OUT/torch.json"
  $GPUD verify-report --kind mlp --api cuda --file "$OUT/torch.json" > "$OUT/torch.verdict.json"
  record "H1 PyTorch inference matches the fixture" "$(jq .ok "$OUT/torch.verdict.json")" "$(cat "$OUT/torch.verdict.json" | tr -d '\n')"
  SC=$(build scrub scrub CUDA_DEVEL_BASE)
  gpu_run "$SC" canary > "$OUT/canary.json"
  gpu_run "$SC" > "$OUT/scrub.json"
  MEM=$(jq -r '.devices[0].memoryMiB' "$OUT/probe.json")
  $GPUD verify-report --kind scrub --memory-mib "$MEM" --file "$OUT/scrub.json" > "$OUT/scrub.verdict.json"
  record "H2 the scan sees a previous tenant's canaries" "$(jq '.canariesBefore > 0' "$OUT/scrub.json")" "$(cat "$OUT/scrub.json" | tr -d '\n')"
  record "H2 no canary survives the scrub; coverage and pattern hold" "$(jq .ok "$OUT/scrub.verdict.json")" "$(cat "$OUT/scrub.verdict.json" | tr -d '\n')"
  if [ -n "${RENDER_BASE:-}" ]; then
    RC=$(build render-check render-check RENDER_BASE)
    podman run --rm --network=none --read-only --cap-drop=ALL --runtime=runsc-nvproxy --device nvidia.com/gpu=0 \
      -e NVIDIA_DRIVER_CAPABILITIES=graphics "$RC" > "$OUT/render.ppm"
    $GPUD verify-render --width 640 --height 480 --file "$OUT/render.ppm" > "$OUT/render.verdict.json"
    record "H9 headless EGL render matches flagship-test-scene/v1" "$(jq .ok "$OUT/render.verdict.json")" "$(cat "$OUT/render.verdict.json" | tr -d '\n')"
  fi
  if [ -n "${FFMPEG_NVIDIA_BASE:-}" ]; then
    VC=$(build video-check video-check FFMPEG_NVIDIA_BASE)
    $GPUD reference-clip --width 320 --height 240 --frames 30 \
      | podman run -i --rm --network=none --read-only --tmpfs /tmp --cap-drop=ALL --runtime=runsc-nvproxy --device nvidia.com/gpu=0 \
        "$VC" 320 240 h264 nvidia > "$OUT/decoded.yuv"
    $GPUD verify-transcode --width 320 --height 240 --frames 30 --file "$OUT/decoded.yuv" > "$OUT/video.verdict.json"
    record "H9 NVENC/NVDEC round trip is within the PSNR floor" "$(jq .ok "$OUT/video.verdict.json")" "$(cat "$OUT/video.verdict.json" | tr -d '\n')"
  fi
  if podman run --rm --network=none --runtime=runsc-nvproxy "$VA" > "$OUT/no-device.json" 2>&1; then
    record "a container without the CDI device gets no GPU" false "the vector add ran without a device"
  else
    record "a container without the CDI device gets no GPU" true "refused: $(tail -n1 "$OUT/no-device.json")"
  fi
  (cd /opt/flagship-m7/rust && FLAGSHIP_GPU_HW=1 FLAGSHIP_GPU_PODMAN=/usr/bin/podman \
    FLAGSHIP_GPU_VECTOR_ADD_IMAGE="$VA" FLAGSHIP_GPU_TORCH_IMAGE="$TC" \
    "$HOME/.cargo/bin/cargo" test --release --locked -p flagship-gpu --test hardware -- --nocapture > "$OUT/cargo-hardware.txt" 2>&1)
  record "cargo test --test hardware on the device" "$([ $? = 0 ] && ! grep -q SKIPPED "$OUT/cargo-hardware.txt" && echo true || echo false)" "$(grep -E 'test result|SKIPPED' "$OUT/cargo-hardware.txt" | tr '\n' ' ')"
  ;;
qualify-mig)
  PROFILES="${3:-3g.20gb,3g.20gb}"
  nvidia-smi -i 0 -mig 1 > "$OUT/mig-mode.txt" 2>&1
  nvidia-smi mig -i 0 -lgip > "$OUT/lgip.txt"
  nvidia-smi mig -i 0 -dci >/dev/null 2>&1; nvidia-smi mig -i 0 -dgi >/dev/null 2>&1
  IDS=$(for p in ${PROFILES//,/ }; do awk -v p="$p" '$3=="MIG" && $4==p {print $5}' "$OUT/lgip.txt" | head -n1; done | paste -sd, -)
  nvidia-smi mig -i 0 -cgi "$IDS" -C > "$OUT/mig-create.txt" 2>&1
  # shellcheck disable=SC2046
  $GPUD probe $(gpud_flags) > "$OUT/probe.json"
  record "H5 the partitions are in the inventory" "$(jq '[.devices[].partitions|length]|max >= 2' "$OUT/probe.json")" "$(jq -c '[.devices[].partitions]' "$OUT/probe.json")"
  VA=$(build vector-add vector-add CUDA_DEVEL_BASE)
  (GPU=0:0 gpu_run "$VA" > "$OUT/p0.json") & (GPU=0:1 gpu_run "$VA" > "$OUT/p1.json") & wait
  ok=true; for p in p0 p1; do $GPUD verify-report --kind vector-add --api cuda --file "$OUT/$p.json" >/dev/null || ok=false; done
  record "H5 two concurrent jobs in separate partitions both verify" "$ok" ""
  ;;
qualify-multi)
  N=$(nvidia-smi -L | wc -l)
  nvidia-smi topo -m > "$OUT/topo.txt"
  # shellcheck disable=SC2046
  $GPUD probe $(gpud_flags) > "$OUT/probe.json"
  record "H7 the host has 2+ GPUs and a topology matrix" "$([ "$N" -ge 2 ] && echo true || echo false)" "$N GPUs, $(jq .topologyLinks "$OUT/probe.json") links"
  log "next: the gang claim and train/resume receipts in gpu-runbooks/multi-gpu-training.md (through flagship-gpud)"
  ;;
qualify-passthrough)
  PCI="${3:?pci address}"
  # shellcheck disable=SC2046
  $GPUD probe $(gpud_flags) > "$OUT/probe.json"
  record "H8 passthrough qualification for $PCI" "$(jq --arg p "$PCI" '[.devices[]|select(.passthrough.ok)]|length>0' "$OUT/probe.json")" "$(jq -c '[.devices[].passthrough]' "$OUT/probe.json")"
  cat "/sys/bus/pci/devices/$PCI/reset_method" > "$OUT/reset_method.txt" 2>&1
  cat "/sys/kernel/iommu_groups/$(basename "$(readlink "/sys/bus/pci/devices/$PCI/iommu_group")")/type" > "$OUT/iommu-type.txt" 2>&1
  ;;
mega)
  if ! command -v nvidia-smi >/dev/null || ! nvidia-smi -L >/dev/null 2>&1; then
    log "no working NVIDIA stack yet: preparing it; the host reboots, then run 'gpu-real.sh mega $OUT' again"
    "$0" prepare-nvidia "$OUT" && { (sleep 2; reboot) & exit 0; }
    record "prepare the NVIDIA stack" false "prepare-nvidia failed"; exit 1
  fi
  "$0" qualify-nvidia "$OUT/nvidia"
  jq -c '.[]' "$OUT/nvidia/summary.json" | while read -r row; do jq --argjson r "$row" '. + [$r]' "$SUMMARY" > "$SUMMARY.tmp" && mv "$SUMMARY.tmp" "$SUMMARY"; done
  if nvidia-smi --query-gpu=mig.mode.current --format=csv,noheader 2>/dev/null | grep -qiv "N/A"; then
    "$0" qualify-mig "$OUT/mig" 2>&1 | tail -n 3
    jq -c '.[]' "$OUT/mig/summary.json" 2>/dev/null | while read -r row; do jq --argjson r "$row" '. + [$r]' "$SUMMARY" > "$SUMMARY.tmp" && mv "$SUMMARY.tmp" "$SUMMARY"; done
  else
    record "H5 MIG" true "skipped: the card has no MIG (not an A100/H100-class part)"
  fi
  if [ "$(nvidia-smi -L | wc -l)" -ge 2 ]; then
    "$0" qualify-multi "$OUT/multi" 2>&1 | tail -n 3
    jq -c '.[]' "$OUT/multi/summary.json" 2>/dev/null | while read -r row; do jq --argjson r "$row" '. + [$r]' "$SUMMARY" > "$SUMMARY.tmp" && mv "$SUMMARY.tmp" "$SUMMARY"; done
  else
    record "H7 multi-GPU" true "skipped: one GPU on this host"
  fi
  PCI=$(lspci -D -d 10de: | grep -iE "VGA|3D" | head -n1 | cut -d' ' -f1)
  if [ -n "$PCI" ] && [ -d "/sys/kernel/iommu_groups" ] && [ -e "/sys/bus/pci/devices/$PCI/iommu_group" ]; then
    "$0" qualify-passthrough "$OUT/passthrough" "$PCI" 2>&1 | tail -n 3
    jq -c '.[]' "$OUT/passthrough/summary.json" 2>/dev/null | while read -r row; do jq --argjson r "$row" '. + [$r]' "$SUMMARY" > "$SUMMARY.tmp" && mv "$SUMMARY.tmp" "$SUMMARY"; done
  else
    record "H8 passthrough" true "skipped: no IOMMU group for the card (enable VT-d/AMD-Vi to qualify it)"
  fi
  ;;
*)
  sed -n '2,20p' "$0"; exit 2 ;;
esac
log "summary: $(jq -c '[.[]|select(.ok==false)|.name]' "$SUMMARY")"
