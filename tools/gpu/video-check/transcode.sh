#!/bin/sh
# flagship-test-clip/v1 encoded and decoded on the GPU: the clip comes from
# `flagship-gpud reference-clip` (raw YUV 4:2:0) on stdin; the decoded YUV goes to stdout for
# `flagship-gpud verify-transcode`. Vendor: nvidia (NVENC/NVDEC), vaapi (AMD, Intel), qsv (Intel).
set -eu
W="$1"; H="$2"; CODEC="$3"; VENDOR="$4"
case "$VENDOR/$CODEC" in
  nvidia/h264) ENC=h264_nvenc; DEC="-c:v h264_cuvid" ;;
  nvidia/hevc) ENC=hevc_nvenc; DEC="-c:v hevc_cuvid" ;;
  nvidia/av1)  ENC=av1_nvenc;  DEC="-c:v av1_cuvid" ;;
  vaapi/h264)  ENC="h264_vaapi -vaapi_device /dev/dri/renderD128 -vf format=nv12,hwupload"; DEC="-hwaccel vaapi" ;;
  vaapi/hevc)  ENC="hevc_vaapi -vaapi_device /dev/dri/renderD128 -vf format=nv12,hwupload"; DEC="-hwaccel vaapi" ;;
  qsv/av1)     ENC=av1_qsv; DEC="-c:v av1_qsv" ;;
  *) echo "unsupported $VENDOR/$CODEC" >&2; exit 2 ;;
esac
TMP=$(mktemp -d)
ffmpeg -loglevel error -f rawvideo -pix_fmt yuv420p -s "${W}x${H}" -i - -c:v $ENC -qp 18 "$TMP/out.mkv"
ffmpeg -loglevel error $DEC -i "$TMP/out.mkv" -f rawvideo -pix_fmt yuv420p -
